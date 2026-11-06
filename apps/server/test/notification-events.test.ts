import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_EVENT_TYPES,
  normalizeNotificationEvent,
  notificationPayloadHash,
  renderNotificationMessage,
  notificationPreview,
} from "../src/notifications/notification-events.js";

const event = {
  eventKey: "work:1:2",
  type: "stage_submitted" as const,
  resourceId: "00000000-0000-4000-8000-000000000001",
  aggregateVersion: 2,
  occurredAt: "2026-11-06T08:00:00Z",
  workNumber: 12,
  title: "作品",
  authorName: "作者",
  actorName: "成员",
};

test("notification event snapshot excludes arbitrary business details and hash is canonical", () => {
  const normalized = normalizeNotificationEvent({
    ...event,
    detail: "SECRET_CANARY",
  } as typeof event);
  assert.deepEqual(normalized.snapshot, {
    workNumber: 12,
    title: "作品",
    authorName: "作者",
    actorName: "成员",
  });
  assert.equal(normalized.ordinal, 0);
  assert.equal(
    notificationPayloadHash(event),
    notificationPayloadHash({
      ...event,
      occurredAt: new Date(event.occurredAt),
      ordinal: 0,
    }),
  );
  assert.notEqual(
    notificationPayloadHash(event),
    notificationPayloadHash({ ...event, title: "其他" }),
  );
  assert.throws(
    () =>
      normalizeNotificationEvent({
        ...event,
        type: "metadata_updated",
      } as never),
    /notification_event_invalid/,
  );
  assert.throws(
    () => normalizeNotificationEvent({ ...event, aggregateVersion: -1 }),
    /notification_event_invalid/,
  );
  assert.equal(
    normalizeNotificationEvent({
      ...event,
      title: `作${String.fromCharCode(0, 0x85, 0x202e)}品`,
    }).snapshot.title,
    "作   品",
  );
  for (const control of [0, 0x1f, 0x7f, 0x85, 0x9f]) {
    assert.throws(
      () =>
        normalizeNotificationEvent({
          ...event,
          eventKey: `event:${String.fromCharCode(control)}`,
        }),
      /notification_event_invalid/,
    );
  }
});

