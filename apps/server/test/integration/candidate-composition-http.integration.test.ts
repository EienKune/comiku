import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import type { CandidateCompositionResultDto } from "../../src/candidates/composition.dto.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { hashPassword } from "../../src/users/password.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

test("composition HTTP routes validate DTOs, session/CSRF permissions and private successful receipts", async () => {
  const f = await candidateReviewFixture();
  const environment = parseEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    OBJECT_STORAGE_DRIVER: "memory",
  });
  const app = await createApplication(environment);
  const userIds = [f.actor.id];
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const password = "synthetic-composition-http-password",
      passwordHash = await hashPassword(password);
    await f.db.user.update({
      where: { id: f.actor.id },
      data: { passwordHash },
    });
    async function account(role: "source" | "translator") {
      const user = await f.db.user.create({
        data: {
          username: `composition_http_${randomUUID().slice(0, 18)}`,
          displayName: "Synthetic composition HTTP",
          passwordHash,
          mustChangePassword: false,
          roles: { create: { role } },
        },
      });
      userIds.push(user.id);
      return user;
    }
    async function request(
      method: string,
      path: string,
      body?: object,
      cookie?: string,
      csrf = true,
    ) {
      return fetch(`${base}/api${path}`, {
        method,
        headers: {
          Origin: environment.appOrigin,
          ...(csrf ? { "X-Comiku-Request": "1" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    async function login(username: string) {
      const response = await request("POST", "/auth/login", {
        username,
        password,
      });
      assert.equal(response.status, 200);
      await response.json();
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie, "actual login must issue a session cookie");
      return cookie;
    }
    const other = await account("source"),
      reader = await account("translator");
    const sourceCookie = await login(f.actor.username),
      otherCookie = await login(other.username),
      readerCookie = await login(reader.username);
    const candidate = await f.post({
      analysisPredictions: Array.from({ length: 3 }, () => ({
        label: "positive",
        confidence: 0.8,
        score: 0.8,
      })),
    });
    const media = await f.db.candidateMedia.findMany({
      where: { candidatePostId: candidate.id },
      orderBy: { orderIndex: "asc" },
    });
    const input = {
      idempotencyKey: randomUUID(),
      mode: "split",
      candidates: [{ id: candidate.id, expectedRevision: 0 }],
      works: [
        { title: "HTTP One", mediaIds: [media[1].id] },
        { title: "HTTP Two", mediaIds: [media[0].id] },
      ],
    };
    for (const body of [
      { ...input, works: [{ mediaIds: [media[1].id] }, input.works[1]] },
      {
        ...input,
        works: [
          { title: "Too long".repeat(30), mediaIds: [media[1].id] },
          input.works[1],
        ],
      },
      {
        ...input,
        works: [
          { ...input.works[0], mediaIds: [media[0].id, media[0].id] },
          input.works[1],
        ],
      },
      { ...input, series: {} },
    ]) {
      const response = await request(
        "POST",
        "/candidates/compositions",
        body,
        sourceCookie,
      );
      assert.equal(response.status, 400);
      await response.json();
    }
    for (const [cookie, csrf, expected] of [
      [undefined, true, 401],
      [sourceCookie, false, 403],
      [readerCookie, true, 403],
    ] as const) {
      const response = await request(
        "POST",
        "/candidates/compositions",
        input,
        cookie,
        csrf,
      );
      assert.equal(response.status, expected);
      await response.json();
    }
    assert.equal(
      await f.db.candidateCompositionReceipt.count({
        where: { actorId: f.actor.id },
      }),
      0,
    );
    const created = await request(
      "POST",
      "/candidates/compositions",
      input,
      sourceCookie,
    );
    assert.equal(created.status, 201);
    const result = (await created.json()) as CandidateCompositionResultDto;
    assert.equal(result.works.length, 2);
    assert.deepEqual(
      result.works.map((work) => work.title),
      ["HTTP One", "HTTP Two"],
    );
    assert.equal(result.candidates[0].revision, 1);
    assert.deepEqual(
      result.candidates[0].workIds,
      result.works.map((work) => work.workId),
    );
    const resultPath = `/candidates/compositions/${input.idempotencyKey}`;
    const receipt = await request("GET", resultPath, undefined, sourceCookie);
    assert.equal(receipt.status, 200);
    assert.deepEqual(await receipt.json(), result);
    for (const [cookie, expected] of [
      [readerCookie, 403],
      [otherCookie, 404],
    ] as const) {
      const response = await request("GET", resultPath, undefined, cookie);
      assert.equal(response.status, expected);
      await response.json();
    }
    const malformedPath = await request(
      "GET",
      "/candidates/compositions/not-a-uuid",
      undefined,
      sourceCookie,
    );
    assert.equal(malformedPath.status, 400);
    await malformedPath.json();
    const replay = await request(
      "POST",
      "/candidates/compositions",
      input,
      sourceCookie,
    );
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), result);
    assert.equal(
      await f.db.workEvent.count({
        where: { actorId: f.actor.id, action: "imported" },
      }),
      2,
    );
    assert.equal(
      await f.db.candidateCompositionReceipt.count({
        where: { actorId: f.actor.id },
      }),
      1,
    );
  } finally {
    await app.close();
    await f.db.candidateActionLog.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.workEvent.deleteMany({ where: { actorId: f.actor.id } });
    await f.db.work.deleteMany({ where: { importedById: f.actor.id } });
    await f.db.candidateCompositionReceipt.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await f.db.accountAudit.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await f.db.userRole.deleteMany({
      where: { userId: { in: userIds.slice(1) } },
    });
    await f.db.user.deleteMany({ where: { id: { in: userIds.slice(1) } } });
    await f.close();
  }
});
