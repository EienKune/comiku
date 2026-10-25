import type { components } from "@comiku/api-client";
import { apiBaseUrl, authenticatedFetch, client, unwrap } from "../account/api";
import {
  typesetUploadContentType,
  uploadFileChecksum,
} from "./typeset-upload-plan";

type CreateUpload = components["schemas"]["CreateDirectUploadDto"];
type PrepareDownload = Omit<
  components["schemas"]["PrepareDownloadDto"],
  "requireCurrentParticipation"
> & { requireCurrentParticipation?: boolean };

export async function pollTransfer<
  T extends { status: string; error?: string | null },
>(
  initial: T,
  read: () => Promise<T>,
  pending: string[],
  signal?: AbortSignal,
): Promise<T> {
  let current = initial;
  const deadline = Date.now() + 15 * 60_000;
  while (pending.includes(current.status)) {
    signal?.throwIfAborted();
    if (Date.now() > deadline)
      throw new Error("后台仍在处理，请稍后恢复会话查看结果");
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", stop);
        resolve();
      }, 2_000);
      signal?.addEventListener("abort", stop, { once: true });
    });
    signal?.throwIfAborted();
    current = await read();
  }
  if (["failed", "expired"].includes(current.status))
    throw new Error(current.error || "处理失败或会话已过期，请重新选择文件");
  return current;
}

export async function uploadDirect(
  input: Omit<CreateUpload, "files">,
  files: File[],
) {
  const descriptors = [];
  for (const file of files) {
    const contentType = typesetUploadContentType(file);
    if (contentType === "application/zip")
      throw new Error("此处仅支持 PNG、JPEG、WebP 图片");
    descriptors.push({
      sourceName: file.name,
      contentType,
      size: file.size,
      checksum: await uploadFileChecksum(file),
    });
  }
  const session = await unwrap(
    await client.POST("/api/transfers/uploads", {
      body: { ...input, files: descriptors },
    }),
  );
  for (const [index, file] of files.entries()) {
    const target = session.files[index]?.upload;
    if (!target) throw new Error("上传会话已过期，请重新选择文件");
    const response = await authenticatedFetch(target.url, {
      method: "PUT",
      headers: target.headers,
      body: file,
      credentials: target.url.startsWith("/api/") ? "include" : "omit",
    });
    if (!response.ok) throw new Error(`上传失败：${file.name}`);
  }
  const queued = await unwrap(
    await client.POST("/api/transfers/uploads/{id}/finalize", {
      params: { path: { id: session.id } },
      body: {},
    }),
  );
  return pollTransfer(
    queued,
    async () =>
      unwrap(
        await client.GET("/api/transfers/uploads/{id}", {
          params: { path: { id: session.id } },
        }),
      ),
    ["queued", "processing"],
  );
}

export async function downloadPrepared(
  input: PrepareDownload,
  signal?: AbortSignal,
) {
  const task = await unwrap(
    await client.POST("/api/transfers/downloads", {
      body: {
        ...input,
        requireCurrentParticipation:
          input.requireCurrentParticipation !== false,
      },
      signal,
    }),
  );
  const completed = await pollTransfer(
    task,
    async () =>
      unwrap(
        await client.GET("/api/transfers/downloads/{id}", {
          params: { path: { id: task.id } },
          signal,
        }),
      ),
    ["queued", "running"],
    signal,
  );
  const delivery = await unwrap(
    await client.POST("/api/transfers/downloads/{id}/deliver", {
      params: { path: { id: completed.id } },
      body: {},
      signal,
    }),
  );
  // A signed URL goes directly to the browser; archive bytes never become an API response Blob.
  const anchor = document.createElement("a");
  anchor.href = delivery.url.startsWith("/api/")
    ? apiBaseUrl + delivery.url
    : delivery.url;
  anchor.download = delivery.fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return delivery;
}
