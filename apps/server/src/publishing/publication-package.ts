import { createSourceImageArchive } from "../typesetting/handoff-package.js";

export interface PublicationImageArchiveEntry {
  contentType: string;
  body: Uint8Array;
}

export function publicationImagePackageFileName(workNumber: number) {
  return `${workNumber}_成图.zip`;
}

export function createPublicationImageArchive(
  images: PublicationImageArchiveEntry[],
  workNumber: number,
) {
  return createSourceImageArchive(images, workNumber, true);
}
