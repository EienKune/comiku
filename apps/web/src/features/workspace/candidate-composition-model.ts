import {
  buildCandidateImportIntent,
  settleCandidateImport,
  type CandidateImportEntry,
  type CandidateImportState,
} from "./candidate-import-state";
import type { components } from "@comiku/api-client";

export type CompositionMode = "merge" | "split";
export type CompositionGroup = {
  id: string;
  title: string;
  mediaIds: string[];
};
export type CompositionDraft = {
  mode: CompositionMode;
  sources: CandidateImportEntry[];
  excludedCandidateIds: string[];
  groups: CompositionGroup[];
  version: number;
};
export type CompositionIntent = components["schemas"]["ComposeCandidatesDto"];

export function compositionEligibility(
  state: CandidateImportState,
  mode: CompositionMode,
) {
  const candidates = [...state.selected.values()].map(
    (entry) => entry.candidate,
  );
  if (mode === "merge" && candidates.length < 2) return "至少选择 2 个帖子";
  if (mode === "split" && candidates.length !== 1)
    return "拆分入库一次只处理 1 个帖子";
  if (candidates.length > 20) return "每次最多处理 20 个来源帖";
  if (candidates.some((candidate) => candidate.status !== "pending"))
    return "仅待处理帖子可以拆分或合并入库";
  if (new Set(candidates.map((candidate) => candidate.authorId)).size !== 1)
    return "所选帖子作者不同，无法合并";
  if (mode === "split" && candidates[0].media.length < 2)
    return "单图帖子无法拆分入库";
  if (
    candidates.reduce((count, candidate) => count + candidate.media.length, 0) >
    1000
  )
    return "来源图片总数不能超过 1000 张";
  try {
    buildCandidateImportIntent(state);
  } catch (error) {
    return error instanceof Error ? error.message : "图片草稿需要重新检查";
  }
  return "";
}

export function createCompositionDraft(
  state: CandidateImportState,
  mode: CompositionMode,
): CompositionDraft {
  const reason = compositionEligibility(state, mode);
  if (reason) throw new Error(reason);
  const sources = buildCandidateImportIntent(state).sort((a, b) => {
    const left = Date.parse(a.candidate.postedAt),
      right = Date.parse(b.candidate.postedAt);
    return (
      (Number.isFinite(left) && Number.isFinite(right) ? left - right : 0) ||
      a.id.localeCompare(b.id)
    );
  });
  return {
    mode,
    sources,
    excludedCandidateIds: [],
    groups: [
      {
        id: "work-1",
        title: "",
        mediaIds: sources.flatMap((source) => source.mediaIds),
      },
    ],
    version: 0,
  };
}

export function compositionSources(draft: CompositionDraft) {
  return draft.sources.filter(
    (source) => !draft.excludedCandidateIds.includes(source.id),
  );
}
export function compositionMedia(draft: CompositionDraft) {
  return compositionSources(draft).flatMap((source) =>
    source.candidate.media.map((media) => media.id),
  );
}
export function compositionMediaDetails(draft: CompositionDraft) {
  return new Map(
    draft.sources.flatMap((source, sourceIndex) =>
      source.candidate.media.map(
        (media, mediaIndex) =>
          [
            media.id,
            { candidate: source.candidate, sourceIndex, mediaIndex },
          ] as const,
      ),
    ),
  );
}
export function compositionUnadopted(draft: CompositionDraft) {
  const adopted = new Set(draft.groups.flatMap((group) => group.mediaIds));
  return compositionMedia(draft).filter((id) => !adopted.has(id));
}
export function compositionProblem(draft: CompositionDraft) {
  const sources = compositionSources(draft),
    validIds = new Set(compositionMedia(draft));
  const ids = draft.groups.flatMap((group) => group.mediaIds);
  if (sources.length > 20 || validIds.size > 1000 || draft.groups.length > 20)
    return "超过单次入库数量限制";
  if (new Set(ids).size !== ids.length || ids.some((id) => !validIds.has(id)))
    return "图片归属已变化，请重新检查";
  if (draft.mode === "merge") {
    if (sources.length < 2) return "合并至少保留 2 个帖子";
    if (
      sources.some(
        (source) =>
          !source.candidate.media.some((media) => ids.includes(media.id)),
      )
    )
      return "有帖子未采用图片，请先明确移出本次合并";
    if (draft.groups.length !== 1) return "合并只创建 1 部作品";
  } else {
    if (sources.length !== 1) return "拆分入库一次只处理 1 个帖子";
    if (draft.groups.some((group) => !group.mediaIds.length))
      return "请为每部作品移入图片，或移除空作品";
    if (draft.groups.length < 2)
      return "至少分成 2 部作品；只有一部时请使用普通入库";
    if (draft.groups.some((group) => !group.title.trim()))
      return "请为每部作品填写名称";
  }
  if (draft.groups.some((group) => group.title.trim().length > 200))
    return "作品名称最多 200 个字符";
  return ids.length ? "" : "请至少采用 1 张图片";
}

