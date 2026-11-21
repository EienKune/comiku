import { Unzip, UnzipInflate } from "fflate";
import {
  typesetUploadContentType,
  type UploadImage,
} from "./typeset-upload-plan";

const MiB = 1024 * 1024;
export type LocalTypesetImage = UploadImage & { file: File; localUrl: string };
function nameHints(name: string, archive = false) {
  const stem = name.replace(/\.[^.]+$/, "");
  const work = stem.match(
    archive
      ? /^([1-9]\d*)(?:_成图|_嵌字交接)?$/u
      : /^([1-9]\d*)-\d+(?:成图)?$/u,
  );
  const page = archive ? null : stem.match(/-(\d+)(?:成图)?$/u);
  return {
    workNumber: work ? Number(work[1]) : null,
    pageNumber: page ? Number(page[1]) : null,
  };
}
export function releaseLocalTypesetImages(images: LocalTypesetImage[]) {
  for (const image of images) URL.revokeObjectURL(image.localUrl);
}

/** Stream inflation in small input chunks and enforce both advertised and actual output budgets. */
async function expandArchive(
  file: File,
  signal?: AbortSignal,
  remainingBytes = 512 * MiB,
  remainingImages = 200,
) {
  const entries: { name: string; chunks: Uint8Array[]; size: number }[] = [];
  let total = 0,
    count = 0;
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    if (failure) return;
    const parts = entry.name.replaceAll("\\", "/").split("/");
    if (
      parts.some((part) => part === ".." || part === ".") ||
      /^[\\/]|^[a-z]:/i.test(entry.name) ||
      /[\p{Cc}]/u.test(entry.name) ||
      parts.length > 3
    ) {
      failure = new Error(`${file.name}：ZIP 包含越界路径或超过两层目录`);
      return;
    }
    if (entry.name.endsWith("/")) return;
    if (++count > 1000) {
      failure = new Error(`${file.name}：ZIP 条目过多`);
      return;
    }
    if (/\.(zip|rar|7z|tar|gz)$/i.test(entry.name)) {
      failure = new Error("不支持嵌套压缩包");
      return;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name) || parts.includes("__MACOSX"))
      return;
    if (
      entries.length >= remainingImages ||
      (entry.originalSize ?? 0) > 25 * MiB
    ) {
      failure = new Error("ZIP 图片数量或单图容量超限");
      return;
    }
    const result = { name: parts.at(-1)!, chunks: [] as Uint8Array[], size: 0 };
    entries.push(result);
    entry.ondata = (error, chunk) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      total += chunk.length;
      result.size += chunk.length;
      if (
        result.size > 25 * MiB ||
        total > Math.min(250 * MiB, remainingBytes)
      ) {
        failure = new Error("ZIP 解压后超过 25 MiB/图或 250 MiB/包上限");
        entry.terminate();
        return;
      }
      result.chunks.push(chunk);
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(), true);
        break;
      }
      // Blob streams normally use 64 KiB, but do not depend on that implementation detail.
      for (let offset = 0; offset < value.length; offset += 65536) {
        unzip.push(value.subarray(offset, offset + 65536));
        if (failure) throw failure;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (failure) throw failure;
    if (!entries.length) throw new Error(`${file.name}：ZIP 内没有支持的成图`);
    return entries.map((entry) => {
      const image = new File(entry.chunks as BlobPart[], entry.name, {
        type: typesetUploadContentType({ name: entry.name } as File),
      });
      entry.chunks = [];
      return image;
    });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function prepareLocalTypesetImages(
  files: File[],
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
) {
  const images: LocalTypesetImage[] = [];
  let bytes = 0;
  if (
    !files.length ||
    files.length > 200 ||
    files.reduce((sum, file) => sum + file.size, 0) > 512 * MiB
  )
    throw new Error("所选文件超过整批数量或 512 MiB 容量上限");
  try {
    for (const input of files) {
      options.signal?.throwIfAborted();
      const archive = typesetUploadContentType(input) === "application/zip";
      if (!input.size || input.size > (archive ? 250 : 25) * MiB)
        throw new Error(`${input.name} 为空或超过单文件容量上限`);
      options.onProgress?.(`正在本地读取：${input.name}`);
      const container = crypto.randomUUID();
      const entries = archive
        ? await expandArchive(
            input,
            options.signal,
            512 * MiB - bytes,
            200 - images.length,
          )
        : [input];
      for (const file of entries) {
        options.signal?.throwIfAborted();
        bytes += file.size;
        if (images.length >= 200 || bytes > 512 * MiB)
          throw new Error("解压后超过整批 200 张或 512 MiB 容量上限");
        if (!file.size || file.size > 25 * MiB || file.name.length > 255)
          throw new Error(`${file.name} 为空、名称过长或超过单图容量上限`);
        let width = 0,
          height = 0;
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(file);
          width = bitmap.width;
          height = bitmap.height;
          bitmap.close();
        }
        const hints = nameHints(file.name);
        const workNumber =
          hints.workNumber ??
          (archive ? nameHints(input.name, true).workNumber : null);
        images.push({
          id: crypto.randomUUID(),
          uploadFileId: container,
          sourceName: file.name,
          width,
          height,
          size: file.size,
          ...hints,
          workNumber,
          warnings: [],
          target: workNumber?.toString() ?? "",
          included: true,
          archive,
          file,
          localUrl: URL.createObjectURL(file),
        });
      }
    }
    return images;
  } catch (error) {
    releaseLocalTypesetImages(images);
    throw error;
  }
}
