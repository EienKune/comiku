import type { NotificationSendDiagnostics } from "./notifications.contracts.js";

/** Copy only protocol numbers, including when an adapter supplies extra fields. */
export function safeNotificationSendDiagnostics(
  value: unknown,
): NotificationSendDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { httpStatus, retcode } = value as Record<string, unknown>;
  const safe: NotificationSendDiagnostics = {};
  if (
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
  )
    safe.httpStatus = httpStatus;
  if (
    typeof retcode === "number" &&
    Number.isSafeInteger(retcode) &&
    retcode >= -2_147_483_648 &&
    retcode <= 2_147_483_647
  )
    safe.retcode = retcode;
  return safe;
}
