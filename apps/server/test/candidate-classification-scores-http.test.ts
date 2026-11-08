import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ImageAnalysisController } from "../src/image-analysis/image-analysis.controller.js";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { RateLimit } from "../src/auth/rate-limit.js";
import { NotFoundException } from "@nestjs/common";
import { type UsersService } from "../src/users/users.service.js";
import { parseEnvironment } from "../src/config/environment.js";

test("classification score HTTP requires candidate read permission, validates UUIDs and propagates safe 404", async () => {
  let permissions: string[] = [];
  let calls = 0;
  const missing = randomUUID();
  const module = await Test.createTestingModule({
    controllers: [ImageAnalysisController],
    providers: [
      {
        provide: ImageAnalysisService,
        useValue: {
          classificationScores: async (id: string) => {
            calls++;
            if (id === missing) throw new NotFoundException("候选不存在");
            return { modelKey: null, columns: [], images: [] };
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalGuards(
    new AuthGuard(
      new Reflector(),
      {
        authenticate: async () => ({
          actor: { userId: "synthetic", sessionId: "synthetic" },
          user: { permissions, mustChangePassword: false },
        }),
      } as unknown as UsersService,
      parseEnvironment({
        NODE_ENV: "test",
        DATABASE_URL:
          "postgresql://synthetic:synthetic@127.0.0.1:1/unused_test",
      }),
      new RateLimit(),
    ),
  );
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    async function get(id: string, cookie = true) {
      const response = await fetch(
        `${base}/api/candidates/${id}/classification-scores`,
        { headers: cookie ? { cookie: "comiku_session=synthetic" } : {} },
      );
      await response.body?.cancel();
      return response.status;
    }
    assert.equal(await get(randomUUID(), false), 401);
    assert.equal(calls, 0);
    assert.equal(await get(randomUUID()), 403);
    assert.equal(calls, 0);
    permissions = ["candidates:read"];
    assert.equal(await get("invalid"), 400);
    assert.equal(calls, 0);
    assert.equal(await get(missing), 404);
    assert.equal(await get(randomUUID()), 200);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});
