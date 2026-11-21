import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TypesetCollaborationService } from "../src/typesetting/typeset-collaboration.service.js";

function fixture() {
  const work = {
    id: "work",
    workNumber: 21,
    revision: 5,
    editorEpoch: 2,
    reviewStatus: "normal",
    workflowStatus: "typesetting",
    requiredHandoffVersionId: null,
    typesetHandoffStartedAt: new Date("2026-01-01"),
  };
  const session = {
    id: "session",
    actorId: "actor",
    status: "previewed",
    expiresAt: new Date(Date.now() + 60_000),
    files: [
      {
        sourceName: "21_成图.zip",
        contentType: "application/zip",
        status: "processed",
        images: [
          {
            id: "image",
            sourceName: "21-002.png",
            fileObject: {
              size: 10n,
              lifecycleStatus: "active",
              deletedAt: null,
            },
          },
        ],
      },
    ],
  };
  let preview: Record<string, unknown> | null = null;
  let creates = 0;
  const db = {
    $queryRaw: async () => [],
    user: { findFirst: async () => ({ id: "actor" }) },
    workStageParticipant: { findFirst: async () => ({ id: "participant" }) },
    work: { findUniqueOrThrow: async () => work },
    workEvent: { findUnique: async () => null },
    workImage: {
      findMany: async () => [
        { id: "p1", orderIndex: 0 },
        { id: "p2", orderIndex: 1 },
      ],
    },
    typesetUploadSession: {
      findFirst: async ({ where }: { where: { actorId: string } }) =>
        where.actorId === session.actorId ? session : null,
    },
    typesetUploadPreview: {
      findUnique: async () => preview,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates++;
        preview = data;
        return data;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        preview = { ...preview, ...data };
        return preview;
      },
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  const service = new TypesetCollaborationService(db as never, {} as never);
  const input = {
    sessionId: "session",
    expectedRevision: 5,
    idempotencyKey: "key",
  };
  return {
    service,
    input,
    work,
    session,
    get creates() {
      return creates;
    },
    setPreview: (value: Record<string, unknown>) => {
      preview = value;
    },
  };
}
test("binds an extracted actor-owned session without storing images again and retries the same snapshot", async () => {
  const f = fixture();
  const first = await f.service.previewSession("actor", "work", f.input);
  assert.deepEqual(first.images, [
    { id: "image", sourceName: "21-002.png", suggestedWorkImageId: "p2" },
  ]);
  assert.deepEqual(
    await f.service.previewSession("actor", "work", f.input),
    first,
  );
  assert.equal(f.creates, 1);
});
test("rejects another actor's session and pending or partially failed extraction", async () => {
  const f = fixture();
  await assert.rejects(f.service.previewSession("other", "work", f.input));
  f.session.status = "extracting";
  await assert.rejects(
    f.service.previewSession("actor", "work", f.input),
    /解析/,
  );
  f.session.status = "previewed";
  f.session.files[0].status = "failed";
  await assert.rejects(
    f.service.previewSession("actor", "work", f.input),
    /解析/,
  );
  assert.equal(f.creates, 0);
});
test("never rebinds an existing preview to a newer work version", async () => {
  const f = fixture();
  f.setPreview({
    workRevision: 4,
    editorEpoch: 2,
    handoffStartedAt: f.work.typesetHandoffStartedAt,
    versionId: null,
  });
  await assert.rejects(
    f.service.previewSession("actor", "work", f.input),
    /更新|重新/,
  );
  f.work.revision = 6;
  await assert.rejects(
    f.service.previewSession("actor", "work", f.input),
    /更新|重新/,
  );
  assert.equal(f.creates, 0);
});
test("explicit rebind reuses unadopted images only while epoch and handoff are unchanged", async () => {
  const f = fixture();
  f.setPreview({
    id: "preview",
    workRevision: 4,
    editorEpoch: 2,
    handoffStartedAt: f.work.typesetHandoffStartedAt,
    versionId: null,
    appliedAt: null,
  });
  const result = await f.service.previewSession("actor", "work", {
    ...f.input,
    rebind: true,
  });
  assert.equal(result.images[0].id, "image");
  assert.equal(result.expectedRevision, 5);
  assert.equal(f.creates, 0);
  f.setPreview({
    id: "preview",
    workRevision: 4,
    editorEpoch: 2,
    handoffStartedAt: f.work.typesetHandoffStartedAt,
    versionId: null,
    appliedAt: new Date(),
  });
  await assert.rejects(
    f.service.previewSession("actor", "work", { ...f.input, rebind: true }),
    /采用|使用|更新/,
  );
  f.setPreview({
    id: "preview",
    workRevision: 4,
    editorEpoch: 1,
    handoffStartedAt: f.work.typesetHandoffStartedAt,
    versionId: null,
    appliedAt: null,
  });
  await assert.rejects(
    f.service.previewSession("actor", "work", { ...f.input, rebind: true }),
    /基线|更新/,
  );
});
test("treats filenames as mapping suggestions while rejecting expired sessions", async () => {
  const f = fixture();
  f.session.files[0].sourceName = "22_成图.zip";
  await f.service.previewSession("actor", "work", f.input);
  f.session.files[0].sourceName = "21_成图.zip";
  f.session.files[0].images[0].sourceName = "22-002.png";
  await f.service.previewSession("actor", "work", f.input);
  f.session.expiresAt = new Date(0);
  await assert.rejects(
    f.service.previewSession("actor", "work", f.input),
    /过期/,
  );
});
