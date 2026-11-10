import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { UsersService } from "../../src/users/users.service.js";
import { tokenHash, hashPassword } from "../../src/users/password.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { createApplication } from "../../src/application.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
const idle = 7 * 86_400,
  absolute = 30 * 86_400;
async function fixture(idleSeconds = idle, absoluteSeconds = absolute) {
  const f = await candidateReviewFixture();
  const env = parseEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_SESSION_IDLE_SECONDS: String(idleSeconds),
    AUTH_SESSION_ABSOLUTE_SECONDS: String(absoluteSeconds),
  });
  const service = new UsersService(f.db, {} as never, env);
  const token = randomBytes(32).toString("base64url"),
    now = new Date();
  const session = await f.db.authSession.create({
    data: {
      userId: f.actor.id,
      tokenHash: tokenHash(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + absoluteSeconds * 1000),
    },
  });
  return {
    ...f,
    env,
    service,
    session,
    token,
    actorSession: { userId: f.actor.id, sessionId: session.id },
    async close() {
      await f.db.authSession.deleteMany({ where: { userId: f.actor.id } });
      await f.close();
    },
  };
}
test("reads do not renew idle time and actual activity respects seven-day idle and thirty-day absolute deadlines", async (t) => {
  const f = await fixture();
  try {
    const base = f.session.lastSeenAt.getTime();
    t.mock.timers.enable({ apis: ["Date"], now: base + 6 * 86_400_000 });
    await f.service.authenticate(f.token);
    assert.equal(
      (await f.service.me(f.actorSession)).activityIntervalSeconds,
      300,
    );
    assert.equal(
      (
        await f.db.authSession.findUniqueOrThrow({
          where: { id: f.session.id },
        })
      ).lastSeenAt.getTime(),
      base,
    );
    await f.service.activity(f.actorSession);
    assert.equal(
      (
        await f.db.authSession.findUniqueOrThrow({
          where: { id: f.session.id },
        })
      ).lastSeenAt.getTime(),
      base + 6 * 86_400_000,
    );
    t.mock.timers.setTime(base + 12 * 86_400_000);
    await f.service.activity(f.actorSession);
    const expires = (
      await f.db.authSession.findUniqueOrThrow({ where: { id: f.session.id } })
    ).expiresAt.getTime();
    assert.equal(expires, f.session.expiresAt.getTime());
    t.mock.timers.setTime(base + 19 * 86_400_000);
    await assert.rejects(f.service.activity(f.actorSession), /登录已失效/);
    await f.db.authSession.update({
      where: { id: f.session.id },
      data: { lastSeenAt: new Date(base + 29 * 86_400_000) },
    });
    t.mock.timers.setTime(base + absolute * 1000);
    await assert.rejects(f.service.activity(f.actorSession), /登录已失效/);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
test("default idle checks and old absolute session expiry remain independent of a longer new configuration", async (t) => {
  const f = await fixture(1800, 28800);
  try {
    const base = f.session.lastSeenAt.getTime();
    t.mock.timers.enable({ apis: ["Date"], now: base + 1800 * 1000 });
    await assert.rejects(f.service.authenticate(f.token), /登录已失效/);
    await assert.rejects(f.service.me(f.actorSession), /登录已失效/);
    const long = new UsersService(f.db, {} as never, {
      ...f.env,
      authSessionIdleSeconds: idle,
      authSessionAbsoluteSeconds: absolute,
    });
    t.mock.timers.setTime(base + 28800 * 1000);
    await assert.rejects(long.activity(f.actorSession), /登录已失效/);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
test("same-session tabs throttle database writes and short-idle activity uses sub-second intervals", async (t) => {
  const f = await fixture(1, 60);
  try {
    const base = f.session.lastSeenAt.getTime();
    t.mock.timers.enable({ apis: ["Date"], now: base + 500 });
    assert.equal(
      (await f.service.me(f.actorSession)).activityIntervalSeconds,
      0.5,
    );
    await Promise.all([
      f.service.activity(f.actorSession),
      f.service.activity(f.actorSession),
    ]);
    const before = await f.db.$queryRaw<
      { xmin: string }[]
    >`SELECT xmin::text FROM auth_sessions WHERE id=${f.session.id}::uuid`;
    t.mock.timers.setTime(base + 501);
    await Promise.all([
      f.service.activity(f.actorSession),
      f.service.activity(f.actorSession),
    ]);
    assert.deepEqual(
      await f.db
        .$queryRaw`SELECT xmin::text FROM auth_sessions WHERE id=${f.session.id}::uuid`,
      before,
    );
    assert.equal(
      (
        await f.db.authSession.findUniqueOrThrow({
          where: { id: f.session.id },
        })
      ).lastSeenAt.getTime(),
      base + 500,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
for (const change of ["revoked", "disabled", "expired"] as const)
  test(`an activity request waiting for locks cannot revive ${change} authentication`, async (t) => {
    const f = await fixture(1, 60);
    let release!: () => void;
    let entered!: () => void;
    const locked = new Promise<void>((r) => (entered = r)),
      finish = new Promise<void>((r) => (release = r));
    try {
      const base = f.session.lastSeenAt.getTime();
      t.mock.timers.enable({ apis: ["Date"], now: base + 500 });
      const blocker = f.db.$transaction(async (tx) => {
        if (change === "expired")
          await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id=${f.session.id}::uuid FOR UPDATE`;
        else {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(20260905,2)`;
          if (change === "revoked")
            await tx.authSession.update({
              where: { id: f.session.id },
              data: { revokedAt: new Date() },
            });
          else
            await tx.user.update({
              where: { id: f.actor.id },
              data: { isActive: false },
            });
        }
        entered();
        await finish;
      });
      await locked;
      const pending = f.service.activity(f.actorSession);
      const rejected = assert.rejects(pending, /登录已失效/);
      await new Promise((r) => setTimeout(r, 50));
      if (change === "expired") t.mock.timers.setTime(base + 1000);
      release();
      await blocker;
      await rejected;
      assert.equal(
        (
          await f.db.authSession.findUniqueOrThrow({
            where: { id: f.session.id },
          })
        ).lastSeenAt.getTime(),
        base,
      );
    } finally {
      release?.();
      t.mock.timers.reset();
      await f.close();
    }
  });
test("HTTP activity keeps CSRF/body protections, exposes auth-only interval and leaves absolute cookies unchanged", async () => {
  const f = await fixture();
  const app = await createApplication(f.env);
  try {
    const password = "synthetic-session-password";
    await f.db.user.update({
      where: { id: f.actor.id },
      data: { passwordHash: await hashPassword(password) },
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        Origin: f.env.appOrigin,
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: f.actor.username, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /Max-Age=2592000/);
    const current = (await login.json()) as { activityIntervalSeconds: number };
    assert.equal(current.activityIntervalSeconds, 300);
    const request = (body: unknown = {}, origin = f.env.appOrigin) =>
      fetch(base + "/api/auth/activity", {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Comiku-Request": "1",
          "Content-Type": "application/json",
          Cookie: cookie.split(";")[0],
        },
        body: JSON.stringify(body),
      });
    assert.equal((await request({}, "https://evil.invalid")).status, 403);
    assert.equal((await request({ extra: true })).status, 400);
    const result = await request();
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("set-cookie"), null);
    const logged = await f.db.authSession.findFirstOrThrow({
      where: { userId: f.actor.id, id: { not: f.session.id } },
    });
    const seen = logged.lastSeenAt;
    const me = await fetch(base + "/api/auth/me", {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert.equal(me.status, 200);
    assert.equal(
      ((await me.json()) as { activityIntervalSeconds: number })
        .activityIntervalSeconds,
      300,
    );
    assert.equal(
      (
        await f.db.authSession.findUniqueOrThrow({ where: { id: logged.id } })
      ).lastSeenAt.getTime(),
      seen.getTime(),
    );
    const logout = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: f.env.appOrigin,
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
        Cookie: cookie.split(";")[0],
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal((await request()).status, 401);
  } finally {
    await app.close();
    await f.db.accountAudit.deleteMany({
      where: { OR: [{ actorId: f.actor.id }, { targetId: f.actor.id }] },
    });
    await f.close();
  }
});

test("new sessions sample issuance time after administration waits rather than inheriting transaction-start time", async (t) => {
  const f = await fixture(1, 60);
  let release!: () => void, entered!: () => void;
  const locked = new Promise<void>((r) => (entered = r)),
    finish = new Promise<void>((r) => (release = r));
  try {
    const password = "synthetic-issuance-password";
    await f.db.user.update({
      where: { id: f.actor.id },
      data: { passwordHash: await hashPassword(password) },
    });
    const base = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: base });
    const blocker = f.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(20260905,2)`;
      entered();
      await finish;
    });
    await locked;
    const login = f.service.login(f.actor.username, password);
    await new Promise((r) => setTimeout(r, 100));
    t.mock.timers.setTime(base + 5000);
    release();
    await blocker;
    const issued = await login;
    const session = await f.db.authSession.findUniqueOrThrow({
      where: { id: issued.sessionId },
    });
    assert.equal(session.createdAt.getTime(), base + 5000);
    assert.equal(session.lastSeenAt.getTime(), base + 5000);
    assert.equal(session.expiresAt.getTime(), base + 65_000);
    await f.service.authenticate(issued.token);
  } finally {
    release?.();
    t.mock.timers.reset();
    await f.close();
  }
});
