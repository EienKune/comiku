import type {
  NotificationEventInput,
  NormalizedNotificationEvent,
} from "./notifications.contracts.js";
import { normalizeNotificationEvent } from "./notification-events.js";

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

/** Receipt versions are immutable allowlists; new facts never broaden old input. */
export function validateNotificationReceiptInput(
  value: unknown,
  version: number,
): NormalizedNotificationEvent {
  const keys = new Set([
    ...sourceKeys,
    ...(version === 2 || version === 3
      ? [
          "title",
          "authorName",
          "actorName",
          "metadataOrigin",
          "metadataObservedAt",
        ]
      : []),
    ...(version === 3 ? ["participationKind"] : []),
  ]);
  if (
    (version !== 1 && version !== 2 && version !== 3) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.has(key))
  )
    throw new Error("notification_event_invalid");
  const input = value as NotificationEventInput;
  if (
    (version === 2 || version === 3) &&
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
