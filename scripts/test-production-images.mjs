import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Isolated synthetic fixtures only; never reads the user's .env or credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedMigrationCount = (
  await readdir(join(root, "apps/server/prisma/migrations"), {
    withFileTypes: true,
  })
).filter((entry) => entry.isDirectory()).length;
const prefix = "comiku-image-check-" + randomUUID().slice(0, 8);
const directory = join(root, ".qa", prefix);
const containers = [],
  volumes = [];
let networkCreated = false;
const option = (name, fallback) =>
  process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const image = {
  server: process.argv.includes("--server")
    ? option("--server")
    : "comiku-server:test",
  tools: process.argv.includes("--tools")
    ? option("--tools")
    : "comiku-tools:test",
  backup: process.argv.includes("--backup")
    ? option("--backup")
    : "comiku-backup:test",
  caddy: process.argv.includes("--caddy")
    ? option("--caddy")
    : "caddy:2.10.2-alpine",
};
function docker(...args) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    }).trim();
  } catch (error) {
    const message = String(error.stderr ?? "").slice(-2000);
    throw new Error(`Isolated Docker check failed (${args[0]}): ${message}`, {
      cause: error,
    });
  }
}
function launch(name, ...args) {
  containers.push(name);
  docker("run", "-d", "--name", name, "--network", prefix, ...args);
  return name;
}
async function waitDatabase(name) {
  for (let i = 0; i < 60; i++) {
    try {
      docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "fixture");
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("Fixture PostgreSQL did not become ready.");
}
const mount = ["--mount", `type=bind,source=${directory},target=/fixtures`];
const password = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const backupPassword = randomBytes(24).toString("hex");
const source = prefix + "-source",
  restore = prefix + "-restore",
  api = prefix + "-api",
  worker = prefix + "-worker",
  caddy = prefix + "-caddy";
const databaseUrl = `postgresql://comiku:${appPassword}@${source}:5432/fixture_test`;
const sourceSecrets = [
  "--mount",
  `type=bind,source=${join(root, "deploy", "postgres-init.sh")},target=/docker-entrypoint-initdb.d/10-comiku.sh,readonly`,
  "--mount",
  `type=bind,source=${join(directory, "app-password")},target=/run/secrets/postgres_password,readonly`,
  "--mount",
  `type=bind,source=${join(directory, "backup-password")},target=/run/secrets/postgres_backup_password,readonly`,
];
const env = [
  "-e",
  "NODE_ENV=production",
  "-e",
  "HOST=0.0.0.0",
  "-e",
  "PORT=3000",
  "-e",
  "APP_ORIGIN=https://app.fixture.test",
  "-e",
  `DATABASE_URL=${databaseUrl}`,
  "-e",
  "OBJECT_STORAGE_DRIVER=r2",
  "-e",
  "R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef",
  "-e",
  "R2_ACCESS_KEY_ID=synthetic-key",
  "-e",
  "R2_SECRET_ACCESS_KEY=synthetic-secret",
  "-e",
  "R2_BUCKET=fixture-business",
  "-e",
  "SOURCE_SCHEDULE_ENABLED=false",
];
async function client(ip, expression) {
  const code = `import https from 'node:https'; const request=(path,headers={},body)=>new Promise((resolve,reject)=>{ const req=https.request({hostname:'${caddy}',port:443,servername:'api.fixture.test',rejectUnauthorized:false,path,method:body===undefined?'GET':'POST',headers:{Host:'api.fixture.test','CF-Connecting-IP':'203.0.113.7',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);}); ${expression}`;
  return JSON.parse(
    docker(
      "run",
      "--rm",
      "--network",
      prefix,
      "--ip",
      ip,
      "--entrypoint",
      "node",
      image.server,
      "--input-type=module",
      "-e",
      code,
    ),
  );
}

try {
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image.server,
    "--input-type=module",
    "-e",
    `if(process.version!=='v24.22.1')process.exit(1);const sharp=(await import('sharp')).default;const output=await sharp({create:{width:1600,height:1000,channels:3,background:'white'}}).resize({width:800,withoutEnlargement:true}).webp().toBuffer();const meta=await sharp(output).metadata();if(meta.width!==800||meta.height!==500)process.exit(1);`,
  );
  assert.equal(
    docker("run", "--rm", "--entrypoint", "pnpm", image.tools, "--version"),
    "9.1.2",
  );
  docker("run", "--rm", image.tools, "pnpm", "db:generate");
  assert.match(
    docker("run", "--rm", "--entrypoint", "pg_dump", image.backup, "--version"),
    /17\./,
  );
  await mkdir(directory, { recursive: true, mode: 0o777 });
  await writeFile(join(directory, "app-password"), appPassword, {
    mode: 0o644,
  });
  await writeFile(join(directory, "backup-password"), backupPassword, {
    mode: 0o644,
  });
  docker("network", "create", "--internal", prefix);
  networkCreated = true;
  const subnet = JSON.parse(docker("network", "inspect", prefix))[0].IPAM
    .Config[0].Subnet;
  const base = subnet.split("/")[0].split(".").slice(0, 3).join(".");
  const trustedClient = base + ".248",
    directClient = base + ".249",
    proxy = base + ".250";
  const volume = prefix + "-data";
  docker("volume", "create", volume);
  volumes.push(volume);
  launch(
    source,
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    ...sourceSecrets,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=fixture_test",
    "--entrypoint",
    "docker-entrypoint.sh",
    image.backup,
    "postgres",
  );
  launch(
    restore,
    "--user",
    "0:0",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_USER=fixture",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=fixture_restore_test",
    "--entrypoint",
    "docker-entrypoint.sh",
    image.backup,
    "postgres",
  );
  await waitDatabase(source);
  await waitDatabase(restore);
  docker(
    "run",
    "--rm",
    "--network",
    prefix,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000",
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    image.tools,
    "pnpm",
    "db:deploy",
  );
  const migrationCount = Number(
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture_test",
      "-Atc",
      "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL",
    ),
  );
  assert.equal(migrationCount, expectedMigrationCount);
  assert.equal(
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture_test",
      "-Atc",
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('comiku','comiku_backup') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole",
    ),
    "2",
  );
  assert.equal(
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "comiku_backup",
      "-d",
      "fixture_test",
      "-Atc",
      "SELECT count(*) FROM _prisma_migrations",
    ),
    String(expectedMigrationCount),
  );
  let backupWriteRejected = false;
  try {
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "comiku_backup",
      "-d",
      "fixture_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DELETE FROM _prisma_migrations WHERE false",
    );
  } catch {
    backupWriteRejected = true;
  }
  assert.ok(backupWriteRejected, "backup database role must be read-only");
  docker(
    "run",
    "--rm",
    "--network",
    prefix,
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    image.tools,
    "pnpm",
    "db:deploy",
  );
  docker(
    "run",
    "--rm",
    "--network",
    prefix,
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    image.tools,
    "pnpm",
    "db:drift",
  );
  const seed = `import {PrismaClient} from './dist/generated/prisma/client.js';import {PrismaPg} from '@prisma/adapter-pg';import {hashPassword} from './dist/users/password.js';const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL,max:1})});await db.user.create({data:{username:'fixtureadmin',displayName:'Synthetic Member',passwordHash:await hashPassword('FixturePassword!2026'),mustChangePassword:false,roles:{create:{role:'admin'}}}});await db.$disconnect();`;
  docker(
    "run",
    "--rm",
    "--network",
    prefix,
    ...env,
    "--entrypoint",
    "node",
    image.server,
    "--input-type=module",
    "-e",
    seed,
  );
  launch(
    api,
    "--network-alias",
    "api",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,uid=1000,gid=1000,size=256m",
    ...env,
    "-e",
    `TRUSTED_PROXY_CIDRS=${proxy}/32`,
    image.server,
  );
  launch(
    worker,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,uid=1000,gid=1000,size=384m",
    ...env,
    "-e",
    "WORKER_HEALTH_FILE=/tmp/health.json",
    image.server,
    "node",
    "dist/worker.js",
  );
  for (let i = 0; i < 60; i++) {
    try {
      docker("exec", api, "node", "dist/ops/healthcheck.js", "api");
      docker("exec", worker, "node", "dist/ops/healthcheck.js", "worker");
      break;
    } catch {
      if (i === 59) throw new Error("API/worker fixture health failed.");
      await delay(500);
    }
  }
  docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    ...mount,
    "--entrypoint",
    "openssl",
    image.tools,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "/fixtures/origin-key.pem",
    "-out",
    "/fixtures/origin-cert.pem",
    "-subj",
    "/CN=api.fixture.test",
    "-addext",
    "subjectAltName=DNS:api.fixture.test",
    "-days",
    "1",
  );
  await writeFile(
    join(directory, "Caddyfile"),
    await readFile(join(root, "deploy", "Caddyfile")),
  );
  await writeFile(
    join(directory, "cloudflare.caddy"),
    `(cloudflare-trust) {\n trusted_proxies static ${trustedClient}/32\n}\n(cloudflare-peer) {\n remote_ip ${trustedClient}/32\n}\n`,
  );
  const caddyMounts = [
    "--mount",
    `type=bind,source=${join(directory, "Caddyfile")},target=/etc/caddy/Caddyfile,readonly`,
    "--mount",
    `type=bind,source=${join(directory, "cloudflare.caddy")},target=/etc/caddy/cloudflare.caddy,readonly`,
    "--mount",
    `type=bind,source=${join(directory, "origin-key.pem")},target=/run/secrets/origin_private_key,readonly`,
    "--mount",
    `type=bind,source=${join(directory, "origin-cert.pem")},target=/run/secrets/origin_certificate,readonly`,
  ];
  docker(
    "run",
    "--rm",
    ...caddyMounts,
    "-e",
    "API_DOMAIN=api.fixture.test",
    image.caddy,
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
  );
  launch(
    caddy,
    "--ip",
    proxy,
    ...caddyMounts,
    "-e",
    "API_DOMAIN=api.fixture.test",
    image.caddy,
  );
  await delay(1500);
  const direct = await client(
    directClient,
    `console.log(JSON.stringify(await request('/api/health',{'X-Forwarded-For':'203.0.113.8'})));`,
  );
  assert.equal(direct.status, 403);
  const login = await client(
    trustedClient,
    `console.log(JSON.stringify(await request('/api/auth/login',{'Origin':'https://app.fixture.test','X-Comiku-Request':'1','Content-Type':'application/json','X-Forwarded-For':'198.51.100.99'},JSON.stringify({username:'fixtureadmin',password:'FixturePassword!2026'}))));`,
  );
  assert.equal(login.status, 200);
  assert.equal(
    login.headers["access-control-allow-origin"],
    "https://app.fixture.test",
  );
  const cookie = login.headers["set-cookie"][0];
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/api"])
    assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes("Domain="));
  const badOrigin = await client(
    trustedClient,
    `console.log(JSON.stringify(await request('/api/auth/login',{'Origin':'https://evil.invalid','X-Comiku-Request':'1','Content-Type':'application/json'},JSON.stringify({username:'fixtureadmin',password:'FixturePassword!2026'}))));`,
  );
  assert.equal(badOrigin.status, 403);
  await writeFile(join(directory, "key"), randomBytes(32).toString("hex"));
  await writeFile(
    join(directory, "backup.env"),
    `BACKUP_DATABASE_URL=postgresql://comiku_backup:${backupPassword}@${source}:5432/fixture_test\nBUSINESS_R2_BUCKET=fixture-business\nBACKUP_R2_BUCKET=fixture-backups\nBACKUP_ENCRYPTION_KEY_FILE=/fixtures/key\nRESTORE_DATABASE_URL=postgresql://fixture:${password}@${restore}:5432/fixture_restore_test\n`,
  );
  docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    prefix,
    ...mount,
    "-e",
    "COMIKU_BACKUP_ENV_FILE=/fixtures/backup.env",
    "-e",
    "COMIKU_RELEASE=test-4e",
    image.backup,
    "backup",
    "--test",
    "--local-only",
    "--output",
    "/fixtures/database.comikubak",
  );
  docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    prefix,
    ...mount,
    "-e",
    "COMIKU_BACKUP_ENV_FILE=/fixtures/backup.env",
    "-e",
    "RESTORE_ARCHIVE_FILE=/fixtures/database.comikubak",
    image.backup,
    "restore",
    "--execute",
  );
  assert.equal(
    docker(
      "exec",
      restore,
      "psql",
      "-U",
      "fixture",
      "-d",
      "fixture_restore_test",
      "-Atc",
      "SELECT count(*) FROM users",
    ),
    "1",
  );
  assert.equal(
    Number(
      docker(
        "exec",
        restore,
        "psql",
        "-U",
        "fixture",
        "-d",
        "fixture_restore_test",
        "-Atc",
        "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL",
      ),
    ),
    expectedMigrationCount,
  );
  let rejected = false;
  try {
    docker(
      "run",
      "--rm",
      "--user",
      "0:0",
      "--network",
      prefix,
      ...mount,
      "-e",
      "COMIKU_BACKUP_ENV_FILE=/fixtures/backup.env",
      "-e",
      "RESTORE_ARCHIVE_FILE=/fixtures/database.comikubak",
      image.backup,
      "restore",
      "--execute",
    );
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "nonempty restore must be rejected");
  docker("stop", "--time", "75", worker, api, caddy);
  docker("stop", source);
  docker("rm", source);
  launch(
    source,
    "--user",
    "0:0",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    ...sourceSecrets,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=fixture_test",
    "--entrypoint",
    "docker-entrypoint.sh",
    image.backup,
    "postgres",
  );
  await waitDatabase(source);
  assert.equal(
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture_test",
      "-Atc",
      "SELECT count(*) FROM users",
    ),
    "1",
  );
  console.log(
    `Linux image checks passed: ${expectedMigrationCount} migrations/replay/drift, API/worker health, HTTPS origin restriction, secure cookie/CORS/CSRF, encrypted offline restore/nonempty rejection, persistent-volume recreation. No real X/R2 calls.`,
  );
} finally {
  for (const name of [...new Set(containers)].reverse()) {
    try {
      docker("rm", "-f", name);
    } catch {
      /* own fixture cleanup */
    }
  }
  for (const name of volumes) {
    try {
      docker("volume", "rm", name);
    } catch {
      /* own fixture cleanup */
    }
  }
  if (networkCreated) {
    try {
      docker("network", "rm", prefix);
    } catch {
      /* own fixture cleanup */
    }
  }
  if (directory.startsWith(join(root, ".qa") + sep))
    await rm(directory, { recursive: true, force: true });
}
