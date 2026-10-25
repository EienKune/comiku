import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  ReviewStatus,
  SourceLanguage,
  WorkCollaborationMode,
  WorkflowStatus,
} from "../src/generated/prisma/client.js";
import {
  WorkClaimOutcome,
  WorkPhase,
  type WorkQueryDto,
} from "../src/works/works.dto.js";
import { WorksService } from "../src/works/works.service.js";

function detailedWork(work: {
  id: string;
  workNumber: number;
  workflowStatus: WorkflowStatus;
  stageParticipants: { stage: "translate" | "proofread" | "typeset" }[];
}) {
  const now = new Date("2026-09-17T00:00:00.000Z");
  return {
    ...work,
    authorId: `author-${work.id}`,
    author: { displayName: `作者 ${work.id}` },
    title: `作品 ${work.workNumber}`,
    sourceLanguage: SourceLanguage.ja,
    collaborationMode: WorkCollaborationMode.single,
    sourcePostUrl: null,
    reviewStatus: ReviewStatus.normal,
    priority: 0,
    revision: 0,
    editorEpoch: 0,
    typesetHandoffStartedAt: null,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    images: [],
    _count: {
      images: 0,
      stageParticipants: work.stageParticipants.length,
    },
    importedAt: now,
    publishedAt: null,
    updatedAt: now,
  };
}

test("work list pages after server-side phase filtering and puts unclaimed work first", async () => {
  const rows = [
    {
      id: "assigned-12",
      workNumber: 12,
      workflowStatus: WorkflowStatus.pending_translate,
      stageParticipants: [{ stage: "translate" as const }],
    },
    {
      id: "unassigned-10",
      workNumber: 10,
      workflowStatus: WorkflowStatus.pending_translate,
      stageParticipants: [],
    },
    {
      id: "unassigned-9",
      workNumber: 9,
      workflowStatus: WorkflowStatus.translating,
      stageParticipants: [],
    },
    {
      id: "proofread-20",
      workNumber: 20,
      workflowStatus: WorkflowStatus.pending_proofread,
      stageParticipants: [],
    },
  ];
  const db = {
    user: {
      findUnique: async () => ({
        isActive: true,
        roles: [{ role: "translator" }],
        languageCapabilities: [{ language: "ja" }],
      }),
    },
    work: {
      count: async ({
        where,
      }: {
        where: { AND: { workflowStatus?: { in?: WorkflowStatus[] } }[] };
      }) => {
        // The database performs the filtering; these mock counts describe its result.
        const statuses = where.AND?.find((scope) => scope.workflowStatus)
          ?.workflowStatus?.in;
        if (statuses?.includes(WorkflowStatus.pending_translate)) return 3;
        if (statuses?.includes(WorkflowStatus.pending_proofread)) return 1;
        return 0;
      },
      findMany: async ({
        take,
        orderBy,
        where,
      }: {
        take: number;
        orderBy: object;
        where: { AND: { stageParticipants?: unknown }[] };
      }) => {
        assert.equal(take, 3);
        assert.deepEqual(orderBy, { workNumber: "desc" });
        assert.ok(where.AND.some((scope) => scope.stageParticipants));
        return [
          detailedWork(rows[1]),
          detailedWork(rows[2]),
          detailedWork(rows[0]),
        ];
      },
    },
  };
  const service = new WorksService(db as never, {} as never, {} as never);
  const page = await service.list("actor", {
    phase: WorkPhase.translation,
    limit: 2,
    mine: false,
  } as WorkQueryDto);

  assert.deepEqual(
    page.items.map(({ id }) => id),
    ["unassigned-10", "unassigned-9"],
  );
  assert.equal(page.total, 3);
  assert.equal(page.nextCursor, "unassigned-9");
  assert.equal(
    page.phaseCounts.find(({ phase }) => phase === WorkPhase.translation)
      ?.count,
    3,
  );
  assert.equal(
    page.phaseCounts.find(({ phase }) => phase === WorkPhase.proofread)?.count,
    1,
  );
});

test("batch work claims keep processing after item-level failures", async () => {
  const service = new WorksService({} as never, {} as never, {} as never);
  service.claimStage = async (_actorId, id) => {
    if (id === "missing") throw new NotFoundException("作品不存在");
    if (id === "forbidden") throw new ForbiddenException("没有对应职责");
    if (id === "stale") throw new ConflictException("作品已更新");
    return {} as never;
  };

  const result = await service.claimStages("actor", {
    stage: "translate",
    items: ["ok", "missing", "forbidden", "stale"].map((id) => ({
      id,
      expectedRevision: 0,
      idempotencyKey: id,
    })),
  });

  assert.deepEqual(
    result.results.map(({ outcome }) => outcome),
    [
      WorkClaimOutcome.succeeded,
      WorkClaimOutcome.not_found,
      WorkClaimOutcome.forbidden,
      WorkClaimOutcome.conflict,
    ],
  );
});
