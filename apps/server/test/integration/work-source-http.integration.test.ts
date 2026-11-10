import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../src/files/object-storage.js";
import type { ImageUrlDto } from "../../src/files/image-url.dto.js";
import { hashPassword } from "../../src/users/password.js";
import type { CandidateBatchResultDto } from "../../src/candidates/candidates.dto.js";
import type { WorkSourceDto } from "../../src/works/works.dto.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

test("work source HTTP permissions include excluded images but never cross-work media or unavailable files", async () => {
  const f = await candidateReviewFixture();
  const app = await createApplication(
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      OBJECT_STORAGE_DRIVER: "memory",
    }),
  );
  const db = app.get(PrismaService);
  const storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  const extraUserIds: string[] = [];
  let base = "";
  async function request<T>(
    cookie: string,
    method: string,
    path: string,
    body?: object,
  ) {
    const response = await fetch(base + path, {
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
  async function login(role?: "translator") {
    const user = await db.user.create({
      data: {
        username: `source_http_${randomUUID()}`,
        displayName: role ?? "no role",
        passwordHash: await hashPassword("fixture-password-12345"),
        mustChangePassword: false,
        ...(role ? { roles: { create: { role } } } : {}),
      },
    });
    extraUserIds.push(user.id);
    const result = await request("", "POST", "/api/auth/login", {
      username: user.username,
      password: "fixture-password-12345",
    });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    await db.user.update({
      where: { id: f.actor.id },
      data: { passwordHash: await hashPassword("fixture-password-12345") },
    });
    const sourceLogin = await request("", "POST", "/api/auth/login", {
      username: f.actor.username,
      password: "fixture-password-12345",
    });
    assert.equal(sourceLogin.status, 200);
    const sourceCookie = sourceLogin.cookie;
    const translator = await login("translator"),
      noRole = await login();
    const candidate = await f.post({
      text: "original source",
      rawJson: { private: "must-not-leak" },
      analysisPredictions: [
        { label: "positive", confidence: 0.8, score: 0.8 },
        { label: "positive", confidence: 0.8, score: 0.8 },
      ],
    });
    const media = await db.candidateMedia.findMany({
      where: { candidatePostId: candidate.id },
      orderBy: { orderIndex: "asc" },
      include: { fileObject: true },
    });
    for (const { fileObject: file } of media)
      await storage.put({
        key: file.objectKey,
        body: new Uint8Array([1]),
        size: 1,
        contentType: file.contentType,
        checksum: file.checksum,
      });
    for (const mediaIds of [
      null,
      [],
      [media[0].id, media[0].id],
      ["invalid"],
    ]) {
      assert.equal(
        (
          await request(sourceCookie, "POST", "/api/candidates/actions", {
            action: "import",
            items: [{ id: candidate.id, expectedRevision: 0, mediaIds }],
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await request(translator, "POST", "/api/candidates/actions", {
          action: "import",
          items: [
            { id: candidate.id, expectedRevision: 0, mediaIds: [media[1].id] },
          ],
        })
      ).status,
      403,
    );
    const imported = await request<CandidateBatchResultDto>(
      sourceCookie,
      "POST",
      "/api/candidates/actions",
      {
        action: "import",
        items: [
          { id: candidate.id, expectedRevision: 0, mediaIds: [media[1].id] },
        ],
      },
    );
    assert.equal(imported.status, 200);
    assert.equal(imported.data.results[0].outcome, "succeeded");
    const workId = imported.data.results[0].workId!;
    // Current source text can be enriched after import; the Work snapshot stays stable.
    await db.candidatePost.update({
      where: { id: candidate.id },
      data: { text: "enriched source" },
    });
    const path = `/api/works/${workId}/source`;
    assert.equal((await request("", "GET", path)).status, 401);
    assert.equal((await request(noRole, "GET", path)).status, 403);
    const record = await request<WorkSourceDto>(translator, "GET", path);
    assert.equal(record.status, 200);
    assert.equal(record.data.sourceText, "enriched source");
    assert.equal(record.data.importedSourceText, "original source");
    assert.deepEqual(
      record.data.media.map(({ adopted }) => adopted),
      [false, true],
    );
    assert.equal(JSON.stringify(record.data).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(record.data).includes("objectKey"), false);
    assert.ok(record.data.media.every((item) => !("url" in item)));
    // The ordinary candidate endpoint stays restricted while its bound work source is readable.
    assert.equal(
      (await request(translator, "GET", `/api/candidates/${candidate.id}`))
        .status,
      403,
    );
    const excludedUrl = `${path}/media/${media[0].id}/url`;
    const image = await request<ImageUrlDto>(translator, "GET", excludedUrl);
    assert.equal(image.status, 200);
    assert.match(image.data.url!, /^memory:/);
    assert.equal((await request(noRole, "GET", excludedUrl)).status, 403);
    assert.equal((await request("", "GET", excludedUrl)).status, 401);
    const foreign = await f.post();
    const foreignMedia = await db.candidateMedia.findFirstOrThrow({
      where: { candidatePostId: foreign.id },
    });
    assert.equal(
      (await request(translator, "GET", `${path}/media/${foreignMedia.id}/url`))
        .status,
      404,
    );
    assert.equal(
      (await request(translator, "GET", `/api/works/${randomUUID()}/source`))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          translator,
          "GET",
          `/api/works/${randomUUID()}/source/media/${media[0].id}/url`,
        )
      ).status,
      404,
    );
    await db.author.update({
      where: { id: f.author.id },
      data: { deletedAt: new Date(), authorizationStatus: "revoked" },
    });
    await db.work.update({
      where: { id: workId },
      data: {
        workflowStatus: "archived",
        archivedFromWorkflowStatus: "pending_translate",
        reviewStatus: "blocked",
      },
    });
    assert.equal((await request(translator, "GET", path)).status, 200);
    assert.equal((await request(translator, "GET", excludedUrl)).status, 200);
    await db.fileObject.update({
      where: { id: media[0].fileObjectId },
      data: { lifecycleStatus: "pending_deletion", deletedAt: new Date() },
    });
    assert.equal((await request(translator, "GET", excludedUrl)).status, 404);
    const unavailable = await request<WorkSourceDto>(translator, "GET", path);
    assert.equal(unavailable.data.media[0].available, false);
    assert.equal(unavailable.data.media[0].adopted, false);
  } finally {
    const userIds = [f.actor.id, ...extraUserIds];
    await db.candidateActionLog.deleteMany({ where: { actorId: f.actor.id } });
    await db.workEvent.deleteMany({
      where: { work: { authorId: f.author.id } },
    });
    await db.work.deleteMany({ where: { authorId: f.author.id } });
    await db.accountAudit.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: extraUserIds } } });
    await db.user.deleteMany({ where: { id: { in: extraUserIds } } });
    await app.close();
    await f.close();
  }
});
