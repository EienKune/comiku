import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDictionaryImportError,
  runDictionaryImportCli,
} from "../src/reference-dictionary/import-cli.js";
import { validateDictionaryImport } from "../src/reference-dictionary/import-validation.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

const privateCanary =
  "postgresql://private-user:secret-password@private-host/private-db private-entry-body";
const input = {
  formatVersion: 1,
  source: {
    key: "synthetic",
    name: "Synthetic",
    version: "1",
    fileSha256: "a".repeat(64),
    importerVersion: "synthetic-v1",
  },
  entries: [{ sourceRef: "line:1", original: "カクッ" }],
};
type CliDb = Pick<PrismaClient, "$transaction" | "$disconnect">;
function dependencies(db: CliDb) {
  const output: string[] = [],
    errors: string[] = [];
  return {
    output,
    errors,
    read: async () => validateDictionaryImport(input),
    connect: async () => db,
    out: (value: string) => {
      output.push(value);
    },
    err: (value: string) => {
      errors.push(value);
    },
  };
}
function assertUncertainSafe(errors: string[]) {
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /outcome.*unconfirmed/i);
  assert.match(errors[0]!, /source revision/i);
  assert.match(errors[0]!, /expected.revision|CAS/i);
  assert.equal(errors.join(" ").includes("no replacement committed"), false);
  assert.equal(errors.join(" ").includes(privateCanary), false);
  assert.equal(errors.join(" ").includes("secret-password"), false);
}
test("lost COMMIT acknowledgement reports unconfirmed outcome without driver DSN or content", async () => {
  let disconnected = false;
  const db = {
    $transaction: async () => {
      throw new Error(`commit reply lost ${privateCanary}`);
    },
    $disconnect: async () => {
      disconnected = true;
    },
  } as unknown as CliDb;
  const io = dependencies(db);
  assert.equal(
    await runDictionaryImportCli(
      ["private-input.json", "--apply", "--expected-revision", "0"],
      io,
    ),
    1,
  );
  assert.deepEqual(io.output, []);
  assert.equal(disconnected, true);
  assertUncertainSafe(io.errors);
});
test("disconnect rejection after acknowledged import never claims the replacement rolled back", async () => {
  let committed = false;
  const tx = {
    $queryRaw: async () => [{ value: 1 }],
    onomatopoeiaSource: {
      findUnique: async () => null,
      create: async () => ({ id: "synthetic", revision: 1 }),
    },
    onomatopoeiaEntry: { createMany: async () => ({ count: 1 }) },
  };
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      const result = await operation(tx);
      committed = true;
      return result;
    },
    $disconnect: async () => {
      throw new Error(`disconnect rejected ${privateCanary}`);
    },
  } as unknown as CliDb;
  const io = dependencies(db);
  assert.equal(
    await runDictionaryImportCli(
      ["private-input.json", "--apply", "--expected-revision", "0"],
      io,
    ),
    1,
  );
  assert.equal(committed, true);
  assertUncertainSafe(io.errors);
  assert.equal(io.output.join(" ").includes(privateCanary), false);
});
test("known validation rejection stays actionable without connecting or echoing imported text", async () => {
  let connected = false;
  const io = dependencies({} as CliDb);
  io.read = async () =>
    validateDictionaryImport({
      ...input,
      entries: [{ sourceRef: "line:1", original: `${privateCanary}\u0000` }],
    });
  io.connect = async () => {
    connected = true;
    throw new Error(privateCanary);
  };
  assert.equal(
    await runDictionaryImportCli(
      ["private-input.json", "--apply", "--expected-revision", "0"],
      io,
    ),
    1,
  );
  assert.equal(connected, false);
  assert.deepEqual(io.errors, ["Invalid entry 1 original"]);
  assert.deepEqual(io.output, []);
  assert.equal(
    formatDictionaryImportError(new Error(privateCanary)).includes(
      privateCanary,
    ),
    false,
  );
});
