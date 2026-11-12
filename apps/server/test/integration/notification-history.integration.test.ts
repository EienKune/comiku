import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import { NotificationStatusService } from "../../src/notifications/notification-status.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import type { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import {
  buildNotificationHistoryQuery,
  normalizeNotificationHistoryQuery,
  parseNotificationHistoryCursor,
} from "../../src/notifications/notification-history-query.js";

const url = process.env.TEST_DATABASE_URL;
if (
  url &&
  (!new URL(url).pathname.endsWith("_test") || process.env.DATABASE_URL !== url)
)
  throw new Error(
    "Matching DATABASE_URL and TEST_DATABASE_URL for an isolated _test database required",
  );

type PlanNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};
function workUnits(node: PlanNode): number {
  return (
    ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
      (node["Actual Loops"] ?? 1) +
    (node.Plans ?? []).reduce((total, child) => total + workUnits(child), 0)
  );
}

test(
  "notification history PostgreSQL: frozen groups, archived work, rare events, deep cursors and bounded unresolved metrics",
  { skip: !url, timeout: 120_000 },
  async (t) => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const prefix = `history_${randomUUID()}`;
    const groupId = String(
      BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)),
    );
    const date = new Date("2026-10-01T00:00:00.000Z");
    const author = await db.author.create({ data: { displayName: prefix } });
    const user = await db.user.create({
      data: {
        username: prefix,
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
        postedAt: date,
        rawJson: {},
      },
    });
    const work = await db.work.create({
      data: {
        authorId: author.id,
        importedById: user.id,
        sourceCandidatePostId: candidate.id,
        workflowStatus: "archived",
      },
    });
    const channel = await db.notificationChannel.create({
      data: {
        name: prefix,
        connectionKey: "fixture",
        connectionFingerprint: "a".repeat(64),
        groupId,
        eventTypes: ["imported"],
        enabled: false,
      },
    });
    const registry = new NotificationConnectionRegistry({
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
    const service = new NotificationsService(
      monitored,
      {} as NotificationPublisherService,
      registry,
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    const status = new NotificationStatusService(monitored, registry);
    const jobIds: string[] = [];
    let deepestGroupCursor: string | null = null;
    try {
      await db.$executeRaw(Prisma.sql`INSERT INTO notification_events
        (id,event_key,payload_hash,type,resource_id,aggregate_version,ordinal,occurred_at,snapshot,route_refs,created_at)
        SELECT gen_random_uuid(), ${prefix} || ':' || g::text, repeat('a',64),
          CASE WHEN g <= 3 THEN 'archived' ELSE 'imported' END,
          CASE WHEN g <= 3 THEN ${work.id}::uuid ELSE gen_random_uuid() END,
          1, 0, ${date}::timestamptz, jsonb_build_object('workNumber', ${work.workNumber}::int), '[]'::jsonb,
          ${date}::timestamptz FROM generate_series(1,40000) g`);
      await db.$executeRaw(Prisma.sql`INSERT INTO notification_deliveries
        (id,event_id,channel_id,audience_generation,connection_key,connection_fingerprint,group_id,channel_revision,text,status,resolved_at,created_at,updated_at)
        SELECT gen_random_uuid(), e.id, ${channel.id}::uuid, 1, 'fixture', repeat('a',64),
          CASE WHEN split_part(e.event_key,':',2)::int <= 300 THEN ${groupId} ELSE ${groupId + "1"} END,
          0, 'Frozen original synthetic body',
          CASE WHEN split_part(e.event_key,':',2)::int <= 22000 THEN
            CASE WHEN split_part(e.event_key,':',2)::int % 2 = 0 THEN 'failed' ELSE 'unknown' END
            ELSE 'pending' END,
          CASE WHEN split_part(e.event_key,':',2)::int <= 22000 THEN ${date}::timestamptz ELSE NULL END,
          ${date}::timestamptz, ${date}::timestamptz
        FROM notification_events e WHERE e.event_key LIKE ${prefix + ":%"}`);
      await db.notificationChannel.update({
        where: { id: channel.id },
        data: { groupId: groupId + "2", revision: 1, audienceGeneration: 2 },
      });
      const openRows = await db.notificationDelivery.findMany({
        where: { channelId: channel.id, event: { type: "imported" } },
        orderBy: { id: "asc" },
        take: 2,
      });
      for (const [index, row] of openRows.entries()) {
        await db.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: index ? "unknown" : "failed",
            resolvedAt: null,
            createdAt: new Date(date.getTime() + 86_400_000),
          },
        });
      }
      await db.$executeRaw`ANALYZE notification_deliveries`;
      await db.$executeRaw`ANALYZE notification_events`;

      await t.test(
        "work lookup includes archived works and original immutable target survives channel edits",
        async () => {
          const query = {
            workNumber: work.workNumber,
            eventType: "archived",
            groupId,
            createdFrom: date.toISOString(),
            createdBefore: "2026-10-02T00:00:00Z",
            limit: 2,
          };
          const first = await service.listDeliveries(query);
          assert.equal(first.items.length, 2);
          assert.ok(first.nextCursor);
          const second = await service.listDeliveries({
            ...query,
            cursor: first.nextCursor,
          });
          assert.equal(second.items.length, 1);
          assert.equal(second.nextCursor, null);
          for (const item of [...first.items, ...second.items]) {
            assert.equal(item.groupId, groupId);
            assert.equal(item.preview, "Frozen original synthetic body");
            assert.equal(item.workNumber, work.workNumber);
          }
          assert.deepEqual(
            await service.listDeliveries({ ...query, groupId: groupId + "2" }),
            { items: [], nextCursor: null },
          );
          assert.deepEqual(
            await service.listDeliveries({ workNumber: 2147483647 }),
            { items: [], nextCursor: null },
          );
          await assert.rejects(
            service.listDeliveries({
              workNumber: 2147483647,
              cursor: first.nextCursor,
            }),
            { status: 400 },
          );
          assert.deepEqual(
            await service.listDeliveries({
              ...query,
              createdFrom: undefined,
              createdBefore: date.toISOString(),
            }),
            { items: [], nextCursor: null },
          );
        },
      );
      await t.test(
        "deep same-millisecond pages stay stable without offsets",
        async () => {
          const seen = new Set<string>();
          let cursor: string | undefined;
          do {
            if (cursor) deepestGroupCursor = cursor;
            const page = await service.listDeliveries({
              groupId,
              limit: 20,
              cursor,
            });
            for (const item of page.items) {
              assert.ok(!seen.has(item.id));
              seen.add(item.id);
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.equal(seen.size, 300);
        },
      );
      await t.test(
        "queued job eligibility projects later retry time without leaking payload/errors",
        async () => {
          const row = openRows[0]!;
          const job = await db.backgroundJob.create({
            data: {
              kind: "notification_deliver",
              resourceId: row.id,
              idempotencyKey: prefix,
              lane: "network",
              executionScope: "notifications",
              availableAt: date,
              payload: { secret: "PRIVATE_CANARY" },
              lastError: "PRIVATE_CANARY",
            },
          });
          jobIds.push(job.id);
          const next = new Date(date.getTime() + 5000);
          await db.notificationDelivery.update({
            where: { id: row.id },
            data: { jobId: job.id, status: "retry_wait", nextAttemptAt: next },
          });
          const listed = await service.listDeliveries({
            status: "retry_wait",
            limit: 50,
          });
          assert.equal(
            listed.items.find((item) => item.id === row.id)?.nextEligibleAt,
            next.toISOString(),
          );
          assert.doesNotMatch(
            JSON.stringify(listed),
            /PRIVATE_CANARY|lastError|payload/,
          );
          await db.backgroundJob.update({
            where: { id: job.id },
            data: { status: "failed" },
          });
          assert.equal(
            (
              await service.listDeliveries({ status: "retry_wait", limit: 50 })
            ).items.find((item) => item.id === row.id)?.nextEligibleAt,
            null,
          );
        },
      );
      await t.test(
        "actual plans bound old resolved failures, rare events, work and deep group pages",
        async () => {
          observed.length = 0;
          const result = await status.status();
          assert.equal(result.deliveries.pending.count, 1000);
          assert.equal(result.deliveries.pending.capped, true);
          assert.equal(result.deliveries.failedUnresolved.count, 0);
          assert.equal(result.deliveries.unknownUnresolved.count, 1);
          const deliveryMetrics = observed.filter((query) =>
            query.text.includes("FROM notification_deliveries"),
          );
          const filters = normalizeNotificationHistoryQuery({
            groupId,
            limit: 20,
          });
          assert.ok(
            deepestGroupCursor,
            "full pagination must establish a deep cursor",
          );
          const cursor = parseNotificationHistoryCursor(
            deepestGroupCursor,
            filters,
          );
          const plans = [
            ...deliveryMetrics.map((query, index) => ({
              name: `metric-${index}`,
              query,
            })),
            {
              name: "original-group",
              query: buildNotificationHistoryQuery(filters, null, null),
            },
            {
              name: "deep-group",
              query: buildNotificationHistoryQuery(filters, cursor, null),
            },
            {
              name: "rare-event",
              query: buildNotificationHistoryQuery(
                normalizeNotificationHistoryQuery({
                  eventType: "archived",
                  limit: 20,
                }),
                null,
                null,
              ),
            },
            {
              name: "archived-work",
              query: buildNotificationHistoryQuery(
                normalizeNotificationHistoryQuery({
                  workNumber: work.workNumber,
                  limit: 20,
                }),
                null,
                work.id,
              ),
            },
          ];
          const unbounded: string[] = [];
          for (const { name, query } of plans) {
            const explained = await db.$queryRaw<
              { "QUERY PLAN": { Plan: PlanNode }[] }[]
            >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
            const plan = explained[0]!["QUERY PLAN"][0]!.Plan;
            t.diagnostic(
              JSON.stringify({ name, workUnits: workUnits(plan), plan }),
            );
            const bound =
              name === "metric-3" ||
              name === "metric-4" ||
              name === "rare-event" ||
              name === "original-group" ||
              name === "deep-group"
                ? 100
                : 2200;
            if (workUnits(plan) >= bound)
              unbounded.push(`${name}: ${workUnits(plan)}`);
          }
          assert.deepEqual(
            unbounded,
            [],
            "queries must sample the 40,000-row history without sorting the full 18,000-item backlog",
          );
        },
      );
    } finally {
      await db.notificationAttempt.deleteMany({
        where: { delivery: { channelId: channel.id } },
      });
      await db.notificationDelivery.deleteMany({
        where: { channelId: channel.id },
      });
      await db.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
      await db.notificationEvent.deleteMany({
        where: { eventKey: { startsWith: prefix + ":" } },
      });
      await db.notificationChannel.delete({ where: { id: channel.id } });
      await db.work.delete({ where: { id: work.id } });
      await db.candidatePost.delete({ where: { id: candidate.id } });
      await db.authorExternalAccount.delete({ where: { id: account.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
