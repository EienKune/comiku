import { queryClient } from "../account/api";
export async function refreshReviewViews(workId: string) {
  await Promise.all(
    [
      "works",
      "dashboard",
      "dashboard-works",
      "reviews",
      "review",
      "work",
      "translation-editor",
      "typeset-versions",
      "typeset-handoff-manifest",
      "publishing",
      "typeset-upload-session",
    ].map((key) =>
      queryClient.invalidateQueries({
        queryKey: [key],
        predicate: (query) =>
          [
            "work",
            "translation-editor",
            "typeset-versions",
            "publishing",
          ].includes(key)
            ? query.queryKey.includes(workId)
            : true,
      }),
    ),
  );
}
