import { zip } from "fflate";
import { authenticatedFetch, unwrap } from "../account/api";

export type MaterialImage = {
  fileName: string;
  size: number;
  checksum: string;
  url?: string;
};
export type MaterialManifest = {
  id: string;
  fileName: string;
  translationVersionId: string;
  sourceAssetRevision: number;
  workRevision: number;
  editorEpoch: number;
  totalBytes: number;
  translationFileName: string;
  translationBase64: string;
  images: MaterialImage[];
};
// Includes retained source buffers and the final uncompressed ZIP. Larger works
// use the existing streaming server package route instead of exhausting a tab.
export const browserArchiveLimit = 256 * 1024 * 1024;

async function materialRequest(
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<MaterialManifest> {
  const response = await authenticatedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Comiku-Request": "1" },
    body: JSON.stringify(body),
    signal,
  });
  const value: unknown = await response.json().catch(() => undefined);
  return unwrap({
    response,
    ...(response.ok ? { data: value as MaterialManifest } : { error: value }),
  });
}

export async function buildMaterialArchive(
  material: Pick<
    MaterialManifest,
    "translationFileName" | "translationBase64" | "images"
  >,
  fetcher: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> = authenticatedFetch,
  signal?: AbortSignal,
  renew?: () => Promise<MaterialManifest>,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const entries: Record<string, Uint8Array> = {};
  let cursor = 0;
  let renewal: Promise<MaterialManifest> | undefined;
  let currentImages = material.images;
  let firstFailure: unknown;
  function renewImages() {
    // R2 can omit CORS headers on an expired signature. The browser then hides
    // its 403 behind a fetch TypeError, indistinguishable from a network fault.
    // Share one renewal, retry once, and let persistent failures surface.
    renewal ??= Promise.resolve()
      .then(renew!)
      .then((refreshed) => {
        controller.signal.throwIfAborted();
        if (
          refreshed.images.length !== material.images.length ||
          refreshed.images.some((image, index) => {
            const original = material.images[index];
            return (
              !image.url ||
              image.fileName !== original.fileName ||
              image.checksum !== original.checksum ||
              image.size !== original.size
            );
          })
        )
          throw new Error("材料已更新，请重新领取");
        currentImages = refreshed.images;
        return refreshed;
      });
    return waitForRenewal();
  }
  function waitForRenewal() {
    controller.signal.throwIfAborted();
    return new Promise<MaterialManifest>((resolve, reject) => {
      const stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
      renewal!.then(resolve, reject).finally(() => {
        controller.signal.removeEventListener("abort", stop);
      });
    });
  }
  async function worker() {
    while (cursor < material.images.length) {
      controller.signal.throwIfAborted();
      const index = cursor++;
      const image = material.images[index];
      // Later worker waves must use renewed URLs, including while signing is
      // still in flight, rather than repeatedly trying the expired manifest.
      if (renewal) await waitForRenewal();
      controller.signal.throwIfAborted();
      const signedImage = currentImages[index];
      if (!signedImage.url) throw new Error("材料下载地址缺失，请重新领取");
      const canRenew = renew && currentImages === material.images;
      let response: Response | undefined;
      try {
        response = await fetcher(signedImage.url, {
          signal: controller.signal,
        });
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!canRenew || !(error instanceof TypeError)) throw error;
      }
      controller.signal.throwIfAborted();
      if (canRenew && (!response || response.status === 403)) {
        await renewImages();
        controller.signal.throwIfAborted();
        response = await fetcher(currentImages[index].url!, {
          signal: controller.signal,
        });
      }
      controller.signal.throwIfAborted();
      if (!response?.ok) throw new Error(`下载失败：${image.fileName}，请重试`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const checksum = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (bytes.length !== image.size || checksum !== image.checksum)
        throw new Error(`文件校验失败：${image.fileName}，请重新下载`);
      entries[image.fileName] = bytes;
    }
  }
  try {
    const workers = Array.from(
      { length: Math.min(6, material.images.length) },
      () =>
        worker().catch((error) => {
          if (signal?.aborted) error = signal.reason;
          firstFailure ??= error;
          controller.abort();
          throw error;
        }),
    );
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw firstFailure ?? failure.reason;
    signal?.throwIfAborted();
    entries[material.translationFileName] = Uint8Array.from(
      atob(material.translationBase64),
      (value) => value.charCodeAt(0),
    );
    // Reestablish manifest order after the concurrent network completion order.
    const ordered = Object.fromEntries([
      ...material.images.map((image) => [
        image.fileName,
        entries[image.fileName],
      ]),
      [material.translationFileName, entries[material.translationFileName]],
    ]);
    return await new Promise<Uint8Array>((resolve, reject) => {
      const cancel = zip(ordered, { level: 0 }, (error, data) => {
        controller.signal.removeEventListener("abort", stop);
        if (error) reject(error);
        else resolve(data);
      });
      const stop = () => {
        cancel();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      controller.signal.addEventListener("abort", stop, { once: true });
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function downloadBrowserMaterials(
  input: {
    workId: string;
    expectedRevision: number;
    expectedEditorEpoch: number;
    idempotencyKey: string;
    requireCurrentParticipation?: boolean;
  },
  signal?: AbortSignal,
) {
  const base = `/api/works/${encodeURIComponent(input.workId)}/typeset/materials`;
  const material = await materialRequest(
    base,
    {
      expectedRevision: input.expectedRevision,
      expectedEditorEpoch: input.expectedEditorEpoch,
      idempotencyKey: input.idempotencyKey,
      requireCurrentParticipation: input.requireCurrentParticipation !== false,
    },
    signal,
  );
  if (material.totalBytes > browserArchiveLimit) return null;
  const deliver = () =>
    materialRequest(
      `${base}/${encodeURIComponent(material.id)}/deliver`,
      {},
      signal,
    );
  const signed = await deliver();
  const bytes = await buildMaterialArchive(
    signed,
    authenticatedFetch,
    signal,
    deliver,
  );
  signal?.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = signed.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { url, fileName: signed.fileName, expiresInSeconds: 60 };
}
