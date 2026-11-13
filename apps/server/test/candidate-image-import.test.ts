import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CandidateAction,
  CandidateBatchActionDto,
} from "../src/candidates/candidates.dto.js";
import { CandidatesService } from "../src/candidates/candidates.service.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const mediaA = "00000000-0000-4000-8000-000000000002";
const mediaB = "00000000-0000-4000-8000-000000000003";

test("batch import accepts an ordered media subset without the manual upload group limit", async () => {
  for (const mediaIds of [
    undefined,
    [mediaB, mediaA],
    Array.from(
      { length: 101 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    ),
  ]) {
    const errors = await validate(
      plainToInstance(CandidateBatchActionDto, {
        action: "import",
        items: [
          {
            id: candidateId,
            expectedRevision: 7,
            ...(mediaIds ? { mediaIds } : {}),
          },
        ],
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    assert.deepEqual(errors, []);
  }
});

test("batch import rejects malformed, empty, null, duplicate and oversized media selections", async () => {
  for (const mediaIds of [
    null,
    [],
    [mediaA, mediaA],
    ["bad-id"],
    "all",
    Array(1001).fill(mediaA),
  ]) {
    const errors = await validate(
      plainToInstance(CandidateBatchActionDto, {
        action: "import",
        items: [{ id: candidateId, expectedRevision: 7, mediaIds }],
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    assert.ok(errors.length > 0);
  }
});

function importFixture(imported = false) {
  const pages: unknown[] = [];
  const events: unknown[] = [];
  const media = [mediaA, mediaB].map((id, orderIndex) => ({
    id,
    orderIndex,
    fileObjectId: `file-${id}`,
    width: 10,
    height: 20,
    fileObject: { lifecycleStatus: "active", deletedAt: null },
  }));
  const candidate = {
    id: candidateId,
    revision: imported ? 8 : 7,
    status: imported ? "imported" : "pending",
    authorId: "author",
    author: {
      deletedAt: null,
      authorizationStatus: "authorized",
      sourceLanguage: "ja",
    },
    externalPostUrl: null,
    text: "source",
    media,
    workSources: imported
      ? [
          {
            importedRevision: 7,
            work: {
              id: "work",
              candidateCompositionId: null,
              candidateImportSeriesIntent: null,
              images: [{ sourceCandidateMediaId: mediaB, orderIndex: 0 }],
            },
          },
        ]
      : [],
  };
  const tx = {
    $queryRaw: async () => [],
    fileObject: { count: async () => 2 },
    candidatePost: {
      findUnique: async () => candidate,
      updateMany: async () => ({ count: 1 }),
    },
    work: {
      create: async ({ data }: { data: object }) => ({
        id: "work",
        ...data,
        workflowStatus: "pending_translate",
        reviewStatus: "normal",
      }),
    },
    workImage: {
      createMany: async ({ data }: { data: unknown[] }) => {
        pages.push(...data);
      },
    },
    workEvent: {
      create: async ({ data }: { data: unknown }) => {
        events.push(data);
      },
    },
    candidateActionLog: { create: async () => ({}) },
  };
  const db = {
    $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
  };
  const service = new CandidatesService(db as never, {} as never);
  return { service, pages, events, candidate };
}

test("import adopts only the requested media and assigns contiguous submitted page order", async () => {
  const f = importFixture();
  const result = await f.service.batch("actor", {
    action: CandidateAction.import,
    items: [
      { id: candidateId, expectedRevision: 7, mediaIds: [mediaB, mediaA] },
    ],
  });
  assert.equal(result.results[0].outcome, "succeeded");
  assert.deepEqual(
    f.pages.map((page) => {
      const value = page as {
        sourceCandidateMediaId: string;
        orderIndex: number;
      };
      return [value.sourceCandidateMediaId, value.orderIndex];
    }),
    [
      [mediaB, 0],
      [mediaA, 1],
    ],
  );
  assert.equal(f.events.length, 1);
});

test("committed replay requires the same original revision and exact ordered selection", async () => {
  const f = importFixture(true);
  for (const [expectedRevision, mediaIds, want] of [
    [7, [mediaB], "unchanged"],
    [8, [mediaB], "conflict"],
    [7, [mediaA], "conflict"],
    [7, undefined, "conflict"],
  ] as const) {
    const result = await f.service.batch("actor", {
      action: CandidateAction.import,
      items: [
        {
          id: candidateId,
          expectedRevision,
          mediaIds: mediaIds ? [...mediaIds] : undefined,
        },
      ],
    });
    assert.equal(result.results[0].outcome, want);
  }
  assert.deepEqual(f.pages, []);
  assert.deepEqual(f.events, []);
});

test("explicit selection never silently replays unknown legacy import intent", async () => {
  const f = importFixture(true);
  Object.assign(f.candidate.workSources[0], { importedRevision: null });
  const result = await f.service.batch("actor", {
    action: CandidateAction.import,
    items: [{ id: candidateId, expectedRevision: 7, mediaIds: [mediaB] }],
  });
  assert.equal(result.results[0].outcome, "conflict");
  const legacyReplay = await f.service.batch("actor", {
    action: CandidateAction.import,
    items: [{ id: candidateId, expectedRevision: 7 }],
  });
  assert.equal(legacyReplay.results[0].outcome, "unchanged");
});
