import { ConflictException } from "@nestjs/common";
import { Prisma, type WorkStage } from "../generated/prisma/client.js";

/** Call with the work row locked. New imports and unambiguous old single owners materialize lazily. */
export async function ensurePageAssignments(
  tx: Prisma.TransactionClient,
  workId: string,
  stage: WorkStage,
) {
  if (stage !== "translate" && stage !== "typeset") return;
  const images = await tx.workImage.findMany({
    where: { workId },
    orderBy: { orderIndex: "asc" },
    select: { id: true },
  });
  await tx.workPageAssignment.createMany({
    data: images.map(({ id }) => ({ workId, workImageId: id, stage })),
    skipDuplicates: true,
  });
  const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
  if (work.collaborationMigrationIssue)
    throw new ConflictException({
      code: "COLLABORATION_MIGRATION_REQUIRED",
      message: work.collaborationMigrationIssue,
    });
  if (work.collaborationMode !== "single") return;
  const owners = await tx.workStageParticipant.findMany({
    where: { workId, stage, leftAt: null },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  });
  if (owners.length > 1)
    throw new ConflictException("当前职责归属有冲突，需要先核对存量数据");
  if (owners.length === 1) {
    await tx.workPageAssignment.updateMany({
      where: { workId, stage, participantId: null },
      data: { participantId: owners[0].id, generation: { increment: 1 } },
    });
    await tx.workStageAssignment.createMany({
      data: images.map(({ id }) => ({
        participantId: owners[0].id,
        workImageId: id,
        assignedById: owners[0].userId,
      })),
      skipDuplicates: true,
    });
  }
}

export function pageSubmissionCurrent(page: {
  participantId: string | null;
  generation: number;
  draftRevision: number;
  submittedAt: Date | null;
  submittedGeneration: number | null;
  submittedRevision: number | null;
}) {
  return Boolean(
    page.participantId &&
    page.submittedAt &&
    page.submittedGeneration === page.generation &&
    page.submittedRevision === page.draftRevision,
  );
}
