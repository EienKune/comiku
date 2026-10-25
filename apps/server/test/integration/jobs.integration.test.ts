import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  JobsService,
  JOB_LEASE_MS,
  retryDelay,
} from "../../src/jobs/jobs.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL required");

test("durable jobs serialize global lanes, recover leases and preserve retries", async () => {
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
  const peer = new JobsService(db);
  const kind = `fixture_${randomUUID()}`;
  const ids: string[] = [];
  let count = 0;
  jobs.register(kind, async () => {
    count++;
  });
  peer.register(kind, async () => {
    count++;
  });
  try {
    const input = {
      kind,
      resourceId: randomUUID(),
      idempotencyKey: kind,
      lane: "heavy" as const,
    };
    const duplicates = await Promise.all([
      jobs.enqueue(input),
      peer.enqueue(input),
    ]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    ids.push(duplicates[0].id);
    const second = await jobs.enqueue({
      ...input,
      idempotencyKey: `${kind}:2`,
    });
    ids.push(second.id);
    const claimed = await Promise.all([
      jobs.claim("heavy"),
      peer.claim("heavy"),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const original = claimed.find(Boolean)!;
    assert.equal(await peer.claim("heavy"), null);
    await db.backgroundJob.update({
      where: { id: original.id },
      data: { leaseUntil: new Date(Date.now() - JOB_LEASE_MS) },
    });
    const recovered = await peer.claim("heavy");
    assert.equal(recovered?.id, original.id);
    assert.equal(recovered?.attempts, 2);
    assert.notEqual(recovered?.leaseId, original.leaseId);
    await peer.execute(recovered!);
    await jobs.runNext("heavy");
    assert.equal(count, 2);
    const failingKind = `${kind}:fail`;
    jobs.register(failingKind, async () => {
      throw new Error("secret payload must not be logged");
    });
    const failed = await jobs.enqueue({
      ...input,
      kind: failingKind,
      idempotencyKey: failingKind,
    });
    ids.push(failed.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.backgroundJob.update({
        where: { id: failed.id },
        data: { availableAt: new Date(0) },
      });
      await jobs.runNext("heavy");
      const current = await db.backgroundJob.findUniqueOrThrow({
        where: { id: failed.id },
      });
      assert.equal(current.attempts, attempt);
      assert.equal(current.status, attempt === 3 ? "failed" : "queued");
      assert.ok(!current.lastError?.includes("secret"));
    }
    assert.equal(retryDelay(2), 10_000);
  } finally {
    await db.backgroundJob.deleteMany({ where: { id: { in: ids } } });
    await module.close();
  }
});

test("scheduler is disabled by default and advances one durable tick without catchup", async () => {
  const disabled = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await disabled.init();
  assert.equal(await disabled.get(SourceFetchService).scheduleDue(), false);
  await disabled.close();
  const enabled = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({
          NODE_ENV: "test",
          DATABASE_URL: url,
          SOURCE_SCHEDULE_ENABLED: "true",
          SOURCE_SCHEDULE_MINUTES: "60",
        }),
      ),
    ],
  }).compile();
  await enabled.init();
  const db = enabled.get(PrismaService);
  try {
    await db.workerSchedule.deleteMany({ where: { name: "sources" } });
    const now = new Date("2026-10-04T12:00:00Z");
    await Promise.all([
      enabled.get(SourceFetchService).scheduleDue(now),
      enabled.get(SourceFetchService).scheduleDue(now),
    ]);
    const tick = await db.workerSchedule.findUniqueOrThrow({
      where: { name: "sources" },
    });
    assert.equal(tick.dueAt.toISOString(), "2026-10-04T13:00:00.000Z");
    assert.equal(await enabled.get(SourceFetchService).scheduleDue(now), false);
  } finally {
    await db.workerSchedule.deleteMany({ where: { name: "sources" } });
    await enabled.close();
  }
});
