import { afterEach, expect, test, vi } from "vitest";
import { client, queryClient } from "./api";
import { renderHook } from "@testing-library/react";
import {
  installSessionActivity,
  useSessionActivity,
} from "./use-session-activity";
import { refreshMemberProfile } from "./profile-cache";
const ok = () => ({ data: { ok: true }, response: new Response() }) as never;
const user = { id: "actor", activityIntervalSeconds: 0.5 };
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  queryClient.clear();
  vi.useRealTimers();
});
function fixture(install = true) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  const listeners = new Map<string, EventListener>();
  vi.spyOn(document, "addEventListener").mockImplementation(
    (kind, listener) => {
      listeners.set(kind, listener as EventListener);
    },
  );
  const remove = vi.spyOn(document, "removeEventListener");
  queryClient.setQueryData(["me"], user);
  if (install) cleanup = installSessionActivity(user);
  return {
    listeners,
    remove,
    setVisibility: (value: DocumentVisibilityState) => (visibility = value),
    send: (kind = "pointerdown", trusted = true) =>
      listeners.get(kind)?.({ isTrusted: trusted } as Event),
  };
}
test("only trusted visible input renews and short-idle requests are throttled without heartbeat timers", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(ok());
  const interval = vi.spyOn(window, "setInterval");
  const f = fixture();
  f.send("pointerdown", false);
  f.setVisibility("hidden");
  f.send();
  expect(post).not.toHaveBeenCalled();
  f.setVisibility("visible");
  expect(post).not.toHaveBeenCalled();
  f.send();
  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
  await Promise.resolve();
  await Promise.resolve();
  vi.setSystemTime(1499);
  f.send("keydown");
  expect(post).toHaveBeenCalledOnce();
  vi.setSystemTime(1500);
  f.send("wheel");
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(interval).not.toHaveBeenCalled();
  cleanup?.();
  vi.setSystemTime(2500);
  f.send();
  expect(post).toHaveBeenCalledTimes(2);
  expect(f.remove).toHaveBeenCalledTimes(3);
});
test("a missing session stops renewal and clears only the same logged-in identity", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    response: new Response(null, { status: 401 }),
    error: { message: "expired" },
  } as never);
  const f = fixture();
  f.send();
  await vi.waitFor(() => expect(queryClient.getQueryData(["me"])).toBeNull());
  vi.setSystemTime(2000);
  f.send();
  expect(post).toHaveBeenCalledOnce();
});
test("old requests cannot clear a newer login and unmount aborts in-flight renewal", async () => {
  let resolve!: (value: never) => void;
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(() => new Promise<never>((r) => (resolve = r)));
  const f = fixture();
  f.send();
  const controllerSignal = (
    post.mock.calls as unknown as [string, { signal: AbortSignal }][]
  )[0][1].signal;
  queryClient.clear();
  const next = { ...user, revision: 2 };
  queryClient.setQueryData(["me"], next);
  cleanup?.();
  expect(controllerSignal.aborted).toBe(true);
  resolve({ response: new Response(null, { status: 401 }) } as never);
  await Promise.resolve();
  expect(queryClient.getQueryData(["me"])).toBe(next);
});
test("a profile response preserves the current auth activity interval", async () => {
  queryClient.setQueryData(["me"], user);
  await refreshMemberProfile({
    id: "actor",
    displayName: "更新后的昵称",
  } as never);
  expect(queryClient.getQueryData(["me"])).toMatchObject({
    id: "actor",
    displayName: "更新后的昵称",
    activityIntervalSeconds: 0.5,
  });
});

test("same-account profile rerenders preserve the activity request throttle", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(ok());
  const f = fixture(false);
  const hook = renderHook(({ identity }) => useSessionActivity(identity), {
    initialProps: { identity: user },
  });
  f.send();
  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
  await Promise.resolve();
  await Promise.resolve();
  vi.setSystemTime(1100);
  hook.rerender({ identity: { ...user } });
  f.send();
  expect(post).toHaveBeenCalledOnce();
  vi.setSystemTime(1500);
  f.send();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  hook.unmount();
});
