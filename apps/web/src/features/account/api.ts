import { QueryClient, useQuery } from "@tanstack/react-query";
import { createComikuClient } from "@comiku/api-client";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15000 } },
});
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
if (
  configuredApiBaseUrl &&
  (!/^https?:\/\/[^/]+$/i.test(configuredApiBaseUrl) ||
    configuredApiBaseUrl.endsWith("/"))
) {
  throw new Error("VITE_API_BASE_URL 必须是不含末尾斜杠的 HTTP(S) origin");
}
export const apiBaseUrl = configuredApiBaseUrl;
export const client = createComikuClient(apiBaseUrl);

export function authenticatedFetch(pathOrUrl: string, init?: RequestInit) {
  const isApiPath = pathOrUrl.startsWith("/api/");
  return fetch(isApiPath ? apiBaseUrl + pathOrUrl : pathOrUrl, {
    ...init,
    credentials: isApiPath ? "include" : (init?.credentials ?? "omit"),
  });
}
export async function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.response.status === 401) {
    queryClient.clear();
    queryClient.setQueryData(["me"], null);
  }
  if (!result.response.ok || result.data === undefined) {
    const error = result.error;
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? error.message
        : "请求失败，请稍后重试";
    throw new Error(
      Array.isArray(message) ? message.join("；") : String(message),
    );
  }
  return result.data;
}
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const result = await client.GET("/api/auth/me");
      return result.response.status === 401 ? null : unwrap(result);
    },
    refetchInterval: 60000,
    staleTime: 0,
  });
}
export function useRoles(enabled = true) {
  return useQuery({
    queryKey: ["roles"],
    queryFn: async () => unwrap(await client.GET("/api/users/roles")),
    enabled,
  });
}
