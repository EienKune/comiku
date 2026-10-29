import type {
  ObjectStorage,
  PutObjectInput,
  SignedWriteInput,
} from "./object-storage.js";
import { validateObjectKey } from "./object-storage.js";

/** Logical database keys stay unchanged; all physical operations share one namespace. */
export class PrefixedObjectStorage implements ObjectStorage {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly prefix: string,
  ) {
    if (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix) || prefix.length > 200)
      throw new Error("Invalid storage prefix");
  }
  private key(key: string) {
    validateObjectKey(key);
    return this.prefix + key;
  }
  async put(input: PutObjectInput) {
    return this.storage.put({ ...input, key: this.key(input.key) });
  }
  async read(key: string) {
    return this.storage.read(this.key(key));
  }
  async readStream(key: string) {
    return this.storage.readStream(this.key(key));
  }
  async head(key: string) {
    return this.storage.head(this.key(key));
  }
  async signedReadUrl(key: string, expires: number, fileName?: string) {
    return this.storage.signedReadUrl(this.key(key), expires, fileName);
  }
  async signedWriteUrl(input: SignedWriteInput, expires: number) {
    return this.storage.signedWriteUrl(
      { ...input, key: this.key(input.key) },
      expires,
    );
  }
  async delete(key: string) {
    return this.storage.delete(this.key(key));
  }
}
