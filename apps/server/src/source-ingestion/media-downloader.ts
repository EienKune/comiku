import { createHash } from "node:crypto";
import { SourceResponseError } from "./source-response.js";

export interface DownloadedMedia {
  body: Uint8Array;
  contentType: string;
  checksum: string;
}

export interface MediaDownloader {
  download(
    url: string,
    allowedHosts: readonly string[],
  ): Promise<DownloadedMedia>;
}

export const MEDIA_DOWNLOADER = Symbol("MEDIA_DOWNLOADER");
const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
export class HttpMediaDownloader implements MediaDownloader {
  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly maximumBytes = 50 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 100 * 1024 * 1024
    )
      throw new Error("Source media limit must be between 1 byte and 100 MiB");
  }

  async download(
    url: string,
    allowedHosts: readonly string[],
  ): Promise<DownloadedMedia> {
    const reject = (reason: string, details: Record<string, unknown> = {}) =>
      new SourceResponseError("configuration", {
        reason,
        scope: "media",
        diagnostic: {
          stage: "download",
          limit_bytes: this.maximumBytes,
          ...details,
        },
      });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw reject("media_url_not_allowed");
    }
    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    ) {
      throw reject("media_url_not_allowed");
    }
    const response = await this.fetchImplementation(parsed, {
      ...(parsed.hostname === "i.pximg.net"
        ? { headers: { Referer: "https://www.pixiv.net/" } }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!response.ok)
        throw new SourceResponseError("temporary_failure", {
          reason: `media_http_${response.status}`,
          scope: "media",
          diagnostic: {
            stage: "download",
            http_status: response.status,
            http_endpoint: url,
          },
        });
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .toLowerCase();
      const declaredSize = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (!contentType || !allowedTypes.has(contentType))
        throw reject("media_type_unsupported");
      if (declaredSize > this.maximumBytes)
        throw reject("media_size_limit", { declared_bytes: declaredSize });
      if (!response.body) throw reject("media_empty");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const checksum = createHash("sha256");
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maximumBytes)
          throw reject("media_size_limit", { observed_bytes: size });
        chunks.push(value);
        checksum.update(value);
      }
      if (!size) throw reject("media_empty");
      return {
        body: Buffer.concat(chunks, size),
        contentType,
        checksum: checksum.digest("hex"),
      };
    } catch (error) {
      if (reader) await reader.cancel().catch(() => undefined);
      else await response.body?.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader?.releaseLock();
    }
  }
}