test("fixed renderer includes history and signed-in link without opt-out details", () => {
  const text = renderNotificationMessage(normalizeNotificationEvent(event), {
    includeDetails: false,
    siteUrl: "https://comiku.example/",
  });
  assert.match(text, /#12/);
  assert.match(text, /2026-11-06T08:00:00.000Z/);
  assert.match(
    text,
    /https:\/\/comiku.example\/works\/00000000-0000-4000-8000-000000000001/,
  );
  assert.doesNotMatch(text, /作品|作者|成员/);
  const details = renderNotificationMessage(normalizeNotificationEvent(event), {
    includeDetails: true,
    historicalReplay: true,
  });
  assert.match(details, /作品/);
  assert.match(details, /历史补发/);
  const long = renderNotificationMessage(
    normalizeNotificationEvent({ ...event, title: "超".repeat(3000) }),
    { includeDetails: true },
  );
  assert.ok([...long].length <= 1000);
});

test("event validation rejects invalid DB identifiers and INTEGER overflow before SQL", () => {
  for (const patch of [
    { resourceId: "not-a-uuid" },
    { aggregateVersion: 2_147_483_648 },
    { ordinal: 2_147_483_648 },
    { workNumber: 2_147_483_648 },
  ]) {
    assert.throws(
      () => normalizeNotificationEvent({ ...event, ...patch }),
      /notification_event_invalid/,
    );
  }
  assert.throws(
    () => normalizeNotificationEvent(null as never),
    /notification_event_invalid/,
  );
  assert.throws(
    () =>
      normalizeNotificationEvent({ ...event, occurredAt: "November 6, 2026" }),
    /notification_event_invalid/,
  );
});

test("catalog exposes only approved core events and preview is synthetic", () => {
  assert.equal(NOTIFICATION_EVENT_TYPES.length, 14);
  assert.ok(
    NOTIFICATION_EVENT_TYPES.some((item) => item.type === "notification.test"),
  );
  assert.match(notificationPreview("imported", true), /预览/);
});

test("stage submission carries its duty and workflow transition without enabling personal details", () => {
  const input = {
    ...event,
    stage: "translate" as const,
    fromWorkflowStatus: "translating" as const,
    toWorkflowStatus: "pending_proofread" as const,
  };
  const normalized = normalizeNotificationEvent(input);
  assert.equal(normalized.snapshot.stage, "translate");
  const text = renderNotificationMessage(normalized, { includeDetails: false });
  assert.match(text, /职责：翻译/);
  assert.match(text, /流程：翻译中 → 待校对/);
  assert.doesNotMatch(text, /标题：|作者：|操作：/);
  assert.notEqual(
    notificationPayloadHash(input),
    notificationPayloadHash({ ...input, toWorkflowStatus: "pending_typeset" }),
  );
});

test("review-only status changes remain visible and participate in the payload identity", () => {
  const input = {
    ...event,
    type: "review_opened" as const,
    fromReviewStatus: "normal" as const,
    toReviewStatus: "needs_review" as const,
  };
  const text = renderNotificationMessage(normalizeNotificationEvent(input), {
    includeDetails: false,
  });
  assert.match(text, /审核：正常 → 待审核/);
  assert.doesNotMatch(text, /流程：/);
  assert.notEqual(
    notificationPayloadHash(input),
    notificationPayloadHash({ ...input, toReviewStatus: "blocked" }),
  );
});

test("only generated stage and status values are accepted in the safe snapshot", () => {
  for (const patch of [
    { stage: "SECRET_CANARY" },
    { fromWorkflowStatus: "SECRET_CANARY" },
    { toWorkflowStatus: "SECRET_CANARY" },
    { fromReviewStatus: "SECRET_CANARY" },
    { toReviewStatus: "SECRET_CANARY" },
  ]) {
    assert.throws(
      () => normalizeNotificationEvent({ ...event, ...patch } as never),
      /notification_event_invalid/,
    );
  }
  assert.match(
    notificationPreview("stage_submitted", false),
    /职责：翻译[\s\S]*流程：翻译中 → 待校对/,
  );
  assert.match(
    notificationPreview("review_opened", false),
    /审核：正常 → 待审核/,
  );
});

test("message budget trims optional details while preserving historical facts and the complete final link", () => {
  const siteUrl = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(50)}.example`;
  const normalized = normalizeNotificationEvent({
    ...event,
    stage: "translate",
    fromWorkflowStatus: "translating",
    toWorkflowStatus: "pending_proofread",
    fromReviewStatus: "normal",
    toReviewStatus: "needs_review",
    title: "🙂".repeat(240),
    authorName: "作者".repeat(120),
    actorName: "操作".repeat(120),
  });
  const text = renderNotificationMessage(normalized, {
    includeDetails: true,
    siteUrl,
    historicalReplay: true,
  });
  assert.ok([...text].length <= 1000);
  assert.ok(
    text.endsWith(
      `登录后查看：${siteUrl}/works/00000000-0000-4000-8000-000000000001`,
    ),
  );
  assert.match(text, /历史补发/);
  assert.match(text, /#12/);
  assert.match(text, /2026-11-06T08:00:00.000Z/);
  assert.match(text, /职责：翻译/);
  assert.match(text, /流程：翻译中 → 待校对/);
  assert.match(text, /审核：正常 → 待审核/);
  assert.match(text, /\.\.\./);
  assert.equal(Buffer.from(text).toString("utf8"), text);
});

test("a fixed message and link that cannot fit fails with a controlled code instead of a broken URL", () => {
  assert.throws(
    () =>
      renderNotificationMessage(normalizeNotificationEvent(event), {
        includeDetails: false,
        siteUrl: `https://comiku.example/${"x".repeat(1100)}`,
      }),
    /^Error: notification_message_too_long$/,
  );
});
