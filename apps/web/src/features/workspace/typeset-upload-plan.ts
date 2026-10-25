import type { components } from "@comiku/api-client";

type Session = components["schemas"]["TypesetUploadSessionDto"];
export type UploadImage = components["schemas"]["TypesetUploadImageDto"] & {
  target: string;
  included: boolean;
  archive: boolean;
};

export function initialTypesetUploadImages(session: Session): UploadImage[] {
  const rows = session.files.flatMap((file) =>
    file.images.map((image) => ({
      ...image,
      target: image.workNumber?.toString() ?? "",
      included: true,
      archive: file.archive,
    })),
  );
  const groups = new Map<string, UploadImage[]>();
  for (const row of rows)
    groups.set(row.target, [...(groups.get(row.target) ?? []), row]);
  return [...groups.values()].flatMap((images) => {
    const pages = images.map((image) => image.pageNumber);
    return pages.every((page) => page !== null) &&
      new Set(pages).size === pages.length
      ? [...images].sort((a, b) => a.pageNumber! - b.pageNumber!)
      : images;
  });
}

export function typesetUploadGroupProblem(
  images: UploadImage[],
  mergeConfirmed: boolean,
) {
  const archives = new Set(
    images.filter((image) => image.archive).map((image) => image.uploadFileId),
  );
  if (
    (archives.size > 1 ||
      (archives.size && images.some((image) => !image.archive))) &&
    !mergeConfirmed
  )
    return "同作品有多份 ZIP 或混入裸图，请确认合并或移除重复项";
  const names = images.map((image) =>
    image.sourceName.split(/[\\/]/).at(-1)?.toLowerCase(),
  );
  const pages = images
    .map((image) => image.pageNumber)
    .filter((page) => page !== null);
  if (
    new Set(names).size !== names.length ||
    new Set(pages).size !== pages.length
  )
    return "同名文件或重复数字页码，请先移除重复项";
  return null;
}

export async function uploadFileChecksum(file: File) {
  const bytes = await file.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function typesetUploadContentType(
  file: File,
): "image/png" | "image/jpeg" | "image/webp" | "application/zip" {
  const extension = file.name.toLowerCase().split(".").at(-1);
  const type = (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      zip: "application/zip",
    } as const
  )[extension as "png"];
  if (!type) throw new Error(`不支持的文件格式：${file.name}`);
  return type;
}
