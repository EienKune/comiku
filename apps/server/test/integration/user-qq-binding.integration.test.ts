import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import { UsersService } from "../../src/users/users.service.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("QQ bindings enforce self-only access, private projections and serialized uniqueness", async (t) => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const db = app.get(PrismaService);
  const ids: string[] = [];
  const prefix = `qq_${randomUUID().slice(0, 8)}`;
  const path = "/api/users/me/qq-binding";
  const password = "qq-binding-fixture-password";
  const passwordHash = await hashPassword(password);
  let base = "";
  type Browser = { cookie?: string; id: string };
  type Binding = { qqNumber: string | null; revision: number };
  async function request<T = Binding>(
    browser: Browser,
    method: string,
    target = path,
    body?: object,
  ) {
    const response = await fetch(base + target, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) browser.cookie = cookie.split(";")[0];
    const text = await response.text();
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? JSON.parse(text)
      : text;
    return { status: response.status, data: data as T };
  }
  async function browser(
    name: string,
    role: "translator" | "admin" | null = "translator",
    forced = false,
  ) {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${name}`,
        displayName: name,
        passwordHash,
        mustChangePassword: forced,
        ...(role ? { roles: { create: { role } } } : {}),
      },
    });
    ids.push(user.id);
    const result: Browser = { id: user.id };
    const login = await request<Record<string, unknown>>(
      result,
      "POST",
      "/api/auth/login",
      { username: user.username, password },
    );
    assert.equal(login.status, 200);
    assert.equal(Object.hasOwn(login.data, "qqNumber"), false);
    return result;
  }
  const bind = (
    who: Browser,
    qqNumber: string | null,
    expectedRevision: number,
  ) => request(who, "PATCH", path, { qqNumber, expectedRevision });
  const bindingAudits = (who: Browser) =>
    db.accountAudit.findMany({
      where: { actorId: who.id, action: "account.qq_binding_updated" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const own = await browser("own");
    const peer = await browser("peer");
    const admin = await browser("admin", "admin");

    await t.test(
      "validates explicit nullable strings and current sessions",
      async () => {
        const anonymous: Browser = { id: "" };
        assert.equal((await request(anonymous, "GET")).status, 401);
        assert.equal((await bind(anonymous, "720000001", 0)).status, 401);
        const forced = await browser("forced", "translator", true);
        assert.equal((await request(forced, "GET")).status, 403);
        assert.equal((await bind(forced, "720000001", 0)).status, 403);
        const invalid = [
          {},
          { expectedRevision: 0 },
          { qqNumber: null },
          { qqNumber: "720000001" },
          { qqNumber: 720000001, expectedRevision: 0 },
          { qqNumber: "", expectedRevision: 0 },
          { qqNumber: "   ", expectedRevision: 0 },
          { qqNumber: "1234", expectedRevision: 0 },
          { qqNumber: "1".repeat(21), expectedRevision: 0 },
          { qqNumber: "0720000001", expectedRevision: 0 },
          { qqNumber: "７２００００００１", expectedRevision: 0 },
          { qqNumber: "[CQ:at,qq=all]", expectedRevision: 0 },
          { qqNumber: "720000001", expectedRevision: -1 },
          { qqNumber: "720000001", expectedRevision: null },
          { qqNumber: "720000001", expectedRevision: 0.5 },
          { qqNumber: "720000001", expectedRevision: 0, userId: peer.id },
        ];
        for (const body of invalid)
          assert.equal(
            (await request(own, "PATCH", path, body)).status,
            400,
            `invalid binding body: ${JSON.stringify(body)}`,
          );
        assert.deepEqual((await request(own, "GET")).data, {
          qqNumber: null,
          revision: 0,
        });
        assert.equal((await bindingAudits(own)).length, 0);
        for (const mode of ["revoked", "expired", "inactive"] as const) {
          const stale = await browser(mode);
          const session = await db.authSession.findFirstOrThrow({
            where: { userId: stale.id },
          });
          if (mode === "inactive")
            await db.user.update({
              where: { id: stale.id },
              data: { isActive: false },
            });
          else
            await db.authSession.updateMany({
              where: { userId: stale.id },
              data:
                mode === "revoked"
                  ? { revokedAt: new Date() }
                  : { expiresAt: new Date(0) },
            });
          assert.equal((await request(stale, "GET")).status, 401);
          assert.equal((await bind(stale, "720000001", 0)).status, 401);
          await assert.rejects(
            () =>
              app
                .get(UsersService)
                .updateQqBinding(
                  { userId: stale.id, sessionId: session.id },
                  { qqNumber: "720000001", expectedRevision: 0 },
                ),
            UnauthorizedException,
          );
          assert.equal((await bindingAudits(stale)).length, 0);
        }
      },
    );

    await t.test(
      "normalizes, preserves same-value idempotency and rejects stale writes",
      async () => {
        assert.deepEqual((await bind(peer, null, 0)).data, {
          qqNumber: null,
          revision: 0,
        });
        assert.equal((await bindingAudits(peer)).length, 0);
        const saved = await bind(own, " 720000001 ", 0);
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.data, { qqNumber: "720000001", revision: 1 });
        assert.equal((await bind(own, "720000001", 1)).status, 200);
        assert.deepEqual((await request(own, "GET")).data, saved.data);
        assert.equal((await bindingAudits(own)).length, 1);
        assert.equal((await bind(own, "720000001", 0)).status, 409);
        assert.equal((await bind(own, "720000002", 0)).status, 409);
        assert.equal((await bind(own, null, 0)).status, 409);
        assert.deepEqual((await request(own, "GET")).data, saved.data);
        assert.deepEqual((await request(peer, "GET")).data, {
          qqNumber: null,
          revision: 0,
        });
        for (const method of ["GET", "PATCH"])
          assert.equal(
            (
              await request(
                peer,
                method,
                `/api/users/${own.id}/qq-binding`,
                method === "PATCH"
                  ? { qqNumber: "720000002", expectedRevision: 1 }
                  : undefined,
              )
            ).status,
            404,
          );
        const noRole = await browser("empty", null);
        assert.equal((await bind(noRole, "720000006", 0)).status, 200);
        assert.equal((await bind(noRole, "12345", 1)).status, 200);
        assert.equal(
          (await bind(noRole, "12345678901234567890", 2)).status,
          200,
        );
      },
    );

    await t.test(
      "concurrent accounts cannot claim the same QQ and unbinding releases it",
      async () => {
        const first = await browser("first");
        const second = await browser("second");
        const contenders = [first, second];
        const results = await Promise.all(
          contenders.map((who) => bind(who, "720000003", 0)),
        );
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          [200, 409],
        );
        const winner =
          contenders[results.findIndex((result) => result.status === 200)]!;
        const loser =
          contenders[results.findIndex((result) => result.status === 409)]!;
        const conflict = results.find((result) => result.status === 409)!;
        assert.equal(
          (conflict.data as unknown as { message: string }).message,
          "QQ 号已被其他账号使用",
        );
        assert.equal(
          await db.user.count({ where: { qqNumber: "720000003" } }),
          1,
        );
        assert.equal((await bindingAudits(winner)).length, 1);
        assert.equal((await bindingAudits(loser)).length, 0);
        const released = await bind(winner, null, 1);
        assert.equal(released.status, 200);
        assert.deepEqual(released.data, { qqNumber: null, revision: 2 });
        assert.equal((await bind(winner, null, 2)).status, 200);
        assert.equal((await bindingAudits(winner)).length, 2);
        assert.equal((await bind(loser, "720000003", 0)).status, 200);
        assert.deepEqual(
          (await bindingAudits(winner)).map((row) => row.detail),
          [{ bound: true }, { bound: false }],
        );
      },
    );

    await t.test(
      "same-user concurrent revisions commit exactly once",
      async () => {
        const concurrent = await browser("concurrent");
        const results = await Promise.all([
          bind(concurrent, "720000004", 0),
          bind(concurrent, "720000005", 0),
        ]);
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          [200, 409],
        );
        const current = await request(concurrent, "GET");
        assert.equal(current.data.revision, 1);
        assert.ok(["720000004", "720000005"].includes(current.data.qqNumber!));
        assert.equal((await bindingAudits(concurrent)).length, 1);
      },
    );

    await t.test(
      "auth, member, administrative and audit DTOs exclude QQ data",
      async () => {
        const me = await request<Record<string, unknown>>(
          own,
          "GET",
          "/api/auth/me",
        );
        assert.equal(me.status, 200);
        assert.equal(Object.hasOwn(me.data, "qqNumber"), false);
        for (const target of ["/api/users", "/api/users/members"]) {
          const response = await request<Record<string, unknown>[]>(
            admin,
            "GET",
            target,
          );
          assert.equal(response.status, 200);
          assert.ok(response.data.some((row) => row.id === own.id));
          assert.ok(
            response.data.every((row) => !Object.hasOwn(row, "qqNumber")),
          );
          assert.equal(
            JSON.stringify(response.data).includes("720000001"),
            false,
          );
        }
        const profile = await request<Record<string, unknown>>(
          own,
          "PATCH",
          "/api/users/me",
          { displayName: "own", qqNumber: "720000002" },
        );
        assert.equal(profile.status, 400);
        const managed = await request(admin, "PATCH", `/api/users/${own.id}`, {
          displayName: "own",
          roles: ["translator"],
          languageCapabilities: [],
          isActive: true,
          expectedRevision: 1,
          currentPassword: password,
          qqNumber: "720000002",
        });
        assert.equal(managed.status, 400);
        const audit = await request<
          { actorId: string | null; action: string; detail: unknown }[]
        >(admin, "GET", "/api/users/audit");
        assert.equal(audit.status, 200);
        const ownAudit = audit.data.find(
          (row) =>
            row.actorId === own.id &&
            row.action === "account.qq_binding_updated",
        );
        assert.ok(ownAudit);
        assert.deepEqual(ownAudit.detail, { bound: true });
        assert.equal(JSON.stringify(audit.data).includes("720000001"), false);
        assert.ok(
          (
            await db.accountAudit.findMany({ where: { actorId: { in: ids } } })
          ).every((row) => !JSON.stringify(row.detail).includes("72000000")),
        );
      },
    );
  } finally {
    try {
      await db.accountAudit.deleteMany({
        where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
      });
      await db.authSession.deleteMany({ where: { userId: { in: ids } } });
      await db.userRole.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await app.close();
    }
  }
});
