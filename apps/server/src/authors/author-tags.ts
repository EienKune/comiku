import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";

export type AuthorTagSelection = {
  existingTags: { id: string; expectedRevision: number }[];
  newTagNames: string[];
};

export function normalizeAuthorTagName(input: string) {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  const normalizedName = name.toLowerCase();
  if (!name || [...name].length > 64 || [...normalizedName].length > 64)
    throw new BadRequestException("标签须为 1 至 64 个字符");
  return { name, normalizedName };
}

export function normalizeAuthorTagSelection(
  input: Partial<AuthorTagSelection>,
): AuthorTagSelection {
  if (
    !Array.isArray(input.existingTags) ||
    !Array.isArray(input.newTagNames) ||
    input.existingTags.length + input.newTagNames.length > 50
  )
    throw new BadRequestException("请提供完整标签选择，每位作者最多 50 个标签");
  const existingTags = input.existingTags.map((ref) => {
    if (
      !ref ||
      typeof ref.id !== "string" ||
      !ref.id ||
      !Number.isSafeInteger(ref.expectedRevision) ||
      ref.expectedRevision < 0
    )
      throw new BadRequestException("已有标签引用无效");
    return { id: ref.id, expectedRevision: ref.expectedRevision };
  });
  const names = input.newTagNames.map((name) => {
    if (typeof name !== "string") throw new BadRequestException("标签名称无效");
    return normalizeAuthorTagName(name);
  });
  if (
    new Set(existingTags.map((ref) => ref.id)).size !== existingTags.length ||
    new Set(names.map((tag) => tag.normalizedName)).size !== names.length
  )
    throw new BadRequestException("标签不能重复");
  return { existingTags, newTagNames: names.map((tag) => tag.name) };
}

/** Only catalog/AuthorTag writers take this short transaction-scoped mutex.
 * Candidate reads and background ingestion never acquire it. Acquire before
 * touching author/tag rows; it avoids ID/name lock inversions in CSV batches. */
export async function lockAuthorTagCatalog(tx: Prisma.TransactionClient) {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(1129270601, 20261106)`,
  );
}

export async function resolveAuthorTagSelections(
  tx: Prisma.TransactionClient,
  inputs: AuthorTagSelection[],
): Promise<string[][]> {
  const selections = inputs.map(normalizeAuthorTagSelection);
  await lockAuthorTagCatalog(tx);
  const ids = [
    ...new Set(
      selections.flatMap((selection) =>
        selection.existingTags.map((ref) => ref.id),
      ),
    ),
  ];
  const tags = ids.length
    ? await tx.tag.findMany({ where: { id: { in: ids } } })
    : [];
  const existing = new Map(tags.map((tag) => [tag.id, tag]));
  for (const selection of selections)
    for (const ref of selection.existingTags)
      if (existing.get(ref.id)?.revision !== ref.expectedRevision)
        throw new ConflictException("标签已更新或移除，请重新选择后保存");
  const newTags = new Map(
    selections.flatMap((selection) =>
      selection.newTagNames.map((name) => {
        const tag = normalizeAuthorTagName(name);
        return [tag.normalizedName, tag] as const;
      }),
    ),
  );
  const ordered = [...newTags.keys()].sort().map((key) => newTags.get(key)!);
  for (let start = 0; start < ordered.length; start += 500)
    await tx.tag.createMany({
      data: ordered.slice(start, start + 500),
      skipDuplicates: true,
    });
  const saved = ordered.length
    ? await tx.tag.findMany({
        where: { normalizedName: { in: [...newTags.keys()] } },
      })
    : [];
  const resolved = new Map(saved.map((tag) => [tag.normalizedName, tag.id]));
  return selections.map((selection) => [
    ...new Set([
      ...selection.existingTags.map((ref) => ref.id),
      ...selection.newTagNames.map((name) =>
        resolved.get(normalizeAuthorTagName(name).normalizedName)!,
      ),
    ]),
  ]);
}
