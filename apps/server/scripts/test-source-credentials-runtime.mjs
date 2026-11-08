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
  const moduleUrl = pathToFileURL(
    join(dist, "source-ingestion/source-platform-state.js"),
  ).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {SourcePlatformStates}=await import(${JSON.stringify(moduleUrl)}); const states=new SourcePlatformStates(null,null,{}); try { await states.activate('x','0'.repeat(64)); process.exitCode=2; } catch(error) { if(error.message!=='Local credential configuration unavailable') throw error; console.log('compiled activation reached'); }`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /compiled activation reached/);
  console.log(
    "Compiled credential CLI and activation dependency closure pass without source checkout, tsx invocation, AppModule or adapter assets; no database/network calls.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
