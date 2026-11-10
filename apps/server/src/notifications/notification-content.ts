import type { WorkStage } from "../generated/prisma/client.js";
import type {
  NotificationEventInput,
  NotificationEventType,
  NormalizedNotificationEvent,
} from "./notifications.contracts.js";
import type { NotificationTemplateSettings } from "./notification-template-policy.js";
import {
  normalizeNotificationEvent,
  notificationPreviewEvent,
  renderNotificationMessage,
} from "./notification-events.js";

const REPLAY_MARKER = "【历史补发】\n";
const sourceKeys = [
  "eventKey",
  "type",
  "resourceId",
  "workNumber",
  "aggregateVersion",
  "ordinal",
  "occurredAt",
  "stage",
  "fromWorkflowStatus",
  "toWorkflowStatus",
  "fromReviewStatus",
  "toReviewStatus",
];
export function validateNotificationReceiptInput(
  value: unknown,
  version: number,
): NormalizedNotificationEvent {
  const keys = new Set([
    ...sourceKeys,
    ...(version === 2
      ? [
          "title",
          "authorName",
          "actorName",
          "metadataOrigin",
          "metadataObservedAt",
        ]
      : []),
  ]);
  if (
    (version !== 1 && version !== 2) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.has(key))
  )
    throw new Error("notification_event_invalid");
  const input = value as NotificationEventInput;
  if (
    version === 2 &&
    (input.metadataOrigin !== "capture_current" ||
      typeof input.metadataObservedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        input.metadataObservedAt,
      ) ||
      !Number.isFinite(Date.parse(input.metadataObservedAt)))
  )
    throw new Error("notification_event_invalid");
  return normalizeNotificationEvent(input);
}

/** Original body is immutable; never reconstruct historical deliveries from live settings. */
export function buildHistoricalReplayText(originalText: string): string {
  if (
    originalText.startsWith(REPLAY_MARKER) ||
    originalText.startsWith("【Comiku 历史补发】\n")
  ) {
    if ([...originalText].length > 1000)
      throw new Error("notification_replay_too_long");
    return originalText;
  }
  if ([...originalText].length + [...REPLAY_MARKER].length > 1000)
    throw new Error("notification_replay_too_long");
  return REPLAY_MARKER + originalText;
}

export function renderTemplateNotificationMessage(
  event: NormalizedNotificationEvent,
  template: NotificationTemplateSettings,
  siteUrl?: string,
): string {
  const base = renderNotificationMessage(event, {
    includeDetails: false,
    siteUrl,
  });
  const lines = base.split("\n");
  const link = lines.pop()!;
  const optional = [
    template.note,
    template.titleEnabled && event.snapshot.title
      ? `标题：${event.snapshot.title}`
      : "",
    template.authorEnabled && event.snapshot.authorName
      ? `作者：${event.snapshot.authorName}`
      : "",
    template.actorEnabled && event.snapshot.actorName
      ? `操作：${event.snapshot.actorName}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const budget = 1000 - [...REPLAY_MARKER].length - [...base].length;
  if (budget < 0) throw new Error("notification_message_too_long");
  if (optional && budget > 1) {
    const chars = [...optional];
    const available = budget - 1;
    lines.push(
      chars.length <= available
        ? optional
        : chars.slice(0, Math.max(0, available - 1)).join("") + "…",
    );
  }
  return [...lines, link].join("\n");
}

export function notificationTemplatePreview(
  type: NotificationEventType,
  template: NotificationTemplateSettings,
  siteUrl?: string,
  stage?: WorkStage,
  missingMetadata = false,
): string {
  return renderTemplateNotificationMessage(
    notificationPreviewEvent(type, stage, missingMetadata),
    template,
    siteUrl,
  );
}
