import assert from "node:assert/strict";
import test from "node:test";
import { assertMaterialIdentity } from "../src/typesetting/typeset-materials-identity.js";
import { TypesetMaterialsService } from "../src/typesetting/typeset-materials.service.js";
import { parseLabelPlus } from "../src/labelplus/labelplus-codec.js";
import { TranslationsService } from "../src/translations/translations.service.js";
import { TypesettingService } from "../src/typesetting/typesetting.service.js";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { unzipSync } from "fflate";

const material = {
  translationVersionId: "text",
  sourceAssetRevision: 2,
  images: [{ workImageId: "page", fileObjectId: "file", orderIndex: 0 }],
};
test("material identity pins formal text and ordered originals", () => {
  assert.doesNotThrow(() =>
    assertMaterialIdentity(material, "text", 2, material.images),
  );
  for (const [text, revision, images] of [
    ["other", 2, material.images],
    ["text", 3, material.images],
    ["text", 2, [{ ...material.images[0], fileObjectId: "replacement" }]],
    ["text", 2, [{ ...material.images[0], orderIndex: 1 }]],
  ] as const)
    assert.throws(() =>
      assertMaterialIdentity(material, text, revision, images),
    );
});

test("manifest exports immutable formal entries without reading or packaging image bodies", async () => {
  type SyntheticData = {
    images: { create: Array<{ fileObjectId: string; [key: string]: unknown }> };
    [key: string]: unknown;
  };
  let created: SyntheticData | undefined;
  const file = { contentType: "image/png", size: 3n, checksum: "a".repeat(64) };
  const tx = {
    $queryRaw: async () => [],
    typesetMaterial: {
      findUnique: async () => null,
      create: async ({ data }: { data: SyntheticData }) => {
        created = data;
        return {
          ...data,
          id: "material",
          images: data.images.create.map((image) => ({
            ...image,
            fileObject: file,
          })),
        };
      },
    },
    work: {
      findUnique: async () => ({
        id: "work",
        workNumber: 7,
        workflowStatus: "pending_typeset",
        reviewStatus: "normal",
        revision: 4,
        editorEpoch: 2,
        sourceAssetRevision: 3,
        requiredHandoffVersionId: "formal",
        images: [
          {
            id: "page",
            orderIndex: 0,
            originalFileObjectId: "file",
            originalFileObject: file,
            translationEntries: [
              { translatedText: "mutable draft must not be exported" },
            ],
          },
        ],
      }),
    },
    translationVersion: {
      findFirst: async () => ({
        id: "formal",
        entries: [
          {
            workImageId: "page",
            markerX: { toNumber: () => 0.5 },
            markerY: { toNumber: () => 0.2 },
            markerPositionType: "inside",
            translatedText: "正式文本",
          },
        ],
      }),
    },
  };
  const service = new TypesetMaterialsService(
    {
      $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
    {} as never,
    { assertCanExportHandoffMaterials: async () => {} } as never,
  );
  const result = await service.create("actor", "work", {
    expectedRevision: 4,
    expectedEditorEpoch: 2,
    idempotencyKey: "intent",
  });
  assert.equal(result.translationVersionId, "formal");
  assert.equal(
    parseLabelPlus(Buffer.from(result.translationBase64, "base64")).document
      .images[0].markers[0].translation,
    "正式文本",
  );
  assert.equal(created?.images.create[0].fileObjectId, "file");
  assert.equal("fileObjectId" in (created ?? {}), false);
  let fallbackZip: Uint8Array | undefined;
  const fallbackTx = {
    ...tx,
    typesetHandoffPackage: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "fallback",
        createdAt: new Date(),
      }),
    },
    translationVersion: {
      ...tx.translationVersion,
      findUniqueOrThrow: tx.translationVersion.findFirst,
    },
  };
  const fallback = new TypesettingService(
    {
      ...fallbackTx,
      $transaction: (fn: (db: typeof fallbackTx) => Promise<unknown>) =>
        fn(fallbackTx),
    } as never,
    {
      readStream: async () => ({
        body: Readable.from([new Uint8Array([1, 2, 3])]),
      }),
      storePath: async ({ path }: { path: string }) => {
        fallbackZip = await readFile(path);
        return { id: "zip" };
      },
    } as never,
    { assertCanExportHandoffMaterials: async () => {} } as never,
  );
  await fallback.createHandoffPackage("actor", "work", {
    expectedRevision: 4,
    expectedEditorEpoch: 2,
    idempotencyKey: "fallback-intent",
  });
  assert.ok(fallbackZip);
  const fallbackEntries = unzipSync(fallbackZip);
  assert.deepEqual(
    fallbackEntries[result.translationFileName],
    Uint8Array.from(Buffer.from(result.translationBase64, "base64")),
  );
  assert.deepEqual(fallbackEntries["7-001.png"], new Uint8Array([1, 2, 3]));
});

