import { Readable, addAbortSignal } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Environment } from "../config/environment.js";
import {
  validateObjectKey,
  validateReadExpiry,
} from "../files/object-storage.js";

export const ARCHIVE_STORAGE = Symbol("ARCHIVE_STORAGE");
export const ARCHIVE_PART_SIZE = 16 * 1024 ** 2;
export interface ArchiveIdentity {
  runId: string;
  packageId: string;
  attemptId: string;
}
export interface ArchivePart {
  partNumber: number;
  etag: string;
  size: number;
}
export interface ArchiveCompleteInput {
  key: string;
  uploadId: string;
  parts: readonly ArchivePart[];
}
export interface ArchiveHead {
  bytes: bigint;
  identity: ArchiveIdentity;
}
export interface ArchiveStorage {
  close?(): void;
  openSource(key: string, signal: AbortSignal): Promise<Readable>;
  createMultipart(
    input: { key: string; identity: ArchiveIdentity },
    signal: AbortSignal,
  ): Promise<string>;
  uploadPart(
    input: { key: string; uploadId: string; partNumber: number; body: Buffer },
    signal: AbortSignal,
  ): Promise<ArchivePart>;
  completeMultipart(
    input: ArchiveCompleteInput,
    signal: AbortSignal,
  ): Promise<void>;
  abortMultipart(
    key: string,
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  head(key: string, signal?: AbortSignal): Promise<ArchiveHead | null>;
  listMultipart(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ key: string; uploadId: string }[]>;
  listParts(
    key: string,
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<ArchivePart[]>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  signedDownload(
    key: string,
    expiresInSeconds: number,
    fileName: string,
  ): Promise<string>;
}

export function archiveObjectKey(identity: ArchiveIdentity): string {
  if (
    ![identity.runId, identity.packageId, identity.attemptId].every(
      (value) =>
        typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value),
    )
  )
    throw new Error("Invalid archive identity");
  return `archive-exports/${identity.runId}/${identity.packageId}/${identity.attemptId}.zip`;
}
export function validateArchiveObjectKey(key: string): string {
  if (
    !/^archive-exports\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\.zip$/.test(
      key,
    )
  ) {
    throw new Error("Invalid archive object key");
  }
  return validateObjectKey(key);
}

export function createArchiveStorage(
  environment: Pick<Environment, "r2" | "objectStorageDriver"> & {
    archiveExports: { enabled: boolean };
  },
): ArchiveStorage | null {
  if (
    !environment.archiveExports.enabled ||
    !environment.r2 ||
    environment.objectStorageDriver !== "r2"
  )
    return null;
  return new R2ArchiveStorage(environment.r2);
}

/** An independent client; importing this module never creates a connection. */
export class R2ArchiveStorage implements ArchiveStorage {
  private readonly client: S3Client;
  private readonly prefix: string;
  constructor(
    private readonly config: NonNullable<Environment["r2"]>,
    client?: S3Client,
  ) {
    this.prefix = config.keyPrefix ?? "";
    if (
      this.prefix &&
      (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(this.prefix) || this.prefix.length > 200)
    )
      throw new Error("Invalid storage prefix");
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }
  private key(key: string) {
    return this.prefix + validateArchiveObjectKey(key);
  }
  close() {
    this.client.destroy();
  }
  async openSource(key: string, signal: AbortSignal): Promise<Readable> {
    signal.throwIfAborted();
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.prefix + validateObjectKey(key),
      }),
      { abortSignal: signal },
    );
    if (!result.Body) throw new Error("Archive source body unavailable");
    return addAbortSignal(
      signal,
      Readable.fromWeb(result.Body.transformToWebStream()),
    );
  }
  async createMultipart(
    input: { key: string; identity: ArchiveIdentity },
    signal: AbortSignal,
  ) {
    if (archiveObjectKey(input.identity) !== input.key)
      throw new Error("Archive identity mismatch");
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: this.key(input.key),
        ContentType: "application/zip",
        CacheControl: "private, no-store",
        Metadata: {
          "archive-run": input.identity.runId,
          "archive-package": input.identity.packageId,
          "archive-attempt": input.identity.attemptId,
        },
      }),
      { abortSignal: signal },
    );
    if (!result.UploadId) throw new Error("Archive upload ID unavailable");
    return result.UploadId;
  }
  async uploadPart(
    input: { key: string; uploadId: string; partNumber: number; body: Buffer },
    signal: AbortSignal,
  ): Promise<ArchivePart> {
    if (
      !Number.isInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > 10_000 ||
      input.body.length > 32 * 1024 ** 2 ||
      !input.body.length
    )
      throw new Error("Invalid archive part");
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: this.key(input.key),
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
        ContentLength: input.body.length,
      }),
      { abortSignal: signal },
    );
    if (!result.ETag) throw new Error("Archive part ETag unavailable");
    return {
      partNumber: input.partNumber,
      etag: result.ETag,
      size: input.body.length,
    };
  }
  async completeMultipart(input: ArchiveCompleteInput, signal: AbortSignal) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: this.key(input.key),
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
      { abortSignal: signal },
    );
  }
  async abortMultipart(
    key: string,
    uploadId: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: this.key(key),
        UploadId: uploadId,
      }),
      { abortSignal: signal },
    );
  }
  async head(
    key: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ): Promise<ArchiveHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: this.key(key),
        }),
        { abortSignal: signal },
      );
      const identity = {
        runId: result.Metadata?.["archive-run"] ?? "",
        packageId: result.Metadata?.["archive-package"] ?? "",
        attemptId: result.Metadata?.["archive-attempt"] ?? "",
      };
      if (
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength! < 0 ||
        archiveObjectKey(identity) !== key
      )
        throw new Error("Archive object identity mismatch");
      return { bytes: BigInt(result.ContentLength!), identity };
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  async listMultipart(
    key: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    const physical = this.key(key);
    const uploads: { key: string; uploadId: string }[] = [];
    let keyMarker: string | undefined, uploadIdMarker: string | undefined;
    let pages = 0;
    do {
      if (++pages > 10)
        throw new Error("Archive multipart listing budget exceeded");
      const result = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.config.bucket,
          Prefix: physical,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
          MaxUploads: 100,
        }),
        { abortSignal: signal },
      );
      for (const upload of result.Uploads ?? [])
        if (upload.Key === physical && upload.UploadId)
          uploads.push({ key, uploadId: upload.UploadId });
      if (uploads.length > 100)
        throw new Error("Archive multipart reconciliation budget exceeded");
      if (!result.IsTruncated) break;
      if (
        !result.NextKeyMarker ||
        (result.NextKeyMarker === keyMarker &&
          result.NextUploadIdMarker === uploadIdMarker)
      )
        throw new Error("Invalid archive multipart cursor");
      keyMarker = result.NextKeyMarker;
      uploadIdMarker = result.NextUploadIdMarker;
    } while (keyMarker !== undefined);
    return uploads;
  }
  async listParts(
    key: string,
    uploadId: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    const parts: ArchivePart[] = [];
    let marker: string | undefined;
    let pages = 0;
    do {
      if (++pages > 10)
        throw new Error("Archive parts listing budget exceeded");
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: this.key(key),
          UploadId: uploadId,
          PartNumberMarker: marker,
          MaxParts: 1000,
        }),
        { abortSignal: signal },
      );
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || part.Size == null)
          throw new Error("Invalid archive part receipt");
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }
      if (parts.length > 10_000)
        throw new Error("Archive parts budget exceeded");
      if (!result.IsTruncated) break;
      if (
        !result.NextPartNumberMarker ||
        result.NextPartNumberMarker === marker
      )
        throw new Error("Invalid archive parts cursor");
      marker = result.NextPartNumberMarker;
    } while (marker !== undefined);
    return parts;
  }
  async delete(key: string, signal: AbortSignal = AbortSignal.timeout(60_000)) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(key),
      }),
      { abortSignal: signal },
    );
  }
  signedDownload(key: string, expiresInSeconds: number, fileName: string) {
    validateReadExpiry(expiresInSeconds);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(key),
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}
