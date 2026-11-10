import type { NotificationEventInput } from "./notifications.contracts.js";
import {
  NOTIFICATION_EVENT_KEYS,
  normalizeNotificationEvent,
} from "./notification-events.js";
import { allowedNotificationStages } from "./notification-template-policy.js";

/** Only these source fields may enter durable notification input. Never hydrate current names/revision. */
export interface WorkEventNotificationSource {
  id: string;
  workId: string;
  workNumber: number;
  action: string;
  createdAt: Date;
  fromWorkflowStatus: string | null;
  toWorkflowStatus: string | null;
  fromReviewStatus: string | null;
  toReviewStatus: string | null;
  detail: unknown;
}

export function mapWorkEventNotification(
  source: WorkEventNotificationSource,
  resourceOrdinal: number,
): NotificationEventInput | null {
  if (!NOTIFICATION_EVENT_KEYS.includes(source.action as never)) return null;
  const detail =
    source.detail &&
    typeof source.detail === "object" &&
    !Array.isArray(source.detail)
      ? (source.detail as Record<string, unknown>)
      : {};
  const allowedStages = allowedNotificationStages(source.action);
  const stage =
    source.action === "publish_confirmed"
      ? "publish"
      : source.action === "typeset_handoff_started" ||
          source.action.startsWith("typeset_version_")
        ? "typeset"
        : source.action === "metadata_updated" ||
            source.action === "collaboration_mode_updated"
          ? undefined
          : detail.stage;
  if (
    stage !== undefined &&
    allowedStages.length &&
    !allowedStages.includes(stage as never)
  )
    throw new Error("notification_event_invalid");
  const input = {
    eventKey: `work-event:${source.id}`,
    type: source.action,
    resourceId: source.workId,
    workNumber: source.workNumber,
    aggregateVersion: 0,
    ordinal: resourceOrdinal,
    occurredAt: source.createdAt,
    ...(stage !== undefined && { stage }),
    ...(source.fromWorkflowStatus !== null && {
      fromWorkflowStatus: source.fromWorkflowStatus,
    }),
    ...(source.toWorkflowStatus !== null && {
      toWorkflowStatus: source.toWorkflowStatus,
    }),
    ...(source.fromReviewStatus !== null && {
      fromReviewStatus: source.fromReviewStatus,
    }),
    ...(source.toReviewStatus !== null && {
      toReviewStatus: source.toReviewStatus,
    }),
  } as NotificationEventInput;
  normalizeNotificationEvent(input);
  return input;
}
