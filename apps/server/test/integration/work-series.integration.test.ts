import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  WorkSeriesService,
  normalizeWorkSeriesImportIntent,
} from "../../src/work-series/work-series.service.js";
import type { Actor } from "../../src/common/access.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { CandidateAction } from "../../src/candidates/candidates.dto.js";
import { createApplication } from "../../src/application.js";

loadRootEnvironment();

async function fixture() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Isolated TEST_DATABASE_URL ending in _test required");
  const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
  const db = new PrismaService(environment);
  await db.$connect();
  const users: string[] = [],
    authors: string[] = [],
    files: string[] = [];
  const service = new WorkSeriesService(db, environment);
  async function actor(
    role: "source" | "admin" | "translator" = "source",
  ): Promise<Actor & { token: string }> {
    const user = await db.user.create({
      data: {
        username: `series_${randomUUID()}`,
        displayName: "Synthetic series actor",
        passwordHash: "disabled",
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    users.push(user.id);
    const token = randomBytes(32).toString("base64url");
    const session = await db.authSession.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { userId: user.id, sessionId: session.id, token };
  }
  async function author() {
    const result = await db.author.create({
      data: {
        displayName: "Synthetic series author",
        authorizationStatus: "authorized",
      },
    });
    authors.push(result.id);
    return result;
  }
  async function work(
    authorId: string,
    actorId: string,
    data: Partial<Prisma.WorkUncheckedCreateInput> = {},
  ) {
    const candidate = await db.candidatePost.create({
      data: {
        authorId,
        platform: "series-fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: { synthetic: true },
        status: "imported",
      },
    });
    return db.work.create({
      data: {
        authorId,
        importedById: actorId,
        sourceCandidatePostId: candidate.id,
        ...data,
      },
    });
  }
  async function pendingCandidate(authorId: string, actorId: string) {
    const post = await db.candidatePost.create({
      data: {
        authorId,
        platform: "series-fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: { synthetic: true },
      },
    });
    const file = await db.fileObject.create({
      data: {
        objectKey: `synthetic-series/${randomUUID()}`,
        bucketScope: "source",
        kind: "source",
        contentType: "image/png",
        size: 10n,
        checksum: "0".repeat(64),
        createdById: actorId,
      },
    });
    files.push(file.id);
    await db.candidateMedia.create({
      data: {
        candidatePostId: post.id,
        fileObjectId: file.id,
        orderIndex: 0,
        externalMediaId: randomUUID(),
        mediaType: "image",
      },
    });
    return post;
  }
  return {
    db,
    environment,
    service,
    actor,
    author,
    work,
    pendingCandidate,
    async close() {
      const series = { authorId: { in: authors } },
        works = { authorId: { in: authors } };
      await db.workSeriesEntry.deleteMany({ where: { series } });
      await db.workSeriesAudit.deleteMany({ where: { series } });
      await db.workSeriesMutationReceipt.deleteMany({
        where: { actorId: { in: users } },
      });
      await db.workSeries.deleteMany({ where: series });
      await db.candidateActionLog.deleteMany({
        where: { candidatePost: { authorId: { in: authors } } },
      });
      await db.workEvent.deleteMany({ where: { work: works } });
      await db.work.deleteMany({ where: works });
      await db.candidatePost.deleteMany({
        where: { authorId: { in: authors } },
      });
      await db.fileObject.deleteMany({ where: { id: { in: files } } });
      await db.author.deleteMany({ where: { id: { in: authors } } });
      await db.authSession.deleteMany({ where: { userId: { in: users } } });
      await db.userRole.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    },
  };
}

test("series membership is author-scoped, revision checked and independent from work editors/events", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      other = await f.actor(),
      author = await f.author(),
      foreign = await f.author();
    const [a, b, c, wrong] = await Promise.all([
      f.work(author.id, actor.userId, { workflowStatus: "published" }),
      f.work(author.id, actor.userId),
      f.work(author.id, actor.userId),
      f.work(foreign.id, actor.userId),
    ]);
    const request = {
      authorId: author.id,
      title: "Synthetic series",
      workIds: [a.id, b.id],
      requestId: randomUUID(),
    };
    const created = await f.service.create(actor, request);
    assert.equal(created.memberCount, 2);
    assert.deepEqual(
      await f.service.create(actor, request),
      created,
      "lost-response retry returns frozen success",
    );
    await assert.rejects(
      f.service.create(actor, { ...request, title: "Changed intent" }),
      /保存标识/,
    );
    assert.equal(
      await f.db.workSeries.count({ where: { authorId: author.id } }),
      1,
    );
    let detail = await f.service.detail(created.id, {});
    const first = detail.entries[0],
      second = detail.entries[1];
    const moved = await f.service.updateEntry(actor, created.id, second.id, {
      expectedRevision: 0,
      requestId: randomUUID(),
      label: "Part B",
      afterEntryId: null,
    });
    assert.equal(moved.revision, 1);
    await assert.rejects(
      f.service.add(actor, created.id, {
        workIds: [c.id],
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /已更新/,
    );
    await assert.rejects(
      f.service.add(actor, created.id, {
        workIds: [wrong.id],
        expectedRevision: 1,
        requestId: randomUUID(),
      }),
      /同一作者/,
    );
    const added = await f.service.add(actor, created.id, {
      workIds: [c.id],
      afterEntryId: second.id,
      expectedRevision: 1,
      requestId: randomUUID(),
    });
    detail = await f.service.detail(created.id, {});
    assert.deepEqual(
      detail.entries.map((entry) => entry.workId),
      [b.id, c.id, a.id],
    );
    assert.equal(detail.entries[0].label, "Part B");
    const alternative = await f.service.create(other, {
      authorId: author.id,
      title: "Alternative",
      requestId: randomUUID(),
    });
    await assert.rejects(
      f.service.add(other, alternative.id, {
        workIds: [a.id],
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /其他系列/,
    );
    const removedRequest = {
      expectedRevision: added.revision,
      requestId: randomUUID(),
    };
    const removed = await f.service.remove(
      actor,
      created.id,
      first.id,
      removedRequest,
    );
    assert.deepEqual(
      await f.service.remove(actor, created.id, first.id, removedRequest),
      removed,
    );
    assert.equal(removed.memberCount, 2);
    assert.equal(
      (await f.db.work.findUniqueOrThrow({ where: { id: a.id } })).editorEpoch,
      0,
    );
    assert.equal(
      (await f.db.work.findUniqueOrThrow({ where: { id: b.id } })).revision,
      0,
    );
    assert.equal(
      await f.db.workEvent.count({
        where: { workId: { in: [a.id, b.id, c.id] } },
      }),
      0,
    );
    assert.equal(
      await f.db.workSeriesAudit.count({ where: { seriesId: created.id } }),
      4,
    );
  } finally {
    await f.close();
  }
});

test("series HTTP routes enforce reads/writes, UUID paths, bounded payloads and explicit anchor-null moves", async () => {
  const f = await fixture();
  const app = await createApplication(f.environment);
  try {
    await app.listen(0, "127.0.0.1");
    const source = await f.actor(),
      reader = await f.actor("translator"),
      author = await f.author();
    const a = await f.work(author.id, source.userId),
      b = await f.work(author.id, source.userId);
    async function request(
      token: string,
      method: string,
      path: string,
      body?: object,
    ) {
      const response = await fetch(`${await app.getUrl()}/api${path}`, {
        method,
        headers: {
          Origin: f.environment.appOrigin,
          "X-Comiku-Request": "1",
          Cookie: `comiku_session=${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        data: (await response.json()) as Record<string, unknown>,
      };
    }
    const input = {
      authorId: author.id,
      title: "HTTP synthetic",
      workIds: [a.id, b.id],
      requestId: randomUUID(),
    };
    assert.equal(
      (await request(reader.token, "POST", "/work-series", input)).status,
      403,
    );
    const created = await request(source.token, "POST", "/work-series", input);
    assert.equal(created.status, 201);
    const id = created.data.id as string;
    assert.equal(
      (
        await request(
          reader.token,
          "GET",
          `/work-series?authorId=${author.id}&limit=1`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          reader.token,
          "GET",
          `/work-series/${id}?includeHistory=true`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request(reader.token, "GET", `/work-series/work/${a.id}/context`))
        .status,
      200,
    );
    assert.equal(
      (await request(reader.token, "GET", "/work-series/not-a-uuid")).status,
      400,
    );
    assert.equal(
      (await request(reader.token, "GET", "/work-series?limit=51")).status,
      400,
    );
    const detail = await f.service.detail(id, {});
    const entry = detail.entries[1];
    assert.equal(
      (
        await request(
          source.token,
          "PATCH",
          `/work-series/${id}/entries/${entry.id}`,
          { requestId: randomUUID(), label: "No revision" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          source.token,
          "PATCH",
          `/work-series/${id}/entries/${entry.id}`,
          {
            requestId: randomUUID(),
            expectedRevision: 0,
            afterEntryId: null,
            label: "Second first",
          },
        )
      ).status,
      200,
    );
    assert.equal((await f.service.detail(id, {})).entries[0].workId, b.id);
  } finally {
    await app.close();
    await f.close();
  }
});

test("candidate import and series attach commit atomically, and replay never checks later revision or restores removed membership", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      author = await f.author();
    const candidates = new CandidatesService(
      f.db,
      {} as never,
      undefined,
      undefined,
      f.service,
    );
    const post = await f.pendingCandidate(author.id, actor.userId);
    const intent = {
      createTitle: "Synthetic imported",
      requestId: randomUUID(),
      label: "One",
    };
    const request = {
      action: CandidateAction.import,
      items: [{ id: post.id, expectedRevision: post.revision, series: intent }],
    };
    const result = (await candidates.batch(actor.userId, request, actor))
      .results[0];
    assert.equal(result.outcome, "succeeded");
    assert.ok(result.workId);
    const context = await f.service.context(result.workId!);
    assert.equal(context.series?.memberCount, 1);
    assert.equal(context.currentEntry?.label, "One");
    assert.deepEqual(
      (await candidates.batch(actor.userId, request, actor)).results[0],
      { ...result, outcome: "unchanged" },
    );
    await f.service.remove(
      actor,
      context.series!.id,
      context.currentEntry!.id,
      { expectedRevision: context.series!.revision, requestId: randomUUID() },
    );
    const replay = (await candidates.batch(actor.userId, request, actor))
      .results[0];
    assert.equal(replay.outcome, "unchanged");
    assert.equal(replay.workId, result.workId);
    assert.equal(
      (await f.service.context(result.workId!)).series,
      null,
      "replay keeps the original intent without restoring membership",
    );
    const changed = (
      await candidates.batch(
        actor.userId,
        {
          ...request,
          items: [
            { ...request.items[0], series: { ...intent, label: "Changed" } },
          ],
        },
        actor,
      )
    ).results[0];
    assert.equal(changed.outcome, "conflict");
    const target = await f.service.create(actor, {
      authorId: author.id,
      title: "Target",
      requestId: randomUUID(),
    });
    await f.service.update(actor, target.id, {
      title: "Target changed",
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    const second = await f.pendingCandidate(author.id, actor.userId);
    const failed = (
      await candidates.batch(
        actor.userId,
        {
          action: CandidateAction.import,
          items: [
            {
              id: second.id,
              expectedRevision: 0,
              series: { seriesId: target.id, expectedRevision: 0 },
            },
          ],
        },
        actor,
      )
    ).results[0];
    assert.equal(failed.outcome, "conflict");
    assert.equal(
      (await f.db.candidatePost.findUniqueOrThrow({ where: { id: second.id } }))
        .status,
      "pending",
    );
    assert.equal(
      await f.db.work.count({ where: { sourceCandidatePostId: second.id } }),
      0,
    );
    assert.equal(
      await f.db.workEvent.count({ where: { workId: result.workId! } }),
      1,
      "only the import WorkEvent exists",
    );
    const third = await f.pendingCandidate(author.id, actor.userId);
    const stable = {
      action: CandidateAction.import,
      items: [
        {
          id: third.id,
          expectedRevision: 0,
          series: { seriesId: target.id, expectedRevision: 1 },
        },
      ],
    };
    const concurrent = await Promise.all([
      candidates.batch(actor.userId, stable, actor),
      candidates.batch(actor.userId, stable, actor),
    ]);
    assert.deepEqual(
      concurrent
        .flatMap((entry) => entry.results.map((item) => item.outcome))
        .sort(),
      ["succeeded", "unchanged"],
    );
    assert.equal((await f.service.detail(target.id, {})).memberCount, 1);
  } finally {
    await f.close();
  }
});

test("candidate series import rechecks revoked, expired and foreign sessions before creating any work or directory", async () => {
  const f = await fixture();
  try {
    const source = await f.actor(),
      other = await f.actor(),
      author = await f.author();
    const candidates = new CandidatesService(
      f.db,
      {} as never,
      undefined,
      undefined,
      f.service,
    );
    const post = await f.pendingCandidate(author.id, source.userId);
    const request = {
      action: CandidateAction.import,
      items: [
        {
          id: post.id,
          expectedRevision: post.revision,
          series: { createTitle: "Rejected session", requestId: randomUUID() },
        },
      ],
    };
    await f.db.authSession.update({
      where: { id: source.sessionId },
      data: { revokedAt: new Date() },
    });
    const revoked = (await candidates.batch(source.userId, request, source))
      .results[0];
    assert.equal(revoked.outcome, "failed");
    await f.db.authSession.update({
      where: { id: source.sessionId },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = (await candidates.batch(source.userId, request, source))
      .results[0];
    assert.equal(expired.outcome, "failed");
    await f.db.authSession.update({
      where: { id: source.sessionId },
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(Date.now() - 3_600_000),
      },
    });
    const idleExpired = (await candidates.batch(source.userId, request, source))
      .results[0];
    assert.equal(idleExpired.outcome, "failed");
    const foreign = (await candidates.batch(source.userId, request, other))
      .results[0];
    assert.equal(foreign.outcome, "failed");
    const missing = (await candidates.batch(source.userId, request)).results[0];
    assert.equal(missing.outcome, "failed");
    await f.db.authSession.update({
      where: { id: source.sessionId },
      data: { lastSeenAt: new Date() },
    });
    await f.db.userRole.deleteMany({ where: { userId: source.userId } });
    await f.db.userRole.create({
      data: { userId: source.userId, role: "operator" },
    });
    const operator = (await candidates.batch(source.userId, request, source))
      .results[0];
    assert.equal(
      operator.outcome,
      "failed",
      "metadata permission alone cannot import a candidate",
    );
    assert.equal(
      (await f.db.candidatePost.findUniqueOrThrow({ where: { id: post.id } }))
        .status,
      "pending",
    );
    assert.equal(
      await f.db.work.count({ where: { sourceCandidatePostId: post.id } }),
      0,
    );
    assert.equal(
      await f.db.workSeries.count({ where: { authorId: author.id } }),
      0,
    );
    assert.equal(
      await f.db.workSeriesEntry.count({
        where: { work: { authorId: author.id } },
      }),
      0,
    );
    assert.equal(
      await f.db.workSeriesAudit.count({ where: { actorId: source.userId } }),
      0,
    );
    assert.equal(
      await f.db.workSeriesMutationReceipt.count({
        where: { actorId: source.userId },
      }),
      0,
    );
  } finally {
    await f.close();
  }
});

test("series navigation retains archived membership, hides it by default, and fences history correction/admin revocation", async () => {
  const f = await fixture();
  try {
    const source = await f.actor(),
      admin = await f.actor("admin"),
      reader = await f.actor("translator"),
      author = await f.author();
    const a = await f.work(author.id, source.userId),
      b = await f.work(author.id, source.userId),
      c = await f.work(author.id, source.userId);
    const series = await f.service.create(source, {
      authorId: author.id,
      title: "History",
      workIds: [a.id, b.id, c.id],
      requestId: randomUUID(),
    });
    await f.db.work.update({
      where: { id: b.id },
      data: { workflowStatus: "archived" },
    });
    const detail = await f.service.detail(series.id, {});
    assert.equal(detail.memberCount, 3);
    assert.equal(detail.visibleTotal, 2);
    assert.equal(
      (await f.service.detail(series.id, { includeHistory: true })).entries
        .length,
      3,
    );
    assert.equal((await f.service.context(a.id)).next?.workId, c.id);
    assert.equal((await f.service.context(a.id, true)).next?.workId, b.id);
    assert.equal((await f.service.context(b.id)).currentEntry?.archived, true);
    const hiddenEntry = (await f.service.context(b.id)).currentEntry!;
    await assert.rejects(
      f.service.remove(source, series.id, hiddenEntry.id, {
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /管理员/,
    );
    await assert.rejects(
      f.service.update(reader, series.id, {
        title: "No",
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /权限/,
    );
    await f.db.userRole.deleteMany({ where: { userId: source.userId } });
    await assert.rejects(
      f.service.update(source, series.id, {
        title: "Revoked",
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /权限/,
    );
    await f.service.remove(admin, series.id, hiddenEntry.id, {
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    assert.equal(
      (await f.service.detail(series.id, { includeHistory: true })).memberCount,
      2,
    );
  } finally {
    await f.close();
  }
});

test("series keyset pages bind filters/revision and concurrent target series cannot steal the same work", async () => {
  const f = await fixture();
  try {
    const a = await f.actor(),
      b = await f.actor(),
      author = await f.author();
    const [w1, w2, w3] = await Promise.all([
      f.work(author.id, a.userId),
      f.work(author.id, a.userId),
      f.work(author.id, a.userId),
    ]);
    const s1 = await f.service.create(a, {
      authorId: author.id,
      title: "First",
      workIds: [w1.id, w2.id],
      requestId: randomUUID(),
    });
    const s2 = await f.service.create(b, {
      authorId: author.id,
      title: "Second",
      requestId: randomUUID(),
    });
    const page = await f.service.list({ authorId: author.id, limit: 1 });
    assert.equal(page.total, 2);
    assert.ok(page.nextCursor);
    const next = await f.service.list({
      authorId: author.id,
      limit: 1,
      cursor: page.nextCursor!,
    });
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, page.items[0].id);
    await assert.rejects(
      f.service.list({
        authorId: author.id,
        limit: 1,
        search: "First",
        cursor: page.nextCursor!,
      }),
      /分页标识/,
    );
    const entries = await f.service.detail(s1.id, { limit: 1 });
    assert.ok(entries.nextCursor);
    const race = await Promise.allSettled([
      f.service.add(a, s1.id, {
        workIds: [w3.id],
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      f.service.add(b, s2.id, {
        workIds: [w3.id],
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
    ]);
    assert.equal(
      race.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      await f.db.workSeriesEntry.count({ where: { workId: w3.id } }),
      1,
    );
    await f.service.update(a, s1.id, {
      title: "Updated",
      expectedRevision: (await f.service.detail(s1.id, {})).revision,
      requestId: randomUUID(),
    });
    await assert.rejects(
      f.service.detail(s1.id, { limit: 1, cursor: entries.nextCursor! }),
      /分页标识/,
    );
  } finally {
    await f.close();
  }
});

test("candidate helpers lock without creating, rollback atomically, and share one new-series intent", async () => {
  const f = await fixture();
  try {
    const actor = await f.actor(),
      author = await f.author();
    const input = {
      createTitle: " Imported series ",
      requestId: randomUUID(),
      label: " Part ",
    };
    const normalized = normalizeWorkSeriesImportIntent(input)!;
    assert.deepEqual(normalized, {
      createTitle: "Imported series",
      requestId: input.requestId,
      label: "Part",
    });
    assert.throws(
      () =>
        normalizeWorkSeriesImportIntent({
          seriesId: randomUUID(),
          createTitle: "Ambiguous",
          expectedRevision: 0,
        }),
      /系列/,
    );
    await f.db.$transaction(async (tx) => {
      await f.service.lockImportIntent(tx, actor.userId, author.id, input);
    });
    assert.equal(
      await f.db.workSeries.count({ where: { authorId: author.id } }),
      0,
    );
    const w1 = await f.work(author.id, actor.userId, {
      candidateImportSeriesIntent: normalized,
    });
    const abort = Error("synthetic rollback");
    await assert.rejects(
      f.db.$transaction(async (tx) => {
        const locked = await f.service.lockImportIntent(
          tx,
          actor.userId,
          author.id,
          input,
        );
        await f.service.attachImportedWork(
          tx,
          actor.userId,
          author.id,
          w1.id,
          locked,
        );
        throw abort;
      }),
      abort,
    );
    assert.equal(
      await f.db.workSeries.count({ where: { authorId: author.id } }),
      0,
    );
    for (const work of [
      w1,
      await f.work(author.id, actor.userId, {
        candidateImportSeriesIntent: normalized,
      }),
    ])
      await f.db.$transaction(async (tx) => {
        const locked = await f.service.lockImportIntent(
          tx,
          actor.userId,
          author.id,
          input,
        );
        await f.service.attachImportedWork(
          tx,
          actor.userId,
          author.id,
          work.id,
          locked,
        );
      });
    assert.equal(
      await f.db.workSeries.count({ where: { authorId: author.id } }),
      1,
    );
    assert.equal(
      await f.db.workSeriesMutationReceipt.count({
        where: { actorId: actor.userId },
      }),
      1,
    );
    const series = (await f.service.context(w1.id)).series!;
    assert.equal(series.memberCount, 2);
    assert.equal(series.revision, 2);
    // A stale selected-series request must still acquire the lock without rejecting:
    // the caller next locks Candidate and may discover a successful replay.
    await f.db.$transaction(async (tx) => {
      await f.service.lockImportIntent(tx, actor.userId, author.id, {
        seriesId: series.id,
        expectedRevision: 0,
      });
    });
    assert.equal(
      await f.db.workEvent.count({ where: { work: { authorId: author.id } } }),
      0,
    );
  } finally {
    await f.close();
  }
});
