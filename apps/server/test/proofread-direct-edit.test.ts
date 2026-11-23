import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "../src/generated/prisma/client.js";
import { TranslationsService } from "../src/translations/translations.service.js";

function fixture() {
  const work = {
    id: "work",
    revision: 8,
    editorEpoch: 4,
    workflowStatus: "proofreading",
    reviewStatus: "normal",
    sourceLanguage: "ja",
    collaborationMode: "multi",
    productionStartedAt: new Date(),
  };
  const entries = ["a", "b"].map((id) => ({
    id,
    workImageId: "page",
    orderIndex: 0,
    markerX: new Prisma.Decimal(0.2),
    markerY: new Prisma.Decimal(0.3),
    markerPositionType: "inside",
    translatedText: "original",
    note: null,
    revision: 0,
    createdById: "actor",
    updatedById: "actor",
    createdAt: new Date(),
    updatedAt: new Date(),
    workImage: { workId: "work" },
  }));
  const db = {
    $queryRaw: async () => [work],
    work: { findUnique: async () => work },
    user: {
      findUnique: async () => ({
        roles: [{ role: "proofreader" }],
        languageCapabilities: [{ language: "ja" }],
      }),
    },
    workStageParticipant: { findMany: async () => [{ stage: "proofread" }] },
    translationEntry: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        entries.find((e) => e.id === where.id),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; revision: number };
        data: { translatedText: string };
      }) => {
        const entry = entries.find(
          (e) => e.id === where.id && e.revision === where.revision,
        );
        if (!entry) return { count: 0 };
        entry.translatedText = data.translatedText;
        entry.revision++;
        return { count: 1 };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(db),
  };
  return {
    service: new TranslationsService(db as never, {} as never),
    entries,
    work,
  };
}

test("proofreaders save separate entries on the same page without page leases and stale same-entry revisions conflict", async () => {
  const { service, entries } = fixture();
  await service.updateEntry("actor", "a", {
    expectedEditorEpoch: 4,
    expectedRevision: 0,
    translatedText: "first",
  });
  await service.updateEntry("other", "b", {
    expectedEditorEpoch: 4,
    expectedRevision: 0,
    translatedText: "second",
  });
  assert.deepEqual(
    entries.map((e) => e.translatedText),
    ["first", "second"],
  );
  await assert.rejects(
    service.updateEntry("other", "a", {
      expectedEditorEpoch: 4,
      expectedRevision: 0,
      translatedText: "overwrite",
    }),
    /条目已更新/,
  );
  assert.equal(entries[0].translatedText, "first");
});

test("an old epoch remains rejected even when a legacy client supplies a lease token", async () => {
  const { service, entries } = fixture();
  await assert.rejects(
    service.updateEntry("actor", "a", {
      expectedEditorEpoch: 3,
      expectedRevision: 0,
      translatedText: "old round",
      editorInstanceId: "legacy",
      leaseToken: "legacy",
    }),
    /新的正式版本/,
  );
  assert.equal(entries[0].revision, 0);
});
