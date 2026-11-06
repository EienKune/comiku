import { useEffect } from "react";
import { client, queryClient } from "./api";
type Identity = { id: string; activityIntervalSeconds?: number };
/** No heartbeat: only trusted input in a visible document may renew the idle deadline. */
export function installSessionActivity(user: Identity) {
  const seconds = user.activityIntervalSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return () => {};
  let stopped = false,
    nextAttempt = -Infinity,
    pending: AbortController | null = null;
  const kinds = ["pointerdown", "keydown", "wheel"] as const;
  const stop = () => {
    stopped = true;
    for (const kind of kinds) document.removeEventListener(kind, activity);
    pending?.abort();
  };
  const activity = (event: Event) => {
    if (
      stopped ||
      !event.isTrusted ||
      document.visibilityState !== "visible" ||
      pending ||
      Date.now() < nextAttempt
    )
      return;
    const identity = queryClient.getQueryData<Identity>(["me"]);
    if (!identity || identity.id !== user.id) return;
    const controller = new AbortController();
    pending = controller;
    nextAttempt = Date.now() + seconds * 1000;
    void client
      .POST("/api/auth/activity", { body: {}, signal: controller.signal })
      .then((result) => {
        if (
          !stopped &&
          result.response.status === 401 &&
          queryClient.getQueryData(["me"]) === identity
        ) {
          stop();
          queryClient.clear();
          queryClient.setQueryData(["me"], null);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (pending === controller) pending = null;
      });
  };
  for (const kind of kinds)
    document.addEventListener(kind, activity, { passive: true });
  return stop;
}
export function useSessionActivity(user: Identity | null | undefined) {
  const id = user?.id,
    interval = user?.activityIntervalSeconds;
  useEffect(
    () =>
      id
        ? installSessionActivity({ id, activityIntervalSeconds: interval })
        : undefined,
    [id, interval],
  );
}
