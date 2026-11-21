import {
  defaultLabelPlusHeader,
  type LabelPlusDocument,
} from "../labelplus/labelplus-codec.js";
import { targetImageFileName } from "./handoff-package.js";

/** Both browser manifests and streaming fallback ZIPs export this same formal snapshot. */
export function formalMaterialDocument(
  workNumber: number,
  images: readonly {
    id: string;
    originalFileObject: { contentType: string };
  }[],
  entries: readonly {
    workImageId: string;
    markerX: { toNumber(): number };
    markerY: { toNumber(): number };
    markerPositionType: string;
    translatedText: string;
  }[],
): LabelPlusDocument {
  const byPage = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const page = byPage.get(entry.workImageId) ?? [];
    page.push(entry);
    byPage.set(entry.workImageId, page);
  }
  return {
    formatVersion: "1,0",
    headerLines: [...defaultLabelPlusHeader],
    images: images.map((image, index) => ({
      fileName: targetImageFileName(
        workNumber,
        index,
        image.originalFileObject.contentType,
      ),
      markers: (byPage.get(image.id) ?? []).map((entry) => ({
        x: entry.markerX.toNumber(),
        y: entry.markerY.toNumber(),
        positionType: entry.markerPositionType === "inside" ? 1 : 2,
        translation: entry.translatedText,
      })),
    })),
  };
}
