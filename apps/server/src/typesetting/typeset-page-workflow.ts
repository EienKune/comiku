import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  Prisma,
  WorkEventAction,
  WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { assertProductionWritable } from "../workflow/review-policy.js";
import { assertCurrentHandoff } from "../workflow/revision-policy.js";

export type TypesetMutation = {
  expectedRevision: number;
  idempotencyKey: string;
  expectedEditorEpoch?: number;
};

export async function typesetActorTx(
  tx: Prisma.TransactionClient,
  actorId: string,
  workId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM users WHERE id=${actorId}::uuid FOR SHARE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT user_id FROM user_roles WHERE user_id=${actorId}::uuid FOR SHARE`,
  );
  const user = await tx.user.findFirst({
    where: {
      id: actorId,
      isActive: true,
      roles: { some: { role: "typesetter" } },
    },
    select: { id: true },
  });
  const participant = await tx.workStageParticipant.findFirst({
    where: { workId, userId: actorId, stage: "typeset", leftAt: null },
  });
  if (!user || !participant)
    throw new ForbiddenException("需要具备嵌字职务并承担当前作品分工");
  return participant;
}

export async function lockTypesetWorkTx(
  tx: Prisma.TransactionClient,
  workId: string,
  input: TypesetMutation,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
  );
  const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
  assertProductionWritable(work);
  if (
    ![WorkflowStatus.typesetting, WorkflowStatus.pending_publish].some(
      (s) => s === work.workflowStatus,
    )
  )
    throw new ConflictException("作品当前不能修改嵌字稿件");
  const replay = await tx.workEvent.findUnique({
    where: {
      workId_idempotencyKey: { workId, idempotencyKey: input.idempotencyKey },
    },
  });
  if (
    !replay &&
    (work.revision !== input.expectedRevision ||
      (input.expectedEditorEpoch !== undefined &&
        input.expectedEditorEpoch !== work.editorEpoch))
  )
    throw new ConflictException("作品已更新，请刷新后重新确认");
  if (!work.typesetHandoffStartedAt)
    throw new ConflictException("请先领取本轮有效嵌字材料");
  await assertCurrentHandoff(tx, work);
  return { work, replay };
}

/** Caller holds the work row lock. Never infer completion from member count. */
export async function aggregateTypesetTx(
  tx: Prisma.TransactionClient,
  workId: string,
  actorId: string,
  key: string,
) {
  const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
  const pages = await tx.workImage.findMany({
    where: { workId },
    orderBy: { orderIndex: "asc" },
  });
  const assignments = await tx.workPageAssignment.findMany({
    where: { workId, stage: WorkStage.typeset },
  });
  const drafts = await tx.workTypesetDraft.findMany({
    where: { workId },
    include: { fileObject: true },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const active = await tx.workStageParticipant.findMany({
    where: { workId, stage: "typeset", leftAt: null },
  });
  const activeIds = new Set(active.map((p) => p.id));
  const valid = (d: (typeof drafts)[number]) =>
    activeIds.has(d.participantId) &&
    d.submittedRevision === d.revision &&
    d.fileObject.lifecycleStatus === "active" &&
    !d.fileObject.deletedAt;
  const complete =
    drafts.length > 0 &&
    drafts.every(valid) &&
    (work.collaborationMode === "single" ||
      (pages.length > 0 &&
        pages.every((page) => {
          const a = assignments.find((a) => a.workImageId === page.id);
          const d = drafts.find((d) => d.workImageId === page.id);
          return (
            a?.participantId &&
            d &&
            d.participantId === a.participantId &&
            d.assignmentGeneration === a.generation &&
            a.submittedGeneration === a.generation &&
            a.submittedRevision === a.draftRevision &&
            !!a.submittedAt
          );
        })));
  if (!complete) return null;
  const ordered =
    work.collaborationMode === "single"
      ? drafts
      : [
          ...drafts.filter((d) => d.position === "start"),
          ...pages.flatMap((p) => drafts.filter((d) => d.workImageId === p.id)),
          ...drafts.filter((d) => d.position === "end"),
        ];
  const latest = await tx.typesetImageVersion.aggregate({
    where: { workId },
    _max: { versionNumber: true },
  });
  const version = await tx.typesetImageVersion.create({
    data: {
      workId,
      versionNumber: (latest._max.versionNumber ?? 0) + 1,
      idempotencyKey: key,
      uploadedById: actorId,
      sourceTranslationVersionId: work.requiredHandoffVersionId,
      reviewedTranslationVersionId: work.requiredHandoffVersionId,
      textReviewedAt: new Date(),
      images: {
        create: ordered.map((d, orderIndex) => ({
          workImageId: d.workImageId,
          supplementId: d.workImageId ? null : d.id,
          supplementPosition: d.workImageId ? null : d.position,
          fileObjectId: d.fileObjectId,
          sourceName: d.sourceName,
          width: d.width!,
          height: d.height!,
          orderIndex,
        })),
      },
    },
  });
  await tx.work.update({
    where: { id: workId },
    data: {
      workflowStatus: "pending_publish",
      currentTypesetVersionId: version.id,
    },
  });
  return version;
}

export async function submitTypesetPagesTx(
  tx: Prisma.TransactionClient,
  actorId: string,
  workId: string,
  input: TypesetMutation,
) {
  const participant = await typesetActorTx(tx, actorId, workId);
  const { work, replay } = await lockTypesetWorkTx(tx, workId, input);
  if (replay) {
    if (
      replay.actorId !== actorId ||
      (replay.detail as { operation?: string }).operation !== "submit:typeset"
    )
      throw new ConflictException("幂等键已用于其他操作");
    return;
  }
  const assignments = await tx.workPageAssignment.findMany({
    where: { workId, stage: "typeset", participantId: participant.id },
  });
  const drafts = await tx.workTypesetDraft.findMany({
    where: { workId, participantId: participant.id },
    include: { fileObject: true },
  });
  if (
    !drafts.length ||
    (work.collaborationMode === "multi" &&
      (!assignments.length ||
        assignments.some(
          (a) =>
            !drafts.some(
              (d) =>
                d.workImageId === a.workImageId &&
                d.assignmentGeneration === a.generation,
            ),
        )))
  )
    throw new ConflictException("本人负责页尚有缺图，请先保存全部成图");
  if (
    drafts.some(
      (d) =>
        d.fileObject.lifecycleStatus !== "active" ||
        d.fileObject.deletedAt ||
        !d.width ||
        !d.height,
    )
  )
    throw new ConflictException("稿件文件不可用");
  const changed = drafts.filter((d) => d.submittedRevision !== d.revision);
  if (!changed.length) return;
  await tx.$executeRaw(
    Prisma.sql`UPDATE work_typeset_drafts SET submitted_revision=revision,updated_at=NOW() WHERE work_id=${workId}::uuid AND participant_id=${participant.id}::uuid`,
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE work_page_assignments SET submitted_revision=draft_revision,submitted_generation=generation,submitted_at=NOW() WHERE work_id=${workId}::uuid AND stage='typeset' AND participant_id=${participant.id}::uuid`,
  );
  await tx.workStageParticipant.update({
    where: { id: participant.id },
    data: { submittedAt: new Date() },
  });
  await tx.stageContributionSubmission.create({
    data: {
      participantId: participant.id,
      createdById: actorId,
      idempotencyKey: input.idempotencyKey,
      pages: {
        create: assignments
          .filter((a) => changed.some((d) => d.workImageId === a.workImageId))
          .map((a) => ({
            workImageId: a.workImageId,
            imageRevision: a.draftRevision,
          })),
      },
    },
  });
  const version = await aggregateTypesetTx(
    tx,
    workId,
    actorId,
    input.idempotencyKey,
  );
  const credits = version ? await currentTypesetCreditsTx(tx, workId) : [];
  await tx.work.update({
    where: { id: workId },
    data: { revision: { increment: 1 } },
  });
  await tx.workEvent.create({
    data: {
      workId,
      actorId,
      action: WorkEventAction.stage_submitted,
      idempotencyKey: input.idempotencyKey,
      fromWorkflowStatus: work.workflowStatus,
      toWorkflowStatus: version ? "pending_publish" : work.workflowStatus,
      fromReviewStatus: work.reviewStatus,
      toReviewStatus: work.reviewStatus,
      detail: {
        operation: "submit:typeset",
        stage: "typeset",
        participantIds: [participant.id],
        pageIds: changed.map((d) => d.workImageId),
        ...(version
          ? { versionId: version.id, typesetVersionId: version.id, credits }
          : {}),
      },
    },
  });
}

