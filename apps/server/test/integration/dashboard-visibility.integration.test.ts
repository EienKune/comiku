import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ForbiddenException } from "@nestjs/common";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { DashboardService } from "../../src/dashboard/dashboard.service.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type {
  Prisma,
  WorkflowStatus,
} from "../../src/generated/prisma/client.js";
import { WorkQueryDto, WorkView } from "../../src/works/works.dto.js";
import { WorksService } from "../../src/works/works.service.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must select a disposable _test database.");

test("dashboard visible count matches discovery through archive and restore without granting admin production eligibility", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error(
    "intentional dashboard visibility fixture rollback",
  );
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          // Keep real archive/restore writes inside the fixture's rollback.
          const client = new Proxy(tx, {
            get(target, property) {
              if (property === "$transaction")
                return (fn: (tx: Prisma.TransactionClient) => unknown) =>
                  fn(tx);
              return Reflect.get(target, property);
            },
          }) as unknown as PrismaService;
          const dashboard = new DashboardService(client);
          const works = new WorksService(client, {} as never, {} as never);
          async function user(role: "admin" | "translator") {
            return tx.user.create({
              data: {
                username: `visibility_${randomUUID()}`,
                displayName: `Visibility ${role}`,
                passwordHash: "non-login-fixture",
                mustChangePassword: false,
                roles: { create: { role } },
                languageCapabilities: { create: { language: "ja" } },
              },
            });
          }
          const admin = await user("admin");
          const translator = await user("translator");
          const author = await tx.author.create({
            data: { displayName: "Dashboard visibility fixture" },
          });
          const baseline = await works.list(admin.id, new WorkQueryDto());
          const archivedBaseline = await works.list(
            admin.id,
            Object.assign(new WorkQueryDto(), { workflowStatus: "archived" }),
          );
          async function work(status: WorkflowStatus) {
            const candidate = await tx.candidatePost.create({
              data: {
                authorId: author.id,
                platform: "fixture",
                externalPostId: randomUUID(),
                postedAt: new Date(),
                rawJson: { fixture: true },
              },
            });
            return tx.work.create({
              data: {
                authorId: author.id,
                sourceCandidatePostId: candidate.id,
                importedById: admin.id,
                title: `Visibility ${status}`,
                workflowStatus: status,
                sourceLanguage: "ja",
                ...(status === "archived"
                  ? { archivedFromWorkflowStatus: "published" as const }
                  : {}),
              },
            });
          }
          async function assertCounts(visible: number, archived: number) {
            const summary = await dashboard.summary(admin.id);
            const page = await works.list(admin.id, new WorkQueryDto());
            const archivedPage = await works.list(
              admin.id,
              Object.assign(new WorkQueryDto(), { workflowStatus: "archived" }),
            );
            assert.equal(summary.totalWorks, baseline.total + visible);
            assert.equal(page.total, summary.totalWorks);
            assert.equal(
              page.phaseCounts.reduce((sum, phase) => sum + phase.count, 0),
              summary.totalWorks,
            );
            assert.equal(archivedPage.total, archivedBaseline.total + archived);
          }

          await work("archived");
          await work("archived");
          await assertCounts(0, 2);

          const pending = await work("pending_translate");
          const published = await work("published");
          await assertCounts(2, 2);
          const fixturePage = await works.list(
            admin.id,
            Object.assign(new WorkQueryDto(), { authorId: author.id }),
          );
          assert.deepEqual(
            fixturePage.items.map(({ id }) => id),
            [published.id, pending.id],
          );

          const archived = await works.archive(admin.id, published.id, {
            expectedRevision: published.revision,
            idempotencyKey: randomUUID(),
          });
          assert.equal(archived.workflowStatus, "archived");
          await assertCounts(1, 3);
          const restored = await works.restore(admin.id, published.id, {
            expectedRevision: archived.revision,
            idempotencyKey: randomUUID(),
          });
          assert.equal(restored.workflowStatus, "published");
          await assertCounts(2, 2);

          for (const view of [WorkView.todo, WorkView.recommended]) {
            const page = await works.list(
              admin.id,
              Object.assign(new WorkQueryDto(), { authorId: author.id, view }),
            );
            assert.equal(page.total, 0);
            assert.equal(page.items.length, 0);
          }
          const recommendations = await works.list(
            translator.id,
            Object.assign(new WorkQueryDto(), {
              authorId: author.id,
              view: WorkView.recommended,
              claimStage: "translate",
            }),
          );
          assert.deepEqual(
            recommendations.items.map(({ id }) => id),
            [pending.id],
          );
          await assert.rejects(
            works.claimStage(admin.id, pending.id, {
              stage: "translate",
              expectedRevision: pending.revision,
              idempotencyKey: randomUUID(),
            }),
            ForbiddenException,
          );
          throw rollback;
        },
        { timeout: 30000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
