import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { ContributionsService } from "../../src/dashboard/contributions.service.js";
import {
  ContributionDetailsQueryDto,
  ContributionQueryDto,
} from "../../src/dashboard/contributions.dto.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("contribution aggregates and bounded details keep set-based plans for synthetic group history", async (t) => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const adminId = randomUUID(),
    users = Array.from({ length: 10 }, () => randomUUID()),
    works = Array.from({ length: 600 }, () => randomUUID());
  const authorId = randomUUID(),
    postId = randomUUID(),
    completedAt = new Date("2026-11-01T00:00:00Z");
  const statements: Prisma.Sql[] = [];
  const measured = new Proxy(db, {
    get(target, property, receiver) {
      return property === "$queryRaw"
        ? (query: Prisma.Sql) => {
            statements.push(query);
            return db.$queryRaw(query);
          }
        : Reflect.get(target, property, receiver);
    },
  });
  const service = new ContributionsService(measured);
  try {
    await db.user.createMany({
      data: [adminId, ...users].map((id) => ({
        id,
        username: `contribution_plan_${id}`,
        displayName: "Synthetic plan member",
        passwordHash: "disabled",
        mustChangePassword: false,
      })),
    });
    await db.userRole.create({ data: { userId: adminId, role: "admin" } });
    await db.author.create({
      data: { id: authorId, displayName: "Synthetic contribution query plan" },
    });
    await db.candidatePost.create({
      data: {
        id: postId,
        authorId,
        platform: "synthetic",
        externalPostId: randomUUID(),
        postedAt: completedAt,
        rawJson: {},
      },
    });
    for (let offset = 0; offset < works.length; offset += 100) {
      const batch = works.slice(offset, offset + 100);
      await db.work.createMany({
        data: batch.map((id) => ({
          id,
          authorId,
          sourceCandidatePostId: postId,
          importedById: adminId,
        })),
      });
      for (const stage of ["translate", "proofread", "typeset"] as const)
        await db.workStageParticipant.createMany({
          data: batch.flatMap((workId) =>
            users.map((userId) => ({
              workId,
              userId,
              stage,
              participationMode: "collaborator" as const,
              submittedAt: completedAt,
            })),
          ),
        });
    }
    await db.$executeRaw(Prisma.sql`ANALYZE work_stage_participants`);
    await db.$executeRaw(Prisma.sql`ANALYZE works`);
    const team = Object.assign(new ContributionQueryDto(), {
      scope: "team",
      period: "all",
    });
    const summary = await service.summary(adminId, team);
    assert.equal(summary.counts.translate, 6000);
    assert.equal(summary.counts.works, 600);
    const personal = await service.summary(
      adminId,
      Object.assign(new ContributionQueryDto(), {
        userId: users[0],
        period: "all",
      }),
    );
    assert.equal(personal.counts.translate, 600);
    assert.equal(
      personal.achievements.find((item) => item.id === "collaboration")
        ?.achieved,
      true,
    );
    const details = await service.details(
      adminId,
      Object.assign(new ContributionDetailsQueryDto(), team, {
        metric: "works",
        limit: 20,
      }),
    );
    assert.equal(details.total, 600);
    assert.equal(details.items.length, 20);
    assert.equal(details.items[0].contributions.length, 30);
    type PlanNode = {
      "Node Type": string;
      "CTE Name"?: string;
      "Actual Loops": number;
      Plans?: PlanNode[];
    };
    for (const [index, statement] of statements.entries()) {
      const [row] = await db.$queryRaw<
        { "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }[]
      >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
      const plan = row["QUERY PLAN"][0];
      assert.ok(
        plan["Execution Time"] < 5000,
        "synthetic query exceeded the broad 5s regression budget",
      );
      const scans: PlanNode[] = [];
      const visit = (node: PlanNode) => {
        if (
          node["Node Type"] === "CTE Scan" &&
          node["CTE Name"] === "completed"
        )
          scans.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan.Plan);
      assert.ok(
        scans.every((node) => node["Actual Loops"] <= 1),
        "completed history must not be rescanned once per page row",
      );
      t.diagnostic(
        `${["team summary", "personal summary", "20-work details"][index]}: ${plan["Execution Time"].toFixed(1)}ms; 18,000 effective credits / 600 works; completed scans at most once per plan node`,
      );
    }
  } finally {
    try {
      for (let offset = 0; offset < works.length; offset += 100) {
        const ids = works.slice(offset, offset + 100);
        await db.workStageParticipant.deleteMany({
          where: { workId: { in: ids } },
        });
        await db.work.deleteMany({ where: { id: { in: ids } } });
      }
      await db.candidatePost.deleteMany({ where: { id: postId } });
      await db.author.deleteMany({ where: { id: authorId } });
      await db.userRole.deleteMany({ where: { userId: adminId } });
      await db.user.deleteMany({ where: { id: { in: [adminId, ...users] } } });
    } finally {
      await db.$disconnect();
    }
  }
});
