import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialInput,
  credentialIntentHash,
  credentialOperationReceipt,
  maintenanceExpectation,
} from "../src/source-ingestion/source-credential-contract.js";

test("credential inputs accept only a complete platform pair and no unrelated credential", () => {
  assert.deepEqual(
    credentialInput("x", { authToken: " synthetic-a ", ct0: "b" }),
    { platform: "x", authToken: "synthetic-a", ct0: "b" },
  );
  assert.deepEqual(credentialInput("pixiv", { refreshToken: "c" }), {
    platform: "pixiv",
    refreshToken: "c",
  });
  for (const [platform, input] of [
    ["x", { authToken: "a" }],
    ["x", { authToken: "a", ct0: "b", refreshToken: "c" }],
    ["pixiv", { refreshToken: "bad\nvalue" }],
    ["pixiv", { refreshToken: "a".repeat(8193) }],
    ["arbitrary", { refreshToken: "a" }],
  ] as const)
    assert.throws(() => credentialInput(platform, input));
});

test("maintenance revisions are bounded integers and generation is explicit", () => {
  const generation = "a".repeat(64);
  assert.deepEqual(
    maintenanceExpectation({
      expectedEpoch: 2,
      expectedGeneration: generation,
    }),
    { expectedEpoch: 2, expectedGeneration: generation },
  );
  for (const epoch of [NaN, Infinity, -1, 1.1, 2147483648, "1"]) {
    assert.throws(() =>
      maintenanceExpectation({
        expectedEpoch: epoch,
        expectedGeneration: generation,
      }),
    );
  }
  assert.throws(() =>
    maintenanceExpectation({
      expectedEpoch: 2,
      expectedGeneration: "not-a-generation",
    }),
  );
});

test("credential intent hash binds caller consent and never returns credentials", () => {
  const expected = { expectedEpoch: 1, expectedGeneration: "a".repeat(64) };
  const input = credentialInput("x", { authToken: "synthetic-a", ct0: "b" });
  const first = credentialIntentHash(expected, input);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, credentialIntentHash({ ...expected }, { ...input }));
  assert.notEqual(
    first,
    credentialIntentHash({ ...expected, expectedEpoch: 2 }, input),
  );
  assert.notEqual(
    first,
    credentialIntentHash(
      expected,
      credentialInput("x", { authToken: "different", ct0: "b" }),
    ),
  );
});

test("operation receipts expose only lifecycle evidence and not internal or secret fields", () => {
  const receipt = credentialOperationReceipt({
    id: "id",
    platform: "x",
    requestId: "request",
    phase: "activated",
    failureCode: null,
    expectedEpoch: 2,
    expectedGeneration: "old",
    targetGeneration: "new",
    verificationOutcome: "unknown",
    verificationCode: "network_error",
    verifiedAt: null,
    createdAt: new Date("2026-11-10T00:00:00Z"),
    completedAt: null,
    inputHash: "secret-digest",
    actorId: "private-actor",
    token: "private-token",
    path: "/private/path",
  });
  assert.equal(receipt.phase, "activated");
  assert.equal(receipt.targetGeneration, "new");
  for (const forbidden of ["inputHash", "actorId", "token", "path"])
    assert.equal(forbidden in receipt, false);
  assert.equal(receipt.createdAt, "2026-11-10T00:00:00.000Z");
});
