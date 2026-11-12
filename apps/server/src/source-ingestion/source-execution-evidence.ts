/** Small protocol facts only. Never persist upstream messages, URLs or response bodies here. */
export interface SourceExecutionEvidence {
  exceptionType?: string;
  missingField?: string;
  responseBytes?: number;
  responseFormat?: string;
  requestOperation?: string;
  runtimeVersion?: string;
  exitCode?: number;
  signal?: string;
  transportError?: string;
}
const exceptions = new Set(
  "KeyError ValueError TypeError JSONDecodeError AdapterError AbortExtraction HttpError RequestException ConnectionError ReadTimeout ConnectTimeout Timeout SSLError OSError Error FetchError AbortError TimeoutError".split(
    " ",
  ),
);
const fields = new Set(
  "result data user users id legacy timeline timeline_v2 instructions entries content media rest_id created_at date".split(
    " ",
  ),
);
const operations = new Set([
  "UserTweets",
  "UserMedia",
  "TweetDetail",
  "UserByScreenName",
  "UserByRestId",
  "UserResultByScreenName",
  "user/illusts",
  "user/detail",
  "illust/detail",
  "auth/token",
]);
const formats = new Set(["empty", "json", "html", "text", "binary"]);
const signals = new Set(
  "SIGHUP SIGINT SIGTERM SIGKILL SIGABRT SIGSEGV".split(" "),
);
const transportErrors = new Set([
  "tls_unexpected_eof",
  "tls_certificate",
  "connection_reset",
  "connection_refused",
  "dns_error",
  "connect_timeout",
  "read_timeout",
]);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;

/** Also used when reading historical JSON: stored data is not an API trust boundary. */
export function sourceExecutionEvidence(
  input: Record<string, unknown>,
): SourceExecutionEvidence {
  const output: SourceExecutionEvidence = {};
  for (const [key, allowed] of [
    ["exceptionType", exceptions],
    ["missingField", fields],
    ["requestOperation", operations],
    ["responseFormat", formats],
    ["signal", signals],
    ["transportError", transportErrors],
  ] as const) {
    const value = input[key];
    if (typeof value === "string" && allowed.has(value)) output[key] = value;
  }
  if (integer(input.responseBytes))
    output.responseBytes = input.responseBytes as number;
  if (integer(input.exitCode, 255)) output.exitCode = input.exitCode as number;
  if (
    typeof input.runtimeVersion === "string" &&
    /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(input.runtimeVersion)
  )
    output.runtimeVersion = input.runtimeVersion;
  return output;
}

export function nativeExecutionEvidence(
  input: Record<string, unknown>,
): SourceExecutionEvidence {
  const number = (value: unknown) =>
    typeof value === "string" && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value;
  let operation: string | undefined;
  try {
    const url = new URL(String(input.http_endpoint));
    if (
      ["x.com", "api.x.com", "twitter.com", "api.twitter.com"].includes(
        url.hostname,
      )
    )
      operation = url.pathname.split("/").at(-1);
    if (["app-api.pixiv.net", "oauth.secure.pixiv.net"].includes(url.hostname))
      operation = url.pathname.replace(/^\/v\d+\//, "").replace(/^\//, "");
  } catch {
    /* No untrusted endpoint is retained. */
  }
  let format: string | undefined;
  try {
    const headers: unknown =
      typeof input.http_response_headers === "string"
        ? JSON.parse(input.http_response_headers)
        : input.http_response_headers;
    const type =
      headers && typeof headers === "object" && "content-type" in headers
        ? String(headers["content-type"]).split(";", 1)[0].trim().toLowerCase()
        : "";
    format = type.includes("json")
      ? "json"
      : type === "text/html"
        ? "html"
        : type.startsWith("text/")
          ? "text"
          : type
            ? "binary"
            : undefined;
  } catch {
    /* Malformed headers contribute no content-format assertion. */
  }
  const responseBytes = number(input.http_response_bytes);
  const message =
    typeof input.message === "string" ? input.message.slice(0, 16384) : "";
  const transportError = /UNEXPECTED_EOF_WHILE_READING/.test(message)
    ? "tls_unexpected_eof"
    : /CERTIFICATE_VERIFY_FAILED/.test(message)
      ? "tls_certificate"
      : /ConnectionResetError|ECONNRESET|Connection reset by peer/.test(message)
        ? "connection_reset"
        : /ConnectionRefusedError|ECONNREFUSED/.test(message)
          ? "connection_refused"
          : /NameResolutionError|ENOTFOUND|Temporary failure in name resolution/.test(
                message,
              )
            ? "dns_error"
            : /ConnectTimeout/.test(message)
              ? "connect_timeout"
              : /ReadTimeout/.test(message)
                ? "read_timeout"
                : undefined;
  return sourceExecutionEvidence({
    exceptionType: input.exception_type,
    missingField: input.field,
    responseBytes,
    responseFormat: responseBytes === 0 ? "empty" : format,
    requestOperation: operation,
    runtimeVersion: input.runtime_version,
    exitCode: number(input.exitCode),
    signal: input.signal,
    transportError,
  });
}
