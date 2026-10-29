import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";
import { SourceFetchController } from "../src/source-ingestion/source-fetch.controller.js";
import { ACCESS, permissionsFor } from "../src/common/access.js";

test("technical sync history is restricted to system administrators", () => {
  assert.ok(
    (permissionsFor(["admin"], false) as string[]).includes("system:manage"),
  );
  for (const role of ["source", "reviewer"] as const)
    assert.ok(
      !(permissionsFor([role], false) as string[]).includes("system:manage"),
    );
  assert.deepEqual(
    Reflect.getMetadata(ACCESS, SourceFetchController.prototype.list),
    {
      permission: "system:manage",
    },
  );
  assert.deepEqual(
    Reflect.getMetadata(ACCESS, SourceFetchController.prototype.get),
    {
      permission: "system:manage",
    },
  );
});

test("manual sync acceptance exposes only business fields for new and reused batches", async () => {
  for (const trigger of ["manual", "scheduled"] as const) {
    const controller = new SourceFetchController({
      runManual: async () => ({
        id: "shared-run",
        trigger,
        status: "running",
        requestedById: "another-user",
        attempts: 2,
        jobStatus: "queued",
        nextRetryAt: "2026-10-26T12:00:00.000Z",
        startedAt: "2026-10-26T11:00:00.000Z",
        completedAt: null,
        items: [{ adapterKey: "private-adapter", errorCode: "private-error" }],
      }),
    } as unknown as SourceFetchService);
    const accepted = await controller.run(
      { actor: { userId: "source-user" } } as Parameters<
        SourceFetchController["run"]
      >[0],
      {},
    );
    assert.deepEqual(accepted, { id: "shared-run", status: "running" });
  }
});

test("reloaded source history includes durable attempt and retry timing without exposing job payload", async () => {
  const run = {
    id: "fixture-run",
    trigger: "manual",
    status: "running",
    requestedById: null,
    startedAt: new Date(0),
    completedAt: null,
    items: [],
  };
  const db = {
    sourceFetchRun: { findUniqueOrThrow: async () => run },
    backgroundJob: {
      findMany: async (query: { where: unknown }) => {
        assert.match(JSON.stringify(query.where), /source:fixture-run/);
        return [
          {
            resourceId: run.id,
            status: "queued",
            attempts: 2,
            availableAt: new Date("2026-10-26T12:00:00Z"),
          },
        ];
      },
    },
  };
  const args = [
    null,
    db,
    null,
    null,
    null,
    null,
  ] as unknown as ConstructorParameters<typeof SourceFetchService>;
  const result = await new SourceFetchService(...args).get(run.id);
  assert.equal(result.attempts, 2);
  assert.equal(result.jobStatus, "queued");
  assert.equal(result.nextRetryAt, "2026-10-26T12:00:00.000Z");
  assert.equal("payload" in result, false);
});
