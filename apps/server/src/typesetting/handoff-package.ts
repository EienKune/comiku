import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, mkdir, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { Zip, ZipPassThrough, zipSync } from "fflate";

const extensionByContentType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface SourceImageArchiveEntry {
  contentType: string;
  body: Uint8Array;
}

export function targetImageFileName(
  workNumber: number,
  index: number,
  contentType: string,
  rendered = false,
) {
  const extension = extensionByContentType[contentType] ?? "img";
  return `${workNumber}-${String(index + 1).padStart(3, "0")}${rendered ? "成图" : ""}.${extension}`;
}

export function typesetHandoffPackageFileName(workNumber: number) {
  return `${workNumber}_嵌字交接.zip`;
}

export function typesetTranslationFileName(workNumber: number) {
  return `${workNumber}_翻译.txt`;
}

export async function createTypesetHandoffArchive(
  images: AsyncIterable<{
    contentType: string;
    body: Uint8Array | AsyncIterable<Uint8Array>;
  }>,
  workNumber: number,
  translationBody?: Uint8Array,
  rendered = false,
) {
  const base = join(tmpdir(), "comiku-exports");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "package-"));
  const path = join(directory, "handoff.zip");
  const output = createWriteStream(path, { flags: "wx" });
  const completion = finished(output);
  void completion.catch(() => undefined);
  let callbackError: Error | undefined;
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      callbackError = error;
      output.destroy(error);
      return;
    }
    output.write(chunk);
    if (final) output.end();
  });
  try {
    let index = 0;
    for await (const image of images) {
      const entry = new ZipPassThrough(
        targetImageFileName(workNumber, index, image.contentType, rendered),
      );
      zip.add(entry);
      const chunks =
        image.body instanceof Uint8Array ? [image.body] : image.body;
      for await (const chunk of chunks) {
        entry.push(chunk, false);
        if (output.writableNeedDrain) await once(output, "drain");
        if (callbackError) throw callbackError;
      }
      entry.push(new Uint8Array(), true);
      index += 1;
    }
    if (translationBody) {
      const translation = new ZipPassThrough(
        typesetTranslationFileName(workNumber),
      );
      zip.add(translation);
      translation.push(translationBody, true);
    }
    zip.end();
    await completion;
    if (callbackError) throw callbackError;
    return {
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    output.destroy();
    await completion.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createSourceImageArchive(
  images: SourceImageArchiveEntry[],
  workNumber: number,
  rendered = false,
) {
  return zipSync(
    Object.fromEntries(
      images.map((image, index) => [
        targetImageFileName(workNumber, index, image.contentType, rendered),
        image.body,
      ]),
    ),
    { level: 0 },
  );
}

// Reclaims only our own abandoned export directories; active generation is bounded far below one day.
export async function cleanupExpiredExportDirectories(now = Date.now()) {
  const base = resolve(tmpdir(), "comiku-exports");
  let entries;
  try {
    entries = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (!/^package-[A-Za-z0-9]{6}$/.test(name)) continue;
    const target = resolve(base, name);
    if (!target.startsWith(base + sep)) continue;
    const entry = await lstat(target).catch(() => null);
    if (
      entry?.isDirectory() &&
      !entry.isSymbolicLink() &&
      entry.mtimeMs < now - 24 * 60 * 60_000
    )
      await rm(target, { recursive: true, force: true });
  }
}
