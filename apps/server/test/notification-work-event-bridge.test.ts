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
  await bridge.maintain();
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
  await bridge.maintain();
  await bridge.maintain();
  assert.equal(calls, 1);
});
