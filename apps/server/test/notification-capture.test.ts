import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  NotificationWorkEventBridgeService,
  validateNotificationFrozenRoutes,
} from "../src/notifications/notification-work-event-bridge.service.js";
import { normalizeNotificationEvent } from "../src/notifications/notification-events.js";
import type {
  NotificationEventInput,
  NotificationFrozenRoute,
} from "../src/notifications/notifications.contracts.js";

const source = {
  id: "00000000-0000-4000-8000-000000000003",
  workId: "00000000-0000-4000-8000-000000000002",
  workNumber: 12,
  action: "stage_submitted",
  createdAt: new Date("2026-11-06T08:00:00Z"),
  detail: { stage: "translate" },
  fromWorkflowStatus: "translating",
  toWorkflowStatus: "pending_proofread",
  fromReviewStatus: null,
  toReviewStatus: null,
};
const base = {
  revision: 1,
  generation: 1,
  groupId: "123456",
  connectionKey: "test",
  connectionFingerprint: "a".repeat(64),
  includeDetails: true,
  templateVersion: 1,
};
test("capture freezes per-recipient mode, rule and template without leaking metadata into legacy", async () => {
  type SavedReceipt = {
    inputVersion: number;
    safeInput: NotificationEventInput;
    routeRefs: NotificationFrozenRoute[];
  };
  let saved!: SavedReceipt;
  const tx = {
    $queryRaw: async (
      sql: { strings: readonly string[] } | TemplateStringsArray,
    ) => {
      const text = "strings" in sql ? sql.strings.join("") : sql.join("");
      if (text.includes("FROM work_events e") && !text.includes("display_name"))
        return [source];
      if (text.includes("FROM notification_channels"))
        return [
          {
            ...base,
            id: "00000000-0000-4000-8000-000000000004",
            receiverMode: "legacy",
            subscriptionRules: [],
          },
          {
            ...base,
            id: "00000000-0000-4000-8000-000000000005",
            receiverMode: "templates",
            subscriptionRules: [
              { eventType: "stage_submitted", stages: ["translate"] },
            ],
          },
          {
            ...base,
            id: "00000000-0000-4000-8000-000000000006",
            receiverMode: "templates",
            subscriptionRules: [
              { eventType: "stage_submitted", stages: ["typeset"] },
            ],
          },
        ];
      if (text.includes("display_name"))
        return [
          {
            title: "捕获标题",
            authorName: "捕获作者",
            actorName: "原操作人",
            observedAt: new Date("2026-11-07T00:00:00Z"),
          },
        ];
      return [];
    },
    $executeRaw: async () => 1,
    notificationTemplate: {
      findMany: async () => [
        {
          eventType: "stage_submitted",
          titleEnabled: true,
          authorEnabled: false,
          actorEnabled: true,
          note: "已提交",
          revision: 7,
          contentRevision: 6,
        },
      ],
    },
    notificationWorkEventReceipt: {
      findFirst: async () => null,
      create: async ({ data }: { data: SavedReceipt }) => {
        saved = data;
      },
    },
  };
  const bridge = new NotificationWorkEventBridgeService(
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
    {} as never,
    { enabled: true } as never,
  );
  await (
    bridge as unknown as { capture(since: Date): Promise<boolean> }
  ).capture(new Date("2026-01-01"));
  assert.equal(saved.inputVersion, 3);
  assert.equal(saved.safeInput.title, "捕获标题");
  assert.equal(saved.safeInput.metadataOrigin, "capture_current");
  assert.equal(saved.routeRefs.length, 2);
  assert.doesNotMatch(
    saved.routeRefs[0].content!.text,
    /捕获标题|原操作人|捕获作者/,
  );
  assert.match(saved.routeRefs[1].content!.text, /捕获标题/);
  assert.match(saved.routeRefs[1].content!.text, /原操作人/);
  assert.doesNotMatch(saved.routeRefs[1].content!.text, /捕获作者/);
  assert.equal(saved.routeRefs[1].content!.templatePolicy!.contentRevision, 6);
  assert.deepEqual(saved.routeRefs[1].content!.matchedRule!.stages, [
    "translate",
  ]);
  assert.equal(
    saved.routeRefs[1].content!.metadataObservedAt,
    "2026-11-07T00:00:00.000Z",
  );
  assert.equal(saved.routeRefs[0].content!.formatVersion, 1);
  assert.equal(saved.routeRefs[1].content!.formatVersion, 2);
  assert.equal(
    validateNotificationFrozenRoutes(
      saved.routeRefs,
      2,
      normalizeNotificationEvent(saved.safeInput),
    ).length,
    2,
  );
  assert.equal(
    validateNotificationFrozenRoutes(
      saved.routeRefs,
      3,
      normalizeNotificationEvent(saved.safeInput),
    ).length,
    2,
  );
  assert.throws(
    () =>
      validateNotificationFrozenRoutes(
        saved.routeRefs.map((route) => {
          const withoutContent = { ...route };
          delete withoutContent.content;
          return withoutContent;
        }),
        3,
      ),
    /notification_routes_invalid/,
  );
  const policy = saved.routeRefs[1].content!.templatePolicy!;
  const corruptions = [
    { templatePolicy: { ...policy, contentRevision: -1 } },
    { templatePolicy: { ...policy, titleEnabled: "yes" } },
    { templatePolicy: { ...policy, secret: "PRIVATE" } },
    { matchedRule: { eventType: "stage_submitted", stages: ["typeset"] } },
    { formatVersion: 1 },
    { metadataObservedAt: "2026-11-08T00:00:00.000Z" },
    { templatePolicy: { ...policy, note: "x".repeat(121) } },
  ];
  for (const corrupt of corruptions) {
    const routes = saved.routeRefs.map((route, index) =>
      index === 1
        ? { ...route, content: { ...route.content, ...corrupt } }
        : route,
    );
    for (const version of [2, 3])
      assert.throws(
        () =>
          validateNotificationFrozenRoutes(
            routes,
            version,
            normalizeNotificationEvent(saved.safeInput),
          ),
        /notification_routes_invalid/,
      );
  }
});
