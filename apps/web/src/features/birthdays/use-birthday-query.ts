import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const shanghaiDay = (timestamp: number) =>
  Math.floor((timestamp + 8 * 3_600_000) / 86_400_000);

export function useBirthdayVisibility(enabled: boolean) {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return enabled && visible;
}

export function useBirthdayQuery<T>(
  key: string,
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<T>,
) {
  const active = useBirthdayVisibility(enabled);
  const client = useQueryClient();
  const daily = key === "summary" || key === "calendar";
  const lastActiveDay = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !daily) return;
    const day = shanghaiDay(Date.now());
    if (lastActiveDay.current !== null && lastActiveDay.current !== day) {
      // Enabling the observer performs the fetch. Only mark this key stale so
      // resuming cannot cancel and restart that request, or wake a lazy panel.
      const cached = client.getQueryState(["birthdays", key]);
      if (cached?.dataUpdatedAt && shanghaiDay(cached.dataUpdatedAt) !== day)
        void client.invalidateQueries({
          queryKey: ["birthdays", key],
          exact: true,
          refetchType: "none",
        });
    }
    lastActiveDay.current = day;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const day = 86_400_000;
      const remaining = day - ((Date.now() + 8 * 3_600_000) % day);
      timer = setTimeout(() => {
        lastActiveDay.current = shanghaiDay(Date.now());
        void client.invalidateQueries({ queryKey: ["birthdays", key] });
        schedule();
      }, remaining + 100);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, client, daily, key]);
  const query = useQuery({
    queryKey: ["birthdays", key],
    enabled: active,
    queryFn: ({ signal }) => read(signal),
    refetchOnWindowFocus: false,
    staleTime: (query) =>
      daily &&
      shanghaiDay(query.state.dataUpdatedAt) !== shanghaiDay(Date.now())
        ? 0
        : 60_000,
  });
  useEffect(() => {
    if (
      !active &&
      !client
        .getQueryCache()
        .find({ queryKey: ["birthdays", key], exact: true })
        ?.isActive()
    )
      void client.cancelQueries({ queryKey: ["birthdays", key], exact: true });
  }, [active, client, key]);
  return query;
}

export function birthdayError(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}
