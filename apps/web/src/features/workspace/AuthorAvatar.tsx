import type { components } from "@comiku/api-client";
import { Avatar } from "../../components/Avatar";
import { isDisplayableImageUrl } from "../../components/media-url";
import { client, unwrap } from "../account/api";
import { useQuery } from "@tanstack/react-query";

export function AuthorAvatar({
  author,
}: {
  author: components["schemas"]["AuthorDto"];
}) {
  const query = useQuery({
    queryKey: ["author-avatar", author.id],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/authors/{id}/avatar/url", {
          params: { path: { id: author.id } },
          signal,
        }),
      ),
    enabled: author.avatarAvailable,
    staleTime: 0,
    refetchOnMount: "always",
  });
  return (
    <Avatar
      className="workspace-avatar workspace-avatar--large"
      size="lg"
      name={author.displayName}
      src={
        query.data?.url && isDisplayableImageUrl(query.data.url)
          ? query.data.url
          : undefined
      }
      loading="lazy"
    />
  );
}
