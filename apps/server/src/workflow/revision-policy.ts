import { ConflictException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
type RevisionDatabase = Pick<
  Prisma.TransactionClient,
  "workImage" | "translationVersion"
>;

export async function captureRevisionText(
  db: RevisionDatabase,
  workId: string,
) {
  const images = await db.workImage.findMany({
    where: { workId },
    orderBy: { orderIndex: "asc" },
    include: { translationEntries: { orderBy: { orderIndex: "asc" } } },
  });
  return images.map((image) => ({
    imageId: image.id,
    entries: image.translationEntries.map((e) => ({
      orderIndex: e.orderIndex,
      x: e.markerX.toNumber(),
      y: e.markerY.toNumber(),
      position: e.markerPositionType,
      text: e.translatedText,
      note: e.note,
    })),
  }));
}

export async function revisionTextChanged(
  db: RevisionDatabase,
  revision: { workId: string; initialText: Prisma.JsonValue },
) {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)]),
          )
        : value;
  return (
    JSON.stringify(
      normalize(await captureRevisionText(db, revision.workId)),
    ) !== JSON.stringify(normalize(revision.initialText))
  );
}

export async function assertCurrentHandoff(
  db: RevisionDatabase,
  work: {
    id: string;
    requiredHandoffVersionId: string | null;
    typesetHandoffStartedAt: Date | null;
  },
) {
  if (!work.requiredHandoffVersionId) return;
  const version = await db.translationVersion.findUnique({
    where: { id: work.requiredHandoffVersionId },
  });
  if (!work.typesetHandoffStartedAt || !version?.handoffStartedAt)
    throw new ConflictException("文本已修订，请重新下载最新嵌字交接包");
}
