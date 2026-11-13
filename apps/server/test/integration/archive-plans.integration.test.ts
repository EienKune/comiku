import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { archiveWorkPageQuery } from "../../src/archive-exports/archive-selection.js";

interface PlanNode {
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}
type Explain = {
  "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
}[];

test("archive keysets and per-work package planning avoid unrelated month and snapshot scans", async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Disposable _test database required");
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  await db.$connect();
  const user = await db.user.create({
    data: {
      username: `archive_plan_${randomUUID()}`,
      displayName: "Synthetic plan actor",
      passwordHash: "disabled",
    },
  });
  const author = await db.author.create({
    data: { displayName: "Synthetic plan author" },
  });
  let runId: string | undefined;
  try {
    const targetDate = new Date("2040-11-15T00:00:00Z");
    const target = Array.from({ length: 400 }, () => ({
      id: randomUUID(),
      createdAt: targetDate,
    }));
    const others = Array.from({ length: 20_000 }, () => ({
      id: randomUUID(),
      createdAt: new Date("2040-01-01T00:00:00Z"),
    }));
    const all = [...others, ...target];
    for (let offset = 0; offset < all.length; offset += 500) {
      const batch = all
        .slice(offset, offset + 500)
        .map((value) => ({ ...value, postId: randomUUID() }));
      await db.candidatePost.createMany({
        data: batch.map((value) => ({
          id: value.postId,
          authorId: author.id,
          platform: "archive-plan",
          externalPostId: value.postId,
          postedAt: value.createdAt,
          rawJson: { synthetic: true },
          status: "imported",
        })),
      });
      await db.work.createMany({
        data: batch.map((value) => ({
          id: value.id,
          authorId: author.id,
          importedById: user.id,
          sourceCandidatePostId: value.postId,
          createdAt: value.createdAt,
        })),
      });
    }
    await db.$executeRawUnsafe("ANALYZE works");
    target.sort((a, b) => a.id.localeCompare(b.id));
    const cursor = target[349];
    const page = archiveWorkPageQuery(
      { year: 2040, month: 11, content: "raw" },
      11,
      cursor,
    );
    const rows = await db.$queryRaw<{ id: string }[]>(page);
    assert.deepEqual(
      rows.map((value) => value.id),
      target.slice(350, 370).map((value) => value.id),
    );
    const explain = await db.$queryRaw<Explain>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${page}`,
    );
    const nodes: PlanNode[] = [];
    const collect = (node: PlanNode) => {
      nodes.push(node);
      node.Plans?.forEach(collect);
    };
    collect(explain[0]["QUERY PLAN"][0].Plan);
    assert.ok(
      nodes.some((node) => node["Index Name"] === "works_created_archive_idx"),
    );
    const rowsExamined = nodes.reduce(
      (sum, node) =>
        sum +
        (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) *
          node["Actual Loops"],
      0,
    );
    assert.ok(
      rowsExamined <= 80,
      `Later page examined ${rowsExamined} rows instead of using its tuple boundary`,
    );

    const run = await db.archiveExportRun.create({
      data: {
        actorId: user.id,
        idempotencyKey: randomUUID(),
        payloadHash: "0".repeat(64),
        year: 2040,
        month: 11,
        content: "raw",
        deadlineAt: new Date(Date.now() + 3_600_000),
      },
    });
    runId = run.id;
    const month = await db.archiveExportMonth.create({
      data: {
        runId: run.id,
        month: 11,
        capturedAt: new Date(),
        manifestHash: "0".repeat(64),
      },
    });
    const snapshots = Array.from({ length: 400 }, (_, i) => ({
      id: randomUUID(),
      runId: run.id,
      monthId: month.id,
      workId: target[i].id,
      workNumber: i + 1,
      workRevision: 0,
      editorEpoch: 0,
      workflowStatus: "pending_translate",
      reviewStatus: "normal",
      textSource: "current_saved_empty",
      facts: { synthetic: true },
    }));
    await db.archiveExportWorkSnapshot.createMany({ data: snapshots });
    for (let offset = 0; offset < 20_000; offset += 500) {
      await db.archiveExportEntry.createMany({
        data: Array.from({ length: 500 }, (_, i) => {
          const ordinal = offset + i;
          return {
            runId: run.id,
            snapshotId: snapshots[Math.floor(ordinal / 50)].id,
            ordinal,
            kind: "manifest",
            path: `synthetic/${ordinal}.json`,
            size: 0n,
            checksum: "0".repeat(64),
            contentText: "",
          };
        }),
      });
    }
    await db.$executeRawUnsafe("ANALYZE archive_export_entries");
    const snapshotId = snapshots[350].id;
    // Same predicate/order used by runtime package planning for one frozen work.
    const entryPlan =
      await db.$queryRaw<Explain>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,path,size,checksum,ordinal FROM archive_export_entries WHERE run_id=${run.id}::uuid AND snapshot_id=${snapshotId}::uuid ORDER BY ordinal ASC`;
    nodes.length = 0;
    collect(entryPlan[0]["QUERY PLAN"][0].Plan);
    assert.ok(
      nodes.some(
        (node) =>
          node["Index Name"] ===
          "archive_export_entries_snapshot_id_ordinal_idx",
      ),
    );
    const entryRows = nodes.reduce(
      (sum, node) =>
        sum +
        (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) *
          node["Actual Loops"],
      0,
    );
    assert.ok(
      entryRows <= 150,
      `One work scanned ${entryRows} rows from unrelated snapshots`,
    );
    t.diagnostic(
      JSON.stringify({
        syntheticWorks: all.length,
        sameTimestampMonthWorks: target.length,
        laterPageExamined: rowsExamined,
        snapshotEntries: 20_000,
        selectedWorkExamined: entryRows,
        pageMs: explain[0]["QUERY PLAN"][0]["Execution Time"],
        workMs: entryPlan[0]["QUERY PLAN"][0]["Execution Time"],
      }),
    );
  } finally {
    if (runId) {
      await db.archiveExportEntry.deleteMany({ where: { runId } });
      await db.archiveExportWorkSnapshot.deleteMany({ where: { runId } });
      await db.archiveExportMonth.deleteMany({ where: { runId } });
      await db.archiveExportRun.delete({ where: { id: runId } });
    }
    await db.work.deleteMany({ where: { authorId: author.id } });
    await db.candidatePost.deleteMany({ where: { authorId: author.id } });
    await db.author.delete({ where: { id: author.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
