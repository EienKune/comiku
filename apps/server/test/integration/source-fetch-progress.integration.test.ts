import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type {
  JobStatus,
  SourceFetchRunStatus,
  SourceFetchTrigger,
} from "../../src/generated/prisma/client.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL required");

const now = new Date("2099-10-27T10:00:00.000Z");
type RunInput = {
  trigger?: SourceFetchTrigger;
  status?: SourceFetchRunStatus;
  startedAt?: Date;
  completedAt?: Date | null;
  job?: {
    status?: JobStatus;
    attempts?: number;
    leaseUntil?: Date | null;
    availableAt?: Date;
  } | null;
  items?: {
    pagesFetched: number;
    candidatesCreated: number;
    mediaStored: number;
  }[];
};

async function withFixture(
  exercise: (fixture: {
    service: SourceFetchService;
    createRun: (input?: RunInput) => Promise<string>;
    state: () => Promise<unknown>;
  }) => Promise<void>,
) {
  const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
  const db = new PrismaService(environment);
  const rollback = new Error("rollback source-progress fixture");
  await db.onModuleInit();
  try {
    await db.$transaction(
      async (tx) => {
        const prefix = `progress_${randomUUID().slice(0, 12)}`;
        const author = await tx.author.create({
          data: { displayName: prefix, authorizationStatus: "authorized" },
        });
        const account = await tx.authorExternalAccount.create({
          data: {
            authorId: author.id,
            platform: prefix,
            externalUserId: prefix,
            adapterStates: { create: { adapterKey: prefix } },
          },
          include: { adapterStates: true },
        });
        const runIds: string[] = [];
        const args = [
          null,
          tx,
          null,
          null,
          null,
          environment,
        ] as unknown as ConstructorParameters<typeof SourceFetchService>;
        const service = new SourceFetchService(...args);
        async function createRun(input: RunInput = {}) {
          const run = await tx.sourceFetchRun.create({
            data: {
              trigger: input.trigger ?? "manual",
              status: input.status ?? "running",
              startedAt:
                input.startedAt ??
                new Date(now.getTime() - 60_000 + runIds.length * 1000),
              completedAt: input.completedAt ?? null,
            },
          });
          runIds.push(run.id);
          if (input.job) {
            await tx.backgroundJob.create({
              data: {
                kind: "source_fetch",
                resourceId: run.id,
                idempotencyKey: `source:${run.id}`,
                lane: "network",
                status: input.job.status ?? "queued",
                attempts: input.job.attempts ?? 0,
                availableAt: input.job.availableAt ?? now,
                leaseUntil: input.job.leaseUntil ?? null,
                payload: { accountIds: [account.id], synthetic: "private" },
              },
            });
          }
          for (const [index, counters] of (input.items ?? []).entries()) {
            await tx.sourceFetchRunItem.create({
              data: {
                runId: run.id,
                externalAccountId: account.id,
                adapterStateId: account.adapterStates[0].id,
                adapterKey: `${prefix}_${index}`,
                cursorBefore: { synthetic: "private cursor" },
                errorCode: "private_error",
                errorMessage: "private upstream response",
                ...counters,
              },
            });
          }
          return run.id;
        }
        async function state() {
          return {
            runs: await tx.sourceFetchRun.findMany({
              where: { id: { in: runIds } },
              orderBy: { id: "asc" },
              include: { items: { orderBy: { id: "asc" } } },
            }),
            jobs: await tx.backgroundJob.findMany({
              where: { kind: "source_fetch", resourceId: { in: runIds } },
              orderBy: { id: "asc" },
            }),
            states: await tx.sourceAdapterState.findMany({
              where: { externalAccountId: account.id },
            }),
            counts: await Promise.all([
              tx.sourceFetchRun.count(),
              tx.backgroundJob.count(),
            ]),
          };
        }
        await exercise({ service, createRun, state });
        throw rollback;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await db.onModuleDestroy();
  }
}

test("progress aggregates only the selected shared runs and makes no persistent writes", async () => {
  await withFixture(async ({ service, createRun, state }) => {
    const manual = await createRun({
      status: "partial_failed",
      completedAt: new Date("2099-10-27T09:59:10Z"),
      items: [
        { pagesFetched: 2, candidatesCreated: 1, mediaStored: 3 },
        { pagesFetched: 4, candidatesCreated: 2, mediaStored: 5 },
      ],
    });
    const active = await createRun({
      trigger: "scheduled",
      job: {
        status: "running",
        attempts: 3,
        leaseUntil: new Date(now.getTime() + 1),
      },
      items: [{ pagesFetched: 7, candidatesCreated: 4, mediaStored: 9 }],
    });
    await createRun({
      trigger: "scheduled",
      status: "succeeded",
      completedAt: now,
      items: [{ pagesFetched: 500, candidatesCreated: 500, mediaStored: 500 }],
    });
    const before = await state();
    const result = await service.progress(now);
    assert.equal(result.active?.id, active);
    assert.equal(result.active?.status, "running");
    assert.equal(result.active?.pagesFetched, 7);
    assert.equal(result.active?.candidatesCreated, 4);
    assert.equal(result.active?.mediaStored, 9);
    assert.equal(result.lastManual?.id, manual);
    assert.equal(result.lastManual?.status, "partial_failed");
    assert.equal(result.lastManual?.pagesFetched, 6);
    assert.equal(result.lastManual?.candidatesCreated, 3);
    assert.equal(result.lastManual?.mediaStored, 8);
    assert.deepEqual(Object.keys(result.active!).sort(), [
      "candidatesCreated",
      "completedAt",
      "id",
      "mediaStored",
      "nextRetryAt",
      "pagesFetched",
      "startedAt",
      "status",
      "trigger",
    ]);
    assert.deepEqual(await state(), before);
  });
});

test("live running work outranks a newer queued batch, then queued retries remain discoverable", async () => {
  await withFixture(async ({ service, createRun }) => {
    const running = await createRun({
      trigger: "scheduled",
      job: {
        status: "running",
        attempts: 3,
        leaseUntil: new Date(now.getTime() + 1),
      },
    });
    const retryAt = new Date(now.getTime() + 5000);
    const retry = await createRun({
      job: { status: "queued", attempts: 1, availableAt: retryAt },
    });
    const first = await service.progress(now);
    assert.equal(first.active?.id, running);
    assert.equal(first.lastManual?.id, retry);
    assert.equal(first.lastManual?.status, "queued");
    assert.equal(first.lastManual?.nextRetryAt, "2099-10-27T10:00:05.000Z");
    const afterExpiry = await service.progress(new Date(now.getTime() + 1));
    assert.equal(afterExpiry.active?.id, retry);
    assert.equal(afterExpiry.active?.pagesFetched, 0);
    assert.equal(afterExpiry.active?.candidatesCreated, 0);
    assert.equal(afterExpiry.active?.mediaStored, 0);
  });
});

for (const input of [
  { job: null, want: "failed" },
  { job: { status: "failed", attempts: 1 }, want: "failed" },
  { job: { status: "succeeded", attempts: 1 }, want: "failed" },
  { job: { status: "queued", attempts: 3 }, want: "failed" },
  { job: { status: "running", attempts: 3, leaseUntil: now }, want: "failed" },
  { job: { status: "running", attempts: 3 }, want: "failed" },
  { job: { status: "running", attempts: 2, leaseUntil: now }, want: "queued" },
  { job: { status: "running", attempts: 2 }, want: "failed" },
] as const) {
  test(`progress filters ${input.job?.status}/${input.job?.attempts}/${input.job?.leaseUntil?.toISOString()} recovery eligibility`, async () => {
    await withFixture(async ({ service, createRun, state }) => {
      const id = await createRun(input);
      const before = await state();
      const result = await service.progress(now);
      assert.equal(result.lastManual?.id, id);
      assert.equal(result.lastManual?.status, input.want);
      assert.equal(result.lastManual?.nextRetryAt, null);
      if (input.want === "queued") assert.equal(result.active?.id, id);
      else assert.notEqual(result.active?.id, id);
      assert.deepEqual(await state(), before);
    });
  });
}

test("terminal manual results keep their outcome even if the old job still has a lease", async () => {
  await withFixture(async ({ service, createRun }) => {
    for (const status of ["succeeded", "partial_failed", "failed"] as const) {
      const id = await createRun({
        status,
        completedAt: now,
        job: {
          status: "running",
          attempts: 1,
          leaseUntil: new Date(now.getTime() + 60_000),
        },
      });
      const result = await service.progress(now);
      assert.equal(result.lastManual?.id, id);
      assert.equal(result.lastManual?.status, status);
      assert.equal(result.lastManual?.completedAt, "2099-10-27T10:00:00.000Z");
      assert.equal(result.lastManual?.nextRetryAt, null);
      assert.notEqual(result.active?.id, id);
    }
  });
});
