import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { RateLimit } from "../src/auth/rate-limit.js";
import { parseEnvironment } from "../src/config/environment.js";
import type { AccessPolicy } from "../src/common/access.js";
test("activity has bounded independent rate buckets without consuming ordinary write allowance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let policy: AccessPolicy = {
    permission: "self",
    allowPasswordChange: true,
    rateClass: "session-activity",
  };
  const request = {
    method: "POST",
    headers: {
      origin: "http://localhost:5173",
      "x-comiku-request": "1",
      cookie: "comiku_session=fixture",
    },
    is: () => true,
    ip: "127.0.0.1",
  };
  const guard = new AuthGuard(
    { getAllAndOverride: () => policy } as never,
    {
      authenticate: async () => ({
        actor: { userId: "actor", sessionId: "session" },
        user: { permissions: ["self"], mustChangePassword: false },
      }),
    } as never,
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/comiku_test",
    }),
    new RateLimit(),
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => null,
    getClass: () => null,
  } as never;
  for (let i = 0; i < 700; i++) {
    t.mock.timers.setTime(1000 + i * 500);
    assert.equal(await guard.canActivate(context), true);
  }
  policy = { permission: "self" };
  for (let i = 0; i < 600; i++)
    assert.equal(await guard.canActivate(context), true);
  await assert.rejects(guard.canActivate(context), /操作过于频繁/);
  policy = { permission: "self", rateClass: "session-activity" };
  assert.equal(await guard.canActivate(context), true);
  request.headers.origin = "https://evil.invalid";
  await assert.rejects(guard.canActivate(context), /请求来源/);
});
