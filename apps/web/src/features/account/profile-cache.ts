import type { CurrentUser, components } from "@comiku/api-client";
import { queryClient } from "./api";

export async function refreshMemberProfile(user: CurrentUser) {
  queryClient.setQueryData<CurrentUser | components["schemas"]["AuthUserDto"]>(
    ["me"],
    (current) => (current?.id === user.id ? { ...current, ...user } : user),
  );
  await Promise.all(
    ["members", "users", "work", "member-avatar"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
