import type { components } from "@comiku/api-client";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../account/api";
type Configuration = components["schemas"]["WorkReminderManagementDto"];
export const workReminderKey = ["work-reminders"];
export function useWorkReminderConfiguration(
  enabled: boolean,
  panel: "subscriptions" | "template",
) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: [...workReminderKey, panel],
    enabled,
    queryFn: async ({ signal }): Promise<Configuration> =>
      unwrap(await client.GET("/api/notifications/work-reminders", { signal })),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (
      !enabled &&
      !cache
        .getQueryCache()
        .find({ queryKey: [...workReminderKey, panel], exact: true })
        ?.isActive()
    )
      void cache.cancelQueries({ queryKey: [...workReminderKey, panel] });
  }, [enabled, cache, panel]);
  return query;
}