export function assignCompositionImages(
  draft: CompositionDraft,
  mediaIds: readonly string[],
  targetGroupId: string | null,
): CompositionDraft {
  const valid = new Set(compositionMedia(draft));
  if (
    !mediaIds.length ||
    new Set(mediaIds).size !== mediaIds.length ||
    mediaIds.some((id) => !valid.has(id)) ||
    (targetGroupId !== null &&
      !draft.groups.some((group) => group.id === targetGroupId))
  )
    return draft;
  const moving = new Set(mediaIds);
  return {
    ...draft,
    version: draft.version + 1,
    groups: draft.groups.map((group) => ({
      ...group,
      mediaIds: [
        ...group.mediaIds.filter((id) => !moving.has(id)),
        ...(group.id === targetGroupId ? mediaIds : []),
      ],
    })),
  };
}
export function excludeCompositionSource(
  draft: CompositionDraft,
  candidateId: string,
  excluded: boolean,
): CompositionDraft {
  const source = draft.sources.find((entry) => entry.id === candidateId);
  if (
    draft.mode !== "merge" ||
    !source ||
    draft.excludedCandidateIds.includes(candidateId) === excluded
  )
    return draft;
  if (
    excluded &&
    draft.groups.some((group) =>
      group.mediaIds.some((id) =>
        source.candidate.media.some((media) => media.id === id),
      ),
    )
  )
    return draft;
  return {
    ...draft,
    version: draft.version + 1,
    excludedCandidateIds: excluded
      ? [...draft.excludedCandidateIds, candidateId]
      : draft.excludedCandidateIds.filter((id) => id !== candidateId),
    groups: excluded
      ? draft.groups
      : draft.groups.map((group, index) =>
          index === 0
            ? { ...group, mediaIds: [...group.mediaIds, ...source.mediaIds] }
            : group,
        ),
  };
}
export function removeCompositionGroup(
  draft: CompositionDraft,
  groupId: string,
): CompositionDraft {
  if (
    draft.mode !== "split" ||
    !draft.groups.some((group) => group.id === groupId)
  )
    return draft;
  return {
    ...draft,
    version: draft.version + 1,
    groups: draft.groups.filter((group) => group.id !== groupId),
  };
}
export function compositionIntent(
  draft: CompositionDraft,
  idempotencyKey: string,
): CompositionIntent {
  const reason = compositionProblem(draft);
  if (reason) throw new Error(reason);
  return {
    idempotencyKey,
    mode: draft.mode,
    candidates: compositionSources(draft).map(({ id, expectedRevision }) => ({
      id,
      expectedRevision,
    })),
    works: draft.groups.map((group) => ({
      title: group.title.trim() || null,
      mediaIds: [...group.mediaIds],
    })),
  };
}
export function settleCompositionSources(
  state: CandidateImportState,
  sources: readonly CandidateImportEntry[],
) {
  return settleCandidateImport(
    state,
    sources,
    sources.map((source) => ({ id: source.id, outcome: "succeeded" })),
  );
}
