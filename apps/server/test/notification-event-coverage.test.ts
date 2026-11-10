import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { WorkEventAction } from "../src/generated/prisma/enums.js";
import {
  NOTIFICATION_EVENT_KEYS,
  notificationPayloadHash,
  notificationPreview,
  normalizeNotificationEvent,
  renderNotificationMessage,
} from "../src/notifications/notification-events.js";
import { mapWorkEventNotification } from "../src/notifications/notification-work-event-mapper.js";
import {
  allowedNotificationStages,
  normalizeSubscriptionRules,
  resolveTemplatePolicy,
} from "../src/notifications/notification-template-policy.js";
import { NotificationChannelInputDto } from "../src/notifications/notifications.dto.js";
import { validateNotificationReceiptInput } from "../src/notifications/notification-content.js";
import { NOTIFICATION_SUPPORTED_WORK_EVENT_ACTIONS } from "../src/notifications/notification-work-event-source.js";

const expanded = [
  "metadata_updated",
  "collaboration_mode_updated",
  "stage_credit_updated",
  "stage_contribution_completed",
  "translation_imported",
  "typeset_version_uploaded",
  "typeset_version_selected",
  "typeset_version_deleted",
  "typeset_version_restored",
] as const;
const dormant = [
  "review_revision_joined",
  "review_revision_left",
  "review_revision_pages_updated",
  "review_revision_contribution_completed",
  "review_revision_completed",
  "typeset_version_reviewed",
  "stage_assigned",
  "translation_revision_submitted",
  "review_revised",
  "review_kept_pending",
  "review_blocked",
];
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
    reason: "PRIVATE_REASON",
    fileId: "PRIVATE_FILE",
    authorName: "PRIVATE_NAME",
    url: "https://private.example",
  },
};

test("all actual work producers can be selected while dormant enum actions stay unavailable", () => {
  assert.equal(NOTIFICATION_EVENT_KEYS.length, 24);
  assert.deepEqual(
    [...NOTIFICATION_SUPPORTED_WORK_EVENT_ACTIONS].sort(),
    [...NOTIFICATION_EVENT_KEYS].sort(),
  );
  for (const type of expanded) {
    assert.ok(NOTIFICATION_EVENT_KEYS.includes(type as never), type);
    assert.equal(
      mapWorkEventNotification({ ...source, action: type }, 1)?.type,
      type,
    );
    assert.doesNotThrow(() =>
      normalizeSubscriptionRules([{ eventType: type, stages: null }]),
    );
    assert.deepEqual(resolveTemplatePolicy(type as never), {
      eventType: type,
      titleEnabled: false,
      authorEnabled: false,
      actorEnabled: false,
      note: "",
      revision: 0,
      contentRevision: 0,
    });
  }
  assert.equal(
    Object.keys(WorkEventAction).length - NOTIFICATION_EVENT_KEYS.length,
    11,
  );
  for (const type of dormant)
    assert.equal(
      mapWorkEventNotification({ ...source, action: type }, 1),
      null,
    );
});

test("all 24 subscriptions pass the HTTP DTO together without inheriting any new subscription", async () => {
  const types = [
    "imported",
    "stage_joined",
    "stage_started",
    "typeset_handoff_started",
    "stage_left",
    "stage_assignment_updated",
    "stage_submitted",
    "proofreading_skipped",
    "stage_submission_cancelled",
    "review_opened",
    "review_withdrawn",
    "review_resumed",
    "archived",
    "restored",
    "publish_confirmed",
    ...expanded,
  ];
  const dto = plainToInstance(NotificationChannelInputDto, {
    name: "Synthetic",
    connectionKey: "fixture",
    groupId: "12345",
    enabled: true,
    eventTypes: types,
    includeDetails: false,
    receiverMode: "templates",
    subscriptionRules: types.map((eventType) => ({ eventType, stages: null })),
  });
  assert.deepEqual(await validate(dto), []);
  assert.deepEqual(
    normalizeSubscriptionRules([{ eventType: "imported", stages: null }]),
    [{ eventType: "imported", stages: null }],
  );
});

