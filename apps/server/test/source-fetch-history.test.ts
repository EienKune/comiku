import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";
import { SourceFetchController } from "../src/source-ingestion/source-fetch.controller.js";
import { ACCESS, permissionsFor } from "../src/common/access.js";
import type { SourceHistoryService } from "../src/source-ingestion/source-history.service.js";

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
    const controller = new SourceFetchController(
      {
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
          items: [
            { adapterKey: "private-adapter", errorCode: "private-error" },
          ],
        }),
      } as unknown as SourceFetchService,
      {} as SourceHistoryService,
    );
    const accepted = await controller.run(
      { actor: { userId: "source-user" } } as Parameters<
        SourceFetchController["run"]
      >[0],
      {},
    );
    assert.deepEqual(accepted, { id: "shared-run", status: "running" });
  }
});

test("technical history GETs delegate only to the dedicated read service", async () => {
  const summaries = {
    items: [],
    nextCursor: null,
    observedAt: new Date(0).toISOString(),
  };
  const expected = { id: "summary-only" };
  const controller = new SourceFetchController(
    {
      list: () => {
        throw new Error("Old full-history path must not be used");
      },
      get: () => {
        throw new Error("Old full-history path must not be used");
      },
    } as unknown as SourceFetchService,
    {
      list: async (query: unknown) => {
        assert.deepEqual(query, { limit: 10 });
        return summaries;
      },
      get: async (id: string) => {
        assert.equal(id, "run");
        return expected;
      },
    } as unknown as SourceHistoryService,
  );
  assert.equal(await controller.list({ limit: 10 }), summaries);
  assert.equal(await controller.get("run"), expected);
});
