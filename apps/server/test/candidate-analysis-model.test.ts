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
    classificationTags: () => [],
    hasEvidence: () => true,
  } as unknown as ImageAnalysisService);
}

// SQL ordering/group/pending semantics are exercised against PostgreSQL in
// candidate-review-sessions.integration and candidate-analysis-model.integration.
test("DTO priority only uses current model evidence and preserves partial positive evidence", async () => {
  const service = fixture("model-b");
  assert.equal((await service.get("old")).reviewPriority, "unprocessed");
  assert.equal((await service.get("legacy")).reviewPriority, "unprocessed");
  assert.equal((await service.get("incomplete")).reviewPriority, "high");
  assert.equal((await service.get("current")).reviewPriority, "low");
});
test("disabled model hides cached DTO priority", async () => {
  assert.equal(
    (await fixture(null).get("incomplete")).reviewPriority,
    "unprocessed",
  );
});
