import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Environment } from "../config/environment.js";
import {
  type ObjectStorage,
  type PutObjectInput,
  type SignedWriteInput,
  type SignedWriteTarget,
  type StoredObjectMetadata,
  validateObjectKey,
  validateReadExpiry,
  validateSignedWriteInput,
} from "./object-storage.js";

export class ObjectStorageUnavailableError extends Error {
  constructor() {
    super("Object storage is not configured");
  }
}

export class UnavailableObjectStorage implements ObjectStorage {
  private unavailable(): never {
    throw new ObjectStorageUnavailableError();
  }
  async put(_input: PutObjectInput): Promise<void> {
    void _input;
    this.unavailable();
  }
  async read(_key: string): Promise<Uint8Array> {
    void _key;
    this.unavailable();
  }
  async readStream(_key: string): Promise<Readable> {
    void _key;
    this.unavailable();
  }
  async head(_key: string): Promise<null> {
    void _key;
    this.unavailable();
  }
  async signedReadUrl(
    _key: string,
    _expiresInSeconds: number,
  ): Promise<string> {
    void _key;
    void _expiresInSeconds;
    this.unavailable();
  }
  async signedWriteUrl(
    _input: SignedWriteInput,
    _expiresInSeconds: number,
  ): Promise<SignedWriteTarget> {
    void _input;
    void _expiresInSeconds;
    this.unavailable();
  }
  async delete(_key: string): Promise<void> {
    void _key;
    this.unavailable();
  }
}

export class R2ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: NonNullable<Environment["r2"]>) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<void> {
    validateObjectKey(input.key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.size,
        ContentType: input.contentType,
        CacheControl: "private, max-age=30",
        Metadata: { sha256: input.checksum },
      }),
    );
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    validateObjectKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentType: result.ContentType,
        size: result.ContentLength,
        checksum: result.Metadata?.sha256,
      };
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "$metadata" in error
          ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
          : undefined;
      if (status === 404) return null;
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array> {
    validateObjectKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("Object body is unavailable");
    return result.Body.transformToByteArray();
  }

  async readStream(key: string): Promise<Readable> {
    validateObjectKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("Object body is unavailable");
    return Readable.fromWeb(result.Body.transformToWebStream());
  }

  signedReadUrl(
    key: string,
    expiresInSeconds: number,
    fileName?: string,
  ): Promise<string> {
    validateObjectKey(key);
    validateReadExpiry(expiresInSeconds);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: fileName
          ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
          : undefined,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async signedWriteUrl(
    input: SignedWriteInput,
    expiresInSeconds: number,
  ): Promise<SignedWriteTarget> {
    validateSignedWriteInput(input, expiresInSeconds);
    const headers = {
      "Content-Type": input.contentType,
      "x-amz-meta-sha256": input.checksum.toLowerCase(),
    };
    return {
      url: await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ContentType: input.contentType,
          Metadata: { sha256: input.checksum.toLowerCase() },
        }),
        { expiresIn: expiresInSeconds },
      ),
      expiresInSeconds,
      headers,
    };
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
