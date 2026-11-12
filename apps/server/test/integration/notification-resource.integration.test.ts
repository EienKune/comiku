import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  notificationResourceKind,
  notificationResourceWhere,
} from "../../src/notifications/notification-resource.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "persisted event types isolate routed and unrouted work, tests, digests and handoffs without rewriting legacy snapshots",
  { skip: !url },
  async () => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const resourceId = randomUUID();
    const prefix = `notification-resource:${resourceId}:`;
    const channel = await db.notificationChannel.create({
      data: {
        name: "Synthetic namespace fixture",
        connectionKey: "fixture",
        connectionFingerprint: "a".repeat(64),
        groupId: resourceId,
        eventTypes: [],
      },
    });
    const types = [
      "imported",
      "notification.test",
      "work.digest",
      "work.ready",
      "birthday.reminder",
      "future.unknown",
    ];
    const legacySnapshot = {
      workNumber: 42,
      title: "Synthetic unchanged snapshot",
    };
    try {
      for (const type of types) {
        const event = await db.notificationEvent.create({
          data: {
            eventKey: prefix + type,
            payloadHash: "a".repeat(64),
            type,
            resourceId,
            aggregateVersion: 1,
            occurredAt: new Date(),
            snapshot: legacySnapshot,
            routeRefs: [],
          },
        });
        await db.notificationDelivery.create({
          data: {
            eventId: event.id,
            channelId: channel.id,
            audienceGeneration: 1,
            connectionKey: channel.connectionKey,
            connectionFingerprint: channel.connectionFingerprint,
            groupId: channel.groupId,
            channelRevision: 0,
            text: "Synthetic frozen body",
            status: "unknown",
          },
        });
      }
      for (const type of types) {
        const namespace = notificationResourceWhere({ type, resourceId });
        const expected =
          type === "imported" || type === "future.unknown"
            ? ["future.unknown", "imported"]
            : [type];
        const blockers = await db.notificationDelivery.findMany({
          where: {
            channelId: channel.id,
            status: "unknown",
            resolvedAt: null,
            event: namespace,
          },
          include: { event: true },
        });
        const unrouted = await db.notificationEvent.findMany({
          where: { ...namespace, routedAt: null },
        });
        assert.deepEqual(
          blockers.map((row) => row.event.type).sort(),
          expected,
        );
        assert.deepEqual(unrouted.map((row) => row.type).sort(), expected);
        for (const event of unrouted) {
          assert.deepEqual(event.snapshot, legacySnapshot);
          assert.equal(event.payloadHash, "a".repeat(64));
        }
      }
      assert.equal(
        notificationResourceKind({ type: "future.unknown" }),
        "work",
      );
    } finally {
      await db.notificationDelivery.deleteMany({
        where: { channelId: channel.id },
      });
      await db.notificationEvent.deleteMany({
        where: { eventKey: { startsWith: prefix } },
      });
      await db.notificationChannel.delete({ where: { id: channel.id } });
      await db.$disconnect();
    }
  },
);

const reminderNamespaceMigration = new URL(
  "../../prisma/migrations/20261112000400_notification_reminder_namespaces/migration.sql",
  import.meta.url,
);
async function namespaceMigrationStatements() {
  const sql = await readFile(reminderNamespaceMigration, "utf8");
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.length, 3);
  return statements.slice(1, -1);
}
test("reminder namespace forward backfill remains explicitly atomic", async () => {
  await namespaceMigrationStatements();
});
test(
  "namespace backfill changes only defaulted digest and handoff namespaces while preserving every historical event field",
  { skip: !url },
  async () => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const schema = `reminder_namespace_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback isolated namespace migration");
    const statements = await namespaceMigrationStatements();
    try {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
          await tx.$executeRawUnsafe(
            "CREATE TABLE notification_events (LIKE public.notification_events INCLUDING ALL)",
          );
          const cases = [
            ["work.digest", "work", "work_digest"],
            ["work.ready", "work", "work_ready"],
            ["work.digest", "work_digest", "work_digest"],
            ["work.ready", "work_ready", "work_ready"],
            ["imported", "work", "work"],
            ["notification.test", "notification_test", "notification_test"],
            ["birthday.reminder", "birthday_digest", "birthday_digest"],
            ["future.unknown", "work", "work"],
          ];
          const expected = new Map<string, string>();
          for (const [type, storedKind, finalKind] of cases) {
            const id = randomUUID();
            expected.set(id, finalKind!);
            const snapshot = JSON.stringify({
              version: 3,
              frozen: "Synthetic immutable body",
              kind: type,
            });
            const routes = JSON.stringify([
              {
                id: randomUUID(),
                generation: 7,
                content: { text: "Synthetic frozen route" },
              },
            ]);
            await tx.$executeRaw`INSERT INTO notification_events
          (id, event_key, payload_hash, type, resource_kind, resource_id, aggregate_version, ordinal, occurred_at, snapshot, route_refs)
          VALUES (${id}::uuid, ${id}, ${"a".repeat(64)}, ${type}, ${storedKind}, ${randomUUID()}::uuid, 4, 2, NOW(), ${snapshot}::jsonb, ${routes}::jsonb)`;
          }
          const before = await tx.$queryRaw<
            { row: Record<string, unknown> }[]
          >`SELECT to_jsonb(e) AS row FROM notification_events e ORDER BY id`;
          for (const statement of statements)
            await tx.$executeRawUnsafe(statement);
          for (const statement of statements)
            await tx.$executeRawUnsafe(statement);
          const after = await tx.$queryRaw<
            { row: Record<string, unknown> }[]
          >`SELECT to_jsonb(e) AS row FROM notification_events e ORDER BY id`;
          assert.equal(after.length, cases.length);
          for (let i = 0; i < after.length; i++) {
            assert.deepEqual(after[i]!.row, {
              ...before[i]!.row,
              resource_kind: expected.get(String(after[i]!.row.id)),
            });
          }
          throw rollback;
        }),
        (error) => error === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
