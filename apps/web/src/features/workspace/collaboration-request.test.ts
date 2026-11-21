import { afterEach, expect, test, vi } from "vitest";
import { collaborationRequest } from "./collaboration-request";

afterEach(() => vi.unstubAllGlobals());

test.each([
  [504, "<!doctype html><title>Gateway Timeout</title>", "服务器响应超时"],
  [502, "<html>upstream</html>", "HTTP 502"],
  [200, "<!doctype html><title>SPA</title>", "服务器响应异常"],
  [409, '{"message":["作品已更新","请重新核对"]}', "作品已更新；请重新核对"],
])("turns HTTP %s into usable feedback", async (status, body, message) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(body, { status })),
  );
  await expect(collaborationRequest("/api/works/test")).rejects.toThrow(
    message,
  );
});

test("an empty successful response still completes the operation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  await expect(collaborationRequest("/api/works/test")).resolves.toEqual({});
});
