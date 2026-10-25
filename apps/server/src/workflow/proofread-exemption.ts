import {
  type Prisma,
  ReviewStatus,
  WorkEventAction,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { canUserWorkStage } from "./workflow-policy.js";

// Shared capability query; mutations repeat it inside the work/account locks.
export async function proofreadSkipAvailability(
  db: Pick<
    Prisma.TransactionClient,
    "user" | "work" | "workEvent" | "translationVersion"
  >,
  actorId: string,
  workId: string,
) {
  const [user, work, submission] = await Promise.all([
    db.user.findUnique({
      where: { id: actorId },
      include: { roles: true, languageCapabilities: true },
    }),
    db.work.findUnique({ where: { id: workId } }),
    db.workEvent.findFirst({
      where: {
        workId,
        action: WorkEventAction.stage_submitted,
        detail: { path: ["stage"], equals: "translate" },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const unavailable = (reason: string) => ({
    canSkipProofreading: false,
    skipProofreadingUnavailableReason: reason,
    sourceVersionId: null,
  });
  if (!user?.isActive || user.mustChangePassword || !user.canSkipProofreading)
    return unavailable("未获得免校对资格或账号暂不可操作");
  if (
    !work ||
    !canUserWorkStage(
      user.roles.map(({ role }) => role),
      user.languageCapabilities.map(({ language }) => language),
      "translate",
      work.sourceLanguage,
    )
  )
    return unavailable("没有本作品的翻译资格");
  if (work.workflowStatus !== WorkflowStatus.pending_proofread)
    return unavailable("仅可跳过尚未开始的校对");
  if (work.reviewStatus !== ReviewStatus.normal)
    return unavailable("请先处理作品审核");
  if (submission?.actorId !== actorId)
    return unavailable("仅限本轮翻译原提交人操作");
  const detail = submission.detail as { translationVersionId?: string };
  const source = detail.translationVersionId
    ? await db.translationVersion.findUnique({
        where: { id: detail.translationVersionId },
      })
    : null;
  if (!source || source.workId !== workId || source.stage !== "translate")
    return unavailable("缺少有效翻译版本");
  if (!source.contributorUserIds.length)
    return unavailable("历史版本缺少贡献记录，请取消翻译提交后重新确认提交");
  if (
    source.contributorUserIds.length !== 1 ||
    source.contributorUserIds[0] !== actorId
  )
    return unavailable("多人翻译不能免校对");
  return {
    canSkipProofreading: true,
    skipProofreadingUnavailableReason: null,
    sourceVersionId: source.id,
  };
}
