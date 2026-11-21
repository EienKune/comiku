export type BatchPageMapping = { imageId: string; workImageId: string };

/** Only explicit stable-page identities grant a mapping; filenames never grant ownership. */
export function planTypesetPageMappings(
  images: { id: string; sourceName: string }[],
  mappings: BatchPageMapping[] | undefined,
  pages: { id: string; participantId: string | null }[],
  participantId: string | undefined,
) {
  if (!participantId) throw new Error("需要认领当前作品的嵌字页");
  if (!mappings || mappings.length !== images.length)
    throw new Error("多人嵌字须逐图确认原稿对应页；补充图请到作品详情处理");
  const byImage = new Map(mappings.map((m) => [m.imageId, m]));
  if (
    byImage.size !== images.length ||
    new Set(mappings.map((m) => m.workImageId)).size !== mappings.length
  )
    throw new Error("同一图片或原稿页不可重复映射");
  const byPage = new Map(pages.map((p) => [p.id, p]));
  const result: (BatchPageMapping & { position: "page" })[] = [];
  const ignored: string[] = [];
  for (const image of images) {
    const mapping = byImage.get(image.id);
    const page = mapping && byPage.get(mapping.workImageId);
    if (!mapping || !page) throw new Error("存在未映射或不属于本作品的原稿页");
    if (page.participantId !== participantId) ignored.push(image.sourceName);
    else result.push({ ...mapping, position: "page" });
  }
  if (!result.length) throw new Error("本批没有本人有权保存的成图");
  return { mappings: result, ignored };
}
