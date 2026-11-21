import { useImageUrl } from "../../components/use-image-url";
import { client, unwrap } from "../account/api";
export function workImageKey(
  workId: string,
  imageId: string | null | undefined,
) {
  return ["work-image", workId, imageId] as const;
}

export function useWorkImageUrl(
  workId: string,
  imageId: string | null | undefined,
  variant: "thumbnail" | "original" = "thumbnail",
  enabled = true,
) {
  return useImageUrl(
    [...workImageKey(workId, imageId), variant],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: { path: { workId, imageId: imageId! }, query: { variant } },
        }),
      ),
    Boolean(imageId) && enabled,
  );
}
