import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client, unwrap } from "../account/api";

export type CandidateBaseFilter = Pick<
  components["schemas"]["CreateCandidateReviewSessionDto"],
  "status" | "search" | "sourceLanguage" | "fetchedAfter"
>;

/** One scope owns one membership snapshot; all four sections share it. */
export function useCandidateReviewSession(filter: CandidateBaseFilter) {
  const cache = useQueryClient();
  const key = ["candidate-review-session", filter] as const;
  const scope = JSON.stringify(filter);
  const pending = useRef<{ scope: string; promise: Promise<void> } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: key,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      unwrap(
        await client.POST("/api/candidates/review-sessions", {
          body: { ...filter, limit: 24, idempotencyKey: crypto.randomUUID() },
        }),
      ),
  });
  const refresh = useCallback(
    (expiredSessionId?: string): Promise<void> => {
      if (pending.current?.scope === scope) return pending.current.promise;
      const current = cache.getQueryData<
        components["schemas"]["CandidateReviewSessionDto"]
      >(["candidate-review-session", filter]);
      if (expiredSessionId && current?.sessionId !== expiredSessionId)
        return Promise.resolve();
      setRefreshing(true);
      setError(null);
      const promise = (async () => {
        try {
          const next = await unwrap(
            await client.POST("/api/candidates/review-sessions", {
              body: {
                ...filter,
                limit: 24,
                idempotencyKey: crypto.randomUUID(),
                ...(current ? { replaceSessionId: current.sessionId } : {}),
              },
            }),
          );
          cache.setQueryData(["candidate-review-session", filter], next);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "刷新列表失败");
        } finally {
          if (pending.current?.scope === scope) {
            pending.current = null;
            setRefreshing(false);
          }
        }
      })();
      pending.current = { scope, promise };
      return promise;
    },
    [cache, filter, scope],
  );
  return {
    session: query.data,
    refresh,
    refreshing,
    error: error ?? query.error?.message,
    isPending: query.isPending,
  };
}
