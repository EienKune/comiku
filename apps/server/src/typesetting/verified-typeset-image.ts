import { ConflictException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";

export type VerifiedImageSelection = {
  sessionId: string;
  uploadImageId: string;
};

// Acquire before actor/work locks, matching the collaboration preview and adoption paths.
export async function lockVerifiedTypesetSession(
  tx: Prisma.TransactionClient,
  actorId: string,
  sessionId: string,
) {
  // Expiry cleanup claims this session before releasing its image references.
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM typeset_upload_sessions WHERE id = ${sessionId}::uuid AND actor_id = ${actorId}::uuid FOR SHARE`,
  );
}
// The caller holds the actor's upload-session lock for the entire business transaction.
export async function verifiedTypesetImages(
  tx: Prisma.TransactionClient,
  actorId: string,
  sessionId: string,
  imageIds: string[],
) {
  const images = await tx.typesetUploadImage.findMany({
    where: {
      id: { in: imageIds },
      uploadFile: {
        status: "processed",
        session: {
          id: sessionId,
          actorId,
          status: "previewed",
          expiresAt: { gt: new Date() },
        },
      },
      fileObject: { lifecycleStatus: "active", deletedAt: null },
    },
    select: {
      id: true,
      fileObjectId: true,
      sourceName: true,
      width: true,
      height: true,
      fileObject: { select: { size: true } },
    },
  });
  const byId = new Map(images.map((image) => [image.id, image]));
  return imageIds.map((id) => {
    const image = byId.get(id);
    if (!image) throw new ConflictException("所选成图尚未校验或上传会话已失效");
    return { ...image, size: Number(image.fileObject.size) };
  });
}

export async function verifiedTypesetImage(
  tx: Prisma.TransactionClient,
  actorId: string,
  selection: VerifiedImageSelection,
) {
  const [image] = await verifiedTypesetImages(
    tx,
    actorId,
    selection.sessionId,
    [selection.uploadImageId],
  );
  return image;
}
