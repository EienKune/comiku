import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client, unwrap } from "../account/api";

export type CandidateBaseFilter = Pick<
  components["schemas"]["CreateCandidateReviewSessionDto"],
  "status" | "search" | "sourceLanguage" | "fetchedAfter"
>;

/** One scope owns one membership snapshot; all sections share it. */
export function useCandidateReviewSession(filter: CandidateBaseFilter) {
  const cache = useQueryClient();
  const key = ["candidate-review-session", filter] as const;
  const scope = JSON.stringify(filter);
  const active = useRef({ scope, generation: 0 });
  if (active.current.scope !== scope)
    active.current = { scope, generation: active.current.generation + 1 };
  const generation = active.current.generation;
  const pending = useRef<{ generation: number; promise: Promise<void> } | null>(
    null,
  );
  const [state, setState] = useState<{
    generation: number;
    refreshing: boolean;
    error: string | null;
  }>({ generation, refreshing: false, error: null });
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
      if (pending.current?.generation === generation)
        return pending.current.promise;
      const current = cache.getQueryData<
        components["schemas"]["CandidateReviewSessionDto"]
      >(["candidate-review-session", filter]);
      if (expiredSessionId && current?.sessionId !== expiredSessionId)
        return Promise.resolve();
      setState({ generation, refreshing: true, error: null });
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
          if (active.current.generation === generation)
            cache.setQueryData(["candidate-review-session", filter], next);
        } catch (failure) {
          if (active.current.generation === generation)
            setState({
              generation,
              refreshing: true,
              error:
                failure instanceof Error ? failure.message : "刷新列表失败",
            });
        } finally {
          if (pending.current?.generation === generation) {
            pending.current = null;
            if (active.current.generation === generation)
              setState((current) => ({ ...current, refreshing: false }));
          }
        }
      })();
      pending.current = { generation, promise };
      return promise;
    },
    [cache, filter, generation],
  );
  return {
    session: query.data,
    refresh,
    refreshing: state.generation === generation && state.refreshing,
    error:
      (state.generation === generation ? state.error : null) ??
      query.error?.message,
    isPending: query.isPending,
  };
}
