/** Explicit allow-list: job payloads and exception messages must never reach logs. */
export function jobEvent(
  event: "started" | "succeeded" | "retry_scheduled" | "failed",
  job: {
    id: string;
    resourceId: string;
    kind: string;
    lane: string;
    attempts: number;
  },
  retryAt?: Date,
) {
  return {
    scope: "background_job",
    event,
    jobId: job.id,
    resourceId: job.resourceId,
    kind: job.kind,
    lane: job.lane,
    attempt: job.attempts,
    ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
  };
}
