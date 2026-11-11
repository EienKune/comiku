import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  BirthdaysService,
  BIRTHDAY_SCOPE,
  BIRTHDAY_SYNC_KIND,
} from "../../src/birthdays/birthdays.service.js";
import { KIVO_SYNC_KIND } from "../../src/birthdays/birthday-supplement.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { JobsService } from "../../src/jobs/jobs.service.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

// Service transactions share a rollback-only PostgreSQL fixture. These assertions
// establish persisted eligibility and lease predicates, not cross-connection races.
function transactionFacade(tx: Prisma.TransactionClient): PrismaService {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$transaction")
        return async <T>(
          action: (client: Prisma.TransactionClient) => Promise<T>,
        ) => action(tx);
      return Reflect.get(target, property);
    },
  }) as unknown as PrismaService;
}

test(
  "both birthday handlers persist five-minute retries across worker replacement without refunding attempts",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error("rollback synthetic birthday retry jobs");
    const fetcher = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected external request");
    });
    t.mock.method(console, "info", () => {});
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            const facade = transactionFacade(tx);
            // Fail before source acquisition, using the real production handler
            // registrations so their retry options are part of this regression.
            const failingSource = new Proxy(facade, {
              get(target, property) {
                if (property === "birthdaySettings")
                  return {
                    async findUnique() {
                      throw new Error("synthetic source preparation failure");
                    },
                  };
                return Reflect.get(target, property);
              },
            });
            const worker = () => {
              const jobs = new JobsService(facade);
              new BirthdaysService(failingSource, jobs, environment);
              return jobs;
            };
            for (const kind of [BIRTHDAY_SYNC_KIND, KIVO_SYNC_KIND]) {
              for (const attempt of [1, 3]) {
                const scope = `birthday-retry:${randomUUID()}`;
                const jobs = worker();
                const queued = await jobs.enqueue({
                  kind,
                  resourceId: randomUUID(),
                  idempotencyKey: scope,
                  lane: "network",
                  executionScope: scope,
                });
                await tx.backgroundJob.update({
                  where: { id: queued.id },
                  data: { attempts: attempt - 1 },
                });
                const claimed = await jobs.claim("network", new Date(), scope);
                assert.ok(claimed);
                assert.equal(claimed.attempts, attempt);
                const startedAt = Date.now();
                await jobs.execute(claimed);
                const finishedAt = Date.now();
                const persisted = await tx.backgroundJob.findUniqueOrThrow({
                  where: { id: queued.id },
                });
                assert.equal(persisted.attempts, attempt);
                assert.equal(
                  persisted.status,
                  attempt === 3 ? "failed" : "queued",
                );
                assert.equal(persisted.leaseId, null);
                assert.equal(persisted.leaseUntil, null);
                assert.equal(persisted.completedAt !== null, attempt === 3);
                assert.ok(
                  persisted.availableAt.getTime() >= startedAt + 300_000,
                );
                assert.ok(
                  persisted.availableAt.getTime() <= finishedAt + 300_000,
                );
                const restarted = worker();
                assert.equal(
                  await restarted.claim(
                    "network",
                    new Date(persisted.availableAt.getTime() - 1),
                    scope,
                  ),
                  null,
                );
                const due = await restarted.claim(
                  "network",
                  persisted.availableAt,
                  scope,
                );
                if (attempt === 3) {
                  assert.equal(
                    due,
                    null,
                    "exhausted jobs stay terminal when due",
                  );
                } else {
                  assert.ok(
                    due,
                    "a replacement worker can claim at the boundary",
                  );
                  assert.equal(due.id, queued.id);
                  assert.equal(due.attempts, 2);
                  assert.notEqual(due.leaseId, claimed.leaseId);
                }
              }
            }
            assert.equal(fetcher.mock.callCount(), 0);
            throw rollback;
          },
          { timeout: 45_000 },
        ),
        (error: unknown) => error === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "SchaleDB and Kivo scheduling cannot replace exhausted jobs before their persisted retry boundary",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error(
      "rollback synthetic birthday scheduling boundaries",
    );
    const fetcher = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected external request");
    });
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            await tx.birthdaySettings.upsert({
              where: { id: "global" },
              create: { id: "global" },
              update: { displayEnabled: true, remindersEnabled: false },
            });
            const facade = transactionFacade(tx);
            const jobs = new JobsService(facade);
            const service = new BirthdaysService(facade, jobs, environment);
            const retryAt = new Date(Date.now() + 300_000);
            for (const [source, kind] of [
              ["schaledb", BIRTHDAY_SYNC_KIND],
              ["kivo", KIVO_SYNC_KIND],
            ] as const) {
              const failed = await tx.backgroundJob.create({
                data: {
                  kind,
                  resourceId: randomUUID(),
                  idempotencyKey: `birthday-exhausted:${randomUUID()}`,
                  lane: "network",
                  executionScope: BIRTHDAY_SCOPE,
                  status: "failed",
                  attempts: 3,
                  availableAt: retryAt,
                  completedAt: new Date(),
                },
              });
              const fields = {
                jobId: failed.id,
                // An overdue source isolates the terminal-job fence; a later
                // source checkpoint must not be needed to enforce this wait.
                nextCheckAt: new Date(0),
                lastCheckedAt: null,
                lastAttemptAt: null,
                lastErrorCode: "birthday_sync_failed",
                sourceCounts: {},
              };
              const before = await tx.birthdaySyncState.upsert({
                where: { id: source },
                create: { id: source, ...fields },
                update: fields,
              });
              const schedule = (now: Date) =>
                source === "schaledb"
                  ? service.schedule(undefined, now)
                  : service.scheduleSupplement(now);
              const countBefore = await tx.backgroundJob.count({
                where: { kind, executionScope: BIRTHDAY_SCOPE },
              });
              assert.deepEqual(
                await schedule(new Date(retryAt.getTime() - 1)),
                { queued: false },
              );
              assert.deepEqual(
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: source },
                }),
                before,
              );
              assert.equal(
                await tx.backgroundJob.count({
                  where: { kind, executionScope: BIRTHDAY_SCOPE },
                }),
                countBefore,
              );
              assert.deepEqual(await schedule(retryAt), { queued: true });
              const after = await tx.birthdaySyncState.findUniqueOrThrow({
                where: { id: source },
              });
              assert.notEqual(after.jobId, failed.id);
              assert.equal(
                await tx.backgroundJob.count({
                  where: { kind, executionScope: BIRTHDAY_SCOPE },
                }),
                countBefore + 1,
              );
              assert.deepEqual(
                await tx.backgroundJob.findUniqueOrThrow({
                  where: { id: failed.id },
                }),
                failed,
                "rescheduling retains the exhausted execution history",
              );
            }
            assert.equal(fetcher.mock.callCount(), 0);
            throw rollback;
          },
          { timeout: 45_000 },
        ),
        (error: unknown) => error === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "expired birthday leases recover with durable five-minute waits while live leases and default recovery stay unchanged",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error("rollback synthetic birthday lease recovery");
    const fetcher = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected external request");
    });
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            const facade = transactionFacade(tx);
            const defaultKind = `recovery_${randomUUID()}`;
            const worker = () => {
              const jobs = new JobsService(facade);
              new BirthdaysService(facade, jobs, environment);
              jobs.register(defaultKind, async () => {
                throw new Error("claim-only fixture must never execute");
              });
              return jobs;
            };
            for (const kind of [BIRTHDAY_SYNC_KIND, KIVO_SYNC_KIND]) {
              for (const attempt of [1, 3]) {
                const scope = `birthday-recovery:${randomUUID()}`;
                const recoveryAt = new Date();
                const expired = await tx.backgroundJob.create({
                  data: {
                    kind,
                    resourceId: randomUUID(),
                    idempotencyKey: scope,
                    lane: "network",
                    executionScope: scope,
                    status: "running",
                    attempts: attempt,
                    leaseId: randomUUID(),
                    leaseUntil: new Date(recoveryAt.getTime() - 1),
                    availableAt: new Date(0),
                  },
                });
                const waiting = await tx.backgroundJob.create({
                  data: {
                    kind,
                    resourceId: randomUUID(),
                    idempotencyKey: `${scope}:waiting`,
                    lane: "network",
                    executionScope: scope,
                    availableAt: new Date(recoveryAt.getTime() + 600_000),
                    lastError: "synthetic existing wait",
                  },
                });
                const restarted = worker();
                assert.equal(
                  await restarted.claim("network", recoveryAt, scope),
                  null,
                  "lease recovery must not immediately reclaim a birthday job",
                );
                const recovered = await tx.backgroundJob.findUniqueOrThrow({
                  where: { id: expired.id },
                });
                assert.equal(recovered.attempts, attempt);
                assert.equal(
                  recovered.status,
                  attempt === 3 ? "failed" : "queued",
                );
                assert.equal(recovered.completedAt !== null, attempt === 3);
                assert.equal(recovered.leaseId, null);
                assert.equal(recovered.leaseUntil, null);
                assert.ok(
                  recovered.availableAt.getTime() >=
                    recoveryAt.getTime() + 300_000,
                );
                assert.deepEqual(
                  await tx.backgroundJob.findUniqueOrThrow({
                    where: { id: waiting.id },
                  }),
                  waiting,
                  "recovering a sibling must not rewrite an existing queued wait",
                );
                const nextWorker = worker();
                assert.equal(
                  await nextWorker.claim(
                    "network",
                    new Date(recovered.availableAt.getTime() - 1),
                    scope,
                  ),
                  null,
                );
                assert.deepEqual(
                  await tx.backgroundJob.findUniqueOrThrow({
                    where: { id: expired.id },
                  }),
                  recovered,
                  "polling a recovered wait must not restart its cooldown",
                );
                const due = await nextWorker.claim(
                  "network",
                  recovered.availableAt,
                  scope,
                );
                if (attempt === 3) assert.equal(due, null);
                else {
                  assert.ok(due);
                  assert.equal(due.id, expired.id);
                  assert.equal(due.attempts, 2);
                  assert.notEqual(due.leaseId, expired.leaseId);
                }

                const liveScope = `${scope}:live`;
                const live = await tx.backgroundJob.create({
                  data: {
                    kind,
                    resourceId: randomUUID(),
                    idempotencyKey: liveScope,
                    lane: "network",
                    executionScope: liveScope,
                    status: "running",
                    attempts: attempt,
                    leaseId: randomUUID(),
                    leaseUntil: new Date(recoveryAt.getTime() + 600_000),
                    availableAt: new Date(0),
                  },
                });
                assert.equal(
                  await worker().claim("network", recoveryAt, liveScope),
                  null,
                );
                assert.deepEqual(
                  await tx.backgroundJob.findUniqueOrThrow({
                    where: { id: live.id },
                  }),
                  live,
                  "another owner's live lease must remain byte-for-byte unchanged",
                );
              }
            }
            const scope = `default-recovery:${randomUUID()}`;
            const recoveryAt = new Date();
            const expiredDefault = await tx.backgroundJob.create({
              data: {
                kind: defaultKind,
                resourceId: randomUUID(),
                idempotencyKey: scope,
                lane: "network",
                executionScope: scope,
                status: "running",
                attempts: 1,
                leaseId: randomUUID(),
                leaseUntil: new Date(recoveryAt.getTime() - 1),
                availableAt: new Date(0),
              },
            });
            const immediate = await worker().claim(
              "network",
              recoveryAt,
              scope,
            );
            assert.ok(
              immediate,
              "unconfigured jobs retain immediate lease recovery",
            );
            assert.equal(immediate.id, expiredDefault.id);
            assert.equal(immediate.attempts, 2);
            assert.notEqual(immediate.leaseId, expiredDefault.leaseId);
            assert.equal(immediate.status, "running");
            assert.equal(immediate.availableAt.getTime(), recoveryAt.getTime());
            assert.equal(fetcher.mock.callCount(), 0);
            throw rollback;
          },
          { timeout: 45_000 },
        ),
        (error: unknown) => error === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
