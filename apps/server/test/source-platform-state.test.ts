import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  credentialFingerprint,
  platformFailure,
} from "../src/source-ingestion/source-platform-state.js";
import { accountBatchStatus } from "../src/source-ingestion/source-account-tasks.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";

test("fingerprint follows actual config and referenced cookie bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comiku-generation-"));
  try {
    const path = join(dir, "gallery.json");
    await writeFile(
      path,
      JSON.stringify({
        extractor: { twitter: { cookies: join(dir, "cookies.txt") } },
      }),
    );
    await writeFile(join(dir, "cookies.txt"), "synthetic-a");
    const first = await credentialFingerprint("x", {
      python: "/synthetic/python",
      xConfigPath: path,
    });
    assert.equal(
      first,
      await credentialFingerprint("x", {
        python: "/synthetic/python",
        xConfigPath: path,
      }),
    );
    await writeFile(join(dir, "cookies.txt"), "synthetic-b");
    assert.notEqual(
      first,
      await credentialFingerprint("x", {
        python: "/synthetic/python",
        xConfigPath: path,
      }),
    );
    await writeFile(path, "{}");
    assert.notEqual(
      first,
      await credentialFingerprint("x", {
        python: "/synthetic/python",
        xConfigPath: path,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("only trusted credential failures pause shared platform", () => {
  for (const scope of ["source", "media", "protocol"] as const)
    assert.equal(
      platformFailure(
        new SourceResponseError("authentication", {
          scope,
          reason: "source_forbidden",
        }),
        new Date(),
      ),
      null,
    );
  assert.equal(
    platformFailure(
      new SourceResponseError("authentication", {
        scope: "credential",
        reason: "auth_failed",
      }),
      new Date(),
    )?.status,
    "auth_paused",
  );
  const now = new Date("2026-10-28T00:00:00Z");
  const rate = platformFailure(
    new SourceResponseError("rate_limited", {
      scope: "credential",
      reason: "rate_limited",
      diagnostic: { http_response_headers: { "retry-after": "9999999" } },
    }),
    now,
  );
  assert.equal(rate?.cooldownUntil?.getTime(), now.getTime() + 86400000);
});
test("batch does not settle until every persisted target settles", () => {
  assert.equal(accountBatchStatus(["succeeded", "waiting"]), null);
  assert.equal(accountBatchStatus(["succeeded", "queued"]), null);
  assert.equal(accountBatchStatus(["succeeded", "failed"]), "partial_failed");
  assert.equal(accountBatchStatus(["succeeded", "succeeded"]), "succeeded");
  assert.equal(accountBatchStatus(["failed"]), "failed");
});
