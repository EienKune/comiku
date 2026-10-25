import { readFile } from "node:fs/promises";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { parseEnvironment } from "../src/config/environment.js";
import {
  assertBackupPolicy,
  parseEncryptionKey,
} from "../src/ops/backup-archive.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = resolve(root, "deploy");
async function values(path: string) {
  return parse(await readFile(resolve(directory, path)));
}
try {
  const test = process.argv.includes("--test");
  const parameters = await values("production.env");
  const app = parameters.APP_DOMAIN,
    api = parameters.API_DOMAIN;
  if (
    !app?.startsWith("app.") ||
    !api?.startsWith("api.") ||
    app.slice(4) !== api.slice(4) ||
    /(?:^|\.)(example\.com|invalid|localhost)$/.test(app)
  )
    throw new Error("Configure app/api subdomains of the same owned domain.");
  if (
    !/^[a-f0-9]{7,40}$/.test(parameters.IMAGE_TAG ?? "") &&
    !(test && /^test-[a-z0-9-]+$/.test(parameters.IMAGE_TAG))
  )
    throw new Error("IMAGE_TAG must identify the reviewed Git revision.");
  const runtime = await values(".secrets/runtime.env");
  const environment = parseEnvironment({
    ...runtime,
    NODE_ENV: "production",
    APP_ORIGIN: `https://${app}`,
    TRUSTED_PROXY_CIDRS: "172.30.0.2/32",
  });
  const target = new URL(environment.databaseUrl);
  const password = (
    await readFile(resolve(directory, ".secrets/postgres-password"), "utf8")
  ).trim();
  if (
    target.hostname !== "postgres" ||
    target.username !== "comiku" ||
    target.pathname !== "/comiku" ||
    decodeURIComponent(target.password) !== password ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(password)
  )
    throw new Error(
      "Database secret must match the internal Compose PostgreSQL target and a random password.",
    );
  const certificate = new X509Certificate(
    await readFile(resolve(directory, ".secrets/origin-cert.pem")),
  );
  const privateKey = createPrivateKey(
    await readFile(resolve(directory, ".secrets/origin-key.pem")),
  );
  if (
    !certificate.checkHost(api) ||
    !certificate.checkPrivateKey(privateKey) ||
    Date.parse(certificate.validTo) <= Date.now() ||
    Date.parse(certificate.validFrom) > Date.now()
  )
    throw new Error(
      "Origin certificate must match the API host, key and current validity period.",
    );
  const backup = await values(".secrets/backup.env");
  const backupDatabase = new URL(backup.BACKUP_DATABASE_URL ?? "");
  const backupPassword = (
    await readFile(
      resolve(directory, ".secrets/postgres-backup-password"),
      "utf8",
    )
  ).trim();
  const adminPassword = (
    await readFile(
      resolve(directory, ".secrets/postgres-admin-password"),
      "utf8",
    )
  ).trim();
  if (
    backupDatabase.hostname !== target.hostname ||
    backupDatabase.pathname !== target.pathname ||
    backupDatabase.username !== "comiku_backup" ||
    decodeURIComponent(backupDatabase.password) !== backupPassword ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(backupPassword) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(adminPassword) ||
    new Set([password, backupPassword, adminPassword]).size !== 3
  )
    throw new Error(
      "Use distinct administrator, application and read-only backup database credentials.",
    );
  if (backup.BUSINESS_R2_BUCKET !== runtime.R2_BUCKET)
    throw new Error(
      "Backup must name the actual business bucket for separation checks.",
    );
  // A configuration-only test does not enable a production timer.
  if (!test) assertBackupPolicy(backup, false);
  parseEncryptionKey(
    (await readFile(resolve(directory, ".secrets/backup-key"), "utf8")).trim(),
  );
  for (const name of [
    "BACKUP_R2_ACCOUNT_ID",
    "BACKUP_R2_ACCESS_KEY_ID",
    "BACKUP_R2_SECRET_ACCESS_KEY",
    "BACKUP_R2_BUCKET",
  ])
    if (!backup[name]?.trim()) throw new Error(`Configure ${name}.`);
  if (backup.BACKUP_R2_BUCKET === runtime.R2_BUCKET)
    throw new Error("Backup bucket must be separate.");
  console.log(
    "生产配置静态检查通过；这不验证真实凭据、网络、Bucket 生命周期、代理防火墙或恢复结果。",
  );
} catch {
  console.error(
    "生产配置检查失败：核对域名/版本、完整私有 R2 配置、数据库密码、有效证书及独立备份策略与密钥；不输出敏感配置。",
  );
  process.exitCode = 1;
}
