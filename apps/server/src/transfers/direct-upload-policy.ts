import type {
  BackgroundJob,
  DirectUploadSession,
  DirectUploadStatus,
} from "../generated/prisma/client.js";
export const DIRECT_UPLOAD_WINDOW_MS = 24 * 60 * 60_000;
export const DIRECT_UPLOAD_RECEIPT_MS = 7 * DIRECT_UPLOAD_WINDOW_MS;
export const DIRECT_UPLOAD_WRITE_GRACE_MS = 15 * 60_000;
export function terminalUpload(status: DirectUploadStatus) {
  return ["completed", "failed", "expired"].includes(status);
}
type UploadIdentity = Pick<DirectUploadSession, "id" | "purpose" | "actorId">;
type RecoveryJob = Pick<
  BackgroundJob,
  | "resourceId"
  | "actorId"
  | "kind"
  | "idempotencyKey"
  | "status"
  | "attempts"
  | "leaseUntil"
>;
export function recoverableDirectUploadJob(
  _session: UploadIdentity,
  _job: RecoveryJob | null,
  _now: Date,
): boolean {
  return (
    !!_job &&
    _job.actorId === _session.actorId &&
    _job.resourceId === _session.id &&
    _job.kind === `direct_${_session.purpose}` &&
    _job.idempotencyKey === `direct:${_session.id}` &&
    (_job.status === "queued"
      ? _job.attempts < 3
      : _job.status === "running" &&
        _job.leaseUntil !== null &&
        (_job.leaseUntil > _now || _job.attempts < 3))
  );
}
export function directUploadGrantSeconds(_expiresAt: Date, _now: Date): number {
  return Math.max(
    0,
    Math.min(900, Math.floor((_expiresAt.getTime() - _now.getTime()) / 1000)),
  );
}
