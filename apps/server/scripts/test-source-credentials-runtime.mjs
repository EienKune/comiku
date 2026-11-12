import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const server = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "comiku-credentials-runtime-"));
try {
  const dist = join(directory, "dist");
  await cp(join(server, "dist"), dist, {
    recursive: true,
    filter: (path) =>
      !path.includes(`${process.platform === "win32" ? "\\" : "/"}adapters`) &&
      !path.endsWith("app.module.js"),
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await symlink(
    resolve(server, "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const entry = join(dist, "ops/source-credentials.js");
  const invalid = spawnSync(process.execPath, [entry], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage: node dist\/ops\/source-credentials\.js/);
  assert.doesNotMatch(invalid.stderr, /MODULE_NOT_FOUND|tsx/);
  const ownerEntry = join(dist, "ops/source-executions.js");
  for (const args of [
    [],
    [
      "confirm-owner-stopped",
      "x",
      "00000000-0000-4000-8000-000000000001",
      "0".repeat(64),
    ],
  ]) {
    const refused = spawnSync(process.execPath, [ownerEntry, ...args], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /Usage: node dist\/ops\/source-executions\.js/,
    );
    assert.doesNotMatch(
      refused.stderr,
      /MODULE_NOT_FOUND|tsx|database.*connect/i,
    );
  }
  const moduleUrl = pathToFileURL(
    join(dist, "source-ingestion/source-platform-state.js"),
  ).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {SourcePlatformStates}=await import(${JSON.stringify(moduleUrl)}); const states=new SourcePlatformStates(null,null,{}); try { await states.activate('x','0'.repeat(64)); process.exitCode=2; } catch(error) { if(error.message!=='Local credential configuration unavailable') throw error; console.log('compiled activation reached'); } try { await states.confirmStoppedOwner('x','00000000-0000-4000-8000-000000000001','0'.repeat(64),false); process.exitCode=3; } catch(error) { if(error.message!=='Explicit confirmation that source processes stopped is required') throw error; console.log('compiled owner confirmation reached'); }`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /compiled activation reached/);
  assert.match(probe.stdout, /compiled owner confirmation reached/);
  console.log(
    "Compiled credential CLI and activation dependency closure pass without source checkout, tsx invocation, AppModule or adapter assets; no database/network calls.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
