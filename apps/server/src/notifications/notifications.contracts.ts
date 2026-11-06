import type {
  WorkEventAction,
  WorkStage,
  WorkflowStatus,
  ReviewStatus,
} from "../generated/prisma/client.js";

export type NotificationWorkEventType = Extract<
  WorkEventAction,
  | "imported"
  | "stage_joined"
  | "stage_started"
  | "typeset_handoff_started"
  | "stage_left"
  | "stage_assignment_updated"
  | "stage_submitted"
  | "proofreading_skipped"
  | "stage_submission_cancelled"
  | "review_opened"
  | "review_withdrawn"
  | "review_resumed"
  | "archived"
  | "restored"
  | "publish_confirmed"
>;
export type NotificationEventType =
  NotificationWorkEventType | "notification.test";
export interface NotificationSafeSnapshot {
  workNumber: number | null;
  title: string | null;
  authorName: string | null;
  actorName: string | null;
  stage?: WorkStage;
  fromWorkflowStatus?: WorkflowStatus;
  toWorkflowStatus?: WorkflowStatus;
  fromReviewStatus?: ReviewStatus;
  toReviewStatus?: ReviewStatus;
}
export interface NotificationEventInput {
  eventKey: string;
  type: NotificationEventType;
  resourceId: string;
  aggregateVersion: number;
  ordinal?: number;
  occurredAt: Date | string;
  workNumber?: number | null;
  title?: string | null;
  authorName?: string | null;
  actorName?: string | null;
  stage?: WorkStage;
  fromWorkflowStatus?: WorkflowStatus;
  toWorkflowStatus?: WorkflowStatus;
  fromReviewStatus?: ReviewStatus;
  toReviewStatus?: ReviewStatus;
}
export interface NormalizedNotificationEvent {
  eventKey: string;
  type: NotificationEventType;
  resourceId: string;
  aggregateVersion: number;
  ordinal: number;
  occurredAt: Date;
  snapshot: NotificationSafeSnapshot;
}
export interface SafeNotificationConnection {
  key: string;
  name: string;
  adapter: "onebot-http";
  available: boolean;
}
/** Internal only: never serialize this object through a controller or logger. */
export interface ValidatedNotificationConnection {
  key: string;
  name: string;
  adapter: "onebot-http";
  fingerprint: string;
  endpoint: string;
  token: string;
  allowedIps: readonly string[];
}
export interface NotificationSendResult {
  status: "accepted" | "retryable" | "failed" | "unknown";
  errorCode?: string;
  providerMessageId?: string;
  sendBoundaryCrossed: boolean;
}

/** Module-internal immutable routing snapshot. Never accepted by HTTP controllers. */
export interface NotificationFrozenRoute {
  id: string;
  revision: number;
  generation: number;
  groupId: string;
  connectionKey: string;
  connectionFingerprint: string;
  includeDetails: boolean;
  templateVersion: 1;
}
