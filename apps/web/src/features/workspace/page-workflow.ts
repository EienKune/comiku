import type { components } from "@comiku/api-client";
import { authenticatedFetch, unwrap } from "../account/api";

type Work = components["schemas"]["WorkDetailDto"];
export type PageAssignment = {
  id: string;
  workImageId: string;
  stage: string;
  participantId: string | null;
  userId: string | null;
  generation: number;
  draftRevision: number;
  submittedAt: string | null;
};

export function workPageAssignments(work: Work): PageAssignment[] {
  return (
    (
      work as Work & { pageAssignments?: PageAssignment[] }
    ).pageAssignments?.filter((page) => page.participantId && page.userId) ??
    work.participants
      .filter((person) => !person.leftAt)
      .flatMap((person) =>
        person.assignedImageIds.map((workImageId) => ({
          id: `${person.id}:${workImageId}`,
          workImageId,
          stage: person.stage,
          participantId: person.id,
          userId: person.userId,
          generation: 0,
          draftRevision: 0,
          submittedAt: person.submittedAt,
        })),
      )
  );
}

export function pageNumbers(
  work: Pick<Work, "images">,
  ids: readonly string[],
) {
  return work.images
    .flatMap((image, index) => (ids.includes(image.id) ? [index + 1] : []))
    .join("、");
}

export async function releaseSupplements(
  workId: string,
  participantId?: string,
) {
  if (!participantId) return [];
  const response = await authenticatedFetch(
    `/api/works/${workId}/typeset/collaboration`,
  );
  const data = await response.json();
  const state = await unwrap<{
    drafts: {
      id: string;
      participantId: string;
      workImageId: string | null;
      sourceName: string;
    }[];
  }>({ response, ...(response.ok ? { data } : { error: data }) });
  return state.drafts.filter(
    (draft) =>
      draft.participantId === participantId && draft.workImageId === null,
  );
}
