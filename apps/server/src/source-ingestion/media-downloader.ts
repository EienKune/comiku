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
const maximumBytes = 25 * 1024 * 1024;

export class HttpMediaDownloader implements MediaDownloader {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async download(
    url: string,
    allowedHosts: readonly string[],
  ): Promise<DownloadedMedia> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.includes(parsed.hostname)
    ) {
      throw new Error("Media URL is not allowed");
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
        throw new Error("Unsupported media type");
      if (declaredSize > maximumBytes)
        throw new Error("Media exceeds the size limit");
      if (!response.body) throw new Error("Invalid media size");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const checksum = createHash("sha256");
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes)
          throw new Error("Media exceeds the size limit");
        chunks.push(value);
        checksum.update(value);
      }
      if (!size) throw new Error("Invalid media size");
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
