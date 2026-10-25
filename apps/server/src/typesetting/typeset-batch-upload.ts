import { basename, extname } from "node:path";
import {
  prepareManualUpload,
  type ManualUploadFile,
} from "../candidates/manual-candidate-upload.js";

export const TYPESET_BATCH_MAX_FILES = 200;
export const TYPESET_BATCH_MAX_WORKS = 20;
export const TYPESET_BATCH_MAX_ZIP_BYTES = 250 * 1024 * 1024;

export function typesetName(
  name: string,
  archive = false,
): { workNumber: number | null; pageNumber: number | null } {
  const stem = basename(name.replaceAll("\\", "/"), extname(name));
  const match = archive
    ? stem.match(/^([1-9]\d*)(?:_成图|_嵌字交接)?$/u)
    : stem.match(/^([1-9]\d*)-(\d+)(?:成图)?$/u);
  const workNumber = match ? Number(match[1]) : null;
  const pageMatch = !archive ? stem.match(/-(\d+)(?:成图)?$/u) : null;
  const pageNumber = pageMatch ? Number(pageMatch[1]) : null;
  return {
    workNumber:
      workNumber !== null &&
      Number.isSafeInteger(workNumber) &&
      workNumber <= 2147483647
        ? workNumber
        : null,
    pageNumber:
      pageNumber !== null && Number.isSafeInteger(pageNumber)
        ? pageNumber
        : null,
  };
}

export function prepareTypesetBatchFile(file: ManualUploadFile) {
  const group = prepareManualUpload(file);
  for (const image of group.images) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(image.contentType) ||
      !image.width ||
      !image.height
    )
      throw new Error("成图只支持尺寸可读取的 PNG、JPEG 或 WebP");
    if (image.sourceName.length > 255) throw new Error("图片路径名称过长");
  }
  return group;
}

export function validateTypesetSelection(
  images: {
    sourceName: string;
    uploadFileId: string;
    archive: boolean;
    size: number;
  }[],
  mergeConfirmed: boolean,
) {
  if (!images.length || images.length > 100)
    throw new Error("每部作品须包含 1–100 张成图");
  if (
    images.reduce((total, image) => total + image.size, 0) >
    TYPESET_BATCH_MAX_ZIP_BYTES
  )
    throw new Error("单作品成图总量不能超过 250 MiB");
  const containers = new Set(
    images.filter((image) => image.archive).map((image) => image.uploadFileId),
  );
  if (
    (containers.size > 1 ||
      (containers.size && images.some((image) => !image.archive))) &&
    !mergeConfirmed
  )
    throw new Error(
      "同作品有多份 ZIP 或混入裸图，请明确合并为一个版本或移除重复项",
    );
  const names = images.map((image) =>
    basename(image.sourceName.replaceAll("\\", "/")).toLowerCase(),
  );
  if (new Set(names).size !== names.length)
    throw new Error("存在同名图片，请移除重复项或拆分作品");
  const pages = images
    .map((image) => typesetName(image.sourceName).pageNumber)
    .filter((page) => page !== null);
  if (new Set(pages).size !== pages.length)
    throw new Error("存在重复数字页码（可能同时选入原图与成图），请移除重复项");
}
