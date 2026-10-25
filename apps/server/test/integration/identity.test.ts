import type {
  UserDto,
  CredentialDto,
  MemberDto,
} from "../../src/users/users.dto.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { UsersService } from "../../src/users/users.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
type Browser = { cookie?: string };
test("identity HTTP and PostgreSQL authorization lifecycle", async (t) => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const db = app.get(PrismaService);
  const service = app.get(UsersService);
  const prefix = `qa${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  const admin: Browser = {};
  const member: Browser = {};
  const second: Browser = {};
  const password = "fixture-new-password-1234";
  let base = "";
  let adminId = "";
  let memberId = "";
  let secondId = "";
  async function request<T = UserDto>(
    browser: Browser,
    method: string,
    path: string,
    body?: object,
    extra: Record<string, string> = {},
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) browser.cookie = setCookie.split(";")[0];
    const data = (await res.json()) as T;
    return { status: res.status, data, headers: res.headers };
  }
  async function login(browser: Browser, username: string, pass: string) {
    const result = await request(browser, "POST", "/api/auth/login", {
      username,
      password: pass,
    });
    assert.equal(result.status, 200);
    return result;
  }
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const initialized = await service.initializeAdmin(
      `${prefix}admin`,
      "管理员测试",
    );
    adminId = initialized.user.id;
    ids.push(adminId);
    await t.test(
      "public probes, CSRF rejection and authenticated default",
      async () => {
        assert.equal((await request({}, "GET", "/api/health")).status, 200);
        assert.equal((await request({}, "GET", "/api/users")).status, 401);
        assert.equal(
          (
            await request(
              {},
              "POST",
              "/api/auth/login",
              { username: `${prefix}admin`, password: "invalid" },
              { Origin: "https://evil.invalid" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              {},
              "POST",
              "/api/auth/login",
              { username: `${prefix}admin`, password: "invalid" },
              { "X-Comiku-Request": "" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request({}, "POST", "/api/auth/login", {
              username: `${prefix}admin`,
              password: "invalid",
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "initial admin is one-time, must change password, and rotates the cookie",
      async () => {
        await assert.rejects(
          service.initializeAdmin(`${prefix}extra`, "第二个初始管理员"),
        );
        const logged = await login(
          admin,
          `${prefix}admin`.toUpperCase(),
          initialized.temporaryPassword,
        );
        assert.ok(logged.data.mustChangePassword);
        assert.ok(logged.headers.get("set-cookie")?.includes("HttpOnly"));
        assert.ok(logged.headers.get("set-cookie")?.includes("SameSite=Lax"));
        assert.ok(logged.headers.get("set-cookie")?.includes("Path=/api"));
        assert.equal(logged.headers.get("cache-control"), "no-store");
        assert.ok(!("passwordHash" in logged.data));
        const oldCookie = admin.cookie;
        assert.equal(
          (await request<UserDto[]>(admin, "GET", "/api/users")).status,
          403,
        );
        assert.equal(
          (
            await request(admin, "PATCH", "/api/users/me", {
              displayName: "不应生效",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(admin, "POST", "/api/auth/password", {
              currentPassword: initialized.temporaryPassword,
              newPassword: password,
            })
          ).status,
          200,
        );
        assert.notEqual(admin.cookie, oldCookie);
        assert.equal(
          (await request({ cookie: oldCookie }, "GET", "/api/auth/me")).status,
          401,
        );
      },
    );
    await t.test(
      "provisioning validates bodies, password confirmation and normalized uniqueness",
      async () => {
        const input = {
          username: `${prefix}member`,
          displayName: "测试成员",
          roles: ["translator", "proofreader"],
          currentPassword: password,
        };
        assert.equal(
          (
            await request(admin, "POST", "/api/users", {
              ...input,
              currentPassword: "invalid",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(admin, "POST", "/api/users", {
              ...input,
              isActive: true,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(admin, "POST", "/api/users", {
              ...input,
              roles: ["unknown"],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(admin, "POST", "/api/users", {
              ...input,
              username: `${prefix}_legacy`,
            })
          ).status,
          400,
        );
        const created = await request<CredentialDto>(
          admin,
          "POST",
          "/api/users",
          input,
        );
        assert.equal(created.status, 201);
        memberId = created.data.user.id;
        ids.push(memberId);
        assert.equal(
          (
            await request(admin, "POST", "/api/users", {
              ...input,
              username: input.username.toUpperCase(),
            })
          ).status,
          409,
        );
        await login(member, input.username, created.data.temporaryPassword);
        assert.equal(
          (await request(member, "GET", "/api/users/members")).status,
          403,
        );
        assert.equal(
          (
            await request(member, "POST", "/api/auth/password", {
              currentPassword: created.data.temporaryPassword,
              newPassword: password,
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "members cannot administer accounts or change another user's profile",
      async () => {
        assert.equal((await request(member, "GET", "/api/users")).status, 403);
        assert.equal(
          (await request(member, "GET", "/api/users/audit")).status,
          403,
        );
        assert.equal(
          (
            await request(member, "POST", "/api/users", {
              username: `${prefix}bad`,
              displayName: "bad",
              roles: ["admin"],
              currentPassword: password,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(member, "PATCH", "/api/users/me", {
              displayName: "试图越权",
              id: adminId,
              roles: ["admin"],
            })
          ).status,
          400,
        );
        assert.equal(
          (await request(member, "PATCH", `/api/users/${adminId}`, {})).status,
          403,
        );
        const visible = await request<MemberDto[]>(
          member,
          "GET",
          "/api/users/members",
        );
        assert.equal(visible.status, 200);
        assert.deepEqual(Object.keys(visible.data[0]).sort(), [
          "avatarVersion",
          "displayName",
          "id",
          "languageCapabilities",
          "roles",
          "username",
        ]);
        assert.equal(
          (
            await request(member, "PATCH", "/api/users/me", {
              displayName: "自己的显示名",
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "account revisions, immediate role changes and last-admin protection",
      async () => {
        const me = (await request(admin, "GET", "/api/auth/me")).data;
        assert.equal(
          (
            await request(admin, "PATCH", `/api/users/${adminId}`, {
              displayName: me.displayName,
              roles: [],
              isActive: true,
              expectedRevision: me.revision,
              currentPassword: password,
            })
          ).status,
          409,
        );
        const list = (await request<UserDto[]>(admin, "GET", "/api/users"))
          .data;
        const target = list.find((u: { id: string }) => u.id === memberId);
        assert.ok(target);
        const body = {
          displayName: target.displayName,
          roles: [],
          isActive: true,
          expectedRevision: target.revision,
          currentPassword: password,
        };
        assert.equal(
          (await request(admin, "PATCH", `/api/users/${memberId}`, body))
            .status,
          200,
        );
        assert.equal(
          (await request(member, "GET", "/api/users/members")).status,
          403,
        );
        assert.equal(
          (await request(member, "GET", "/api/auth/me")).status,
          200,
        );
        assert.equal(
          (await request(admin, "PATCH", `/api/users/${memberId}`, body))
            .status,
          409,
        );
        assert.equal(
          (
            await request(admin, "PATCH", `/api/users/${memberId}`, {
              ...body,
              roles: ["reviewer"],
              expectedRevision: target.revision + 1,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request(member, "GET", "/api/users/members")).status,
          200,
        );
        assert.equal(
          (await request(member, "GET", "/api/users/audit")).status,
          403,
        );
      },
    );
    await t.test(
      "reset revokes sessions, requires password change again, and never exposes stored secrets",
      async () => {
        const oldCookie = member.cookie;
        const reset = await request<CredentialDto>(
          admin,
          "POST",
          `/api/users/${memberId}/reset-password`,
          { currentPassword: password },
        );
        assert.equal(reset.status, 200);
        assert.equal(
          (await request({ cookie: oldCookie }, "GET", "/api/auth/me")).status,
          401,
        );
        await login(member, `${prefix}member`, reset.data.temporaryPassword);
        assert.equal(
          (await request(member, "GET", "/api/users/members")).status,
          403,
        );
        assert.equal(
          (
            await request(member, "POST", "/api/auth/password", {
              currentPassword: reset.data.temporaryPassword,
              newPassword: password,
            })
          ).status,
          200,
        );
        const serialized = JSON.stringify(
          (await request<UserDto[]>(admin, "GET", "/api/users")).data,
        );
        assert.ok(!serialized.includes(reset.data.temporaryPassword));
        assert.ok(!serialized.includes("passwordHash"));
        const audit = await request(admin, "GET", "/api/users/audit");
        assert.ok(!JSON.stringify(audit.data).includes(password));
        assert.ok(
          !JSON.stringify(audit.data).includes(reset.data.temporaryPassword),
        );
      },
    );
    await t.test(
      "disable, re-enable, and session revocation do not restore old sessions",
      async () => {
        const oldCookie = member.cookie;
        const target = (
          await request<UserDto[]>(admin, "GET", "/api/users")
        ).data.find((u: { id: string }) => u.id === memberId);
        assert.ok(target);
        const data = {
          displayName: target.displayName,
          roles: target.roles,
          isActive: false,
          expectedRevision: target.revision,
          currentPassword: password,
        };
        assert.equal(
          (await request(admin, "PATCH", `/api/users/${memberId}`, data))
            .status,
          200,
        );
        assert.equal(
          (await request(member, "GET", "/api/auth/me")).status,
          401,
        );
        assert.equal(
          (
            await request({}, "POST", "/api/auth/login", {
              username: target.username,
              password,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request(admin, "PATCH", `/api/users/${memberId}`, {
              ...data,
              isActive: true,
              expectedRevision: target.revision + 1,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request({ cookie: oldCookie }, "GET", "/api/auth/me")).status,
          401,
        );
        await login(member, target.username, password);
        const other: Browser = {};
        await login(other, target.username, password);
        assert.equal(
          (await request(member, "POST", "/api/auth/revoke-others", {})).status,
          200,
        );
        assert.equal((await request(other, "GET", "/api/auth/me")).status, 401);
        assert.equal(
          (await request(member, "POST", "/api/auth/logout", {})).status,
          200,
        );
        assert.equal(
          (await request(member, "GET", "/api/auth/me")).status,
          401,
        );
      },
    );
    await t.test(
      "concurrent administrator demotions cannot remove every active admin",
      async () => {
        const created = await request<CredentialDto>(
          admin,
          "POST",
          "/api/users",
          {
            username: `${prefix}second`,
            displayName: "第二管理员",
            roles: ["admin"],
            currentPassword: password,
          },
        );
        assert.equal(created.status, 201);
        secondId = created.data.user.id;
        ids.push(secondId);
        await login(
          second,
          created.data.user.username,
          created.data.temporaryPassword,
        );
        assert.equal(
          (
            await request(second, "POST", "/api/auth/password", {
              currentPassword: created.data.temporaryPassword,
              newPassword: password,
            })
          ).status,
          200,
        );
        const firstUser = (await request(admin, "GET", "/api/auth/me")).data;
        const secondUser = (await request(second, "GET", "/api/auth/me")).data;
        const responses = await Promise.all([
          request(admin, "PATCH", `/api/users/${adminId}`, {
            displayName: firstUser.displayName,
            roles: ["source"],
            isActive: true,
            expectedRevision: firstUser.revision,
            currentPassword: password,
          }),
          request(second, "PATCH", `/api/users/${secondId}`, {
            displayName: secondUser.displayName,
            roles: ["source"],
            isActive: true,
            expectedRevision: secondUser.revision,
            currentPassword: password,
          }),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          await db.user.count({
            where: { isActive: true, roles: { some: { role: "admin" } } },
          }),
          1,
        );
      },
    );
    await t.test(
      "server-only recovery resets an existing administrator and revokes old sessions",
      async () => {
        const remaining = await db.user.findFirstOrThrow({
          where: { roles: { some: { role: "admin" } } },
        });
        const oldBrowser = remaining.id === adminId ? admin : second;
        const oldCookie = oldBrowser.cookie;
        const recovered = await service.recoverAdmin(remaining.username);
        assert.equal(recovered.user.mustChangePassword, true);
        assert.equal(
          (await request({ cookie: oldCookie }, "GET", "/api/auth/me")).status,
          401,
        );
        await login(
          oldBrowser,
          remaining.username,
          recovered.temporaryPassword,
        );
        assert.equal(
          (await request(oldBrowser, "GET", "/api/users")).status,
          403,
        );
      },
    );
    await t.test(
      "expired and idle sessions fail; stored tokens are hashes",
      async () => {
        const browser: Browser = {};
        await login(browser, `${prefix}member`, password);
        const sessions = await db.authSession.findMany({
          where: { userId: memberId, revokedAt: null },
        });
        assert.ok(sessions.every((s) => /^[a-f0-9]{64}$/.test(s.tokenHash)));
        await db.authSession.updateMany({
          where: { userId: memberId, revokedAt: null },
          data: { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) },
        });
        assert.equal(
          (await request(browser, "GET", "/api/auth/me")).status,
          401,
        );
        await login(browser, `${prefix}member`, password);
        await db.authSession.updateMany({
          where: { userId: memberId, revokedAt: null },
          data: { expiresAt: new Date(0) },
        });
        assert.equal(
          (await request(browser, "GET", "/api/auth/me")).status,
          401,
        );
      },
    );
  } finally {
    // Only the IDs created by this suite; the separate disposable DB was checked above.
    await db.accountAudit.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userRole.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  }
});
