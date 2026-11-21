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
  "corrupt",
  "lost-commit",
  "expired",
  "budget",
] as const)
  test(`single file snapshot, bounded transactions and retry fences (${mode})`, async () => {
    const checksum = createHash("sha256").update(png).digest("hex");
    const file = {
      id: "file",
      objectKey: "staging/typeset-upload/session/file",
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
    const snapshots = new Map<string, Buffer>(),
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
    const metadata = { size: png.length, contentType: "image/png", checksum };
    const files = {
      headStagingObject: async (key: string) => {
        assert.equal(depth, 0);
        return key.startsWith("staging/")
          ? metadata
          : snapshots.has(key)
            ? metadata
            : null;
      },
      copyStagingObject: async (source: string, key: string) => {
        assert.equal(depth, 0);
        assert.equal(source, file.objectKey);
        copies++;
        snapshots.set(
          key,
          mode === "corrupt" ? Buffer.alloc(png.length) : Buffer.from(png),
        );
      },
      readStagingObjectLimited: async (key: string) => {
        assert.equal(depth, 0);
        assert.ok(!key.startsWith("staging/"));
        if (mode === "expired") attempts[0].expiresAt = new Date(0);
        return snapshots.get(key)!;
      },
      deleteStagingObject: async (key: string) => {
        snapshots.delete(key);
      },
      adoptCopiedObjectTx: async (
        _tx: unknown,
        input: { objectKey: string },
      ) => {
        assert.equal(depth, 1);
        assert.ok(!input.objectKey.startsWith("staging/"));
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
    const result = await service.verifyFile("actor", "session", "file");
    if (["corrupt", "expired", "budget"].includes(mode)) {
      assert.equal(result.status, "failed");
      assert.match(result.error!, /校验|过期|上限/);
      assert.equal(adopts, 0);
      assert.equal(snapshots.size, 0);
    } else {
      assert.equal(result.status, "processed");
      assert.equal(result.images.length, 1);
      await service.verifyFile("actor", "session", "file");
      assert.equal(copies, 1);
      assert.equal(adopts, 1);
      assert.equal(snapshots.size, 1);
    }
  });
