import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "../../components/Avatar";
import { apiBaseUrl, client, unwrap } from "./api";

export function MemberAvatar({
  member,
  size,
}: {
  member: { id: string; displayName: string; avatarVersion?: string | null };
  size?: "sm" | "md" | "lg";
}) {
  const refreshedVersion = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["member-avatar", member.id, member.avatarVersion],
    queryFn: async () =>
      unwrap(
        await client.GET("/api/users/{id}/avatar/url", {
          params: { path: { id: member.id } },
        }),
      ),
    enabled: Boolean(member.avatarVersion),
    staleTime: 240000,
    refetchInterval: 240000,
  });
  const url = member.avatarVersion ? query.data?.url : undefined;
  return (
    <Avatar
      name={member.displayName}
      src={url?.startsWith("/api/") ? apiBaseUrl + url : url}
      size={size}
      onError={() => {
        if (
          member.avatarVersion &&
          refreshedVersion.current !== member.avatarVersion
        ) {
          refreshedVersion.current = member.avatarVersion;
          void query.refetch();
        }
      }}
    />
  );
}
