import { Prisma } from "../generated/prisma/client.js";

export const NOTIFICATION_WORK_EVENT_ACTIVATION_ID = "work-events-v1";
export const NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID =
  "work-events-expanded-v1";

export const NOTIFICATION_LEGACY_WORK_EVENT_ACTIONS = Object.freeze([
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
] as const);
export const NOTIFICATION_EXPANDED_WORK_EVENT_ACTIONS = Object.freeze([
  "metadata_updated",
  "collaboration_mode_updated",
  "stage_credit_updated",
  "stage_contribution_completed",
  "translation_imported",
  "typeset_version_uploaded",
  "typeset_version_selected",
  "typeset_version_deleted",
  "typeset_version_restored",
] as const);
export const NOTIFICATION_SUPPORTED_WORK_EVENT_ACTIONS = Object.freeze([
  ...NOTIFICATION_LEGACY_WORK_EVENT_ACTIONS,
  ...NOTIFICATION_EXPANDED_WORK_EVENT_ACTIONS,
]);

// Combined catalog predicate; bounded source reads use the two index-backed branches below.
// All callers use the local WorkEvent alias e; action values must remain SQL literals
// so PostgreSQL can prove eligibility for the notification-only partial index.
export const NOTIFICATION_SUPPORTED_WORK_EVENT_PREDICATE = Prisma.sql`e.action IN (
  'imported', 'stage_joined', 'stage_started', 'typeset_handoff_started',
  'stage_left', 'stage_assignment_updated', 'stage_submitted',
  'proofreading_skipped', 'stage_submission_cancelled', 'review_opened',
  'review_withdrawn', 'review_resumed', 'archived', 'restored', 'publish_confirmed',
  'metadata_updated', 'collaboration_mode_updated', 'stage_credit_updated',
  'stage_contribution_completed', 'translation_imported', 'typeset_version_uploaded',
  'typeset_version_selected', 'typeset_version_deleted', 'typeset_version_restored')`;

// Keep each literal predicate identical to its migration partial index.
export const NOTIFICATION_LEGACY_WORK_EVENT_PREDICATE = Prisma.sql`e.action IN (
  'imported', 'stage_joined', 'stage_started', 'typeset_handoff_started',
  'stage_left', 'stage_assignment_updated', 'stage_submitted',
  'proofreading_skipped', 'stage_submission_cancelled', 'review_opened',
  'review_withdrawn', 'review_resumed', 'archived', 'restored', 'publish_confirmed')`;
export const NOTIFICATION_EXPANDED_WORK_EVENT_PREDICATE = Prisma.sql`e.action IN (
  'metadata_updated', 'collaboration_mode_updated', 'stage_credit_updated',
  'stage_contribution_completed', 'translation_imported', 'typeset_version_uploaded',
  'typeset_version_selected', 'typeset_version_deleted', 'typeset_version_restored')`;

export interface NotificationWorkEventSourceBoundaries {
  sourceSince: Date;
  expandedSourceSince: Date | null;
}

/** Separate bounded reads avoid scanning pre-expansion history on every legacy poll. */
export function buildNotificationWorkEventSourceBranches(
  boundaries: NotificationWorkEventSourceBoundaries,
): { legacy: Prisma.Sql; expanded: Prisma.Sql | null } {
  return {
    legacy: Prisma.sql`e.notification_captured_at IS NULL
      AND ${NOTIFICATION_LEGACY_WORK_EVENT_PREDICATE}
      AND e.created_at >= ${boundaries.sourceSince}`,
    expanded:
      boundaries.expandedSourceSince === null
        ? null
        : Prisma.sql`e.notification_captured_at IS NULL
          AND ${NOTIFICATION_EXPANDED_WORK_EVENT_PREDICATE}
          AND e.created_at >= ${boundaries.sourceSince}
          AND e.created_at >= ${boundaries.expandedSourceSince}`,
  };
}

/** Eligibility semantics for non-scanning consumers; use branches for bounded source reads. */
export function buildNotificationWorkEventSourceEligibility(
  boundaries: NotificationWorkEventSourceBoundaries,
): Prisma.Sql {
  const branches = buildNotificationWorkEventSourceBranches(boundaries);
  return branches.expanded
    ? Prisma.sql`((${branches.legacy}) OR (${branches.expanded}))`
    : branches.legacy;
}
