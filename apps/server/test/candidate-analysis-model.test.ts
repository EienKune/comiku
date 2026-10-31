import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { CandidatesService } from "../src/candidates/candidates.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";

function fixture(activeModelKey: string | null) {
  const rows = [
    { id: "old", analysisModelKey: "model-a", analysisScore: 0.99, day: 1 },
    { id: "current", analysisModelKey: "model-b", analysisScore: 0.2, day: 2 },
    { id: "legacy", analysisModelKey: null, analysisScore: 0.95, day: 3 },
    {
      id: "incomplete",
      analysisModelKey: "model-b",
      analysisScore: 0.98,
      day: 4,
    },
  ].map(({ day, ...row }) => ({
    ...row,
    authorId: "author",
    author: { displayName: "Fixture", externalAccounts: [] },
    authorExternalAccount: null,
    tagDisposition: "neutral",
    analysisState: row.id === "incomplete" ? "queued" : "succeeded",
    analysisSummaryVersion: 1,
    analysisPredictions: [
      { label: "comic", confidence: 0.8, score: row.analysisScore },
    ],
    classificationDecision: null,
    classificationSuggestions: [],
    sourceObservations: [],
    hashtags: [],
    media: [],
    postedAt: new Date(`2026-01-0${day}T00:00:00Z`),
    fetchedAt: new Date(0),
    work: null,
  }));
  const db = {
    $queryRaw: async () => [],
    candidatePost: {
      findMany: async (input: { where: { id?: { in: string[] } } }) =>
        rows.filter(
          (row) => !input.where.id || input.where.id.in.includes(row.id),
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
    },
  } as unknown as PrismaService;
  return new CandidatesService(db, {} as FileObjectsService, undefined, {
    activeModelKey,
    promotesReview: () => false,
    classificationTags: () => [
      { label: "comic", text: "Comic", tone: "neutral" },
    ],
    hasEvidence: () => true,
  } as unknown as ImageAnalysisService);
}

// SQL ordering/group/pending semantics are exercised against PostgreSQL in
// candidate-review-sessions.integration and candidate-analysis-model.integration.
test("DTO categories only use current model evidence and preserve partial positive evidence", async () => {
  const service = fixture("model-b");
  assert.deepEqual((await service.get("old")).classificationTags, []);
  assert.deepEqual((await service.get("legacy")).classificationTags, []);
  assert.equal("reviewPriority" in (await service.get("incomplete")), false);
  assert.equal(
    (await service.get("incomplete")).classificationTags?.[0]?.label,
    "comic",
  );
  assert.equal(
    (await service.get("current")).classificationTags?.[0]?.label,
    "comic",
  );
  assert.equal((await service.get("current")).triageGroup, "uncertain");
});
test("disabled model hides cached DTO categories", async () => {
  assert.deepEqual(
    (await fixture(null).get("incomplete")).classificationTags,
    [],
  );
});
