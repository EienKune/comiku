import { useImageUrl } from "../../components/use-image-url";
import { client, unwrap } from "../account/api";
export function useWorkImageUrl(
  workId: string,
  imageId: string | undefined,
  variant: "thumbnail" | "original" = "thumbnail",
  enabled = true,
) {
  return useImageUrl(
    [variant, "series-work-image", workId, imageId],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: { path: { workId, imageId: imageId! }, query: { variant } },
        }),
      ),
    Boolean(imageId) && enabled,
  );
}
