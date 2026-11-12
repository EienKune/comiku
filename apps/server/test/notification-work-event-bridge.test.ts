import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import { NotificationWorkEventBridgeService } from "../src/notifications/notification-work-event-bridge.service.js";
import { notificationPayloadHash } from "../src/notifications/notification-events.js";
import { buildHistoricalReplayText } from "../src/notifications/notification-content.js";

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

test("registration accepts immutable v1/v2 receipts alongside v3 without hydrating or rebuilding frozen text", async () => {
  const sourceEventId = "00000000-0000-4000-8000-000000000001";
  const resourceId = "00000000-0000-4000-8000-000000000002";
  const receiptId = "00000000-0000-4000-8000-000000000003";
  const route = {
    id: "00000000-0000-4000-8000-000000000004",
    revision: 1,
    generation: 1,
    groupId: "123456",
    connectionKey: "synthetic",
    connectionFingerprint: "a".repeat(64),
    includeDetails: false,
    templateVersion: 1,
  };
  const frozenText =
    "【Comiku 通知】\nFROZEN ORIGINAL ISO BODY\n发生时间：2026-11-07T00:00:00.000Z\n登录后查看：https://original.example/works/" +
    resourceId;
  for (const inputVersion of [1, 2, 3]) {
    const safeInput = {
      eventKey: `work-event:${sourceEventId}`,
      type: "stage_joined" as const,
      resourceId,
      aggregateVersion: 0,
      ordinal: 7,
      occurredAt: "2026-11-07T00:00:00.000Z",
      stage: "translate" as const,
      ...(inputVersion !== 1 && {
        metadataOrigin: "capture_current" as const,
        metadataObservedAt: "2026-11-08T00:00:00.000Z",
      }),
      ...(inputVersion === 3 && { participationKind: "claim" as const }),
    };
    const routeRefs = [
      {
        ...route,
        ...(inputVersion !== 1 && {
          content: {
            formatVersion: 1,
            receiverMode: "legacy",
            templatePolicy: null,
            matchedRule: { eventType: "stage_joined", stages: ["translate"] },
            text: frozenText,
            metadataObservedAt: null,
            metadataOrigin: null,
          },
        }),
      },
    ];
    const row = {
      id: receiptId,
      sourceEventId,
      resourceId,
      resourceOrdinal: 7,
      status: "pending",
      inputVersion,
      safeInput,
      payloadHash: notificationPayloadHash(safeInput),
      routeRefs,
    };
    let registered = 0;
    let updates = 0;
    const tx = {
      $queryRaw: async () => [{ id: receiptId }],
      $executeRaw: async () => 1,
      notificationWorkEventReceipt: {
        findUniqueOrThrow: async () => row,
        count: async () => 0,
        update: async ({
          data,
        }: {
          data: { status: string; notificationEventId: string };
        }) => {
          assert.equal(data.status, "recorded");
          assert.equal(data.notificationEventId, "registered-event");
          updates++;
        },
      },
    };
    const bridge = new NotificationWorkEventBridgeService(
      {
        $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      } as never,
      {
        recordFrozenRoutesTx: async (
          _tx: unknown,
          actualInput: unknown,
          actualRoutes: typeof routeRefs,
        ) => {
          assert.deepEqual(actualInput, safeInput);
          assert.deepEqual(actualRoutes, routeRefs);
          if (inputVersion !== 1) {
            assert.equal(actualRoutes[0].content!.text, frozenText);
            assert.equal(
              buildHistoricalReplayText(actualRoutes[0].content!.text),
              "【历史补发】\n" + frozenText,
            );
          }
          registered++;
          return { id: "registered-event" };
        },
      } as never,
      { enabled: true } as never,
    );
    assert.equal(
      await (
        bridge as unknown as { register(id: string): Promise<boolean> }
      ).register(receiptId),
      true,
    );
    assert.equal(registered, 1);
    assert.equal(updates, 1);
    assert.equal(row.payloadHash, notificationPayloadHash(safeInput));
  }
});