test("all image signing must succeed before handoff transaction is invoked", async () => {
  let began = false;
  const service = new TypesetMaterialsService(
    {
      typesetMaterial: {
        findFirst: async () => ({
          images: [{ fileObjectId: "missing", fileName: "page.png" }],
        }),
      },
    } as never,
    {
      signedDownloadUrl: async () => {
        throw new Error("missing object");
      },
    } as never,
    {
      assertCanExportHandoffMaterials: async () => {},
      beginTypesetHandoff: async () => {
        began = true;
      },
    } as never,
  );
  await assert.rejects(
    service.deliver("actor", "work", "material"),
    /missing object/,
  );
  assert.equal(began, false);
});

function handoffFixture(required = true) {
  const receipt = {
    ...material,
    id: "material",
    workId: "work",
    actorId: "actor",
    workRevision: 4,
    editorEpoch: 2,
    requireCurrentParticipation: required,
    deliveredAt: null as Date | null,
  };
  const work = {
    id: "work",
    revision: 4,
    editorEpoch: 2,
    sourceAssetRevision: 2,
    requiredHandoffVersionId: "text",
    workflowStatus: "pending_typeset",
    reviewStatus: "normal",
    sourceLanguage: "ja",
    typesetHandoffStartedAt: null as Date | null,
    proofreadSkippedVersionId: null,
  };
  let events = 0;
  let froze = "";
  const tx = {
    $queryRaw: async () => [],
    typesetMaterial: {
      findFirst: async () => receipt,
      findUniqueOrThrow: async () => receipt,
      update: async ({ data }: { data: { deliveredAt: Date } }) =>
        Object.assign(receipt, data),
    },
    work: {
      findUnique: async () => work,
      findUniqueOrThrow: async () => work,
      updateMany: async () => {
        Object.assign(work, {
          revision: 5,
          editorEpoch: 3,
          workflowStatus: "typesetting",
          typesetHandoffStartedAt: new Date(),
        });
        return { count: 1 };
      },
    },
    workImage: {
      findMany: async () => [
        { id: "page", originalFileObjectId: "file", orderIndex: 0 },
      ],
    },
    translationVersion: {
      findUniqueOrThrow: async () => ({
        id: "text",
        versionNumber: 2,
        kind: "proofread_submission",
      }),
      update: async ({ where }: { where: { id: string } }) => {
        froze = where.id;
      },
    },
    user: {
      findFirst: async () => ({ id: "actor" }),
      findUnique: async () => ({
        isActive: true,
        roles: [{ role: "typesetter" }],
        workParticipations: [{ stage: "typeset" }],
      }),
    },
    workStageParticipant: { findFirst: async () => ({ id: "member" }) },
    workEvent: {
      create: async () => {
        events++;
      },
    },
  };
  const service = new TranslationsService(
    {
      $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
    {} as never,
  );
  const deliver = () =>
    service.beginTypesetHandoff("actor", "work", {
      material: "browser_materials",
      fileId: "material",
      expectedRevision: 4,
      expectedEditorEpoch: 2,
      requireCurrentParticipation: required,
    });
  return { receipt, work, deliver, events: () => events, froze: () => froze };
}

test("inspection records access without starting a qualified member's work", async () => {
  const fixture = handoffFixture(false);
  await fixture.deliver();
  assert.equal(fixture.work.revision, 4);
  assert.equal(fixture.events(), 0);
  assert.ok(fixture.receipt.deliveredAt);
});

test("formal delivery freezes exactly its named text and renews without another transition", async () => {
  const fixture = handoffFixture();
  await fixture.deliver();
  assert.equal(fixture.work.workflowStatus, "typesetting");
  assert.equal(fixture.froze(), "text");
  assert.equal(fixture.events(), 1);
  assert.ok(fixture.receipt.deliveredAt);
  await fixture.deliver();
  assert.equal(fixture.events(), 1);
  assert.equal(fixture.work.revision, 5);
});

test("an interrupted pre-delivery baseline cannot adopt a newer work revision", async () => {
  const fixture = handoffFixture();
  fixture.work.revision = 5;
  await assert.rejects(fixture.deliver(), /基线已变化/);
  assert.equal(fixture.events(), 0);
  assert.equal(fixture.receipt.deliveredAt, null);
});
