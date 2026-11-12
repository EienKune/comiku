import assert from "node:assert/strict";
import test from "node:test";
import { DashboardService } from "../src/dashboard/dashboard.service.js";
import {
  ReviewStatus,
  WorkflowStatus,
} from "../src/generated/prisma/client.js";

for (const { name, groups, expected } of [
  { name: "empty", groups: [], expected: 0 },
  {
    name: "only archived",
    groups: [{ workflowStatus: WorkflowStatus.archived, _count: { _all: 2 } }],
    expected: 0,
  },
  {
    name: "published",
    groups: [{ workflowStatus: WorkflowStatus.published, _count: { _all: 3 } }],
    expected: 3,
  },
  {
    name: "active, published and archived",
    groups: [
      { workflowStatus: WorkflowStatus.pending_translate, _count: { _all: 1 } },
      { workflowStatus: WorkflowStatus.published, _count: { _all: 1 } },
      { workflowStatus: WorkflowStatus.archived, _count: { _all: 2 } },
    ],
    expected: 2,
  },
]) {
  test(`dashboard visible total excludes archived works: ${name}`, async () => {
    const service = new DashboardService({
      user: {
        findUniqueOrThrow: async () => ({ roles: [{ role: "translator" }] }),
      },
      work: {
        groupBy: async ({ by, where }: { by: string[]; where?: object }) => {
          if (by.includes("reviewStatus"))
            return [
              { reviewStatus: ReviewStatus.blocked, _count: { _all: 4 } },
            ];
          if (where)
            return [
              { workflowStatus: WorkflowStatus.archived, _count: { _all: 1 } },
            ];
          return groups;
        },
      },
      workStageParticipant: {
        findMany: async () => [{ workId: "historical-participation" }],
      },
      workEvent: { findMany: async () => [] },
    } as never);

    const result = await service.summary("actor");

    assert.equal(result.totalWorks, expected);
    // The visible total does not redefine existing historical summaries.
    assert.equal(result.myParticipatingWorks, 1);
    assert.equal(
      result.myWorkflowCounts.find(({ status }) => status === "archived")
        ?.count,
      1,
    );
    assert.equal(
      result.reviewCounts.find(({ status }) => status === "blocked")?.count,
      4,
    );
    for (const group of groups)
      assert.equal(
        result.workflowCounts.find(
          ({ status }) => status === group.workflowStatus,
        )?.count,
        group._count._all,
      );
  });
}
