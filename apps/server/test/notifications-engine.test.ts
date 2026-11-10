import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { NotificationFrozenRoute } from "../src/notifications/notifications.contracts.js";

test("publisher freezes original routes on a same-key replay and rejects changed facts", async () => {
  type StoredEvent = Prisma.NotificationEventCreateManyInput & { id: string };
  const rows = new Map<string, StoredEvent>();
  let routeReads = 0;
  const tx = {
    $executeRaw: async () => 1,
    notificationTemplate: { findMany: async () => [] },
    notificationEvent: {
      findUnique: async ({ where }: { where: { eventKey: string } }) =>
        rows.get(where.eventKey) ?? null,
      createMany: async ({
        data,
      }: {
        data: Prisma.NotificationEventCreateManyInput;
      }) => {
        if (!rows.has(data.eventKey))
          rows.set(data.eventKey, { id: "event", ...data });
      },
      findUniqueOrThrow: async ({ where }: { where: { eventKey: string } }) =>
        rows.get(where.eventKey),
    },
    $queryRaw: async () => {
      routeReads++;
      return [
        {
          id: "channel",
          revision: 2,
          generation: 3,
          groupId: "123",
          connectionKey: "synthetic",
          connectionFingerprint: "a".repeat(64),
          includeDetails: false,
          receiverMode: "legacy",
          subscriptionRules: [],
        },
      ];
    },
  };
  const publisher = new NotificationPublisherService({
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService);
  const input = {
    eventKey: "test:1",
    type: "imported" as const,
    resourceId: "b43061af-e7c4-4a57-bfc0-a7da1e254773",
    aggregateVersion: 1,
    occurredAt: "2026-11-06T00:00:00Z",
    workNumber: 12,
  };
  const original = await publisher.record(input);
  const replay = await publisher.record(input);
  assert.deepEqual(replay, original);
  assert.equal(routeReads, 1);
  assert.deepEqual(original.routeRefs, [
    {
      id: "channel",
      revision: 2,
      generation: 3,
      groupId: "123",
      connectionKey: "synthetic",
      connectionFingerprint: "a".repeat(64),
      includeDetails: false,
      templateVersion: 1,
      content: (original.routeRefs as unknown as NotificationFrozenRoute[])[0]
        .content,
    },
  ]);
  await assert.rejects(
    publisher.record({ ...input, workNumber: 13 }),
    /different|冲突|不一致/,
  );
});
