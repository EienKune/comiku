import { SourceResponseError } from "./source-response.js";

export type SourceFailureScope =
  | "credential"
  | "source"
  | "post"
  | "media"
  | "transport"
  | "storage"
  | "protocol"
  | "configuration";
export interface SourceFailureDetails {
  reason: string;
  scope: SourceFailureScope;
  diagnostic?: unknown;
}
const reasons = new Set(
  "unknown_failure auth_failed source_forbidden challenge_required rate_limited network_error source_not_found post_not_found not_found connector_failed cursor_invalid discovery_incomplete limit_reached runtime_unavailable source_identity_conflict source_unresolved process_output_limit process_timeout process_start process_exit invalid_json media_network_error storage_failure invalid_response configuration_error".split(
    " ",
  ),
);
const scopes = new Set(
  "credential source post media transport storage protocol configuration".split(
    " ",
  ),
);
export function controlledFailureDetails(
  details: SourceFailureDetails,
): SourceFailureDetails {
  return Object.freeze({
    reason:
      reasons.has(details.reason) ||
      /^(?:media|request)_http_[1-5][0-9]{2}$/.test(details.reason)
        ? details.reason
        : "unknown_failure",
    scope: scopes.has(details.scope) ? details.scope : "protocol",
    diagnostic: Object.freeze(sanitizeSourceDiagnostic(details.diagnostic)),
  });
}
const fields = new Set(
  "stage guard exception_type runtime_version message traceback field http_status http_method http_endpoint http_response_bytes http_response_headers http_response_excerpt response_excerpt upstream_logs exitCode signal killed timeout duration stderr runId jobId attempt accountId platform adapter page postId mediaId windowStart windowEnd credentialGeneration".split(
    " ",
  ),
);
const headers = new Set(
  "content-type server cf-ray x-request-id x-transaction-id x-rate-limit-limit x-rate-limit-remaining x-rate-limit-reset retry-after request-id rate-limit-limit rate-limit-remaining rate-limit-reset".split(
    " ",
  ),
);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function decoded(value: string, protectBoundaries = false): string {
  for (let i = 0; i < 3; i++) {
    const previous = value;
    let ambiguous = false;
    const part = (text: string) => {
      if (protectBoundaries && /[\s"'<>]/u.test(text)) ambiguous = true;
      return text;
    };
    value = value
      .replace(/\\u([\da-f]{4})/gi, (_, hex: string) =>
        part(String.fromCharCode(parseInt(hex, 16))),
      )
      .replace(/\\([\\"/])/g, (_, text: string) => part(text));
    value = value.replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
      try {
        return part(decodeURIComponent(encoded));
      } catch {
        if (protectBoundaries) ambiguous = true;
        return "[encoded removed]";
      }
    });
    // A decoded delimiter can split an unknown query/JSON secret. Preserve no
    // free text when its original boundaries cannot be proved before decoding.
    if (ambiguous) return "[diagnostic omitted]";
    if (value === previous) break;
    if (protectBoundaries && i === 2) return "[diagnostic omitted]";
  }
  return value;
}
function stripUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[url removed]";
    }
  });
}
function clean(value: string, secrets: readonly string[]): string {
  // Strip raw URL tails before decoding can turn their delimiters into whitespace.
  value = stripUrls(decoded(stripUrls(value), true));
  // Preserve sensitive key boundaries before fragment replacement can erase a key.
  const sensitive =
    /(["']?\b(?:authorization|proxy-authorization|cookie|set-cookie|[\w-]{0,64}(?:token|secret|password|signature|api[_-]?key)[\w-]{0,64})["']?\s*[:=]\s*)[^\r\n]*/gi;
  if (/[\r\n]/.test(value) && sensitive.test(value))
    return "[diagnostic omitted]";
  value = value.replace(sensitive, "$1[credential removed]");
  for (const raw of secrets) {
    const secret = decoded(raw);
    if (!secret) continue;
    value = value.replaceAll(secret, "[credential removed]");
    // Also remove credential fragments already truncated by a subprocess.
    if (secret.length >= 4) {
      const fragments = new Set<string>();
      for (let i = 0; i <= secret.length - 4; i++)
        fragments.add(escape(secret.slice(i, i + 4)));
      value = value.replace(
        new RegExp(`(?:${[...fragments].join("|")})+`, "g"),
        "[credential removed]",
      );
    }
  }
  return value;
}
function cap(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  return (
    Buffer.from(value)
      .subarray(0, bytes - 16)
      .toString("utf8")
      .replace(/\uFFFD$/, "") + " [truncated]"
  );
}
function data(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  ))
    if ("value" in descriptor) result[key] = descriptor.value;
  return result;
}
export function sanitizeSourceDiagnostic(
  input: unknown,
  knownSecrets: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  // Fail closed on exceptional input sizes rather than truncate unsanitized text.
  if (
    knownSecrets.length > 128 ||
    knownSecrets.some((value) => value.length > 1024) ||
    knownSecrets.reduce((sum, value) => sum + value.length, 0) > 65536
  )
    return result;
  const values = data(input);
  if (!values) return result;
  for (const [key, raw] of Object.entries(values)) {
    if (!fields.has(key) || Object.keys(result).length >= 32) continue;
    let value = raw;
    if (typeof value === "string" && value.length > 262144) continue;
    if (key === "http_response_headers") {
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      }
      const allowed: Record<string, string> = {};
      for (const [name, entry] of Object.entries(data(value) ?? {}))
        if (
          headers.has(name.toLowerCase()) &&
          typeof entry === "string" &&
          entry.length <= 262144
        )
          allowed[name.toLowerCase()] = clean(entry, knownSecrets);
      value = JSON.stringify(allowed);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    const entry = cap(clean(String(value), knownSecrets), 16384);
    if (Buffer.byteLength(JSON.stringify({ ...result, [key]: entry })) > 65536)
      continue;
    result[key] = entry;
  }
  return result;
}
/** Unknown exceptions deliberately contribute no arbitrary free text. */
export function sourceDiagnostic(
  error: unknown,
  context: unknown = {},
): Record<string, unknown> {
  const details =
    error instanceof SourceResponseError ? error.details : undefined;
  return {
    ...sanitizeSourceDiagnostic(context),
    reason: details?.reason ?? "unknown_failure",
    failureScope: details?.scope ?? "unknown",
    diagnostic: sanitizeSourceDiagnostic(details?.diagnostic),
  };
}
