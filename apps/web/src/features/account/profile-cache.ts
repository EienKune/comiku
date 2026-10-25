import type { CurrentUser } from "@comiku/api-client";
import { queryClient } from "./api";

export async function refreshMemberProfile(user: CurrentUser) {
  queryClient.setQueryData(["me"], user);
  await Promise.all(
    ["members", "users", "work", "member-avatar"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
