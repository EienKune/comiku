import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Role } from "../src/generated/prisma/client.js";
import { permissionsFor } from "../src/common/access.js";
import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from "../src/users/password.js";
import { RateLimit } from "../src/auth/rate-limit.js";
import { parseEnvironment } from "../src/config/environment.js";
import { sessionCookieOptions } from "../src/auth/cookie.js";

test("password hashes use random salts and reject incorrect credentials", async () => {
  const password = "fixture-password-12345";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("incorrect", first), false);
  assert.equal(await verifyPassword(password, "invalid"), false);
  assert.equal(normalizeUsername(" MiKu_Test "), "miku_test");
});
test("temporary-password and roleless users cannot use administrative or team permissions", () => {
  assert.deepEqual(permissionsFor([Role.admin], true), ["self"]);
  assert.deepEqual(permissionsFor([], false), ["self"]);
  for (const role of Object.values(Role).filter((r) => r !== Role.admin)) {
    const permissions = permissionsFor([role], false);
    assert.deepEqual(permissions.slice(0, 3), [
      "self",
      "members:read",
      "authors:read",
    ]);
    assert.equal(permissions.includes("accounts:manage"), false);
  }
  assert.ok(permissionsFor([Role.source], false).includes("authors:manage"));
  assert.equal(
    permissionsFor([Role.reviewer], false).includes("authors:sensitive"),
    false,
  );
  assert.ok(permissionsFor([Role.source], false).includes("authors:sensitive"));
  assert.ok(
    permissionsFor([Role.admin, Role.reviewer], false).includes(
      "accounts:manage",
    ),
  );
});
test("rate limits reject repeated attempts", () => {
  const limiter = new RateLimit();
  limiter.check("fixture", 2);
  limiter.check("fixture", 2);
  assert.throws(() => limiter.check("fixture", 2), /操作过于频繁/);
  assert.doesNotThrow(() => limiter.check("another", 2));
});
test("production requires an explicit HTTPS origin", () => {
  const input = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/comiku_test",
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "fixture-access-key",
    R2_SECRET_ACCESS_KEY: "fixture-secret-key",
    R2_BUCKET: "comiku-private",
  };
  for (const origin of [
    undefined,
    "http://comiku.test",
    "https://comiku.test/",
    "https://comiku.test/path",
  ]) {
    assert.throws(
      () => parseEnvironment({ ...input, APP_ORIGIN: origin }),
      /APP_ORIGIN/,
    );
  }
  assert.equal(
    parseEnvironment({ ...input, APP_ORIGIN: "https://comiku.test" }).appOrigin,
    "https://comiku.test",
  );
});

test("production cookies are Secure and HttpOnly, scoped to the API", () => {
  const env = parseEnvironment({
    NODE_ENV: "production",
    APP_ORIGIN: "https://comiku.test",
    DATABASE_URL: "postgresql://localhost/comiku_test",
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "fixture-access-key",
    R2_SECRET_ACCESS_KEY: "fixture-secret-key",
    R2_BUCKET: "comiku-private",
  });
  assert.deepEqual(sessionCookieOptions(env), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api",
  });
  assert.equal(
    sessionCookieOptions({ ...env, nodeEnv: "development" }).secure,
    false,
  );
});
