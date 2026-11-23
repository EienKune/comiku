import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { zipSync } from "fflate";
import { TypesetUploadsService } from "../src/typesetting/typeset-uploads.service.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

for (const fail of [false, true, "abort", "lease"] as const)
  test(`extract bounds storage concurrency and settles siblings before cleanup (failure=${fail})`, async () => {
    const controller = new AbortController();
    const body = Buffer.from(
      zipSync(
        Object.fromEntries(
          Array.from({ length: 15 }, (_, i) => [
            `p${String(i).padStart(2, "0")}.png`,
            png,
          ]),
        ),
      ),
    );
    const checksum = createHash("sha256").update(body).digest("hex");
    const file = {
      id: "file",
      objectKey: "staging/file",
      sourceName: "16.zip",
      contentType: "application/zip",
      size: BigInt(body.length),
      checksum,
      status: "pending",
      error: null as string | null,
      images: [] as unknown[],
    };
    const session = {
      id: "session",
      actorId: "actor",
      status: "pending",
      expiresAt: new Date(Date.now() + 3600000),
      files: [file],
    };
    let active = 0,
      peak = 0;
    const stored: string[] = [],
      purged: string[] = [];
    const db = {
      typesetUploadPreview: { findMany: async () => [] },
      user: { findFirst: async () => ({ id: "actor" }) },
      typesetUploadSession: {
        findFirst: async () => session,
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: { status?: string } }) => {
          if (data.status) session.status = data.status;
        },
      },
      typesetUploadFile: {
        update: async ({
          data,
        }: {
          data: {
            status: string;
            error?: string | null;
            images?: { create: { sourceName: string; orderIndex: number }[] };
          };
        }) => {
          file.status = data.status;
          file.error = data.error ?? null;
          if (data.images)
            file.images = data.images.create.map((image) => ({
              ...image,
              id: image.sourceName,
              fileObject: { size: BigInt(png.length) },
            }));
        },
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    };
    const files = {
      headStagingObject: async () => ({
        size: body.length,
        contentType: "application/zip",
        checksum,
      }),
      readStagingObject: async () => body,
      deleteStagingObject: async () => undefined,
      signedStagingWriteUrl: async () => ({
        url: "https://invalid/upload",
        headers: {},
        expiresInSeconds: 60,
      }),
      store: async ({ sourceName }: { sourceName: string }) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (fail === true && sourceName === "p00.png")
            throw new Error("synthetic storage failure");
          if (fail === "abort" && sourceName === "p00.png")
            controller.abort(new Error("synthetic abort"));
          await new Promise((resolve) => setTimeout(resolve, 10));
          stored.push(sourceName);
          return { id: sourceName };
        } finally {
          active--;
        }
      },
      purgeUnreferenced: async (id: string) => {
        assert.equal(
          active,
          0,
          "cleanup cannot race an unfinished successful sibling",
        );
        purged.push(id);
      },
    };
    const service = new TypesetUploadsService(
      db as never,
      files as never,
      {} as never,
      {} as never,
      {
        typesetBatchMaxBytes: 512 * 1024 * 1024,
        typesetBatchMaxWorks: 20,
      } as never,
      undefined,
      fail === "lease"
        ? ({
            assertCurrentLease: async () => {
              throw new Error("synthetic lease loss");
            },
          } as never)
        : undefined,
    );
    if (fail === "abort" || fail === "lease") {
      await assert.rejects(
        service.extract("actor", "session", false, controller.signal),
        /synthetic/,
      );
      assert.equal(active, 0);
      assert.equal(peak, 3);
      assert.equal(stored.length, fail === "abort" ? 3 : 15);
      assert.deepEqual(new Set(purged), new Set(stored));
      assert.equal(file.images.length, 0);
      return;
    }
    const result = await service.extract("actor", "session");
    assert.equal(active, 0);
    assert.equal(peak, fail === true ? 2 : 3);
    if (fail) {
      assert.equal(result.files[0].status, "failed");
      assert.match(result.files[0].error!, /synthetic storage failure/);
      assert.equal(stored.length, 2);
      assert.deepEqual(new Set(purged), new Set(stored));
      assert.equal(result.files[0].images.length, 0);
    } else {
      assert.equal(result.files[0].status, "processed");
      assert.equal(result.files[0].images.length, 15);
      assert.deepEqual(
        result.files[0].images.map((image) => image.sourceName),
        Array.from(
          { length: 15 },
          (_, i) => `p${String(i).padStart(2, "0")}.png`,
        ),
      );
      assert.equal(purged.length, 0);
    }
  });
