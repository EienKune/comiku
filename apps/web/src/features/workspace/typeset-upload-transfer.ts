import type { components } from "@comiku/api-client";
import { authenticatedFetch, client, unwrap } from "../account/api";
import { pollTransfer } from "./transfers-api";
import {
  typesetUploadContentType,
  uploadFileChecksum,
} from "./typeset-upload-plan";

type Session = components["schemas"]["TypesetUploadSessionDto"];
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
      session.files.some((file, i) => file.sourceName !== files[i].name)
    )
      throw new Error("重试文件与上传会话不匹配，请重新选择文件");
    onSession?.(session);
    if (
      session.status === "previewed" &&
      session.files.every((file) => file.status === "processed")
    )
      return session;
    if (session.status === "extracting")
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
        checksum: await uploadFileChecksum(file),
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
  // Bound outgoing bodies, and settle all in-flight uploads before reporting failure.
  await Promise.all(
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
          if (!item.upload) throw new Error("上传地址已失效");
          onProgress?.(
            `正在上传 ${completed}/${files.length}：${item.sourceName}`,
          );
          const response = await authenticatedFetch(item.upload.url, {
            method: item.upload.method,
            headers: item.upload.headers,
            body: files[index],
            signal,
          });
          if (!response.ok)
            throw new Error(`上传失败（HTTP ${response.status}）`);
          completed++;
          onProgress?.(`已上传 ${completed}/${files.length} 个文件`);
        } catch (error) {
          const readable = readableTransferError(error);
          errors.push(
            `${item.sourceName}：${readable instanceof Error ? readable.message : "上传连接中断"}`,
          );
        }
      }
    }),
  );
  signal?.throwIfAborted();
  if (errors.length) throw new Error(`${errors.join("；")}。请重试上传`);
  return extractTypesetSessionInternal(session.id, options);
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
