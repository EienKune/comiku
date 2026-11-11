import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
  useEffect(() => {
    if (!active) void client.cancelQueries({ queryKey: ["birthdays", key] });
  }, [active, client, key]);
  useEffect(() => {
    if (!active || (key !== "summary" && key !== "calendar")) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const day = 86_400_000;
      const remaining = day - ((Date.now() + 8 * 3_600_000) % day);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: ["birthdays", key] });
        schedule();
      }, remaining + 100);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, client, key]);
  return useQuery({
    queryKey: ["birthdays", key],
    enabled: active,
    queryFn: ({ signal }) => read(signal),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

export function birthdayError(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}
