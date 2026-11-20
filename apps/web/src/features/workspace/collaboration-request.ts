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
  const body = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(
      Array.isArray(body.message)
        ? body.message.join("；")
        : body.message || "操作失败",
    );
  return body as T;
}
