import {
  controlledFailureDetails,
  type SourceFailureDetails,
} from "./source-diagnostics.js";
/** Only controlled messages cross the adapter boundary; upstream bodies may contain secrets. */
export class SourceResponseError extends Error {
  declare readonly details: SourceFailureDetails | undefined;
  constructor(
    readonly code:
      | "authentication"
      | "rate_limited"
      | "temporary_failure"
      | "configuration"
      | "invalid_response",
    details?: SourceFailureDetails,
  ) {
    const messages = {
      authentication: "图源 身份验证或访问权限失效，请检查凭据及账号授权",
      rate_limited: "图源 请求达到频率限制，请稍后重试",
      temporary_failure: "图源 服务或网络暂时不可用，请稍后重试",
      configuration: "图源 请求配置无效，请检查查询配置及账号信息",
      invalid_response: "图源 响应不完整或格式已变化，本页未推进同步进度",
    };
    super(messages[code]);
    this.name = "SourceResponseError";
    Object.defineProperty(this, "details", {
      value: details ? controlledFailureDetails(details) : undefined,
      enumerable: false,
    });
  }
}

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function requestSourceJson(
  request: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await request();
  } catch {
    throw new SourceResponseError("temporary_failure", {
      reason: "network_error",
      scope: "transport",
      diagnostic: { stage: "request" },
    });
  }
  if (!response.ok) {
    throw new SourceResponseError(
      response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 429
          ? "rate_limited"
          : response.status >= 500 || response.status === 408
            ? "temporary_failure"
            : "configuration",
      {
        reason: `request_http_${response.status}`,
        scope:
          response.status === 401 || response.status === 429
            ? "credential"
            : response.status === 403 || response.status === 404
              ? "source"
              : response.status >= 500 || response.status === 408
                ? "transport"
                : "configuration",
        diagnostic: { stage: "request", http_status: response.status },
      },
    );
  }
  let raw: Record<string, unknown> | null;
  try {
    raw = jsonObject(await response.json());
  } catch {
    throw new SourceResponseError("invalid_response");
  }
  if (!raw) throw new SourceResponseError("invalid_response");
  if ("errors" in raw && (!Array.isArray(raw.errors) || raw.errors.length)) {
    const codes = Array.isArray(raw.errors)
      ? raw.errors.map((entry) => jsonObject(entry)?.code)
      : [];
    throw new SourceResponseError(
      codes.some((code) =>
        [32, 89, 99, 135, 215, 220, 326, 353].includes(Number(code)),
      )
        ? "authentication"
        : codes.some((code) => Number(code) === 88)
          ? "rate_limited"
          : "invalid_response",
    );
  }
  if ("error" in raw || ("title" in raw && !raw.data)) {
    throw new SourceResponseError("invalid_response");
  }
  return raw;
}
