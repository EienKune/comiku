import type { components } from "@comiku/api-client";
import { workPageAssignments } from "./page-workflow";

type Work = components["schemas"]["WorkDetailDto"];
type Participant = Work["participants"][number];

/** Membership identity is the account, never its nickname or temporary credit. */
export function stageSummaryMembers(
  work: Work,
  stage: "translate" | "proofread" | "typeset",
): Participant[] {
  const byUser = new Map<string, Participant>();
  const byId = new Map(work.participants.map((person) => [person.id, person]));
  for (const person of work.participants) {
    if (person.stage !== stage || person.leftAt) continue;
    const previous = byUser.get(person.userId);
    if (
      !previous ||
      (!person.submittedAt && previous.submittedAt) ||
      (Boolean(person.submittedAt) === Boolean(previous.submittedAt) &&
        person.joinedAt > previous.joinedAt)
    )
      byUser.set(person.userId, person);
  }
  // Current ownership is authoritative, even if a compatibility membership is exited.
  for (const assignment of workPageAssignments(work)) {
    if (
      assignment.stage !== stage ||
      !assignment.userId ||
      byUser.has(assignment.userId)
    )
      continue;
    const owner = assignment.participantId
      ? byId.get(assignment.participantId)
      : undefined;
    if (owner && owner.userId === assignment.userId && owner.stage === stage)
      byUser.set(owner.userId, owner);
  }
  return [...byUser.values()].sort((left, right) =>
    left.joinedAt.localeCompare(right.joinedAt),
  );
}
