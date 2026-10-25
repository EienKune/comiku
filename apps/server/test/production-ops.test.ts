import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Body, Controller, Post, Req } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Request } from "express";
import { parseTrustedProxies } from "../src/config/trusted-proxies.js";
import { RateLimit } from "../src/auth/rate-limit.js";
import { SafeExceptionFilter } from "../src/common/http.js";
import { loadRootEnvironment } from "../src/config/environment.js";
import {
  assertBackupPolicy,
  assertRestoreTarget,
  decryptBackup,
  encryptBackup,
  parseEncryptionKey,
} from "../src/ops/backup-archive.js";
import {
  checkWorkerHealth,
  writeWorkerHealth,
} from "../src/ops/worker-health.js";

test("explicit deployment secrets fail closed and never override injected environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comiku-env-test-"));
  const previousFile = process.env.COMIKU_ENV_FILE;
  const previousValue = process.env.COMIKU_ENV_TEST_VALUE;
  try {
    process.env.COMIKU_ENV_FILE = "relative.env";
    assert.throws(loadRootEnvironment, /absolute/);
    process.env.COMIKU_ENV_FILE = join(directory, "missing.env");
    assert.throws(loadRootEnvironment, /Cannot read/);
    const file = join(directory, "secret.env");
    await writeFile(file, "COMIKU_ENV_TEST_VALUE=from-file\n");
    process.env.COMIKU_ENV_FILE = file;
    process.env.COMIKU_ENV_TEST_VALUE = "injected";
    loadRootEnvironment();
    assert.equal(process.env.COMIKU_ENV_TEST_VALUE, "injected");
    delete process.env.COMIKU_ENV_TEST_VALUE;
    loadRootEnvironment();
    assert.equal(process.env.COMIKU_ENV_TEST_VALUE, "from-file");
  } finally {
    if (previousFile === undefined) delete process.env.COMIKU_ENV_FILE;
    else process.env.COMIKU_ENV_FILE = previousFile;
    if (previousValue === undefined) delete process.env.COMIKU_ENV_TEST_VALUE;
    else process.env.COMIKU_ENV_TEST_VALUE = previousValue;
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted proxy configuration rejects hop counts, wildcards and universal CIDRs", () => {
  assert.deepEqual(parseTrustedProxies(undefined), []);
  assert.deepEqual(parseTrustedProxies("172.30.0.2/32, ::1,172.30.0.2/32"), [
    "172.30.0.2/32",
    "::1",
  ]);
  for (const value of [
    "true",
    "1",
    "*",
    "0.0.0.0/0",
    "::/0",
    "192.0.2.1/33",
    "192.0.2.1/xx",
    "127.0.0.1,",
  ])
    assert.throws(() => parseTrustedProxies(value), /TRUSTED_PROXY_CIDRS/);
});

@Controller()
class ProxyProbe {
  readonly rate = new RateLimit();
  @Post("probe")
  probe(@Req() request: Request, @Body() _body: object) {
    void _body;
    this.rate.check(`probe:${request.ip}`, 1);
    return { ip: request.ip };
  }
}
test("HTTP forwarding separates client limits and a forged leftmost address cannot bypass a limit", async () => {
  const module = await Test.createTestingModule({
    controllers: [ProxyProbe],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", parseTrustedProxies("127.0.0.1/32"));
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(0, "127.0.0.1");
  try {
    const url = (await app.getUrl()) + "/probe";
    const send = async (value: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": value,
        },
        body: "{}",
      });
    const a = await send("203.0.113.1");
    assert.equal(a.status, 201);
    assert.equal(((await a.json()) as { ip: string }).ip, "203.0.113.1");
    const b = await send("203.0.113.2");
    assert.equal(b.status, 201);
    await b.body?.cancel();
    const forged = await send("198.51.100.250, 203.0.113.1");
    assert.equal(forged.status, 429);
    await forged.body?.cancel();
    app.getHttpAdapter().getInstance().set("trust proxy", false);
    const direct = await send("198.51.100.99");
    assert.equal(((await direct.json()) as { ip: string }).ip, "127.0.0.1");
  } finally {
    await app.close();
  }
});

test("encrypted backups round-trip and reject tampering, wrong keys and overwrites without exposing a partial dump", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comiku-backup-test-"));
  try {
    const source = randomBytes(262_144),
      key = randomBytes(32),
      archive = join(directory, "a.comikubak"),
      output = join(directory, "out.dump");
    const metadata = {
      format: 1 as const,
      createdAt: new Date().toISOString(),
      release: "test-fixture",
      postgresMajor: 17 as const,
    };
    await encryptBackup(Readable.from([source]), archive, key, metadata);
    assert.ok(!(await readFile(archive)).includes(source.subarray(0, 64)));
    assert.deepEqual(await decryptBackup(archive, output, key), metadata);
    assert.deepEqual(await readFile(output), source);
    await assert.rejects(decryptBackup(archive, output, key), /EEXIST/);
    assert.deepEqual(await readFile(output), source);
    const failed = join(directory, "failed.dump");
    await assert.rejects(decryptBackup(archive, failed, randomBytes(32)));
    await assert.rejects(stat(failed), /ENOENT/);
    const bytes = await readFile(archive);
    bytes[bytes.length - 30] ^= 1;
    await writeFile(archive, bytes);
    await assert.rejects(decryptBackup(archive, failed, key));
    await assert.rejects(stat(failed), /ENOENT/);
    await assert.rejects(
      encryptBackup(Readable.from([source]), archive, key, metadata),
      /EEXIST/,
    );
    assert.throws(() => parseEncryptionKey("short"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production backups require policy and a separate bucket; restore never targets the live database", () => {
  const base = {
    BACKUP_DATABASE_URL: "postgresql://user:fixture@localhost/comiku",
    BUSINESS_R2_BUCKET: "business",
    BACKUP_R2_BUCKET: "backup",
  };
  assert.throws(() => assertBackupPolicy(base, false), /policy/);
  assert.throws(() => assertBackupPolicy(base, true), /_test/);
  const policy = {
    ...base,
    BACKUP_POLICY_CONFIRMED: "true",
    BACKUP_INTERVAL_HOURS: "24",
    BACKUP_RETENTION_DAYS: "14",
    BACKUP_RPO_HOURS: "24",
    BACKUP_RTO_MINUTES: "120",
  };
  assert.equal(assertBackupPolicy(policy, false).pathname, "/comiku");
  assert.throws(
    () => assertBackupPolicy({ ...policy, BACKUP_RPO_HOURS: "12" }, false),
    /interval/,
  );
  assert.throws(
    () =>
      assertBackupPolicy({ ...policy, BACKUP_R2_BUCKET: "business" }, false),
    /separate/,
  );
  for (const name of ["comiku", "comiku_test", "comiku_restore_test/extra"])
    assert.throws(
      () => assertRestoreTarget("postgresql://localhost/" + name),
      /_restore_test/,
    );
  assert.equal(
    assertRestoreTarget("postgresql://localhost/comiku_restore_test").pathname,
    "/comiku_restore_test",
  );
});

test("worker health detects a stale or future heartbeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comiku-health-test-"));
  try {
    const file = join(directory, "health.json");
    await writeWorkerHealth(file);
    await checkWorkerHealth(file);
    await writeFile(file, JSON.stringify({ at: 1 }));
    await assert.rejects(checkWorkerHealth(file), /stale/);
    await writeFile(file, JSON.stringify({ at: Date.now() + 60_000 }));
    await assert.rejects(checkWorkerHealth(file), /stale/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
