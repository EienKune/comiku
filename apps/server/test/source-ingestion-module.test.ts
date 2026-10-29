import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/application.js";
import { parseEnvironment } from "../src/config/environment.js";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";

for (const adapter of ["disabled", "example"] as const) {
  test(`source ingestion and ${adapter} analysis compose without a legacy classifier`, async () => {
    // Construct the real module graph without app.init(), database connections,
    // model services or source requests. Register both worker handlers as well.
    const app = await createApplication(
      parseEnvironment({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/offline",
        OBJECT_STORAGE_DRIVER: "memory",
        IMAGE_ANALYSIS_ADAPTER: adapter,
      }),
    );
    try {
      const sources = app.get(SourceFetchService);
      const analysis = app.get(ImageAnalysisService);
      sources.onModuleInit();
      analysis.onModuleInit();
      if (adapter === "disabled") assert.equal(analysis.activeModelKey, null);
      else assert.match(analysis.activeModelKey!, /^[a-f0-9]{64}$/);
    } finally {
      await app.close();
    }
  });
}
