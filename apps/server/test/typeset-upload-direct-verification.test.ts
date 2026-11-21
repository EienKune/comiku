import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TypesetUploadsService } from "../src/typesetting/typeset-uploads.service.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
interface Attempt {
  id: string;
  uploadFileId: string;
  objectKey: string;
  status: string;
  expiresAt: Date;
}
interface Where {
  id?: string | { not: string };
  status: string;
  uploadFileId?: string;
  expiresAt?: { gt?: Date; lte?: Date };
}
interface Image {
  fileObjectId: string;
  sourceName: string;
  width: number;
  height: number;
  orderIndex: number;
}
interface FileData {
  status: string;
  error?: string | null;
  images?: { create: Image[] };
}
function matches(a: Attempt, w: Where) {
  return (
    a.status === w.status &&
    (!w.uploadFileId || a.uploadFileId === w.uploadFileId) &&
    (!w.id || (typeof w.id === "string" ? a.id === w.id : a.id !== w.id.not)) &&
    (!w.expiresAt?.gt || a.expiresAt > w.expiresAt.gt) &&
    (!w.expiresAt?.lte || a.expiresAt <= w.expiresAt.lte)
  );
}
for (const mode of [
  "success",
  "missing",
  "wrong-size",
  "metadata-ignored",
  "legacy",
  "invalid-dimensions",
  "lost-commit",
  "expired",
  "budget",
] as const)
  test(`immutable direct file HEAD confirmation, bounded transactions and retry fences (${mode})`, async () => {
    const checksum = createHash("sha256").update(png).digest("hex");
    const file = {
      id: "file",
      objectKey:
        mode === "legacy"
          ? "staging/typeset-upload/session/file"
          : "typeset-uploads/immutable/session/file",
      sourceName: "1-1成图.png",
      contentType: "image/png",
      size: BigInt(png.length),
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
    const deleted: string[] = [],
      attempts: Attempt[] = [];
    let copies = 0,
      adopts = 0,
      depth = 0,
      lostReply = false;
    const updateFile = async ({ data }: { data: FileData }) => {
      file.status = data.status;
      file.error = data.error ?? null;
      if (data.images)
        file.images = data.images.create.map((i) => ({
          ...i,
          id: "image",
          fileObject: { size: file.size },
        }));
      return file;
    };
    const db = {
      user: { findFirst: async () => ({ id: "actor" }) },
      backgroundJob: { count: async () => 0 },
      typesetUploadSession: {
        findFirst: async () => session,
        update: async ({ data }: { data: Partial<typeof session> }) =>
          Object.assign(session, data),
      },
      typesetUploadPreview: { findMany: async () => [] },
      fileObject: { aggregate: async () => ({ _sum: { size: 0n } }) },
      typesetUploadImage: { count: async () => 0 },
      typesetUploadFile: {
        update: updateFile,
        updateMany: async (input: { data: FileData }) => {
          if (file.status !== "processed") await updateFile(input);
          return { count: 1 };
        },
      },
      typesetUploadVerification: {
        count: async ({ where }: { where: Where }) =>
          attempts.filter((a) => matches(a, where)).length,
        create: async ({ data }: { data: Omit<Attempt, "status"> }) => {
          const row = { ...data, status: "processing" };
          attempts.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          attempts.find((a) => a.id === where.id),
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Attempt>;
        }) =>
          Object.assign(
            attempts.find((a) => a.id === where.id)!,
            data,
          ),
        updateMany: async ({
          where,
          data,
        }: {
          where: Where;
          data: Partial<Attempt>;
        }) => {
          for (const a of attempts)
            if (matches(a, where)) Object.assign(a, data);
          return { count: 1 };
        },
      },
      $queryRaw: async () => [],
      $transaction: async (
        run: (tx: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        depth++;
        try {
          const result = await run(db);
          if (
            mode === "lost-commit" &&
            !lostReply &&
            attempts.some((a) => a.status === "completed")
          ) {
            lostReply = true;
            throw new Error("synthetic lost commit reply");
          }
          return result;
        } finally {
          depth--;
        }
      },
    };
    const files = {
      headStagingObject: async (key: string, signal?: AbortSignal) => {
        assert.equal(depth, 0);
        assert.equal(key, file.objectKey);
        assert.ok(signal);
        if (mode === "expired") attempts[0].expiresAt = new Date(0);
        return mode === "missing"
          ? null
          : {
              size: mode === "wrong-size" ? png.length + 1 : png.length,
              contentType: "application/octet-stream",
              checksum: "deliberately-untrusted-metadata",
            };
      },
      copyStagingObject: async () => {
        copies++;
        throw new Error("must not copy");
      },
      readStagingObjectLimited: async () => {
        throw new Error("must not read bytes");
      },
      readStagingObject: async () => {
        throw new Error("must not read bytes");
      },
      deleteStagingObject: async (key: string) => {
        deleted.push(key);
      },
      adoptDirectObjectTx: async (
        _tx: unknown,
        input: {
          objectKey: string;
          size: number;
          checksum: string;
          contentType: string;
        },
      ) => {
        assert.equal(depth, 1);
        assert.equal(input.objectKey, file.objectKey);
        assert.equal(input.checksum, checksum);
        assert.equal(input.size, png.length);
        assert.equal(input.contentType, file.contentType);
        adopts++;
        return { id: "object" };
      },
      signedStagingWriteUrl: async () => {
        throw new Error("per-file progress must not sign upload URLs");
      },
    };
    const service = new TypesetUploadsService(
      db as never,
      files as never,
      {} as never,
      {} as never,
      {
        typesetBatchMaxBytes: mode === "budget" ? 1 : 100000,
        typesetBatchMaxWorks: 20,
      } as never,
    );
    const verify = () =>
      service.verifyFile("actor", "session", "file", {
        width: mode === "invalid-dimensions" ? 0 : 1234,
        height: 5678,
      });
    if (["legacy", "invalid-dimensions"].includes(mode)) {
      await assert.rejects(verify, /重新选择|宽高/);
      assert.equal(adopts, 0);
      assert.equal(copies, 0);
      return;
    }
    const result = await verify();
    if (["missing", "wrong-size", "expired", "budget"].includes(mode)) {
      assert.equal(result.status, "failed");
      assert.match(result.error!, /大小|未上传|过期|上限/);
      assert.equal(adopts, 0);
    } else {
      assert.equal(result.status, "processed");
      assert.equal(result.images.length, 1);
      assert.equal(result.images[0].width, 1234);
      assert.equal(result.images[0].height, 5678);
      await verify();
      assert.equal(adopts, 1);
    }
    assert.equal(result.uploadMissing, mode === "missing");
    assert.equal(result.size, png.length);
    assert.equal(result.checksum, checksum);
    assert.equal(result.contentType, "image/png");
    assert.equal(copies, 0);
    assert.deepEqual(deleted, []);
  });
