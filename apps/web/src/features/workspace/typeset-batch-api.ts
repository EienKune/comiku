import { queryClient } from "../account/api";

export async function refreshTypesetWork(workId: string) {
  queryClient.removeQueries({
    queryKey: ["translation-editor", workId],
    exact: true,
  });
  await Promise.all(
    ["work", "typeset-versions"]
      .map((prefix) =>
        queryClient.invalidateQueries({ queryKey: [prefix, workId] }),
      )
      .concat(
        ["works", "dashboard", "dashboard-works"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix] }),
        ),
      ),
  );
}
