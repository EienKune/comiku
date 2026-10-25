import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL required");

test("derivatives are durable, shared, idempotent and never overwrite originals", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await module.init();
  const db = module.get(PrismaService);
  const files = module.get(FileObjectsService);
  const jobs = module.get(JobsService);
  const body = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: "#337799" },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const originals: string[] = [];
  const derivativeIds: string[] = [];
  try {
    const file = await files.store({
      body,
      contentType: "image/png",
      bucketScope: "source",
      kind: "candidate-media",
    });
    originals.push(file.id);
    const derivatives = await db.imageDerivative.findMany({
      where: { sourceFileId: file.id },
    });
    derivativeIds.push(...derivatives.map((item) => item.id));
    assert.equal(derivatives.length, 1);
    const pending = await files.imageUrl(file.id, "thumbnail");
    assert.equal(pending.url, null);
    assert.equal(pending.status, "queued");
    // Older test jobs whose resources no longer exist are harmless to resume.
    for (
      let i = 0;
      i < 300 &&
      (await files.imageUrl(file.id, "thumbnail")).status === "queued";
      i++
    )
      await jobs.runNext("heavy");
    const ready = await files.imageUrl(file.id, "thumbnail");
    assert.equal(ready.status, "ready");
    assert.equal(ready.width, 800);
    assert.equal(ready.height, 533);
    assert.equal((await files.imageUrl(file.id, "thumbnail")).url, ready.url);
    const original = await files.read(file.id);
    assert.equal(
      createHash("sha256").update(original.body).digest("hex"),
      file.checksum,
    );
    assert.deepEqual(Buffer.from(original.body), body);
    const same = await Promise.all([
      files.imageUrl(file.id, "thumbnail"),
      files.imageUrl(file.id, "thumbnail"),
    ]);
    assert.equal(same[0].url, same[1].url);
    assert.equal(
      await db.imageDerivative.count({ where: { sourceFileId: file.id } }),
      1,
    );
    const tinyBody = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .webp()
      .toBuffer();
    const tiny = await files.store({
      body: tinyBody,
      contentType: "image/webp",
      bucketScope: "works",
      kind: "typeset-result",
    });
    originals.push(tiny.id);
    derivativeIds.push(
      (
        await db.imageDerivative.findFirstOrThrow({
          where: { sourceFileId: tiny.id },
        })
      ).id,
    );
    await jobs.runNext("heavy");
    const reused = await files.imageUrl(tiny.id, "thumbnail");
    assert.equal(reused.status, "reused");
    assert.equal(reused.url, (await files.imageUrl(tiny.id, "original")).url);
    const outputId = (
      await db.imageDerivative.findUniqueOrThrow({
        where: { id: derivatives[0].id },
      })
    ).outputFileId!;
    await files.purgeUnreferenced(file.id);
    assert.equal(
      await db.fileObject.findUnique({ where: { id: outputId } }),
      null,
    );
    await assert.rejects(() => files.imageUrl(file.id, "thumbnail"));
  } finally {
    for (const id of originals) await files.purgeUnreferenced(id);
    await db.backgroundJob.deleteMany({
      where: { resourceId: { in: derivativeIds } },
    });
    await module.close();
  }
});
