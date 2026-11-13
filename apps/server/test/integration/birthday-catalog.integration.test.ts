import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  BaBirthdayDataAdapter,
  BIRTHDAY_SYNC_KIND,
} from "../../src/birthdays/adapters/ba/ba-birthday-data.adapter.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { JobsService } from "../../src/jobs/jobs.service.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Nested service transactions share the fixture's rollback-only transaction. This suite
// proves persistence and real lease predicates, not cross-connection lock scheduling.
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
  "birthday catalog persistence preserves old snapshots, quarantines identity changes and fences stale leases",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error("rollback birthday catalog synthetic fixtures");
    let failSource = false;
    let calls = 0;
    const firstId = 1_900_000_000;
    const token = randomUUID();
    t.mock.method(console, "error", () => {});
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0]) => {
        calls++;
        if (failSource) throw new Error("synthetic source unavailable");
        const path = new URL(String(input)).pathname;
        if (path === "/data/config.min.json")
          return Response.json({ Regions: [{ Name: "Jp" }] });
        if (path === "/data/jp/students.min.json")
          return Response.json(
            Object.fromEntries(
              [firstId, firstId + 1].map((id) => [
                id,
                {
                  Id: id,
                  Name: id === firstId ? "合成学生甲" : "合成学生乙",
                  FamilyName: "合成",
                  PersonalName: "学生",
                  IsReleased: [true],
                  FavorAlts: [firstId],
                  BirthDay: id === firstId ? "11/11" : "11/12",
                },
              ]),
            ),
          );
        if (path === "/data/cn/students.min.json")
          return Response.json(
            Object.fromEntries(
              [firstId, firstId + 1].map((id) => [
                id,
                {
                  Id: id,
                  Name: "合成学生",
                  FamilyName: "合成",
                  PersonalName: "学生",
                },
              ]),
            ),
          );
        throw new Error("unexpected synthetic source URL");
      },
    );
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            // Global identity isolation is rolled back, including any pre-existing test rows.
            await tx.birthdayIdentity.deleteMany();
            await tx.birthdaySettings.upsert({
              where: { id: "global" },
              create: { id: "global" },
              update: { displayEnabled: true, remindersEnabled: false },
            });
            const old = await tx.birthdayCatalog.create({
              data: {
                contentHash: hash(token),
                sourceCounts: { jp: 1, cn: 1 },
                people: [
                  {
                    key: `schaledb:${firstId}`,
                    name: "旧合成名",
                    aliases: [token],
                    month: 11,
                    day: 11,
                    originalEntryId: null,
                    entryIds: [firstId],
                    notificationEligible: true,
                  },
                ],
              },
            });
            const job = await tx.backgroundJob.create({
              data: {
                kind: BIRTHDAY_SYNC_KIND,
                resourceId: randomUUID(),
                idempotencyKey: `birthday-fixture:${token}`,
                lane: "network",
                executionScope: "birthdays",
                status: "running",
                leaseId: randomUUID(),
                leaseUntil: new Date(Date.now() + 120_000),
              },
            });
            await tx.birthdayIdentity.create({
              data: {
                entryId: firstId,
                personKey: `schaledb:${firstId}`,
                status: "confirmed",
              },
            });
            await tx.birthdayIdentity.create({
              data: {
                entryId: firstId + 2,
                personKey: `schaledb:${firstId + 2}`,
                status: "unlocalized",
              },
            });
            const initialTime = new Date(Date.now() - 86_400_000);
            await tx.birthdaySyncState.upsert({
              where: { id: "schaledb" },
              create: {
                id: "schaledb",
                catalogId: old.id,
                jobId: job.id,
                lastCheckedAt: initialTime,
                sourceCounts: { jp: 1, cn: 1 },
              },
              update: {
                catalogId: old.id,
                jobId: job.id,
                lastCheckedAt: initialTime,
                sourceCounts: { jp: 1, cn: 1 },
                lastErrorCode: null,
              },
            });
            const facade = transactionFacade(tx);
            const service = new BaBirthdayDataAdapter(
              facade,
              new JobsService(facade),
              environment,
            );
            await service.synchronize(job, new AbortController().signal);
            const accepted = await tx.birthdaySyncState.findUniqueOrThrow({
              where: { id: "schaledb" },
              include: { catalog: true },
            });
            assert.notEqual(accepted.catalogId, old.id);
            assert.equal(accepted.lastErrorCode, null);
            assert.ok(accepted.lastCheckedAt! > initialTime);
            assert.deepEqual(
              (
                await tx.birthdayCatalog.findUniqueOrThrow({
                  where: { id: old.id },
                })
              ).people,
              old.people,
            );
            assert.equal(
              (
                await tx.birthdayIdentity.findUniqueOrThrow({
                  where: { entryId: firstId + 1 },
                })
              ).status,
              "pending",
            );
            assert.equal(
              (
                await tx.birthdayIdentity.findUniqueOrThrow({
                  where: { entryId: firstId + 2 },
                })
              ).status,
              "unlocalized",
            );
            assert.equal(
              (
                await tx.birthdayIdentity.findUniqueOrThrow({
                  where: { entryId: firstId },
                })
              ).personKey,
              `schaledb:${firstId}`,
            );
            await service.synchronize(job, new AbortController().signal);
            assert.equal(
              (
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "schaledb" },
                })
              ).catalogId,
              accepted.catalogId,
            );
            const lastSuccessfulCheck =
              await tx.birthdaySyncState.findUniqueOrThrow({
                where: { id: "schaledb" },
              });
            failSource = true;
            await assert.rejects(
              service.synchronize(job, new AbortController().signal),
              /birthday_source_failed/,
            );
            const failed = await tx.birthdaySyncState.findUniqueOrThrow({
              where: { id: "schaledb" },
            });
            assert.equal(failed.catalogId, accepted.catalogId);
            assert.deepEqual(
              failed.lastCheckedAt,
              lastSuccessfulCheck.lastCheckedAt,
            );
            assert.equal(failed.lastErrorCode, "birthday_source_failed");
            const beforeLostLease = calls;
            await tx.backgroundJob.update({
              where: { id: job.id },
              data: { leaseId: randomUUID() },
            });
            await assert.rejects(
              service.synchronize(job, new AbortController().signal),
              /租约/,
            );
            assert.equal(calls, beforeLostLease);
            assert.equal(
              (
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "schaledb" },
                })
              ).catalogId,
              accepted.catalogId,
            );
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
  "catalog cleanup keeps source and reminder references and deletes at most twenty old unused versions",
  { skip: !url, timeout: 60_000 },
  async () => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error(
      "rollback birthday catalog cleanup synthetic fixtures",
    );
    const token = randomUUID();
    const now = new Date("2050-01-01T00:00:00Z");
    const ancient = new Date("0001-01-01T00:00:00Z");
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            const make = (suffix: string, createdAt = ancient) =>
              tx.birthdayCatalog.create({
                data: {
                  contentHash: hash(`${token}:${suffix}`),
                  people: [],
                  sourceCounts: { jp: 1, cn: 1 },
                  createdAt,
                },
              });
            const source = await make("source");
            const reminder = await make("reminder");
            const recent = await make("recent", now);
            await tx.birthdaySyncState.upsert({
              where: { id: "schaledb" },
              create: { id: "schaledb", catalogId: source.id },
              update: { catalogId: source.id },
            });
            await tx.birthdayReminderOccurrence.create({
              data: {
                namespace: token.slice(0, 32),
                sendLocalDate: "2050-01-01",
                targetLocalDate: "2050-01-01",
                offsetDays: 0,
                dueAt: now,
                validBefore: new Date(now.getTime() + 86_400_000),
                catalogId: reminder.id,
                snapshot: {},
                globalGeneration: 1,
                offsetGeneration: 1,
              },
            });
            const unused = [];
            for (let i = 0; i < 25; i++) unused.push(await make(`unused:${i}`));
            const facade = transactionFacade(tx);
            const service = new BaBirthdayDataAdapter(
              facade,
              new JobsService(facade),
              environment,
            );
            await service.cleanupCatalogs(now);
            const remaining = await tx.birthdayCatalog.count({
              where: { id: { in: unused.map((row) => row.id) } },
            });
            assert.equal(remaining, 5);
            assert.equal(
              await tx.birthdayCatalog.count({
                where: { id: { in: [source.id, reminder.id, recent.id] } },
              }),
              3,
            );
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
