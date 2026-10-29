import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

test("lease verification fences replacement until the protected transaction commits", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await module.init();
  const db = module.get(PrismaService);
  const jobs = new JobsService(db);
  const kind = `lease_fence_${randomUUID()}`;
  let blocked = false;
  jobs.register(kind, async () => {
    await db.$transaction(async (tx) => {
      await jobs.assertCurrentLease(tx);
      try {
        await db.$transaction(async (peer) => {
          await peer.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
          await peer.$executeRaw`UPDATE background_jobs SET lease_id = ${randomUUID()}::uuid WHERE id = ${row.id}::uuid`;
        });
      } catch (error) {
        blocked = /lock timeout/.test(String(error));
      }
    });
  });
  const row = await jobs.enqueue({
    kind,
    resourceId: randomUUID(),
    idempotencyKey: kind,
  });
  try {
    const claimed = await jobs.claim("heavy");
    assert.equal(claimed?.id, row.id);
    await jobs.execute(claimed!);
    assert.equal(
      blocked,
      true,
      "A peer replaced the lease while its verified transaction was still open",
    );
    assert.equal(
      (await db.backgroundJob.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
      "succeeded",
    );
  } finally {
    await db.backgroundJob.deleteMany({ where: { id: row.id } });
    await module.close();
  }
});
