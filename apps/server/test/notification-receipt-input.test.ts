import assert from "node:assert/strict";
import test from "node:test";
import { validateNotificationReceiptInput } from "../src/notifications/notification-receipt-input.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
  notificationPreviewEvent,
} from "../src/notifications/notification-events.js";

const input = {
  eventKey: "work:1:2",
  type: "stage_joined" as const,
  resourceId: "00000000-0000-4000-8000-000000000001",
  aggregateVersion: 2,
  occurredAt: "2026-11-06T08:00:00Z",
  workNumber: 12,
  stage: "translate" as const,
};
const metadata = {
  metadataOrigin: "capture_current" as const,
  metadataObservedAt: "2026-11-07T00:00:00.000Z",
};

test("receipt v3 validates participation without broadening earlier receipt allowlists", () => {
  for (const kind of ["claim", "join"] as const) {
    const value = { ...input, ...metadata, participationKind: kind };
    assert.equal(
      validateNotificationReceiptInput(value, 3).snapshot.participationKind,
      kind,
    );
    for (const version of [1, 2])
      assert.throws(
        () => validateNotificationReceiptInput(value, version),
        /notification_event_invalid/,
      );
  }
  assert.equal(
    "participationKind" in
      validateNotificationReceiptInput({ ...input, ...metadata }, 3).snapshot,
    false,
  );
  for (const value of [
    { ...input, ...metadata, participationKind: "assign" },
    { ...input, ...metadata, participationKind: null },
    {
      ...input,
      ...metadata,
      type: "stage_started",
      participationKind: "claim",
    },
    { ...input, ...metadata, operation: "join:translate:" },
    { ...input, ...metadata, note: "PRIVATE" },
    { ...input, ...metadata, metadataOrigin: "event_time" },
    { ...input, ...metadata, metadataObservedAt: "bad" },
    { ...input, participationKind: "claim" },
  ])
    assert.throws(
      () => validateNotificationReceiptInput(value, 3),
      /notification_event_invalid/,
    );
  assert.throws(
    () => validateNotificationReceiptInput({ ...input, ...metadata }, 4),
    /notification_event_invalid/,
  );
});

test("normalizer rejects misplaced participation and keeps absent fields out of historic hashes", () => {
  const v1Hash = notificationPayloadHash(input);
  const v2Hash = notificationPayloadHash({ ...input, ...metadata });
  assert.equal(
    notificationPayloadHash({ ...input, participationKind: undefined }),
    v1Hash,
  );
  assert.equal(
    notificationPayloadHash({
      ...input,
      ...metadata,
      participationKind: undefined,
    }),
    v2Hash,
  );
  assert.notEqual(
    notificationPayloadHash({ ...input, participationKind: "claim" }),
    v1Hash,
  );
  for (const value of [
    { ...input, participationKind: "CLAIM" },
    { ...input, type: "notification.test", participationKind: "join" },
  ])
    assert.throws(
      () => normalizeNotificationEvent(value as never),
      /notification_event_invalid/,
    );
  assert.equal(
    notificationPreviewEvent("stage_joined").snapshot.participationKind,
    "claim",
  );
});
