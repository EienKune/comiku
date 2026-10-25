import type { Readable } from "node:stream";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
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

interface LocalMetadata {
  contentType: string;
  size: number;
  checksum: string;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;
  private readonly signingKey: Buffer;

  constructor(root: string) {
    this.root = resolve(root);
    this.signingKey = randomBytes(32);
  }

  private path(key: string): string {
    const target = resolve(this.root, ...validateObjectKey(key).split("/"));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error("Invalid object key");
    }
    return target;
  }

  private metadataPath(key: string): string {
    return this.path(key) + ".metadata.json";
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey)
      .update(payload)
      .digest("base64url");
  }

  private verify(token: string): Record<string, unknown> {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new Error("Invalid file token");
    const expected = Buffer.from(this.sign(payload), "base64url");
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("Invalid file token");
    }
    if (
      provided.byteLength !== expected.byteLength ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new Error("Invalid file token");
    }
    try {
      return JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid file token");
    }
  }

  async put(input: PutObjectInput): Promise<void> {
    const target = this.path(input.key);
    await mkdir(dirname(target), { recursive: true });
    if (input.body instanceof Uint8Array) {
      await writeFile(target, input.body, { flag: "wx" });
    } else {
      await pipeline(input.body, createWriteStream(target, { flags: "wx" }));
    }
    try {
      await writeFile(
        this.metadataPath(input.key),
        JSON.stringify({
          contentType: input.contentType,
          size: input.size,
          checksum: input.checksum,
        } satisfies LocalMetadata),
        { flag: "wx" },
      );
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async readStream(key: string): Promise<Readable> {
    if (!(await this.head(key))) throw new Error("Object not found");
    return createReadStream(this.path(key));
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const [file, metadata] = await Promise.all([
        stat(this.path(key)),
        readFile(this.metadataPath(key), "utf8"),
      ]);
      const parsed = JSON.parse(metadata) as LocalMetadata;
      return {
        contentType: parsed.contentType,
        size: file.size,
        checksum: parsed.checksum,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async signedReadUrl(
    key: string,
    expiresInSeconds: number,
    fileName?: string,
  ): Promise<string> {
    validateObjectKey(key);
    validateReadExpiry(expiresInSeconds);
    if (!(await this.head(key))) throw new Error("Object not found");
    const payload = Buffer.from(
      JSON.stringify({
        key,
        fileName,
        expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
      }),
    ).toString("base64url");
    const signature = this.sign(payload);
    return "/api/local-files/" + payload + "." + signature;
  }

  async readSigned(token: string): Promise<{
    body: Uint8Array;
    contentType: string;
  }> {
    const data = this.verify(token);
    if (
      typeof data.key !== "string" ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      throw new Error("Expired or invalid file token");
    }
    const metadata = await this.head(data.key);
    if (!metadata?.contentType) throw new Error("Object not found");
    return {
      body: await this.read(data.key),
      contentType: metadata.contentType,
    };
  }

  async readSignedStream(token: string) {
    const data = this.verify(token);
    if (
      typeof data.key !== "string" ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt < Math.floor(Date.now() / 1000)
    )
      throw new Error("Expired or invalid file token");
    const metadata = await this.head(data.key);
    if (!metadata?.contentType) throw new Error("Object not found");
    return {
      body: await this.readStream(data.key),
      contentType: metadata.contentType,
      fileName: typeof data.fileName === "string" ? data.fileName : undefined,
    };
  }

  async signedWriteUrl(
    input: SignedWriteInput,
    expiresInSeconds: number,
  ): Promise<SignedWriteTarget> {
    validateSignedWriteInput(input, expiresInSeconds);
    const payload = Buffer.from(
      JSON.stringify({
        ...input,
        checksum: input.checksum.toLowerCase(),
        expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
      }),
    ).toString("base64url");
    return {
      url: "/api/local-files/uploads/" + payload + "." + this.sign(payload),
      expiresInSeconds,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Comiku-Request": "1",
      },
    };
  }

  signedWriteMetadata(token: string): SignedWriteInput {
    const data = this.verify(token);
    if (
      typeof data.key !== "string" ||
      typeof data.contentType !== "string" ||
      typeof data.size !== "number" ||
      typeof data.checksum !== "string" ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      throw new Error("Expired or invalid file token");
    }
    validateSignedWriteInput(
      {
        key: data.key,
        contentType: data.contentType,
        size: data.size,
        checksum: data.checksum,
      },
      Math.max(1, data.expiresAt - Math.floor(Date.now() / 1000)),
    );
    return {
      key: data.key,
      contentType: data.contentType,
      size: data.size,
      checksum: data.checksum,
    };
  }

  async writeSigned(token: string, body: Uint8Array): Promise<void> {
    const data = this.signedWriteMetadata(token);
    const checksum = createHash("sha256").update(body).digest("hex");
    if (body.byteLength !== data.size || checksum !== data.checksum) {
      throw new Error("Uploaded object does not match signed metadata");
    }
    const existing = await this.head(data.key);
    if (
      existing?.size === data.size &&
      existing.contentType === data.contentType &&
      existing.checksum === data.checksum
    ) {
      return;
    }
    if (existing) await this.delete(data.key);
    await this.put({
      key: data.key,
      body,
      size: body.byteLength,
      contentType: data.contentType,
      checksum: data.checksum,
    });
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      rm(this.path(key), { force: true }),
      rm(this.metadataPath(key), { force: true }),
    ]);
  }
}
