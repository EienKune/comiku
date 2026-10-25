import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import type { UserDto, MemberDto } from "../../src/users/users.dto.js";
import type {
  UserAvatarUploadDto,
  UserAvatarUrlDto,
} from "../../src/users/user-avatar.dto.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("own avatar signed upload, private reads, replacement, removal and stale/foreign sessions", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const db = app.get(PrismaService);
  const ids: string[] = [];
  const prefix = `avatar_${randomUUID().slice(0, 8)}`;
  let base = "";
  type Browser = { cookie?: string; id: string };
  async function request<T = UserDto & UserAvatarUploadDto & UserAvatarUrlDto>(
    browser: Browser,
    method: string,
    path: string,
    body?: object,
  ) {
    const response = await fetch(base + path, {
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
    return { status: response.status, data: (await response.json()) as T };
  }
  async function browser(name: string, role = true, forced = false) {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${name}`,
        displayName: name,
        passwordHash: await hashPassword("avatar-fixture-password"),
        mustChangePassword: forced,
        ...(role ? { roles: { create: { role: "translator" } } } : {}),
      },
    });
    ids.push(user.id);
    const result: Browser = { id: user.id };
    assert.equal(
      (
        await request(result, "POST", "/api/auth/login", {
          username: user.username,
          password: "avatar-fixture-password",
        })
      ).status,
      200,
    );
    return result;
  }
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  );
  const input = (expectedRevision: number, body = png) => ({
    sourceName: "avatar.png",
    size: body.byteLength,
    contentType: "image/png",
    checksum: createHash("sha256").update(body).digest("hex"),
    expectedRevision,
  });
  async function staged(who: Browser, revision: number, body = png) {
    const session = await request(
      who,
      "POST",
      "/api/users/me/avatar/upload-sessions",
      input(revision, body),
    );
    assert.equal(session.status, 201);
    const upload = await fetch(base + session.data.url, {
      method: "PUT",
      headers: { ...session.data.headers, Origin: "http://localhost:5173" },
      body,
    });
    assert.equal(upload.status, 200);
    return session.data.id as string;
  }
  const complete = (who: Browser, id: string) =>
    request(
      who,
      "POST",
      `/api/users/me/avatar/upload-sessions/${id}/complete`,
      {},
    );
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const own = await browser("own");
    const peer = await browser("peer");
    const restricted = await browser("forced", true, true);
    const noRole = await browser("empty", false);
    assert.equal(
      (
        await request(
          restricted,
          "POST",
          "/api/users/me/avatar/upload-sessions",
          input(0),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(own, "PATCH", "/api/users/me", {
          displayName: "own",
          avatarObjectKey: "private/other",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(own, "POST", "/api/users/me/avatar/upload-sessions", {
          ...input(0),
          size: 6 * 1024 * 1024,
        })
      ).status,
      400,
    );
    const firstId = await staged(own, 0);
    assert.equal((await complete(peer, firstId)).status, 404);
    const first = await complete(own, firstId);
    assert.equal(first.status, 200);
    assert.ok(first.data.avatarVersion);
    assert.equal(first.data.revision, 1);
    assert.equal((await complete(own, firstId)).data.revision, 1);
    const read = await request(peer, "GET", `/api/users/${own.id}/avatar/url`);
    assert.equal(read.status, 200);
    assert.match(read.data.url, /^memory:\/\//);
    assert.equal(
      (await request(noRole, "GET", `/api/users/${own.id}/avatar/url`)).status,
      403,
    );
    const members = await request<MemberDto[]>(
      peer,
      "GET",
      "/api/users/members",
    );
    assert.equal(
      members.data.find((member) => member.id === own.id)!.avatarVersion,
      first.data.avatarVersion,
    );
    const bad = await staged(own, 1, Buffer.from("not a picture"));
    assert.equal((await complete(own, bad)).status, 400);
    const expired = await staged(own, 1);
    await db.userAvatarUploadSession.update({
      where: { id: expired },
      data: { expiresAt: new Date(0) },
    });
    assert.equal((await complete(own, expired)).status, 400);
    const stale = await staged(own, 1);
    await request(own, "PATCH", "/api/users/me", { displayName: "changed" });
    assert.equal((await complete(own, stale)).status, 409);
    assert.equal(
      await db.fileObject.count({
        where: { createdById: own.id, kind: "user_avatar" },
      }),
      1,
    );
    const replacement = await complete(own, await staged(own, 2));
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.data.avatarVersion, first.data.avatarVersion);
    assert.equal(
      (
        await db.fileObject.findUnique({
          where: { id: first.data.avatarVersion },
        })
      )?.lifecycleStatus,
      "active",
    );
    assert.equal(
      (
        await request(own, "DELETE", "/api/users/me/avatar", {
          expectedRevision: 2,
        })
      ).status,
      409,
    );
    const removed = await request(own, "DELETE", "/api/users/me/avatar", {
      expectedRevision: replacement.data.revision,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.avatarVersion, null);
    assert.equal(
      (await request(peer, "GET", `/api/users/${own.id}/avatar/url`)).status,
      404,
    );
    assert.equal(removed.data.username, `${prefix}_own`);
    const ownWithoutRole = await complete(noRole, await staged(noRole, 0));
    assert.equal(ownWithoutRole.status, 200);
    assert.equal(
      (await request(noRole, "GET", `/api/users/${noRole.id}/avatar/url`))
        .status,
      200,
    );
    assert.equal(
      (await request(peer, "GET", `/api/users/${noRole.id}/avatar/url`)).status,
      404,
    );
    assert.equal(
      (
        await request(
          restricted,
          "GET",
          `/api/users/${restricted.id}/avatar/url`,
        )
      ).status,
      403,
    );
    assert.deepEqual(removed.data.roles, ["translator"]);
    assert.equal(
      await db.accountAudit.count({
        where: { actorId: own.id, action: "account.avatar_updated" },
      }),
      2,
    );
  } finally {
    await db.user.updateMany({
      where: { id: { in: ids } },
      data: { avatarFileObjectId: null },
    });
    await db.fileObject.deleteMany({ where: { createdById: { in: ids } } });
    await db.userAvatarUploadSession.deleteMany({
      where: { userId: { in: ids } },
    });
    await db.accountAudit.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userRole.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  }
});
