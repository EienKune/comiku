import type { components } from "@comiku/api-client";
import { authenticatedFetch, client, unwrap } from "../account/api";
import { pollTransfer } from "./transfers-api";
import { typesetImageDimensions } from "./typeset-image-dimensions";
import {
  typesetUploadContentType,
  uploadFileChecksum,
} from "./typeset-upload-plan";

type Session = components["schemas"]["TypesetUploadSessionDto"];
// Receipts belong to an exact immutable File and authorized session/file identity.
// Keep uncertain replies so Retry confirms the original object before any PUT.
const uploadReceipts = new WeakMap<File, Set<string>>();
const checksums = new WeakMap<File, Promise<string>>();
function checksum(file: File) {
  let pending = checksums.get(file);
  if (!pending) {
    pending = uploadFileChecksum(file).catch((error: unknown) => {
      checksums.delete(file);
      throw error;
    });
    checksums.set(file, pending);
  }
  return pending;
}
/** Match exact immutable bytes, permitting local package extras only for explicit restoration. */
export async function matchTypesetSessionFiles(
  session: Session,
  files: File[],
  options: { allowExtraFiles?: boolean; signal?: AbortSignal } = {},
) {
  if (
    (!options.allowExtraFiles && session.files.length !== files.length) ||
    session.files.length > files.length
  )
    throw new Error("重试文件与上传会话不匹配，请重新选择文件");
  const available = [];
  // Hash one file at a time: an entire selected batch can reach 512 MiB.
  for (const file of files) {
    options.signal?.throwIfAborted();
    available.push({
      file,
      checksum: await checksum(file),
      contentType: typesetUploadContentType(file),
    });
  }
  const restored: File[] = [];
  for (const remote of session.files) {
    options.signal?.throwIfAborted();
    const index = available.findIndex(
      (local) =>
        remote.sourceName === local.file.name &&
        remote.size === local.file.size &&
        remote.contentType === local.contentType &&
        remote.checksum === local.checksum,
    );
    if (index < 0) throw new Error("重试文件与上传会话不匹配，请重新选择文件");
    restored.push(available.splice(index, 1)[0].file);
  }
  return restored;
}
export type TypesetTransferOptions = {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onSession?: (session: Session) => void;
  maxTotalBytes?: number;
  sessionId?: string;
  requireComplete?: boolean;
};
function assertComplete(session: Session) {
  const failed = session.files.filter((file) => file.status !== "processed");
  if (failed.length)
    throw new Error(
      failed
        .map(
          (file) =>
            `${file.sourceName}：${file.error || "文件尚未处理，请重试上传"}`,
        )
        .join("；"),
    );
  return session;
}
async function extractTypesetSessionInternal(
  id: string,
  options: TypesetTransferOptions = {},
): Promise<Session> {
  const { signal, onProgress, onSession } = options;
  signal?.throwIfAborted();
  onProgress?.("正在后台解包与生成预览…");
  const queued = await unwrap(
    await client.POST("/api/typeset/upload-sessions/{id}/extract", {
      params: { path: { id } },
      body: {},
      signal,
    }),
  );
  onSession?.(queued);
  const result = await pollTransfer(
    queued,
    async () => {
      const current = await unwrap(
        await client.GET("/api/typeset/upload-sessions/{id}", {
          params: { path: { id } },
          signal,
        }),
      );
      onSession?.(current);
      const completed = current.files.filter(
        (file) => file.status === "processed",
      ).length;
      onProgress?.(`正在后台处理 ${completed}/${current.files.length} 个文件…`);
      return current;
    },
    ["extracting"],
    signal,
  );
  if (options.requireComplete) assertComplete(result);
  onProgress?.("");
  return result;
}
async function uploadTypesetFilesInternal(
  files: File[],
  options: TypesetTransferOptions = {},
): Promise<Session> {
  const { signal, onProgress, onSession } = options;
  if (!files.length) throw new Error("请选择成图或 ZIP");
  if (
    files.length > 200 ||
    files.reduce((sum, file) => sum + file.size, 0) >
      (options.maxTotalBytes ?? 512 * 1024 * 1024)
  )
    throw new Error("所选文件超过整批数量或容量上限");
  for (const file of files) {
    const type = typesetUploadContentType(file);
    if (
      !file.size ||
      file.size > (type === "application/zip" ? 250 : 25) * 1024 * 1024
    )
      throw new Error(`${file.name} 为空或超过单文件容量上限`);
  }
  let session: Session;
  if (options.sessionId) {
    session = await unwrap(
      await client.GET("/api/typeset/upload-sessions/{id}", {
        params: { path: { id: options.sessionId } },
        signal,
      }),
    );
    if (
      session.files.length !== files.length ||
      session.id !== options.sessionId
    )
      throw new Error("重试文件与上传会话不匹配，请重新选择文件");
    files = await matchTypesetSessionFiles(session, files, { signal });
    onSession?.(session);
    if (
      session.status === "previewed" &&
      session.files.every((file) => file.status === "processed")
    )
      return session;
    if (
      session.status === "extracting" &&
      session.files.every((file) => file.archive || file.status === "processed")
    )
      return extractTypesetSessionInternal(session.id, options);
  } else {
    const descriptors = [];
    for (const file of files) {
      signal?.throwIfAborted();
      onProgress?.(`正在校验：${file.name}`);
      descriptors.push({
        sourceName: file.name,
        contentType: typesetUploadContentType(file),
        size: file.size,
        checksum: await checksum(file),
      });
    }
    session = await unwrap(
      await client.POST("/api/typeset/upload-sessions", {
        body: { files: descriptors },
        signal,
      }),
    );
  }
  onSession?.(session);
  let next = 0;
  let completed = 0;
  const errors: string[] = [];
  const ready: number[] = [];
  const waiting: ((index: number | null) => void)[] = [];
  let uploadsFinished = false;
  function enqueue(index: number) {
    const receive = waiting.shift();
    if (receive) receive(index);
    else ready.push(index);
  }
  function take() {
    if (ready.length) return Promise.resolve(ready.shift()!);
    if (uploadsFinished) return Promise.resolve(null);
    return new Promise<number | null>((resolve) => waiting.push(resolve));
  }
  function report(item: Session["files"][number], error: unknown) {
    const readable = readableTransferError(error);
    errors.push(
      `${item.sourceName}：${readable instanceof Error ? readable.message : "上传连接中断"}`,
    );
  }
  const validators = Array.from(
    { length: Math.min(2, files.length) },
    async () => {
      while (true) {
        const index = await take();
        if (index === null) return;
        const item = session.files[index];
        try {
          let processed = false;
          for (let retry = 0; retry < 30; retry++) {
            signal?.throwIfAborted();
            const response = await authenticatedFetch(
              `/api/typeset/upload-sessions/${session.id}/files/${item.id}/verify`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "X-Comiku-Request": "1",
                },
                body: JSON.stringify(
                  await typesetImageDimensions(files[index]),
                ),
                signal,
              },
            );
            const verified =
              (await response.json()) as components["schemas"]["TypesetUploadFileDto"] & {
                message?: string;
              };
            if (
              !response.ok &&
              (response.status !== 409 ||
                verified.message?.includes("会话已过期"))
            )
              throw new Error(
                verified.message || `校验失败（HTTP ${response.status}）`,
              );
            if (response.ok && verified.status !== "verifying") {
              session = {
                ...session,
                files: session.files.map((file) =>
                  file.id === item.id ? verified : file,
                ),
              };
              onSession?.(session);
              if (verified.uploadMissing)
                uploadReceipts
                  .get(files[index])
                  ?.delete(`${session.id}:${item.id}`);
              if (verified.status !== "processed")
                throw new Error(verified.error || "文件校验失败，请重试");
              processed = true;
              completed++;
              onProgress?.(`已校验 ${completed}/${files.length} 个文件`);
              break;
            }
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              }, 1000);
              function abort() {
                clearTimeout(timer);
                reject(signal?.reason);
              }
              signal?.addEventListener("abort", abort, { once: true });
            });
          }
          if (!processed) throw new Error("文件仍在校验，请稍后重试保存");
        } catch (error) {
          report(item, error);
        }
      }
    },
  );
  // Three storage PUTs feed two independent metadata confirmation slots.
  // All requests settle before save or error reporting.
  const uploads = Promise.all(
    Array.from({ length: Math.min(3, files.length) }, async () => {
      while (next < files.length && !signal?.aborted) {
        const index = next++;
        const item = session.files[index];
        if (item.status === "processed") {
          completed++;
          continue;
        }
        try {
          signal?.throwIfAborted();
          const receiptKey = `${session.id}:${item.id}`;
          const receipts =
            uploadReceipts.get(files[index]) ?? new Set<string>();
          uploadReceipts.set(files[index], receipts);
          if (item.status !== "verifying" && !receipts.has(receiptKey)) {
            if (!item.upload) throw new Error("上传地址已失效");
            const immutable =
              !item.archive &&
              new Headers(item.upload.headers).get("If-None-Match") === "*";
            if (!item.archive) await typesetImageDimensions(files[index]);
            onProgress?.(
              `正在上传 ${completed}/${files.length}：${item.sourceName}`,
            );
            if (immutable) receipts.add(receiptKey);
            const response = await authenticatedFetch(item.upload.url, {
              method: item.upload.method,
              headers: item.upload.headers,
              body: files[index],
              signal,
            });
            if (!response.ok && !(immutable && response.status === 412))
              throw new Error(`上传失败（HTTP ${response.status}）`);
          }
          if (!item.archive) {
            enqueue(index);
          } else completed++;
        } catch (error) {
          report(item, error);
        }
      }
    }),
  ).finally(() => {
    uploadsFinished = true;
    for (const receive of waiting.splice(0)) receive(null);
  });
  await Promise.all([uploads, ...validators]);
  signal?.throwIfAborted();
  if (errors.length) throw new Error(`${errors.join("；")}。请重试上传`);
  if (session.files.some((file) => file.archive))
    return extractTypesetSessionInternal(session.id, options);
  session = await unwrap(
    await client.GET("/api/typeset/upload-sessions/{id}", {
      params: { path: { id: session.id } },
      signal,
    }),
  );
  if (options.requireComplete) assertComplete(session);
  onProgress?.("");
  return session;
}

function readableTransferError(error: unknown) {
  if (error instanceof SyntaxError)
    return new Error("上传服务返回了异常页面，请稍后重试或恢复上传");
  if (error instanceof TypeError)
    return new Error("文件读取或上传连接中断，请检查网络后重试");
  return error;
}
async function transferRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw readableTransferError(error);
  }
}
export function uploadTypesetFiles(
  files: File[],
  options: TypesetTransferOptions = {},
) {
  return transferRequest(() => uploadTypesetFilesInternal(files, options));
}
export function extractTypesetSession(
  id: string,
  options: TypesetTransferOptions = {},
) {
  return transferRequest(() => extractTypesetSessionInternal(id, options));
}
