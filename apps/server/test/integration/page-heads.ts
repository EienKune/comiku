import type { Prisma } from "../../src/generated/prisma/client.js";

/** Read the exact current pending page heads; never fill a missing/tampered request automatically. */
export async function translationPageHeads(
  db: Pick<Prisma.TransactionClient, "workPageAssignment">,
  workId: string,
  userId?: string,
) {
  const pages = await db.workPageAssignment.findMany({
    where: {
      workId,
      stage: "translate",
      participant: { leftAt: null, ...(userId ? { userId } : {}) },
    },
    orderBy: { workImage: { orderIndex: "asc" } },
  });
  return pages
    .filter(
      (p) =>
        !p.submittedAt ||
        p.submittedGeneration !== p.generation ||
        p.submittedRevision !== p.draftRevision,
    )
    .map((p) => ({
      imageId: p.workImageId,
      generation: p.generation,
      draftRevision: p.draftRevision,
    }));
}
