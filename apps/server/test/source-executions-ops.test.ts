import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceExecutionOperation } from "../src/ops/source-executions-arguments.js";
const owner = "00000000-0000-4000-8000-000000000001",
  generation = "a".repeat(64);
const args = [
  "confirm-owner-stopped",
  "x",
  owner,
  generation,
  "--confirm-source-processes-stopped",
];
test("source owner ops parsing requires one fixed scope and explicit external-stop declaration", () => {
  assert.deepEqual(parseSourceExecutionOperation(args), {
    platform: "x",
    ownerId: owner,
    expectedGeneration: generation,
  });
  for (const input of [
    [],
    args.slice(0, 4),
    [...args, "--all"],
    [args[0], "all", ...args.slice(2)],
    [args[0], args[1], "all", ...args.slice(3)],
    [args[0], args[1], owner, "bad-generation", args[4]],
  ])
    assert.equal(parseSourceExecutionOperation(input), null);
});
