import {
  inspectImage,
  type PreparedManualImage,
} from "../files/image-inspection.js";
export {
  inspectImage,
  type PreparedManualImage,
} from "../files/image-inspection.js";
import { extname, basename } from "node:path";
import { unzipSync } from "fflate";

export const MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES = 20;
export const MANUAL_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MANUAL_UPLOAD_MAX_IMAGES_PER_GROUP = 100;
export const MANUAL_UPLOAD_MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
export const MANUAL_UPLOAD_MAX_DIRECTORY_DEPTH = 2;

export interface ManualUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface PreparedManualGroup {
  sourceName: string;
  images: PreparedManualImage[];
  automaticallySorted: boolean;
  warnings: string[];
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function cleanArchivePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^([.][/])+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !segments.length ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("ZIP 包含无效路径");
  }
  return segments.join("/");
}

function trailingNumber(sourceName: string): number | null {
  const name = basename(sourceName, extname(sourceName));
  const match = name.match(/-(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function orderManualImages(images: PreparedManualImage[]): {
  images: PreparedManualImage[];
  automaticallySorted: boolean;
} {
  const numbers = images.map((image) => trailingNumber(image.sourceName));
  if (
    images.length > 1 &&
    numbers.every((number) => number !== null) &&
    new Set(numbers).size === numbers.length
  ) {
    return {
      images: images
        .map((image, index) => ({ image, index, number: numbers[index]! }))
        .sort(
          (left, right) =>
            left.number - right.number ||
            left.image.sourceName.localeCompare(right.image.sourceName) ||
            left.index - right.index,
        )
        .map(({ image }) => image),
      automaticallySorted: true,
    };
  }
  return { images, automaticallySorted: false };
}

function isZip(file: ManualUploadFile): boolean {
  return (
    extname(file.originalname).toLowerCase() === ".zip" ||
    file.mimetype === "application/zip" ||
    file.mimetype === "application/x-zip-compressed"
  );
}

export function prepareManualUpload(
  file: ManualUploadFile,
): PreparedManualGroup {
  if (!isZip(file)) {
    return {
      sourceName: file.originalname,
      images: [inspectImage(file.originalname, file.buffer)],
      automaticallySorted: false,
      warnings: [],
    };
  }
  if (
    file.buffer.byteLength < 4 ||
    file.buffer[0] !== 0x50 ||
    file.buffer[1] !== 0x4b
  ) {
    throw new Error("ZIP 文件内容无效");
  }
  let expanded = 0;
  let imageCount = 0;
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(file.buffer, {
      filter(entry) {
        const name = cleanArchivePath(entry.name);
        if (name.startsWith("__MACOSX/") || basename(name).startsWith(".")) {
          return false;
        }
        if (entry.name.endsWith("/")) return false;
        if (seenPaths.has(name))
          throw new Error("ZIP 内存在重复文件路径，请先移除重复项");
        seenPaths.add(name);
        const depth = name.split("/").length - 1;
        if (depth > MANUAL_UPLOAD_MAX_DIRECTORY_DEPTH) {
          throw new Error("ZIP 图片目录最多深入两层");
        }
        if (
          [".zip", ".rar", ".7z", ".tar", ".gz"].includes(
            extname(name).toLowerCase(),
          )
        ) {
          throw new Error("不展开 ZIP 内的嵌套压缩包");
        }
        if (!imageExtensions.has(extname(name).toLowerCase())) {
          warnings.push("已忽略非图片文件：" + name);
          return false;
        }
        imageCount += 1;
        expanded += entry.originalSize;
        if (imageCount > MANUAL_UPLOAD_MAX_IMAGES_PER_GROUP) {
          throw new Error("每个图组最多包含 100 张图片");
        }
        if (entry.originalSize > MANUAL_UPLOAD_MAX_FILE_BYTES) {
          throw new Error("ZIP 内单张图片不能超过 25 MiB");
        }
        if (expanded > MANUAL_UPLOAD_MAX_EXPANDED_BYTES) {
          throw new Error("ZIP 解压后的图片总量不能超过 250 MiB");
        }
        return true;
      },
    });
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "无法解析 ZIP 文件",
      { cause: error },
    );
  }
  const images = Object.entries(entries).map(([name, body]) =>
    inspectImage(cleanArchivePath(name), body),
  );
  if (!images.length) throw new Error("ZIP 中没有可用图片");
  const ordered = orderManualImages(images);
  if (!ordered.automaticallySorted && images.length > 1) {
    warnings.push("文件名没有统一的末尾数字标识，已保留 ZIP 条目顺序");
  }
  return {
    sourceName: file.originalname,
    images: ordered.images,
    automaticallySorted: ordered.automaticallySorted,
    warnings,
  };
}
