import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import type { ContentSourceClient } from "../../src/source-ingestion/content-source.js";
import type {
  SourceRunPageDto,
  SourceRunSummaryDto,
  SourceTaskDetailDto,
  SourceTaskPageDto,
  SourceExecutionPageDto,
  SourceGapPageDto,
} from "../../src/source-ingestion/source-history.dto.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

test("source history HTTP reads bounded summaries and task pages without writes, credentials or historical recovery invention", async () => {
  const app = await createApplication(
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      OBJECT_STORAGE_DRIVER: "memory",
    }),
  );
  const db = app.get(PrismaService);
  const prefix = `history_${randomUUID()}`;
  app
    .get(ContentSourceRegistry)
    .register({
      platform: "x",
      adapterKey: `${prefix}_adapter`,
      available: true,
      priority: 1,
      metered: false,
      supportedFirstSyncModes: ["none"],
      allowedMediaHosts: [],
      initialCursor: () => ({}),
      checkAccount: async (account) => account,
      fetchPage: async () => {
        throw new Error("History GET must never call a source");
      },
    } as ContentSourceClient)
    .register({
      platform: "x",
      adapterKey: `${prefix}_unavailable`,
      available: false,
      priority: 2,
      metered: false,
      supportedFirstSyncModes: ["none"],
      allowedMediaHosts: [],
      initialCursor: () => ({}),
      checkAccount: async (account) => account,
      fetchPage: async () => {
        throw new Error("History GET must never call a source");
      },
    } as ContentSourceClient);
  const runIds = Array.from({ length: 14 }, () => randomUUID());
  const authorIds = Array.from({ length: 400 }, () => randomUUID());
  const accountIds = Array.from({ length: 400 }, () => randomUUID());
  const taskIds = Array.from({ length: 400 }, () => randomUUID());
  const adapterIds = Array.from({ length: 400 }, () => randomUUID());
  const executionIds: string[] = Array.from({ length: 24 }, () => randomUUID());
  const userIds: string[] = [];
  const jobId = randomUUID();
  const origin = new Date("2199-11-10T12:00:00Z");
  let base = "";
  async function request<T>(
    cookie: string,
    path: string,
    method = "GET",
    body?: object,
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: (await response.json()) as T,
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  }
  async function login(role: "admin" | "source" | "reviewer") {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${role}`,
        displayName: role,
        passwordHash: await hashPassword("synthetic-password-12345"),
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    userIds.push(user.id);
    const result = await request("", "/auth/login", "POST", {
      username: user.username,
      password: "synthetic-password-12345",
    });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  async function state() {
    return {
      runs: await db.sourceFetchRun.findMany({
        where: { id: { in: runIds } },
        orderBy: { id: "asc" },
      }),
      tasks: await db.sourceFetchAccountTask.findMany({
        where: { runId: { in: runIds } },
        orderBy: { id: "asc" },
      }),
      items: await db.sourceFetchRunItem.findMany({
        where: { runId: { in: runIds } },
        orderBy: { id: "asc" },
      }),
      jobs: await db.backgroundJob.findMany({ where: { id: jobId } }),
      gaps: await db.sourceDiscoveryPost.findMany({
        where: { accountId: { in: accountIds } },
        orderBy: { id: "asc" },
      }),
      executions: await db.sourcePlatformExecution.findMany({
        where: { id: { in: executionIds } },
        orderBy: { id: "asc" },
      }),
      campaigns: await db.sourceRecoveryCampaign.findMany({
        where: { discoveryPost: { accountId: { in: accountIds } } },
        orderBy: { id: "asc" },
      }),
    };
  }
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    await db.author.createMany({
      data: authorIds.map((id, i) => ({
        id,
        displayName: `${prefix} Author ${String(i).padStart(3, "0")}`,
        authorizationStatus: "authorized" as const,
      })),
    });
    await db.authorExternalAccount.createMany({
      data: accountIds.map((id, i) => ({
        id,
        authorId: authorIds[i],
        platform: i % 2 ? "pixiv" : "x",
        externalUserId: `${prefix}_${i}`,
        handle: `needle_${String(i).padStart(3, "0")}`,
        notes: "private account note",
        metadataJson: { cookie: "must-not-leak" },
        ...(i === 398 ? { deletedAt: origin } : {}),
      })),
    });
    await db.sourceAdapterState.createMany({
      data: adapterIds.map((id, i) => ({
        id,
        externalAccountId: accountIds[i],
        adapterKey: `${prefix}_adapter`,
        health: "healthy" as const,
        cursorJson: { token: "must-not-leak" },
      })),
    });
    await db.sourceAdapterState.createMany({
      data: [
        {
          externalAccountId: accountIds[398],
          adapterKey: "x_web_session",
          enabled: true,
          health: "unavailable",
        },
        {
          externalAccountId: accountIds[398],
          adapterKey: "x_official_v2",
          enabled: true,
          health: "unavailable",
        },
        {
          externalAccountId: accountIds[398],
          adapterKey: `${prefix}_unavailable`,
          enabled: true,
          health: "unavailable",
        },
      ],
    });
    await db.sourceFetchRun.createMany({
      data: runIds.map((id, i) => ({
        id,
        trigger: "manual" as const,
        status: i === 0 ? ("running" as const) : ("succeeded" as const),
        startedAt: new Date(origin.getTime() - i * 60_000),
        completedAt: i === 0 ? null : origin,
      })),
    });
    await db.backgroundJob.create({
      data: {
        id: jobId,
        kind: "source_account_fetch",
        resourceId: taskIds[399],
        idempotencyKey: `${prefix}:waiting`,
        status: "queued",
        attempts: 0,
        availableAt: new Date(origin.getTime() + 60_000),
        payload: { token: "must-not-leak" },
        lastError: "Cookie: must-not-leak",
      },
    });
    await db.sourceFetchAccountTask.createMany({
      data: taskIds.map((id, i) => ({
        id,
        runId: runIds[0],
        accountId: accountIds[i],
        platform: i % 2 ? "pixiv" : "x",
        status:
          i === 399
            ? ("waiting" as const)
            : i === 398
              ? ("failed" as const)
              : ("succeeded" as const),
        failureCode:
          i === 1
            ? "discovery_gaps"
            : i === 398
              ? "network_error"
              : i === 399
                ? "platform_auth_paused"
                : null,
        credentialGeneration: "private-fingerprint",
        startedAt: origin,
        completedAt: i === 399 ? null : origin,
        ...(i === 399
          ? { jobId, deferredUntil: new Date(origin.getTime() + 60_000) }
          : {}),
      })),
    });
    await db.sourceFetchRunItem.createMany({
      data: accountIds.map((externalAccountId, i) => ({
        runId: runIds[0],
        externalAccountId,
        adapterStateId: adapterIds[i],
        adapterKey: `${prefix}_adapter`,
        status: "succeeded" as const,
        cursorBefore: { secret: "must-not-leak" },
        cursorAfter: { url: "https://private.invalid/?token=must-not-leak" },
        pagesFetched: 1,
        candidatesCreated: 1,
        mediaStored: 2,
        errorMessage: "Cookie: must-not-leak",
        startedAt: origin,
        completedAt: origin,
      })),
    });
    const legacy = await db.sourceFetchRunItem.create({
      data: {
        runId: runIds[13],
        externalAccountId: accountIds[398],
        adapterStateId: adapterIds[398],
        adapterKey: `${prefix}_legacy`,
        status: "failed",
        cursorBefore: { token: "must-not-leak" },
        errorCode: "network_error",
        errorMessage: "https://private.invalid/?token=must-not-leak",
        startedAt: origin,
        completedAt: origin,
      },
    });
    // Two later tasks: the gap-bearing success must never count as a true success.
    await db.sourceFetchRun.update({
      where: { id: runIds[11] },
      data: { startedAt: new Date(origin.getTime() + 60_000) },
    });
    await db.sourceFetchRun.update({
      where: { id: runIds[12] },
      data: { startedAt: new Date(origin.getTime() + 120_000) },
    });
    const success = await db.sourceFetchAccountTask.create({
      data: {
        runId: runIds[11],
        accountId: accountIds[398],
        platform: "x",
        status: "succeeded",
        completedAt: new Date(origin.getTime() + 60_000),
      },
    });
    await db.sourceFetchAccountTask.create({
      data: {
        runId: runIds[12],
        accountId: accountIds[398],
        platform: "x",
        status: "succeeded",
        failureCode: "discovery_gaps",
        completedAt: new Date(origin.getTime() + 120_000),
      },
    });
    await db.sourceDiscoveryPost.createMany({
      data: ["media_pending", "complete", "excluded"].map((state, i) => ({
        accountId: accountIds[398],
        platform: "x",
        externalPostId: `${prefix}_gap_${i}`,
        sourceUserId: `${prefix}_398`,
        adapterKey: `${prefix}_adapter`,
        discoveredRunId: runIds[13],
        windowJson: {},
        evidenceJson: { token: "must-not-leak" },
        state,
      })),
    });
    const gap = await db.sourceDiscoveryPost.findFirstOrThrow({
      where: { accountId: accountIds[398], state: "media_pending" },
    });
    await db.sourceRecoveryCampaign.createMany({
      data: [
        {
          discoveryPostId: gap.id,
          number: 1,
          state: "failed",
          failureCode: "network_error",
          startedAt: origin,
          completedAt: origin,
        },
        {
          discoveryPostId: gap.id,
          number: 2,
          state: "running",
          startedAt: origin,
        },
      ],
    });
    await db.sourceDiscoveryPost.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        accountId: accountIds[397],
        platform: "pixiv",
        externalPostId: `${prefix}_extra_gap_${i}`,
        sourceUserId: `${prefix}_397`,
        adapterKey: `${prefix}_adapter`,
        discoveredRunId: runIds[13],
        windowJson: {},
        state: "media_pending",
        createdAt: origin,
      })),
    });
    await db.sourcePlatformExecution.createMany({
      data: executionIds.map((id, i) => ({
        id,
        platform: "x",
        kind: i === 22 ? "recovery" : "scan",
        ownerId: randomUUID(),
        jobId: randomUUID(),
        leaseId: randomUUID(),
        taskId: i === 23 ? taskIds[397] : taskIds[398],
        credentialGeneration: "private-fingerprint",
        budgetAttempt: (i % 3) + 1,
        budgetRefunded: i % 2 === 0,
        admittedAt: origin,
        businessOutcome: "failed",
        businessFinishedAt: origin,
        settledAt: i % 2 === 0 ? origin : null,
        diagnosticJson: {
          samples: [
            {
              stage: "download",
              reason: "network_error",
              scope: "transport",
              occurredAt: origin.toISOString(),
              httpStatus: 503,
              exceptionType: "HttpError",
              transportError: "tls_unexpected_eof",
              runtimeVersion: "1.32.11",
              durationMs: 20000,
              timeout: true,
              traceback: "Cookie: must-not-leak",
              response_excerpt: "https://private.invalid/",
            },
          ],
          omitted: 1,
          token: "must-not-leak",
        },
      })),
    });
    const admin = await login("admin"),
      source = await login("source"),
      reviewer = await login("reviewer");
    const before = await state();
    for (const cookie of [source, reviewer]) {
      for (const path of [
        "/source-fetch/runs",
        `/source-fetch/runs/${runIds[0]}`,
        `/source-fetch/runs/${runIds[0]}/tasks`,
        `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}`,
        `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/executions`,
        `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/gaps`,
      ])
        assert.equal((await request(cookie, path)).status, 403);
    }
    const page = await request<SourceRunPageDto>(admin, "/source-fetch/runs");
    assert.equal(page.status, 200);
    assert.equal(page.data.items.length, 10);
    assert.ok(page.data.nextCursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page.data)) < 15_000);
    for (const row of page.data.items) {
      assert.equal("items" in row, false);
      assert.equal("attempts" in row, false);
    }
    const next = await request<SourceRunPageDto>(
      admin,
      `/source-fetch/runs?cursor=${encodeURIComponent(page.data.nextCursor!)}`,
    );
    assert.equal(next.status, 200);
    assert.ok(
      next.data.items.every(
        (row) => !page.data.items.some((first) => first.id === row.id),
      ),
    );
    const run = await request<SourceRunSummaryDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}`,
    );
    assert.equal(run.status, 200);
    assert.equal(run.data.targetCount, 400);
    assert.equal(run.data.completedTargets, 399);
    assert.equal(run.data.succeededTargets, 397);
    assert.equal(run.data.failedTargets, 1);
    assert.equal(run.data.waitingTargets, 1);
    assert.equal(run.data.anomalyTargets, 2);
    assert.equal(run.data.pagesFetched, 400);
    assert.equal(run.data.candidatesCreated, 400);
    assert.equal(run.data.mediaStored, 800);
    const tasks = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks`,
    );
    assert.equal(tasks.status, 200);
    assert.equal(tasks.data.items.length, 20);
    assert.ok(tasks.data.nextCursor);
    assert.equal(tasks.data.legacy, false);
    const tasks2 = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks?cursor=${encodeURIComponent(tasks.data.nextCursor!)}`,
    );
    assert.equal(tasks2.status, 200);
    assert.equal(tasks2.data.items.length, 20);
    assert.ok(
      tasks2.data.items.every(
        (row) => !tasks.data.items.some((first) => first.id === row.id),
      ),
    );
    const active = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks?status=active`,
    );
    assert.equal(active.status, 200);
    assert.equal(active.data.items.length, 1);
    assert.equal(active.data.items[0].status, "waiting");
    const anomalies = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks?status=anomalies`,
    );
    assert.equal(anomalies.status, 200);
    assert.equal(anomalies.data.items.length, 2);
    const searched = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks?search=needle_398&platform=x`,
    );
    assert.equal(searched.status, 200);
    assert.equal(searched.data.items.length, 1);
    assert.equal(searched.data.items[0].accountId, accountIds[398]);
    const literalSearch = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks?search=${encodeURIComponent("%_")}`,
    );
    assert.equal(literalSearch.status, 200);
    assert.equal(literalSearch.data.items.length, 0);
    const detail = await request<SourceTaskDetailDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.data.original.status, "failed");
    assert.equal(detail.data.followupSuccess?.taskId, success.id);
    assert.equal(detail.data.current?.adapterHealth, "healthy");
    assert.equal(detail.data.current?.unresolvedGapCount, 1);
    assert.equal(detail.data.current?.excludedGapCount, 1);
    assert.ok(detail.data.current?.deletedAt);
    assert.equal(detail.data.executionHistoryAvailable, true);
    const executions = await request<SourceExecutionPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/executions`,
    );
    assert.equal(executions.status, 200);
    assert.equal(executions.data.scope, "scan");
    assert.equal(executions.data.legacy, false);
    assert.equal(executions.data.items.length, 20);
    assert.ok(executions.data.nextCursor);
    assert.ok(
      executions.data.items.every(
        (item) => item.kind === "scan" && executionIds.indexOf(item.id) < 22,
      ),
    );
    assert.equal(
      executions.data.items[0].diagnostics.samples[0].httpStatus,
      503,
    );
    assert.equal(
      executions.data.items[0].diagnostics.samples[0].durationMs,
      20000,
    );
    assert.equal(executions.data.items[0].diagnostics.samples[0].timeout, true);
    assert.equal(
      executions.data.items[0].diagnostics.samples[0].transportError,
      "tls_unexpected_eof",
    );
    assert.equal(
      executions.data.items[0].diagnostics.samples[0].exceptionType,
      "HttpError",
    );
    const executions2 = await request<SourceExecutionPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/executions?cursor=${encodeURIComponent(executions.data.nextCursor!)}`,
    );
    assert.equal(executions2.status, 200);
    assert.equal(executions2.data.items.length, 2);
    assert.equal(executions2.data.nextCursor, null);
    assert.ok(
      executions2.data.items.every(
        (item) => !executions.data.items.some((first) => first.id === item.id),
      ),
    );
    const gaps = await request<SourceGapPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/gaps`,
    );
    assert.equal(gaps.status, 200);
    assert.equal(gaps.data.scope, "current_account");
    assert.equal(gaps.data.items.length, 1);
    assert.equal(gaps.data.items[0].id, gap.id);
    assert.equal(gaps.data.items[0].campaign?.number, 2);
    assert.equal(gaps.data.items[0].campaign?.state, "running");
    const gapsPage = await request<SourceGapPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[397]}/gaps`,
    );
    assert.equal(gapsPage.status, 200);
    assert.equal(gapsPage.data.items.length, 20);
    assert.ok(gapsPage.data.nextCursor);
    const gapsPage2 = await request<SourceGapPageDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[397]}/gaps?cursor=${encodeURIComponent(gapsPage.data.nextCursor!)}`,
    );
    assert.equal(gapsPage2.status, 200);
    assert.equal(gapsPage2.data.items.length, 5);
    assert.equal(gapsPage2.data.nextCursor, null);
    assert.ok(
      gapsPage2.data.items.every(
        (item) => !gapsPage.data.items.some((first) => first.id === item.id),
      ),
    );
    for (const suffix of ["executions", "gaps"]) {
      assert.equal(
        (
          await request(
            admin,
            `/source-fetch/runs/${runIds[1]}/tasks/${taskIds[398]}/${suffix}`,
          )
        ).status,
        404,
      );
      for (const query of [
        "limit=0",
        "limit=101",
        "cursor=invalid",
        "unexpected=1",
      ])
        assert.equal(
          (
            await request(
              admin,
              `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}/${suffix}?${query}`,
            )
          ).status,
          400,
        );
    }
    const old = await request<SourceTaskPageDto>(
      admin,
      `/source-fetch/runs/${runIds[13]}/tasks`,
    );
    assert.equal(old.status, 200);
    assert.equal(old.data.legacy, true);
    assert.equal(old.data.items[0].id, legacy.id);
    const oldDetail = await request<SourceTaskDetailDto>(
      admin,
      `/source-fetch/runs/${runIds[13]}/tasks/${legacy.id}`,
    );
    assert.equal(oldDetail.status, 200);
    assert.equal(oldDetail.data.original.legacy, true);
    assert.equal(oldDetail.data.executionHistoryAvailable, false);
    const oldExecutions = await request<SourceExecutionPageDto>(
      admin,
      `/source-fetch/runs/${runIds[13]}/tasks/${legacy.id}/executions`,
    );
    assert.equal(oldExecutions.status, 200);
    assert.equal(oldExecutions.data.legacy, true);
    assert.deepEqual(oldExecutions.data.items, []);
    const oldGaps = await request<SourceGapPageDto>(
      admin,
      `/source-fetch/runs/${runIds[13]}/tasks/${legacy.id}/gaps`,
    );
    assert.equal(oldGaps.status, 200);
    assert.equal(oldGaps.data.legacy, true);
    assert.equal(oldGaps.data.scope, "current_account");
    assert.equal(oldGaps.data.items[0].id, gap.id);
    assert.equal(
      (
        await request(
          admin,
          `/source-fetch/runs/${runIds[1]}/tasks/${taskIds[398]}`,
        )
      ).status,
      404,
    );
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "cursor=invalid",
      "status=secret",
      "search=" + "x".repeat(101),
      "unexpected=1",
    ])
      assert.equal(
        (await request(admin, `/source-fetch/runs/${runIds[0]}/tasks?${query}`))
          .status,
        400,
        query,
      );
    for (const query of [
      "limit=0",
      "limit=51",
      "cursor=invalid",
      "trigger=secret",
      "status=secret",
    ])
      assert.equal(
        (await request(admin, `/source-fetch/runs?${query}`)).status,
        400,
        query,
      );
    const safeJson = JSON.stringify([
      page.data,
      run.data,
      tasks.data,
      detail.data,
      old.data,
      oldDetail.data,
      executions.data,
      executions2.data,
      gaps.data,
      gapsPage.data,
    ]);
    for (const forbidden of [
      "must-not-leak",
      "private-fingerprint",
      "private.invalid",
      "cursorBefore",
      "errorMessage",
      "metadataJson",
      "evidenceJson",
      "credentialGeneration",
      "ownerId",
      "leaseId",
      "jobId",
      "traceback",
      "response_excerpt",
    ])
      assert.equal(safeJson.includes(forbidden), false, forbidden);
    assert.deepEqual(await state(), before);
    // Current runtime state selection is independent of the original failure.
    await db.sourceAdapterState.update({
      where: { id: adapterIds[398] },
      data: { enabled: false },
    });
    const disabled = await request<SourceTaskDetailDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}`,
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.current?.adapterHealth, null);
    assert.equal(disabled.data.original.failureCode, "network_error");
    await db.sourceAdapterState.update({
      where: { id: adapterIds[398] },
      data: { enabled: true, health: "unavailable" },
    });
    const staleHealth = await request<SourceTaskDetailDto>(
      admin,
      `/source-fetch/runs/${runIds[0]}/tasks/${taskIds[398]}`,
    );
    assert.equal(staleHealth.status, 200);
    assert.equal(staleHealth.data.current?.adapterHealth, "idle");
  } finally {
    await db.sourcePlatformExecution.deleteMany({
      where: { id: { in: executionIds } },
    });
    await db.sourceRecoveryCampaign.deleteMany({
      where: { discoveryPost: { accountId: { in: accountIds } } },
    });
    await db.sourceFetchAccountTask.deleteMany({
      where: { runId: { in: runIds } },
    });
    await db.sourceFetchRunItem.deleteMany({
      where: { runId: { in: runIds } },
    });
    await db.sourceFetchRun.deleteMany({ where: { id: { in: runIds } } });
    await db.sourceDiscoveryPost.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await db.sourceAdapterState.deleteMany({
      where: { externalAccountId: { in: accountIds } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
    await db.author.deleteMany({ where: { id: { in: authorIds } } });
    await db.backgroundJob.deleteMany({ where: { id: jobId } });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
