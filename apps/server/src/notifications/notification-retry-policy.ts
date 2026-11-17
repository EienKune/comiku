/** Confirmed-unsent retries only; durable delivery attempts own this budget, not Jobs. */
const NOTIFICATION_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
] as const;
export const NOTIFICATION_MAX_ATTEMPTS =
  NOTIFICATION_RETRY_DELAYS_MS.length + 1;
export function notificationRetryDelay(attempt: number): number {
  return NOTIFICATION_RETRY_DELAYS_MS[
    Math.min(Math.max(attempt - 1, 0), NOTIFICATION_RETRY_DELAYS_MS.length - 1)
  ]!;
}
