export interface StoredObjectMetadata {
  contentType?: string;
  size?: number;
  checksum?: string;
}

export interface PutObjectInput {
  key: string;
  body: Uint8Array | Readable;
  size: number;
  contentType: string;
  checksum: string;
}

export interface SignedWriteInput {
  key: string;
  contentType: string;
  size: number;
  checksum: string;
}

export interface SignedWriteTarget {
  url: string;
  expiresInSeconds: number;
  headers: Record<string, string>;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  readStream(key: string): Promise<Readable>;
  head(key: string): Promise<StoredObjectMetadata | null>;
  signedReadUrl(
    key: string,
    expiresInSeconds: number,
    fileName?: string,
  ): Promise<string>;
  signedWriteUrl(
    input: SignedWriteInput,
    expiresInSeconds: number,
  ): Promise<SignedWriteTarget>;
  writeSigned?(token: string, body: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export function validateObjectKey(key: string): string {
  if (
    key.length < 1 ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === "." || part === "..") ||
    [...key].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error("Invalid object key");
  }
  return key;
}

export function validateReadExpiry(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("Signed read expiry must be between 1 and 3600 seconds");
  }
  return seconds;
}

export function validateSignedWriteInput(
  input: SignedWriteInput,
  expiresInSeconds: number,
): SignedWriteInput {
  validateObjectKey(input.key);
  validateReadExpiry(expiresInSeconds);
  if (
    !input.contentType ||
    input.contentType.length > 255 ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    !/^[a-f0-9]{64}$/i.test(input.checksum)
  ) {
    throw new Error("Invalid signed write metadata");
  }
  return input;
}
import type { Readable } from "node:stream";
