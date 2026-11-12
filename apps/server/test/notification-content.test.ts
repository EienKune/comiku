import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
} from "../src/notifications/notification-events.js";
import {
  buildHistoricalReplayText,
  renderTemplateNotificationMessage,
  validateNotificationReceiptInput,
} from "../src/notifications/notification-content.js";

const input = {
  eventKey: "work-event:00000000-0000-4000-8000-000000000001",
  type: "stage_submitted" as const,
  resourceId: "00000000-0000-4000-8000-000000000002",
  aggregateVersion: 0,
  ordinal: 1,
  occurredAt: "2026-11-06T08:00:00Z",
  workNumber: 12,
  stage: "translate" as const,
};
const settings = {
  titleEnabled: true,
  authorEnabled: false,
  actorEnabled: true,
  note: "阶段提交提醒",
};
test("structured content honors independent masks, missing metadata and original facts", () => {
  const text = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      title: "作品",
      authorName: "PRIVATE_AUTHOR",
      actorName: "原操作人",
    }),
    settings,
    "https://example.test",
  );
  assert.match(text, /标题：作品/);
  assert.match(text, /操作：原操作人/);
  assert.doesNotMatch(text, /PRIVATE_AUTHOR/);
  assert.match(text, /职责：翻译/);
  assert.match(text, /2026-11-06T08:00:00.000Z/);
  assert.match(text, /阶段提交提醒/);
  const missing = renderTemplateNotificationMessage(
    normalizeNotificationEvent(input),
    settings,
  );
  assert.doesNotMatch(missing, /标题：|作者：|操作：|undefined|null/);
});
test("new content reserves replay budget, retains full URL and original text", () => {
  const url = "https://example.test/" + "x".repeat(400);
  const text = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      title: "😀".repeat(240),
      authorName: "作".repeat(240),
      actorName: "人".repeat(240),
    }),
    { ...settings, authorEnabled: true, note: "😀".repeat(120) },
    url,
  );
  const replay = buildHistoricalReplayText(text);
  assert.ok([...replay].length <= 1000);
  assert.ok(replay.includes(text));
  assert.ok(text.endsWith(`${url}/works/${input.resourceId}`));
  assert.throws(
    () => buildHistoricalReplayText("x".repeat(1000)),
    /notification_replay_too_long/,
  );
});
test("receipt v1 stays strict and hash stable while v2 explicitly validates capture metadata", () => {
  const oldHash = notificationPayloadHash(input);
  assert.equal(
    oldHash,
    "d065ae6edbbe6a0b1d154d15852021b8718248fbda42b77233cbc6749e600017",
  );
  assert.equal(validateNotificationReceiptInput(input, 1).type, input.type);
  assert.throws(
    () => validateNotificationReceiptInput({ ...input, title: "name" }, 1),
    /notification_event_invalid/,
  );
  const v2 = {
    ...input,
    title: "name",
    metadataOrigin: "capture_current",
    metadataObservedAt: "2026-11-07T00:00:00.000Z",
  };
  assert.equal(validateNotificationReceiptInput(v2, 2).snapshot.title, "name");
  assert.equal(
    notificationPayloadHash(v2 as never),
    "868f201ed7e85049d8d1a7fb5eace29ceafd7e6f66f31f40281a54a3d7f967c6",
  );
  for (const bad of [
    { ...v2, metadataOrigin: "event_time" },
    { ...v2, metadataObservedAt: "bad" },
    { ...v2, internalNote: "SECRET" },
  ])
    assert.throws(
      () => validateNotificationReceiptInput(bad, 2),
      /notification_event_invalid/,
    );
  assert.equal(notificationPayloadHash(input), oldHash);
  assert.notEqual(
    notificationPayloadHash(v2 as never),
    notificationPayloadHash({
      ...v2,
      metadataObservedAt: "2026-11-08T00:00:00.000Z",
    } as never),
  );
});
