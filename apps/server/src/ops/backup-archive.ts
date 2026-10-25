import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("COMIKUB1");
const PREFIX_SIZE = 24;
export type BackupMetadata = {
  format: 1;
  createdAt: string;
  release: string;
  postgresMajor: 17;
};

export function parseEncryptionKey(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("Backup key must be 32 random bytes encoded as hex.");
  return Buffer.from(value, "hex");
}

export async function encryptBackup(
  input: Readable,
  output: string,
  key: Buffer,
  metadata: BackupMetadata,
) {
  const nonce = randomBytes(12);
  const json = Buffer.from(JSON.stringify(metadata));
  if (json.length > 65_536 || key.length !== 32)
    throw new Error("Invalid backup metadata or key.");
  const prefix = Buffer.alloc(PREFIX_SIZE);
  MAGIC.copy(prefix);
  nonce.copy(prefix, 8);
  prefix.writeUInt32BE(json.length, 20);
  const header = Buffer.concat([prefix, json]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  // Reserve the path; never overwrite an existing archive.
  await writeFile(output, header, { flag: "wx", mode: 0o600 });
  try {
    await pipeline(input, cipher, createWriteStream(output, { flags: "a" }));
    await appendFile(output, cipher.getAuthTag());
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}

export async function decryptBackup(
  input: string,
  output: string,
  key: Buffer,
): Promise<BackupMetadata> {
  const size = (await stat(input)).size;
  const handle = await open(input, "r");
  let header: Buffer, nonce: Buffer, tag: Buffer, metadata: BackupMetadata;
  try {
    const prefix = Buffer.alloc(PREFIX_SIZE);
    if (
      (await handle.read(prefix, 0, PREFIX_SIZE, 0)).bytesRead !==
        PREFIX_SIZE ||
      !prefix.subarray(0, 8).equals(MAGIC)
    )
      throw new Error("Invalid backup archive.");
    const length = prefix.readUInt32BE(20);
    if (length > 65_536 || length < 1 || size < PREFIX_SIZE + length + 16)
      throw new Error("Invalid backup header.");
    header = Buffer.alloc(PREFIX_SIZE + length);
    prefix.copy(header);
    await handle.read(header, PREFIX_SIZE, length, PREFIX_SIZE);
    metadata = JSON.parse(
      header.subarray(PREFIX_SIZE).toString(),
    ) as BackupMetadata;
    if (
      metadata.format !== 1 ||
      metadata.postgresMajor !== 17 ||
      typeof metadata.release !== "string" ||
      typeof metadata.createdAt !== "string"
    )
      throw new Error("Unsupported backup format.");
    nonce = prefix.subarray(8, 20);
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const pending = output + "." + randomUUID() + ".pending";
  await writeFile(output, "", { flag: "wx", mode: 0o600 });
  try {
    await pipeline(
      createReadStream(input, { start: header.length, end: size - 17 }),
      decipher,
      createWriteStream(pending, { flags: "wx", mode: 0o600 }),
    );
    await rename(pending, output);
    return metadata;
  } catch (error) {
    await rm(pending, { force: true });
    await rm(output, { force: true });
    throw error;
  }
}

export function assertRestoreTarget(databaseUrl: string) {
  const target = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !/^[a-zA-Z0-9_]+_restore_test$/.test(target.pathname.slice(1))
  )
    throw new Error(
      "Restore is limited to a separate database ending in _restore_test.",
    );
  return target;
}

export function assertBackupPolicy(input: NodeJS.ProcessEnv, test: boolean) {
  const target = new URL(input.BACKUP_DATABASE_URL ?? "");
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !target.hostname ||
    !target.username ||
    !/^\/[a-zA-Z0-9_]+$/.test(target.pathname)
  )
    throw new Error("Backup database must be an explicit PostgreSQL target.");
  if (test) {
    if (!target.pathname.endsWith("_test"))
      throw new Error(
        "Test backup requires a disposable database ending in _test.",
      );
  } else {
    if (input.BACKUP_POLICY_CONFIRMED !== "true")
      throw new Error(
        "Confirm backup policy before enabling production backups.",
      );
    for (const name of [
      "BACKUP_INTERVAL_HOURS",
      "BACKUP_RETENTION_DAYS",
      "BACKUP_RPO_HOURS",
      "BACKUP_RTO_MINUTES",
    ])
      if (!/^[1-9]\d*$/.test(input[name] ?? ""))
        throw new Error(`Explicit ${name} is required.`);
    if (Number(input.BACKUP_INTERVAL_HOURS) > Number(input.BACKUP_RPO_HOURS))
      throw new Error(
        "Backup interval exceeds the stated recovery point target.",
      );
  }
  if (
    !input.BUSINESS_R2_BUCKET ||
    !input.BACKUP_R2_BUCKET ||
    input.BUSINESS_R2_BUCKET === input.BACKUP_R2_BUCKET
  )
    throw new Error("Backup bucket must be separate from the business bucket.");
  return target;
}
