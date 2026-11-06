import { SourceResponseError } from "../source-ingestion/source-response.js";

export type ProfileAvatarStage = "missing" | "download" | "store" | "sign";

const networkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** Avatar logs contain controlled scalars only: never URLs or exception text. */
export function profileAvatarDiagnostic(
  stage: ProfileAvatarStage,
  error?: unknown,
): Record<string, string> {
  const details =
    error instanceof SourceResponseError ? error.details : undefined;
  const result: Record<string, string> = {
    stage,
    reason:
      details?.reason ??
      {
        missing: "avatar_url_missing",
        download: "media_network_error",
        store: "storage_failure",
        sign: "avatar_sign_failure",
      }[stage],
    failureScope:
      details?.scope ??
      (stage === "store" || stage === "sign" ? "storage" : "media"),
  };
  if (stage !== "missing") {
    result.exception_type =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof DOMException &&
              ["AbortError", "TimeoutError"].includes(error.name)
            ? error.name
            : "Error";
    for (const candidate of [
      own(error, "code"),
      own(own(error, "cause"), "code"),
    ]) {
      if (typeof candidate === "string" && networkCodes.has(candidate)) {
        result.error_code = candidate;
        break;
      }
    }
  }
  // Controlled source errors can still contain a URL or private upstream text.
  // Retain only numeric HTTP/policy evidence at this narrower log boundary.
  for (const field of [
    "http_status",
    "limit_bytes",
    "declared_bytes",
    "observed_bytes",
  ]) {
    const value = own(details?.diagnostic, field);
    if (typeof value === "string" && /^\d{1,15}$/.test(value))
      result[field] = value;
  }
  return result;
}
