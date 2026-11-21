import { authenticatedFetch } from "../account/api";

export async function collaborationRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET")
    headers.set("X-Comiku-Request", "1");
  const response = await authenticatedFetch(url, { ...init, headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (response.status === 504 || response.status === 408)
      throw new Error("服务器响应超时，请稍后重试");
    if (!response.ok)
      throw new Error(
        `服务暂时无法完成请求（HTTP ${response.status}），请稍后重试`,
      );
    throw new Error("服务器响应异常，请刷新查看当前状态后重试");
  }
  if (!response.ok) {
    const message = body?.message;
    throw new Error(
      Array.isArray(message)
        ? message.join("；")
        : typeof message === "string" && message
          ? message
          : `请求失败（HTTP ${response.status}），请稍后重试`,
    );
  }
  return body as T;
}
