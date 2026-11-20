import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";

/** Material identity is independent from participants, title and a reader's role. */
export async function assertUnifiedHandoffCurrent(
  db: Pick<
    Prisma.TransactionClient,
    "typesetHandoffPackage" | "translationVersion" | "workEvent"
  >,
  work: {
    id: string;
    sourceAssetRevision: number;
    editorEpoch: number;
    typesetHandoffStartedAt: Date | null;
    requiredHandoffVersionId: string | null;
  },
  packageId: string,
) {
  const pack = await db.typesetHandoffPackage.findFirst({
    where: { id: packageId, workId: work.id, kind: "unified_handoff" },
  });
  const textId =
    work.requiredHandoffVersionId ??
    (
      await db.translationVersion.findFirst({
        where: { workId: work.id },
        orderBy: { versionNumber: "desc" },
        select: { id: true },
      })
    )?.id ??
    null;
  if (
    !pack ||
    pack.sourceAssetRevision !== work.sourceAssetRevision ||
    pack.translationVersionId !== textId
  )
    throw new ConflictException(
      "原图或正式文本已更新，请重新生成并领取最新材料",
    );
  // An unused package from an earlier review round cannot establish delivery.
  // A confirmed package of the same material can still be downloaded after review.
  const currentRound =
    pack.editorEpoch === work.editorEpoch ||
    (work.typesetHandoffStartedAt && pack.editorEpoch + 1 === work.editorEpoch);
  if (!currentRound) {
    const delivered =
      work.typesetHandoffStartedAt &&
      (await db.workEvent.findFirst({
        where: {
          workId: work.id,
          action: "typeset_handoff_started",
          detail: { path: ["fileId"], equals: pack.id },
        },
        select: { id: true },
      }));
    if (!delivered)
      throw new ConflictException("交接包属于已结束的审核轮次，请重新生成材料");
  }
  return pack;
}
