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
  | "metadata_updated"
  | "collaboration_mode_updated"
  | "stage_credit_updated"
  | "stage_contribution_completed"
  | "translation_imported"
  | "typeset_version_uploaded"
  | "typeset_version_selected"
  | "typeset_version_deleted"
  | "typeset_version_restored"
>;
export type NotificationEventType =
  NotificationWorkEventType | "notification.test";
export interface NotificationSafeSnapshot {
  workNumber: number | null;
  title: string | null;
  authorName: string | null;
  actorName: string | null;
  metadataObservedAt?: string;
  metadataOrigin?: "capture_current";
  stage?: WorkStage;
  participationKind?: "claim" | "join";
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
  metadataObservedAt?: string;
  metadataOrigin?: "capture_current";
  stage?: WorkStage;
  participationKind?: "claim" | "join";
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
  /** Safe transient numeric evidence only; never persist or expose a raw response. */
  diagnostics?: NotificationSendDiagnostics;
}
export interface NotificationSendDiagnostics {
  httpStatus?: number;
  retcode?: number;
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
  content?: NotificationFrozenContent;
}

export interface NotificationFrozenContent {
  formatVersion: 1 | 2;
  receiverMode: "legacy" | "templates";
  templatePolicy: {
    eventType: NotificationWorkEventType;
    titleEnabled: boolean;
    authorEnabled: boolean;
    actorEnabled: boolean;
    note: string;
    revision: number;
    contentRevision: number;
  } | null;
  matchedRule: {
    eventType: NotificationWorkEventType;
    stages: WorkStage[] | null;
  } | null;
  text: string;
  metadataObservedAt: string | null;
  metadataOrigin: "capture_current" | null;
}
