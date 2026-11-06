import type { components } from "@comiku/api-client";
import { client, unwrap } from "../account/api";
type Candidate = components["schemas"]["CandidateDto"];
export type ManualCandidateDraft = {
  authorId: string;
  text: string;
  sourceUrl: string;
  media: Candidate["media"];
};
/** Page-local checkpoints advance immediately after each authoritative response. */
export class ManualUploadCheckpoints {
  private current = new Map<string, Candidate>();
  private imported = new Set<string>();
  isImported(id: string) {
    return this.imported.has(id);
  }
  canConfirm(items: Candidate[], drafts: Record<string, ManualCandidateDraft>) {
    return (
      items.length > 0 &&
      items.every(
        (item) =>
          this.imported.has(item.id) || Boolean(drafts[item.id]?.authorId),
      )
    );
  }
  async confirm(
    items: Candidate[],
    drafts: Record<string, ManualCandidateDraft>,
    destination: "direct" | "candidate",
  ) {
    const candidates: Candidate[] = [];
    for (const initial of items) {
      if (this.imported.has(initial.id)) continue;
      const draft = drafts[initial.id];
      if (!draft?.authorId) throw Error("请明确选择每个图组的作者");
      let current = this.current.get(initial.id) ?? initial;
      const mediaIds = draft.media.map((item) => item.id);
      if (
        mediaIds.length !== current.media.length ||
        mediaIds.some((id, index) => id !== current.media[index]?.id)
      ) {
        current = await unwrap(
          await client.POST("/api/candidates/{id}/media-order", {
            params: { path: { id: current.id } },
            body: { expectedRevision: current.revision, mediaIds },
          }),
        );
        this.current.set(current.id, current);
      }
      if (
        draft.authorId !== current.authorId ||
        draft.text.trim() !== (current.text ?? "") ||
        draft.sourceUrl.trim() !== (current.externalPostUrl ?? "")
      ) {
        current = await unwrap(
          await client.PATCH("/api/candidates/{id}/manual-metadata", {
            params: { path: { id: current.id } },
            body: {
              authorId: draft.authorId,
              text: draft.text.trim() || null,
              sourceUrl: draft.sourceUrl.trim() || null,
              expectedRevision: current.revision,
            },
          }),
        );
        this.current.set(current.id, current);
      }
      candidates.push(current);
    }
    if (destination === "direct" && candidates.length) {
      const result = await unwrap(
        await client.POST("/api/candidates/actions", {
          body: {
            action: "import",
            items: candidates.map(({ id, revision }) => ({
              id,
              expectedRevision: revision,
            })),
          },
        }),
      );
      for (const item of result.results)
        if (["succeeded", "unchanged"].includes(item.outcome))
          this.imported.add(item.id);
      const failures = candidates.filter(
        (candidate) => !this.imported.has(candidate.id),
      );
      if (failures.length)
        throw Error(
          `${failures.length} 个图组未能直接入库，请重试或在候选池检查`,
        );
    }
  }
}
