import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { createApplication } from "../../src/application.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationStatusService } from "../../src/notifications/notification-status.service.js";
import { hashPassword } from "../../src/users/password.js";
import {
  NOTIFICATION_WORK_EVENT_ACTIVATION_ID,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID,
} from "../../src/notifications/notification-work-event-source.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");
const activationIds = [
  NOTIFICATION_WORK_EVENT_ACTIVATION_ID,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID,
];
type SavedActivation = {
  id: string;
  source_since: Date;
  last_maintenance_at: Date | null;
  last_capture_at: Date | null;
  last_registration_at: Date | null;
  last_error_at: Date | null;
  last_error_code: string | null;
};

test(
  "notification status PostgreSQL: bounded ledger/source reads, observation evidence and stable private receipt pages",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const enabled = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true" },
    });
    const disabled = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "false" },
    });
    const observed: Prisma.Sql[] = [];
    const monitored = new Proxy(db, {
      get(target, property) {
        if (property === "$queryRaw")
          return (query: Prisma.Sql) => {
            observed.push(query);
            return target.$queryRaw(query);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new NotificationStatusService(monitored, enabled);
    const resources: string[] = [randomUUID(), randomUUID()];
    const author = await db.author.create({
      data: { displayName: `notification_status_${randomUUID()}` },
    });
    const user = await db.user.create({
      data: {
        username: `notification_status_${randomUUID()}`,
        displayName: "Synthetic",
        passwordHash: "synthetic",
        mustChangePassword: false,
      },
    });
    const account = await db.authorExternalAccount.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalUserId: randomUUID(),
      },
    });
    const candidate = await db.candidatePost.create({
      data: {
        authorId: author.id,
        authorExternalAccountId: account.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const work = await db.work.create({
      data: {
        authorId: author.id,
        importedById: user.id,
        sourceCandidatePostId: candidate.id,
      },
    });
    const saved = await db.$queryRaw<SavedActivation[]>(
      Prisma.sql`SELECT * FROM notification_work_event_activation WHERE id IN (${Prisma.join(activationIds)})`,
    );
    const now = new Date();
    const baseSince = new Date(now.getTime() - 100_000);
    const expandedSince = new Date(now.getTime() - 10_000);
    const sourceDate = new Date(now.getTime() - 20_000);
    const receiptDate = new Date(now.getTime() - 30_000);
    const pendingIds = Array.from({ length: 1001 }, () => randomUUID());
    async function createReceipts(
      ids: string[],
      status: string,
      resourceId = resources[0]!,
    ) {
      await db.notificationWorkEventReceipt.createMany({
        data: ids.map((id, index) => ({
          id,
          sourceEventId: randomUUID(),
          resourceId,
          resourceOrdinal: index + 1,
          safeInput: {
            type: "imported",
            workNumber: 777,
            title: "PRIVATE_TITLE_CANARY",
            detail: { token: "PRIVATE_DETAIL_CANARY" },
          },
          routeRefs: [
            {
              groupId: "PRIVATE_GROUP_CANARY",
              token: "PRIVATE_TOKEN_CANARY",
              text: "PRIVATE_BODY_CANARY",
            },
          ],
          status,
          errorCode: "registration_temporarily_unavailable",
          attempts: 3,
          createdAt: receiptDate,
          updatedAt: receiptDate,
        })),
      });
    }
    try {
      await db.notificationWorkEventActivation.deleteMany({
        where: { id: { in: activationIds } },
      });
      await t.test(
        "uninitialized and disabled reads never scan the source table",
        async () => {
          observed.length = 0;
          const uninitialized = await service.status();
          assert.equal(uninitialized.state, "not_started");
          assert.equal(uninitialized.counts.uncaptured, null);
          assert.ok(
            observed.every((query) => !query.text.includes("FROM work_events")),
          );
          await db.notificationWorkEventActivation.create({
            data: { id: activationIds[0]!, sourceSince: baseSince },
          });
          observed.length = 0;
          const off = await new NotificationStatusService(
            monitored,
            disabled,
          ).status();
          assert.equal(off.state, "disabled");
          assert.equal(off.counts.uncaptured, null);
          assert.ok(
            observed.every((query) => !query.text.includes("FROM work_events")),
          );
        },
      );
      await db.notificationWorkEventActivation.create({
        data: { id: activationIds[1]!, sourceSince: expandedSince },
      });
      await t.test(
        "maintenance failures before any success are visible, successful empty passes do not invent capture evidence",
        async () => {
          await service.recordMaintenance({
            success: false,
            captured: 0,
            registered: 0,
          });
          const failed = await service.status();
          assert.equal(failed.state, "error");
          assert.equal(failed.lastErrorCode, "maintenance_failed");
          assert.equal(failed.lastMaintenanceAt, null);
          await service.recordMaintenance({
            success: true,
            captured: 0,
            registered: 0,
          });
          const empty = await service.status();
          assert.equal(empty.state, "healthy");
          assert.equal(empty.lastCaptureAt, null);
          assert.equal(empty.lastRegistrationAt, null);
          await service.recordMaintenance({
            success: true,
            captured: 1,
            registered: 1,
          });
          const captured = await service.status();
          assert.ok(captured.lastCaptureAt);
          assert.ok(captured.lastRegistrationAt);
          assert.equal(captured.sourceSince, baseSince.toISOString());
          assert.equal(
            captured.expandedSourceSince,
            expandedSince.toISOString(),
          );
          await db.$executeRaw`UPDATE notification_work_event_activation SET last_maintenance_at = ${new Date(Date.now() - 61_000)}, last_error_at = NULL WHERE id = ${activationIds[0]}`;
          assert.equal((await service.status()).state, "stale");
        },
      );
      await createReceipts(pendingIds.slice(0, 1000), "pending");
      await t.test(
        "1000 is exact and an extra row marks the statistic as capped",
        async () => {
          assert.deepEqual((await service.status()).counts.pending, {
            count: 1000,
            capped: false,
            oldestAt: receiptDate.toISOString(),
          });
          await db.notificationWorkEventReceipt.create({
            data: {
              id: pendingIds[1000]!,
              sourceEventId: randomUUID(),
              resourceId: resources[0]!,
              resourceOrdinal: 1001,
              safeInput: {},
              routeRefs: [],
              status: "pending",
              createdAt: receiptDate,
              updatedAt: receiptDate,
            },
          });
          assert.deepEqual((await service.status()).counts.pending, {
            count: 1000,
            capped: true,
            oldestAt: receiptDate.toISOString(),
          });
        },
      );
      await t.test(
        "same-millisecond pages include each row once with status-bound cursors and safe catalog fields",
        async () => {
          const ids: string[] = [];
          let cursor: string | undefined;
          let firstCursor: string | null = null;
          do {
            const page = await service.receipts({
              status: "pending",
              limit: 50,
              cursor,
            });
            assert.ok(page.items.length <= 50);
            assert.doesNotMatch(
              JSON.stringify(page),
              /PRIVATE_|safeInput|routeRefs|payloadHash/,
            );
            if (!firstCursor) firstCursor = page.nextCursor;
            ids.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(ids, [...pendingIds].sort().reverse());
          await assert.rejects(
            service.receipts({ status: "invalid", cursor: firstCursor! }),
            { status: 400 },
          );
          await assert.rejects(service.receipts({ cursor: "invalid" }), {
            status: 400,
          });
          await createReceipts([randomUUID()], "invalid", resources[1]);
          await db.notificationWorkEventReceipt.updateMany({
            where: { resourceId: resources[1] },
            data: {
              safeInput: {
                type: "PRIVATE_EVENT_CANARY",
                workNumber: "PRIVATE_NUMBER_CANARY",
              },
              errorCode: "PRIVATE_DRIVER_CANARY",
            },
          });
          const invalid = await service.receipts({ status: "invalid" });
          assert.equal(invalid.items[0]?.eventType, null);
          assert.equal(invalid.items[0]?.eventLabel, null);
          assert.equal(invalid.items[0]?.workNumber, null);
          assert.equal(invalid.items[0]?.errorCode, null);
          assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_/);
        },
      );
      await t.test(
        "HTTP rechecks database administrator permission and keeps receipt payloads private",
        async () => {
          const environment = parseEnvironment({
            NODE_ENV: "test",
            DATABASE_URL: url,
            NOTIFICATIONS_ENABLED: "false",
          });
          await db.user.update({
            where: { id: user.id },
            data: {
              passwordHash: await hashPassword("synthetic-password-12345"),
              roles: { create: { role: "admin" } },
            },
          });
          const app = await createApplication(environment);
          try {
            await app.listen(0, "127.0.0.1");
            const base = await app.getUrl();
            const unauthenticated = await fetch(
              `${base}/api/notifications/status`,
            );
            assert.equal(unauthenticated.status, 401);
            await unauthenticated.body?.cancel();
            const login = await fetch(`${base}/api/auth/login`, {
              method: "POST",
              headers: {
                Origin: environment.appOrigin,
                "X-Comiku-Request": "1",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                username: user.username,
                password: "synthetic-password-12345",
              }),
            });
            assert.equal(login.status, 200);
            const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
            await login.body?.cancel();
            for (const path of ["status", "receipts?status=pending&limit=1"]) {
              const response = await fetch(
                `${base}/api/notifications/${path}`,
                { headers: { cookie } },
              );
              assert.equal(response.status, 200);
              assert.doesNotMatch(
                await response.text(),
                /PRIVATE_|safeInput|routeRefs|payloadHash/,
              );
            }
            await db.userRole.deleteMany({ where: { userId: user.id } });
            for (const path of ["status", "receipts"]) {
              const response = await fetch(
                `${base}/api/notifications/${path}`,
                { headers: { cookie } },
              );
              assert.equal(response.status, 403);
              await response.body?.cancel();
            }
          } finally {
            await app.close();
          }
        },
      );
      await t.test(
        "source and receipt status reads stay bounded despite unrelated history and pre-expansion backlog",
        async () => {
          await db.workEvent.createMany({
            data: Array.from({ length: 10_000 }, () => ({
              workId: work.id,
              action: "metadata_updated" as const,
              createdAt: sourceDate,
            })),
          });
          await db.workEvent.createMany({
            data: Array.from({ length: 1001 }, () => ({
              workId: work.id,
              action: "imported" as const,
              createdAt: sourceDate,
            })),
          });
          await db.workEvent.create({
            data: {
              workId: work.id,
              action: "metadata_updated",
              createdAt: now,
            },
          });
          const unrelated = randomUUID();
          resources.push(unrelated);
          await createReceipts(
            Array.from({ length: 6000 }, () => randomUUID()),
            "recorded",
            unrelated,
          );
          await db.$executeRaw`ANALYZE work_events`;
          await db.$executeRaw`ANALYZE notification_work_event_receipts`;
          observed.length = 0;
          const result = await service.status();
          assert.deepEqual(result.counts.uncaptured, {
            count: 1000,
            capped: true,
            oldestAt: sourceDate.toISOString(),
          });
          const sourceQueries = observed.filter((query) =>
            query.text.includes("FROM work_events"),
          );
          assert.equal(sourceQueries.length, 2);
          type PlanNode = {
            "Actual Rows"?: number;
            "Actual Loops"?: number;
            "Rows Removed by Filter"?: number;
            Plans?: PlanNode[];
          };
          function workUnits(node: PlanNode): number {
            return (
              ((node["Actual Rows"] ?? 0) +
                (node["Rows Removed by Filter"] ?? 0)) *
                (node["Actual Loops"] ?? 1) +
              (node.Plans ?? []).reduce(
                (sum, child) => sum + workUnits(child),
                0,
              )
            );
          }
          const queries = observed.filter(
            (query) =>
              !query.text.includes("notification_work_event_activation"),
          );
          for (const query of queries) {
            const explained = await db.$queryRaw<
              { "QUERY PLAN": { Plan: PlanNode }[] }[]
            >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
            const units = workUnits(explained[0]!["QUERY PLAN"][0]!.Plan);
            assert.ok(
              units < 5000,
              `bounded status query examined ${units} row/filter units`,
            );
          }
        },
      );
    } finally {
      await db.notificationWorkEventReceipt.deleteMany({
        where: { resourceId: { in: resources } },
      });
      await db.workEvent.deleteMany({ where: { workId: work.id } });
      await db.work.delete({ where: { id: work.id } });
      await db.candidatePost.delete({ where: { id: candidate.id } });
      await db.authorExternalAccount.delete({ where: { id: account.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.userRole.deleteMany({ where: { userId: user.id } });
      await db.authSession.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.notificationWorkEventActivation.deleteMany({
        where: { id: { in: activationIds } },
      });
      for (const row of saved)
        await db.$executeRaw`INSERT INTO notification_work_event_activation (id, source_since, last_maintenance_at, last_capture_at, last_registration_at, last_error_at, last_error_code) VALUES (${row.id}, ${row.source_since}, ${row.last_maintenance_at}, ${row.last_capture_at}, ${row.last_registration_at}, ${row.last_error_at}, ${row.last_error_code})`;
      await db.$disconnect();
    }
  },
);
