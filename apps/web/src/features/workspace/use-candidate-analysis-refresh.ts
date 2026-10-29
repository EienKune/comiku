import { useEffect } from "react";
import {
  focusManager,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { components } from "@comiku/api-client";

/** Analysis can move a candidate between sections; refresh their shared view. */
export function useCandidateAnalysisRefresh() {
  const client = useQueryClient();
  useEffect(() => {
    const cache = client.getQueryCache();
    const prefix = ["candidates", "pending"] as const;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pendingFinalRefresh = false;
    const refresh = () => {
      if (!focusManager.isFocused()) return;
      void client.invalidateQueries(
        { queryKey: prefix, type: "active" },
        { cancelRefetch: false },
      );
    };
    const sync = () => {
      const queries = cache.findAll({ queryKey: prefix, type: "active" });
      const queued = queries.some((query) => {
        const data = query.state.data as
          | InfiniteData<
              components["schemas"]["CandidatePageDto"] & {
                analysisPending?: boolean;
              }
            >
          | undefined;
        return data?.pages.some(
          (page) =>
            page.analysisPending ??
            page.items.some((item) => item.reviewPriority === "queued"),
        );
      });
      if (queued && timer === undefined) timer = setInterval(refresh, 5000);
      else if (!queued && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
        pendingFinalRefresh = true;
      }
      // Initial queries without cached data can reuse an older in-flight response.
      // Wait for that response, then fetch again; retain this intent in background.
      if (
        pendingFinalRefresh &&
        focusManager.isFocused() &&
        queries.every((query) => query.state.fetchStatus === "idle")
      ) {
        pendingFinalRefresh = false;
        refresh();
      }
    };
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.query.queryKey[0] === prefix[0] &&
        event.query.queryKey[1] === prefix[1]
      )
        sync();
    });
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) {
        sync();
        if (timer !== undefined) refresh();
      }
    });
    sync();
    return () => {
      unsubscribe();
      unsubscribeFocus();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [client]);
}
