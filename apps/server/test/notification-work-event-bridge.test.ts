import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import { NotificationWorkEventBridgeService } from "../src/notifications/notification-work-event-bridge.service.js";

test("disabled bridge never initializes activation, queries sources or registers", async () => {
  const bridge = new NotificationWorkEventBridgeService(
    {} as PrismaService,
    {} as NotificationPublisherService,
    { enabled: false } as NotificationConnectionRegistry,
  );
  assert.equal(await bridge.maintain(), null);
});

test("systemic database failure backs off instead of hot-looping and stays outside callers", async () => {
  let calls = 0;
  const bridge = new NotificationWorkEventBridgeService(
    {
      notificationWorkEventActivation: {
        upsert: async () => {
          calls++;
          throw new Error("PRIVATE_CANARY");
        },
      },
    } as unknown as PrismaService,
    {} as NotificationPublisherService,
    { enabled: true } as NotificationConnectionRegistry,
  );
  assert.deepEqual(await bridge.maintain(), {
    success: false,
    captured: 0,
    registered: 0,
  });
  await bridge.maintain();
  assert.equal(calls, 1);
});

test("maintenance initializes both persistent boundaries and reports actual completed work", async () => {
  const activations: string[] = [];
  const sourceSince = new Date("2026-11-01T00:00:00.000Z");
  const expandedSourceSince = new Date("2026-11-10T00:00:00.000Z");
  let selection: { values: unknown[] } | undefined;
  const bridge = new NotificationWorkEventBridgeService(
    {
      notificationWorkEventActivation: {
        upsert: async ({
          where,
          update,
        }: {
          where: { id: string };
          update: object;
        }) => {
          assert.deepEqual(update, {});
          activations.push(where.id);
          return {
            sourceSince:
              where.id === "work-events-v1" ? sourceSince : expandedSourceSince,
          };
        },
      },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
        operation({
          $queryRaw: async (query: { values: unknown[] }) => {
            selection = query;
            return [];
          },
        }),
      $queryRaw: async () => [],
    } as unknown as PrismaService,
    {} as NotificationPublisherService,
    { enabled: true } as NotificationConnectionRegistry,
  );
  assert.deepEqual(await bridge.maintain(), {
    success: true,
    captured: 0,
    registered: 0,
  });
  assert.deepEqual(activations, ["work-events-v1", "work-events-expanded-v1"]);
  assert.ok(selection?.values.includes(sourceSince));
  assert.ok(selection?.values.includes(expandedSourceSince));
});