test("new stage derivation follows durable operation semantics and rejects unsupported responsibilities", () => {
  for (const type of ["metadata_updated", "collaboration_mode_updated"]) {
    assert.equal(
      mapWorkEventNotification({ ...source, action: type }, 1)?.stage,
      undefined,
    );
    assert.deepEqual(allowedNotificationStages(type), []);
  }
  for (const type of [
    "typeset_version_uploaded",
    "typeset_version_selected",
    "typeset_version_deleted",
    "typeset_version_restored",
  ]) {
    assert.equal(
      mapWorkEventNotification({ ...source, action: type }, 1)?.stage,
      "typeset",
    );
    assert.deepEqual(allowedNotificationStages(type), ["typeset"]);
    assert.match(notificationPreview(type as never, false), /职责：嵌字/);
  }
  assert.deepEqual(allowedNotificationStages("translation_imported"), [
    "translate",
    "proofread",
  ]);
  for (const stage of ["translate", "proofread"])
    assert.equal(
      mapWorkEventNotification(
        { ...source, action: "translation_imported", detail: { stage } },
        1,
      )?.stage,
      stage,
    );
  assert.match(
    notificationPreview("translation_imported" as never, false),
    /职责：翻译/,
  );
  for (const type of ["stage_credit_updated", "stage_contribution_completed"]) {
    assert.deepEqual(allowedNotificationStages(type), [
      "translate",
      "proofread",
      "typeset",
    ]);
    assert.equal(
      mapWorkEventNotification({ ...source, action: type }, 1)?.stage,
      "translate",
    );
    assert.throws(
      () =>
        mapWorkEventNotification(
          { ...source, action: type, detail: { stage: "publish" } },
          1,
        ),
      /notification_event_invalid/,
    );
  }
  assert.throws(
    () =>
      mapWorkEventNotification(
        {
          ...source,
          action: "translation_imported",
          detail: { stage: "typeset" },
        },
        1,
      ),
    /notification_event_invalid/,
  );
  assert.throws(
    () =>
      normalizeSubscriptionRules([
        { eventType: "translation_imported", stages: ["typeset"] },
      ]),
    /通知职责条件无效/,
  );
  assert.throws(
    () =>
      normalizeSubscriptionRules([
        { eventType: "metadata_updated", stages: ["translate"] },
      ]),
    /通知职责条件无效/,
  );
});

test("individual contribution completion retains its action and never invents a stage submission", () => {
  const input = mapWorkEventNotification(
    { ...source, action: "stage_contribution_completed" },
    2,
  )!;
  assert.ok(input);
  assert.equal(input.type, "stage_contribution_completed");
  const text = renderNotificationMessage(normalizeNotificationEvent(input), {
    includeDetails: true,
  });
  assert.match(text, /个人贡献已完成/);
  assert.doesNotMatch(text, /阶段已提交|流程：/);
});

test("expanded receipts expose only safe facts and retain deterministic source identity and hashes", () => {
  for (const action of expanded) {
    const input = mapWorkEventNotification({ ...source, action }, 3)!;
    assert.ok(input, action);
    assert.equal(input.eventKey, `work-event:${source.id}`);
    assert.equal(
      notificationPayloadHash(input),
      notificationPayloadHash(
        mapWorkEventNotification({ ...source, action }, 3)!,
      ),
    );
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_|private.example/);
    const v2 = {
      ...input,
      metadataOrigin: "capture_current" as const,
      metadataObservedAt: "2026-11-10T00:00:00.000Z",
    };
    assert.equal(validateNotificationReceiptInput(v2, 2).type, action);
    assert.throws(
      () =>
        validateNotificationReceiptInput(
          { ...v2, url: "https://private.example" },
          2,
        ),
      /notification_event_invalid/,
    );
  }
});
