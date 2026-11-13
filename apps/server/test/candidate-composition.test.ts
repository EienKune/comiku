import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { normalizeCandidateComposition } from "../src/candidates/composition-intent.js";
import { CandidateCompositionsService } from "../src/candidates/composition.service.js";

const a = randomUUID(),
  b = randomUUID(),
  imageA = randomUUID(),
  imageB = randomUUID();
const merge = () => ({
  idempotencyKey: randomUUID(),
  mode: "merge" as const,
  candidates: [
    { id: b, expectedRevision: 1 },
    { id: a, expectedRevision: 0 },
  ],
  works: [{ title: null, mediaIds: [imageB, imageA] }],
});

test("composition canonical intent sorts candidate identities but retains output and page order", () => {
  const input = merge();
  const first = normalizeCandidateComposition(input);
  const equivalent = normalizeCandidateComposition({
    ...input,
    candidates: [...input.candidates].reverse(),
  });
  assert.equal(first.payloadHash, equivalent.payloadHash);
  assert.notEqual(
    first.payloadHash,
    normalizeCandidateComposition({
      ...input,
      works: [{ title: null, mediaIds: [imageA, imageB] }],
    }).payloadHash,
  );
  assert.equal(
    normalizeCandidateComposition({
      ...input,
      works: [{ title: "  Named  ", mediaIds: [imageA] }],
    }).works[0].title,
    "Named",
  );
});

test("composition rejects duplicate, empty, invalid and overbudget intents before any database work", () => {
  const input = merge();
  for (const changed of [
    { candidates: [input.candidates[0], input.candidates[0]] },
    { candidates: [input.candidates[0]] },
    { works: [{ title: null, mediaIds: [] }] },
    { works: [{ title: null, mediaIds: [imageA, imageA] }] },
    { works: Array(21).fill(input.works[0]) },
    { candidates: Array(21).fill(input.candidates[0]) },
    {
      works: [
        {
          title: null,
          mediaIds: Array.from({ length: 1001 }, () => randomUUID()),
        },
      ],
    },
    { candidates: [{ id: a, expectedRevision: -1 }, input.candidates[1]] },
    { idempotencyKey: "invalid" },
    { series: {} },
  ])
    assert.throws(() =>
      normalizeCandidateComposition({ ...input, ...changed } as never),
    );
});

test("split requires one source and at least two nonempty named outputs without media duplication", () => {
  const split = {
    ...merge(),
    mode: "split" as const,
    candidates: [{ id: a, expectedRevision: 0 }],
    works: [
      { title: "One", mediaIds: [imageA] },
      { title: "Two", mediaIds: [imageB] },
    ],
  };
  assert.equal(normalizeCandidateComposition(split).works.length, 2);
  for (const changed of [
    { works: [split.works[0]] },
    { works: [split.works[0], { title: " ", mediaIds: [imageB] }] },
    { works: [split.works[0], { title: "Two", mediaIds: [imageA] }] },
    { candidates: merge().candidates },
  ])
    assert.throws(() =>
      normalizeCandidateComposition({ ...split, ...changed }),
    );
});

test("successful receipt replay checks the current actor before returning the durable result", async () => {
  const input = merge(),
    expected = {
      idempotencyKey: input.idempotencyKey,
      mode: "merge",
      works: [],
      candidates: [],
      unadoptedMediaIds: [],
    };
  let allowed = true,
    reads = 0;
  const tx = {
    $queryRaw: async () => [],
    candidateCompositionReceipt: {
      findUnique: async () => {
        reads++;
        return {
          payloadHash: normalizeCandidateComposition(input).payloadHash,
          result: expected,
        };
      },
    },
  };
  const service = new CandidateCompositionsService(
    { $transaction: async (run: (tx: object) => unknown) => run(tx) } as never,
    {
      authorizeImport: async () => {
        if (!allowed) throw Error("revoked");
      },
    } as never,
  );
  const actor = { userId: randomUUID(), sessionId: randomUUID() };
  assert.deepEqual(await service.compose(actor, input), expected);
  assert.deepEqual(await service.result(actor, input.idempotencyKey), expected);
  allowed = false;
  await assert.rejects(service.compose(actor, input), /revoked/);
  await assert.rejects(service.result(actor, input.idempotencyKey), /revoked/);
  assert.equal(reads, 2);
});

test("a committed key rejects any changed normalized composition intent", async () => {
  const input = merge();
  const tx = {
    $queryRaw: async () => [],
    candidateCompositionReceipt: {
      findUnique: async () => ({
        payloadHash: normalizeCandidateComposition(input).payloadHash,
        result: {},
      }),
    },
  };
  const service = new CandidateCompositionsService(
    { $transaction: async (run: (tx: object) => unknown) => run(tx) } as never,
    { authorizeImport: async () => undefined } as never,
  );
  await assert.rejects(
    service.compose(
      { userId: randomUUID(), sessionId: randomUUID() },
      { ...input, works: [{ title: "Changed", mediaIds: [imageA] }] },
    ),
    /已用于其他入库意图/,
  );
});

test("source total budget is checked before loading any complete media records", async () => {
  const input = merge();
  let loaded = false;
  const tx = {
    $queryRaw: async () => [],
    candidateCompositionReceipt: { findUnique: async () => null },
    candidatePost: {
      findMany: async ({ include }: { include?: unknown }) => {
        if (include) loaded = true;
        return input.candidates.map((item) => ({ ...item, authorId: a }));
      },
    },
    candidateMedia: { count: async () => 1001 },
  };
  const service = new CandidateCompositionsService(
    { $transaction: async (run: (tx: object) => unknown) => run(tx) } as never,
    { authorizeImport: async () => undefined } as never,
  );
  await assert.rejects(
    service.compose({ userId: randomUUID(), sessionId: randomUUID() }, input),
    /1000/,
  );
  assert.equal(loaded, false);
});
