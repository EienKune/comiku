import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import {
  configureApplication,
  createOpenApiDocument,
} from "../src/application.js";
import { PrismaService } from "../src/database/prisma.service.js";

test("HTTP liveness, readiness and OpenAPI remain distinct when the database fails", async () => {
  let unavailable = false;
  let queryCount = 0;
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 3000,
        databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unused",
        appOrigin: "http://localhost:5173",
        xOfficialDailyBudget: 0,
        xOfficialMonthlyBudget: 0,
        sourceOverlapMinutes: 10,
        sourceScheduleEnabled: false,
        sourceScheduleMinutes: 60,
        sourceFailureThreshold: 3,
        sourceCooldownMinutes: 360,
        typesetBatchMaxBytes: 512 * 1024 * 1024,
        typesetBatchMaxWorks: 20,
        objectStorageDriver: "memory",
      }),
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({
      $queryRaw: () => {
        queryCount += 1;
        if (unavailable)
          throw new Error("postgresql://private:secret@internal/db");
        return Promise.resolve([{ "?column?": 1 }]);
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  configureApplication(app);
  try {
    const document = createOpenApiDocument(app);
    assert.equal(queryCount, 0);
    assert.equal(document.paths["/api/health"]?.get?.operationId, "getHealth");
    assert.equal(
      document.paths["/api/health/ready"]?.get?.operationId,
      "getReadiness",
    );
    assert.deepEqual(document.components?.schemas?.HealthResponse, {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
        service: { type: "string", enum: ["comiku-server"] },
      },
      required: ["status", "service"],
    });
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    const alive = await fetch(`${baseUrl}/api/health`);
    assert.equal(alive.status, 200);
    assert.deepEqual(await alive.json(), {
      status: "ok",
      service: "comiku-server",
    });
    assert.equal(queryCount, 0);
    const ready = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(ready.status, 200);
    await ready.body?.cancel();
    unavailable = true;
    const failed = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(failed.status, 503);
    const body = await failed.text();
    assert.ok(!body.includes("secret"));
    assert.match(body, /Database unavailable/);
    const stillAlive = await fetch(`${baseUrl}/api/health`);
    assert.equal(stillAlive.status, 200);
    await stillAlive.body?.cancel();
  } finally {
    await app.close();
  }
});
