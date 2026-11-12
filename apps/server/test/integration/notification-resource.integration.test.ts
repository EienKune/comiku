import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
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
