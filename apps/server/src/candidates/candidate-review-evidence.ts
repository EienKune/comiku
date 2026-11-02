import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type {
  CandidateTagRuleMatchDto,
  CandidateTriageGroup,
  CandidateTriageReason,
} from "./candidates.dto.js";
import type { CandidateAnalysisPolicy } from "./candidate-query.js";

export const CANDIDATE_REVIEW_POLICY_VERSION = 2;
export interface CandidateTagRule {
  normalizedValue: string;
  groupId: string;
  groupName: string;
  groupRevision: number;
  direction: "priority" | "deprioritize";
}
export interface CandidateReviewReason {
  hashtags: string[];
  tagRuleMatches: CandidateTagRuleMatchDto[];
  triageReasons: CandidateTriageReason[];
  modelPositive: boolean;
  allLow: boolean;
}
export interface CandidateReviewRow {
  id: string;
  triage_group: CandidateTriageGroup;
  reason_json: CandidateReviewReason;
  representative_class?: string | null;
}
export function candidateReviewPolicyKey(policy: CandidateAnalysisPolicy) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CANDIDATE_REVIEW_POLICY_VERSION,
        policy.modelKey,
        policy.labels,
        policy.positiveLabels,
        policy.lowPriorityLabels ?? [],
      ]),
    )
    .digest("hex");
}
/** One MVCC statement captures group metadata and its aliases together. */
export async function candidateTagRules(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
) {
  const rules = await db.$queryRaw<
    CandidateTagRule[]
  >`SELECT a.normalized_value AS "normalizedValue",g.id AS "groupId",g.name AS "groupName",g.revision AS "groupRevision",CASE WHEN g.kind='valid' THEN 'priority' ELSE 'deprioritize' END AS direction FROM candidate_tag_aliases a JOIN candidate_tag_groups g ON g.id=a.group_id WHERE g.enabled AND g.kind IN ('valid','blocked') ORDER BY a.normalized_value,g.id`;
  return {
    rules,
    version: createHash("sha256").update(JSON.stringify(rules)).digest("hex"),
  };
}
export const emptyCandidateReviewReason: CandidateReviewReason = {
  hashtags: [],
  tagRuleMatches: [],
  triageReasons: ["insufficient_evidence"],
  modelPositive: false,
  allLow: false,
};
