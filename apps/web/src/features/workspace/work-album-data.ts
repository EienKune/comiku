import type { AlbumImage } from "./WorkAlbum";
export function albumDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  });
}
export function groupAlbumImages(items: readonly AlbumImage[]) {
  const days = new Map<string, AlbumImage[]>();
  for (const item of items) {
    const day = albumDate(item.importedAt);
    const entries = days.get(day) ?? [];
    entries.push(item);
    days.set(day, entries);
  }
  return [...days];
}
