import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import type {
  ManagedAuthorDto,
  AuthorDto,
  ExternalAccountDto,
} from "../../src/authors/authors.dto.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("management notes persist, respect revision fences and remain absent for public-role reads", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const db = app.get(PrismaService);
  const prefix = `notes_${randomUUID()}`;
  const userIds: string[] = [];
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
  async function login(role: "source" | "admin" | "translator" | "reviewer") {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${role}`,
        displayName: role,
        passwordHash: await hashPassword("fixture-password-12345"),
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    userIds.push(user.id);
    const result = await request<object>("", "POST", "/api/auth/login", {
      username: user.username,
      password: "fixture-password-12345",
    });
    assert.equal(result.status, 200);
    return { id: user.id, cookie: result.cookie };
  }
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const source = await login("source"),
      admin = await login("admin"),
      translator = await login("translator"),
      reviewer = await login("reviewer");
    const input = {
      displayName: prefix,
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tagNames: [],
      notes: " author private ",
      idempotencyKey: randomUUID(),
      accounts: [
        {
          platform: "pixiv",
          externalUserId: `${Date.now()}`,
          fetchEnabled: false,
          firstSyncMode: "none",
          notes: " account private ",
        },
      ],
    };
    const created = await request<ManagedAuthorDto>(
      source.cookie,
      "POST",
      "/api/authors",
      input,
    );
    assert.equal(created.status, 201);
    const id = created.data.id,
      account = created.data.externalAccounts[0];
    assert.equal(created.data.notes, "author private");
    assert.equal(account.notes, "account private");
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id } })).notes,
      "author private",
    );
    assert.equal(
      (
        await db.authorExternalAccount.findUniqueOrThrow({
          where: { id: account.id },
        })
      ).notes,
      "account private",
    );
    for (const actor of [source, admin]) {
      const managed = await request<ManagedAuthorDto>(
        actor.cookie,
        "GET",
        `/api/authors/${id}/managed`,
      );
      assert.equal(managed.status, 200);
      assert.equal(managed.data.notes, "author private");
    }
    for (const actor of [translator, reviewer]) {
      assert.equal(
        (await request(actor.cookie, "GET", `/api/authors/${id}/managed`))
          .status,
        403,
      );
      const publicRead = await request<AuthorDto>(
        actor.cookie,
        "GET",
        `/api/authors/${id}`,
      );
      assert.equal(publicRead.status, 200);
      assert.equal(Object.hasOwn(publicRead.data, "notes"), false);
      assert.equal(
        Object.hasOwn(publicRead.data.externalAccounts[0], "notes"),
        false,
      );
      const page = await request<{ items: AuthorDto[] }>(
        actor.cookie,
        "GET",
        `/api/authors?search=${encodeURIComponent(prefix)}`,
      );
      assert.equal(page.status, 200);
      assert.equal(page.data.items.length, 1);
      assert.equal(JSON.stringify(page.data).includes("private"), false);
      assert.equal(
        (
          await request(actor.cookie, "PATCH", `/api/authors/${id}`, {
            ...input,
            accounts: undefined,
            idempotencyKey: undefined,
            expectedRevision: 0,
          })
        ).status,
        403,
      );
    }
    const fields = {
      displayName: prefix,
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tagNames: [],
    };
    const preserved = await request<ManagedAuthorDto>(
      admin.cookie,
      "PATCH",
      `/api/authors/${id}`,
      { ...fields, expectedRevision: 0 },
    );
    assert.equal(preserved.status, 200);
    assert.equal(preserved.data.notes, "author private");
    assert.equal(
      (
        await request(source.cookie, "PATCH", `/api/authors/${id}`, {
          ...fields,
          notes: "stale",
          expectedRevision: 0,
        })
      ).status,
      409,
    );
    const oversized = await request(
      source.cookie,
      "PATCH",
      `/api/authors/${id}`,
      { ...fields, notes: "x".repeat(2001), expectedRevision: 1 },
    );
    assert.equal(oversized.status, 400);
    const cleared = await request<ManagedAuthorDto>(
      source.cookie,
      "PATCH",
      `/api/authors/${id}`,
      { ...fields, notes: " ", expectedRevision: 1 },
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.notes, null);
    const accountFields = { fetchEnabled: false, firstSyncMode: "none" };
    const untouched = await request<ExternalAccountDto>(
      admin.cookie,
      "PATCH",
      `/api/authors/${id}/accounts/${account.id}`,
      { ...accountFields, expectedRevision: 0 },
    );
    assert.equal(untouched.status, 200);
    assert.equal(untouched.data.notes, "account private");
    const saved = await request<ExternalAccountDto>(
      source.cookie,
      "PATCH",
      `/api/authors/${id}/accounts/${account.id}`,
      { ...accountFields, notes: " next ", expectedRevision: 1 },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.data.notes, "next");
    assert.equal(
      (
        await request(
          source.cookie,
          "PATCH",
          `/api/authors/${id}/accounts/${account.id}`,
          { ...accountFields, notes: "stale", expectedRevision: 1 },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          source.cookie,
          "PATCH",
          `/api/authors/${id}/accounts/${account.id}`,
          { ...accountFields, notes: "x".repeat(2001), expectedRevision: 2 },
        )
      ).status,
      400,
    );
    const clearAccount = await request<ExternalAccountDto>(
      source.cookie,
      "PATCH",
      `/api/authors/${id}/accounts/${account.id}`,
      { ...accountFields, notes: null, expectedRevision: 2 },
    );
    assert.equal(clearAccount.status, 200);
    assert.equal(clearAccount.data.notes, null);
    assert.equal(
      (
        await request(source.cookie, "POST", "/api/authors", {
          ...input,
          notes: "different intent",
        })
      ).status,
      409,
    );
    // Seed the exact pre-notes canonical hash to simulate a committed older request.
    const legacyKey = randomUUID();
    const legacyPayload = {
      displayName: prefix,
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tags: [],
      accounts: [],
    };
    await db.authorCreationRequest.create({
      data: {
        actorId: source.id,
        idempotencyKey: legacyKey,
        authorId: id,
        payloadHash: createHash("sha256")
          .update(JSON.stringify(legacyPayload))
          .digest("hex"),
      },
    });
    const replay = await request<ManagedAuthorDto>(
      source.cookie,
      "POST",
      "/api/authors",
      { ...fields, notes: null, accounts: [], idempotencyKey: legacyKey },
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.data.id, id);
    assert.equal(
      (
        await request(source.cookie, "POST", "/api/authors", {
          ...fields,
          notes: "new intent",
          idempotencyKey: legacyKey,
        })
      ).status,
      409,
    );
  } finally {
    const authors = { displayName: { startsWith: prefix } };
    await db.authorCreationRequest.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await db.sourceAdapterState.deleteMany({
      where: { externalAccount: { author: authors } },
    });
    await db.authorExternalAccount.deleteMany({ where: { author: authors } });
    await db.authorTag.deleteMany({ where: { author: authors } });
    await db.author.deleteMany({ where: authors });
    await db.accountAudit.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
