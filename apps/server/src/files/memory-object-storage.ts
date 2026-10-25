import { Readable } from "node:stream";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<
    string,
    Omit<PutObjectInput, "body"> & { body: Uint8Array }
  >();
  private readonly signingKey = randomBytes(32);

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey)
      .update(payload)
      .digest("base64url");
  }

  async put(input: PutObjectInput): Promise<void> {
    validateObjectKey(input.key);
    let body: Uint8Array;
    if (input.body instanceof Uint8Array) {
      body = input.body.slice();
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      body = new Uint8Array(Buffer.concat(chunks));
    }
    this.objects.set(input.key, { ...input, body });
  }

  async read(key: string): Promise<Uint8Array> {
    const item = this.objects.get(validateObjectKey(key));
    if (!item) throw new Error("Object not found");
    return item.body.slice();
  }

  async readStream(key: string) {
    return Readable.from([await this.read(key)]);
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const item = this.objects.get(validateObjectKey(key));
    return item
      ? {
          contentType: item.contentType,
          size: item.body.byteLength,
          checksum: item.checksum,
        }
      : null;
  }

  async signedReadUrl(
    key: string,
    expiresInSeconds: number,
    _fileName?: string,
  ): Promise<string> {
    void _fileName;
    validateReadExpiry(expiresInSeconds);
    if (!this.objects.has(validateObjectKey(key)))
      throw new Error("Object not found");
    return `memory://object/${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
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
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new Error("Invalid file token");
    const expected = Buffer.from(this.sign(payload), "base64url");
    const provided = Buffer.from(signature, "base64url");
    if (
      provided.byteLength !== expected.byteLength ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new Error("Invalid file token");
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid file token");
    }
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
    await this.put({
      key: data.key,
      body,
      size: body.byteLength,
      contentType: data.contentType,
      checksum: data.checksum,
    });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(validateObjectKey(key));
  }
}
