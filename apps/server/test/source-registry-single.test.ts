import assert from "node:assert/strict";
import test from "node:test";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import type { ContentSourceClient } from "../src/source-ingestion/content-source.js";

function source(key: string, available = true): ContentSourceClient {
  return {
    platform: "x",
    adapterKey: key,
    available,
    priority: 1,
    metered: false,
    supportedFirstSyncModes: ["none"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (account) => account,
    fetchPage: async () => ({ items: [], complete: true }),
  };
}
test("a platform cannot register two simultaneously available collection adapters", () => {
  const registry = new ContentSourceRegistry().register(source("first"));
  registry.register(source("second"));
  assert.throws(
    () => registry.assertSingleActiveAdapters(),
    /active.*platform/i,
  );
});
test("inactive implementations and another platform do not duplicate the active source", () => {
  const registry = new ContentSourceRegistry()
    .register(source("old", false))
    .register(source("current"));
  registry.register({ ...source("pixiv_current"), platform: "pixiv" });
  registry.assertSingleActiveAdapters();
  assert.equal(
    registry.forPlatform("x").filter((item) => item.available).length,
    1,
  );
});
