import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";

type ImageIdentity = {
  workImageId: string;
  fileObjectId: string;
  orderIndex: number;
};
export function assertMaterialIdentity(
  material: {
    translationVersionId: string;
    sourceAssetRevision: number;
    images: readonly ImageIdentity[];
  },
  textId: string | null,
  sourceRevision: number,
  images: readonly ImageIdentity[],
) {
  if (
    material.translationVersionId !== textId ||
    material.sourceAssetRevision !== sourceRevision ||
    material.images.length !== images.length ||
    material.images.some(
      (image, i) =>
        image.workImageId !== images[i]?.workImageId ||
        image.fileObjectId !== images[i]?.fileObjectId ||
        image.orderIndex !== images[i]?.orderIndex,
    )
  )
    throw new ConflictException("原图或正式文本已更新，请重新领取最新材料");
}

export async function assertMaterialCurrent(
  tx: Prisma.TransactionClient,
  workId: string,
  materialId: string,
) {
  const material = await tx.typesetMaterial.findFirst({
    where: { id: materialId, workId },
    include: { images: { orderBy: { orderIndex: "asc" } } },
  });
  if (!material) throw new ConflictException("材料清单不存在");
  const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
  const textId =
    work.requiredHandoffVersionId ??
    (
      await tx.translationVersion.findFirst({
        where: { workId },
        orderBy: { versionNumber: "desc" },
        select: { id: true },
      })
    )?.id ??
    null;
  const images = await tx.workImage.findMany({
    where: { workId },
    orderBy: { orderIndex: "asc" },
    select: { id: true, originalFileObjectId: true, orderIndex: true },
  });
  assertMaterialIdentity(
    material,
    textId,
    work.sourceAssetRevision,
    images.map((image) => ({
      workImageId: image.id,
      fileObjectId: image.originalFileObjectId,
      orderIndex: image.orderIndex,
    })),
  );
  if (
    material.editorEpoch !== work.editorEpoch &&
    !(
      material.deliveredAt &&
      work.typesetHandoffStartedAt &&
      material.editorEpoch + 1 === work.editorEpoch
    )
  )
    throw new ConflictException("交接材料所属审核轮次已变化，请重新领取");
  return material;
}
