import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertBackupPolicy,
  assertRestoreTarget,
  decryptBackup,
  encryptBackup,
  parseEncryptionKey,
} from "../src/ops/backup-archive.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
function databaseProcess(command: string, target: URL, extra: string[]) {
  const args = [
    "--host",
    target.hostname,
    "--port",
    target.port || "5432",
    "--username",
    decodeURIComponent(target.username),
    "--dbname",
    decodeURIComponent(target.pathname.slice(1)),
    ...extra,
  ];
  const child = spawn(command, args, {
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      PGPASSWORD: decodeURIComponent(target.password),
      PGCONNECT_TIMEOUT: "10",
      PGSSLMODE: target.searchParams.get("sslmode") ?? "prefer",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain errors without forwarding server names, SQL values or credentials.
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error(`${command} could not start.`)));
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} failed; inspect database readiness and permissions.`,
            ),
          ),
    );
  });
  void done.catch(() => {});
  return { child, done };
}
function storage() {
  const account = required("BACKUP_R2_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/i.test(account))
    throw new Error("Invalid backup R2 account ID.");
  return new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("BACKUP_R2_ACCESS_KEY_ID"),
      secretAccessKey: required("BACKUP_R2_SECRET_ACCESS_KEY"),
    },
  });
}
async function key() {
  return parseEncryptionKey(
    (await readFile(required("BACKUP_ENCRYPTION_KEY_FILE"), "utf8")).trim(),
  );
}

export async function runBackupCommand(args: string[]) {
  const secret = process.env.COMIKU_BACKUP_ENV_FILE;
  if (
    !secret ||
    !isAbsolute(secret) ||
    config({ path: secret, override: false, quiet: true }).error
  )
    throw new Error(
      "COMIKU_BACKUP_ENV_FILE must point to a readable absolute secret file.",
    );
  const mode = args[0];
  if (mode === "decrypt") {
    if (!args[1] || !args[2])
      throw new Error("Usage: decrypt encrypted-archive output-dump");
    const metadata = await decryptBackup(args[1], args[2], await key());
    console.log(JSON.stringify({ status: "decrypted", metadata }));
    return;
  }
  if (!["backup", "restore"].includes(mode))
    throw new Error(
      "Usage: backup [--test] | decrypt archive output | restore [--execute]",
    );
  const directory = await mkdtemp(join(tmpdir(), "comiku-backup-"));
  try {
    if (mode === "backup") {
      const target = assertBackupPolicy(process.env, args.includes("--test"));
      const release = required("COMIKU_RELEASE");
      if (release === "unconfigured")
        throw new Error("Build the image with an explicit COMIKU_RELEASE.");
      const output = join(directory, "database.comikubak");
      const dump = databaseProcess("pg_dump", target, [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ]);
      try {
        await Promise.all([
          encryptBackup(dump.child.stdout, output, await key(), {
            format: 1,
            createdAt: new Date().toISOString(),
            release,
            postgresMajor: 17,
          }),
          dump.done,
        ]);
      } catch (error) {
        dump.child.kill();
        throw error;
      }
      const size = (await stat(output)).size;
      if (args.includes("--local-only")) {
        const destination = args[args.indexOf("--output") + 1];
        if (
          !args.includes("--test") ||
          !args.includes("--output") ||
          !destination ||
          !isAbsolute(destination)
        )
          throw new Error(
            "Local-only backups require --test and an absolute --output path.",
          );
        await copyFile(output, destination, constants.COPYFILE_EXCL);
        console.log(
          JSON.stringify({ status: "local-test-backup", bytes: size, release }),
        );
        return;
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(output)) hash.update(chunk);
      const objectKey = `postgres/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.comikubak`;
      const client = storage();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: required("BACKUP_R2_BUCKET"),
            Key: objectKey,
            Body: createReadStream(output),
            ContentLength: size,
            ContentType: "application/octet-stream",
            Metadata: { sha256: hash.digest("hex"), release },
          }),
        );
      } finally {
        client.destroy();
      }
      console.log(
        JSON.stringify({ status: "ok", key: objectKey, bytes: size, release }),
      );
    } else {
      if (!args.includes("--execute"))
        throw new Error(
          "Restore requires explicit --execute into an empty _restore_test database.",
        );
      const target = assertRestoreTarget(required("RESTORE_DATABASE_URL"));
      const check = databaseProcess("psql", target, [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p');",
      ]);
      let tables = "";
      for await (const chunk of check.child.stdout) tables += String(chunk);
      await check.done;
      if (tables.trim() !== "0")
        throw new Error(
          "Restore target is not empty; existing tables are never overwritten.",
        );
      const encrypted = join(directory, "database.comikubak"),
        dump = join(directory, "database.dump");
      const localArchive = process.env.RESTORE_ARCHIVE_FILE;
      if (localArchive && !isAbsolute(localArchive))
        throw new Error("RESTORE_ARCHIVE_FILE must be absolute.");
      if (!localArchive) {
        const objectKey = required("BACKUP_OBJECT_KEY");
        if (
          !/^postgres\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]+\.comikubak$/.test(
            objectKey,
          )
        )
          throw new Error("Invalid backup object key.");
        const client = storage();
        try {
          const result = await client.send(
            new GetObjectCommand({
              Bucket: required("BACKUP_R2_BUCKET"),
              Key: objectKey,
            }),
          );
          if (!result.Body) throw new Error("Backup object is missing.");
          await pipeline(
            result.Body.transformToWebStream(),
            (await import("node:fs")).createWriteStream(encrypted, {
              flags: "wx",
              mode: 0o600,
            }),
          );
        } finally {
          client.destroy();
        }
      }
      const metadata = await decryptBackup(
        localArchive || encrypted,
        dump,
        await key(),
      );
      const restore = databaseProcess("pg_restore", target, [
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        dump,
      ]);
      restore.child.stdout.resume();
      await restore.done;
      console.log(JSON.stringify({ status: "restored", metadata }));
    }
  } finally {
    // Only this mkdtemp-created directory, never an input or calculated database path.
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runBackupCommand(process.argv.slice(2));
  } catch {
    console.error(
      "备份/恢复失败：检查确认策略、密钥文件、独立目标、磁盘容量和服务权限；详细凭据不写入日志。",
    );
    process.exitCode = 1;
  }
}