export async function currentTypesetCreditsTx(
  tx: Prisma.TransactionClient,
  workId: string,
) {
  const owners = await tx.workPageAssignment.findMany({
    where: { workId, stage: "typeset", participantId: { not: null } },
    include: { workImage: { select: { orderIndex: true } } },
    orderBy: { workImage: { orderIndex: "asc" } },
  });
  const participants = await tx.workStageParticipant.findMany({
    where: { workId, stage: "typeset", leftAt: null },
    include: { user: { select: { displayName: true } } },
  });
  const aliases = await tx.workCreditAlias.findMany({
    where: { workId, stage: "typeset" },
  });
  return [...new Set(owners.map((o) => o.participantId))].flatMap((id) => {
    const p = participants.find((p) => p.id === id);
    return p
      ? [
          {
            userId: p.userId,
            creditName:
              aliases.find((a) => a.userId === p.userId)?.creditName ??
              p.creditNameSnapshot ??
              p.user.displayName,
          },
        ]
      : [];
  });
}

export async function cancelTypesetPagesTx(
  tx: Prisma.TransactionClient,
  actorId: string,
  workId: string,
  input: TypesetMutation,
) {
  const participant = await typesetActorTx(tx, actorId, workId);
  const { work, replay } = await lockTypesetWorkTx(tx, workId, input);
  if (replay) {
    if (
      replay.actorId !== actorId ||
      (replay.detail as { operation?: string }).operation !== "cancel:typeset"
    )
      throw new ConflictException("幂等键已用于其他操作");
    return;
  }
  await tx.workTypesetDraft.updateMany({
    where: { workId, participantId: participant.id },
    data: { submittedRevision: null },
  });
  await tx.workPageAssignment.updateMany({
    where: { workId, stage: "typeset", participantId: participant.id },
    data: {
      submittedRevision: null,
      submittedGeneration: null,
      submittedAt: null,
    },
  });
  await tx.workStageParticipant.update({
    where: { id: participant.id },
    data: { submittedAt: null },
  });
  await tx.work.update({
    where: { id: workId },
    data: { workflowStatus: "typesetting", revision: { increment: 1 } },
  });
  await tx.workEvent.create({
    data: {
      workId,
      actorId,
      action: WorkEventAction.stage_submission_cancelled,
      idempotencyKey: input.idempotencyKey,
      fromWorkflowStatus: work.workflowStatus,
      toWorkflowStatus: "typesetting",
      fromReviewStatus: work.reviewStatus,
      toReviewStatus: work.reviewStatus,
      detail: { operation: "cancel:typeset", stage: "typeset" },
    },
  });
}

export async function clearTypesetPagesTx(
  tx: Prisma.TransactionClient,
  participantId: string,
  pageIds: string[],
  options: { lastPage: boolean },
) {
  await tx.workTypesetDraft.deleteMany({
    where: {
      participantId,
      OR: [
        { workImageId: { in: pageIds } },
        ...(options.lastPage ? [{ workImageId: null }] : []),
      ],
    },
  });
}
