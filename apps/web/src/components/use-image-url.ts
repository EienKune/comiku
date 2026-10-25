import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { useAccount } from "../features/account/account-context";

type ImageUrl = components["schemas"]["ImageUrlDto"];
export function imageUrlPollInterval(
  data: Pick<ImageUrl, "status" | "expiresInSeconds"> | undefined,
  count: number,
) {
  if (!data) return false;
  if (data.status === "queued" || data.status === "processing")
    return count < 12 ? 2_000 : false;
  return Math.max(1_000, (data.expiresInSeconds - 30) * 1_000);
}

export function useImageUrl(
  key: readonly unknown[],
  load: () => Promise<ImageUrl>,
  enabled = true,
) {
  const user = useAccount();
  return useQuery({
    queryKey: [...key, user.id],
    queryFn: load,
    enabled,
    staleTime: (query) =>
      Math.max(0, ((query.state.data?.expiresInSeconds ?? 0) - 30) * 1_000),
    refetchInterval: (query) =>
      imageUrlPollInterval(query.state.data, query.state.dataUpdateCount),
  });
}
