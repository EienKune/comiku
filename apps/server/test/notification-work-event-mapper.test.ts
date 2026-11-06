import assert from "node:assert/strict";
import test from "node:test";
import { mapWorkEventNotification } from "../src/notifications/notification-work-event-mapper.js";
import {
  notificationPreview,
  normalizeNotificationEvent,
} from "../src/notifications/notification-events.js";

const source = {
  id: "00000000-0000-4000-8000-000000000001",
  workId: "00000000-0000-4000-8000-000000000002",
  workNumber: 42,
  action: "stage_joined",
  createdAt: new Date("2026-11-07T00:00:00Z"),
  fromWorkflowStatus: null,
  toWorkflowStatus: null,
  fromReviewStatus: null,
  toReviewStatus: null,
  detail: {
    stage: "translate",
    reason: "SECRET_CANARY",
    url: "https://private.example",
  },
};

test("work mapper freezes only historical allowlisted facts and capture order", () => {
  const mapped = mapWorkEventNotification(source, 7)!;
  assert.equal(mapped.eventKey, `work-event:${source.id}`);
  assert.equal(mapped.aggregateVersion, 0);
  assert.equal(mapped.ordinal, 7);
  assert.deepEqual(normalizeNotificationEvent(mapped).snapshot, {
    workNumber: 42,
    title: null,
    authorName: null,
    actorName: null,
    stage: "translate",
  });
  assert.doesNotMatch(JSON.stringify(mapped), /SECRET_CANARY|private.example/);
});

test("start events distinguish participation and use fixed handoff/publish stages", () => {
  assert.equal(
    mapWorkEventNotification({ ...source, action: "stage_started" }, 1)?.type,
    "stage_started",
  );
  assert.equal(
    mapWorkEventNotification(
      { ...source, action: "typeset_handoff_started" },
      1,
    )?.stage,
    "typeset",
  );
  assert.equal(
    mapWorkEventNotification({ ...source, action: "publish_confirmed" }, 1)
      ?.stage,
    "publish",
  );
  assert.doesNotMatch(
    notificationPreview("stage_joined", false),
    /待翻译 → 翻译中/,
  );
  assert.match(notificationPreview("stage_started", false), /待翻译 → 翻译中/);
});

test("unsupported actions and invalid allowlisted facts are deterministic poison", () => {
  assert.equal(
    mapWorkEventNotification({ ...source, action: "metadata_updated" }, 1),
    null,
  );
  assert.throws(
    () =>
      mapWorkEventNotification({ ...source, detail: { stage: "secret" } }, 1),
    /notification_event_invalid/,
  );
  assert.throws(
    () => mapWorkEventNotification({ ...source, createdAt: new Date(NaN) }, 1),
    /notification_event_invalid/,
  );
});
