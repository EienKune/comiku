import { createHash } from "node:crypto";

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
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`Media download failed with status ${response.status}`);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .toLowerCase();
    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (!contentType || !allowedTypes.has(contentType))
      throw new Error("Unsupported media type");
    if (declaredSize > maximumBytes)
      throw new Error("Media exceeds the size limit");
    const body = new Uint8Array(await response.arrayBuffer());
    if (!body.byteLength || body.byteLength > maximumBytes)
      throw new Error("Invalid media size");
    return {
      body,
      contentType,
      checksum: createHash("sha256").update(body).digest("hex"),
    };
  }
}
