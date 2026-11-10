import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import type {
  ManagedAuthorDto,
  ExternalAccountDto,
  ResolvedPixivProfileDto,
  AuthorDto,
} from "../../src/authors/authors.dto.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("Pixiv profile HTTP evidence persists with revision fences and keeps notes private", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const db = app.get(PrismaService),
    prefix = `pixiv_profile_${randomUUID()}`,
    users: string[] = [];
  let base = "",
    calls = 0;
  const platformScopes: string[] = [];
  // Replace provider and execution boundary with deterministic synthetic calls.
  // Durable lease/generation/auth behavior is verified by source-profile-scope tests.
  app.get(ContentSourceRegistry).register({
    platform: "pixiv",
    adapterKey: "pixiv_profile_fixture",
    available: true,
    priority: -1,
    metered: false,
    allowedMediaHosts: [],
    supportedFirstSyncModes: ["none"],
    initialCursor: () => ({}),
    fetchPage: async () => {
      throw new Error("Profile must not enumerate works");
    },
    checkAccount: async ({ externalUserId }) => {
      calls++;
      return {
        externalUserId,
        displayName: "Synthetic Pixiv Artist",
        profileUrl: `https://www.pixiv.net/users/${externalUserId}`,
      };
    },
  });
  app.get(SourceFetchService).platforms.profileNetwork = async <T>(
    _actor: string,
    run: () => Promise<T>,
    platform = "x",
  ) => {
    platformScopes.push(platform);
    return run();
  };
  async function request<T>(
    cookie: string,
    method: string,
    path: string,
    body?: object,
  ) {
    const res = await fetch(base + path, {
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
      status: res.status,
      data: (await res.json()) as T,
      cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  }
  async function login(role: "source" | "translator") {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${role}`,
        displayName: role,
        passwordHash: await hashPassword("fixture-password-12345"),
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    users.push(user.id);
    const result = await request<object>("", "POST", "/api/auth/login", {
      username: user.username,
      password: "fixture-password-12345",
    });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const source = await login("source"),
      translator = await login("translator"),
      externalUserId = BigInt(
        `0x${randomUUID().replaceAll("-", "").slice(0, 15)}`,
      ).toString();
    const created = await request<ManagedAuthorDto>(
      source,
      "POST",
      "/api/authors",
      {
        displayName: prefix,
        sourceLanguage: "ja",
        authorizationStatus: "authorized",
        existingTags: [],
        newTagNames: [],
        notes: "private author note",
        idempotencyKey: randomUUID(),
        accounts: [
          {
            platform: "pixiv",
            externalUserId,
            notes: "private account note",
            fetchEnabled: false,
            firstSyncMode: "none",
          },
        ],
      },
    );
    assert.equal(created.status, 201);
    const authorId = created.data.id,
      account = created.data.externalAccounts[0]!;
    const body = { externalUserId, authorId, accountId: account.id };
    assert.equal(
      (
        await request(
          translator,
          "POST",
          "/api/authors/pixiv-profile/resolve",
          body,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(source, "POST", "/api/authors/pixiv-profile/resolve", {
          ...body,
          externalUserId: "0",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(source, "POST", "/api/authors/pixiv-profile/resolve", {
          ...body,
          externalUserId: (BigInt(externalUserId) + 1n).toString(),
        })
      ).status,
      409,
    );
    assert.equal(calls, 0);
    const resolved = await request<ResolvedPixivProfileDto>(
      source,
      "POST",
      "/api/authors/pixiv-profile/resolve",
      body,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.handle, null);
    assert.equal(resolved.data.externalUserId, externalUserId);
    assert.equal(calls, 1);
    assert.deepEqual(platformScopes, ["pixiv"]);
    const update = {
      externalUserId,
      displayNameSnapshot: resolved.data.displayName,
      profileProof: resolved.data.profileProof,
      avatarFileObjectId: null,
      fetchEnabled: false,
      firstSyncMode: "none",
      expectedRevision: account.revision,
    };
    const saved = await request<ExternalAccountDto>(
      source,
      "PATCH",
      `/api/authors/${authorId}/accounts/${account.id}`,
      update,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.data.notes, "private account note");
    assert.equal(saved.data.displayNameSnapshot, "Synthetic Pixiv Artist");
    assert.equal(saved.data.revision, account.revision + 1);
    const row = await db.authorExternalAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    assert.equal(row.externalUserId, externalUserId);
    assert.equal(row.fetchEnabled, false);
    assert.equal(row.firstSyncMode, "none");
    assert.equal(row.notes, "private account note");
    assert.equal(
      (row.metadataJson as Record<string, unknown>).profileSyncAdapter,
      "pixiv_profile_fixture",
    );
    assert.equal(
      (
        await request(
          source,
          "PATCH",
          `/api/authors/${authorId}/accounts/${account.id}`,
          update,
        )
      ).status,
      409,
    );
    const publicRead = await request<AuthorDto>(
      translator,
      "GET",
      `/api/authors/${authorId}`,
    );
    assert.equal(publicRead.status, 200);
    assert.equal(JSON.stringify(publicRead.data).includes("private"), false);
    assert.equal(
      Object.hasOwn(publicRead.data.externalAccounts[0]!, "notes"),
      false,
    );
  } finally {
    const authors = { displayName: { startsWith: prefix } };
    await db.authorCreationRequest.deleteMany({
      where: { actorId: { in: users } },
    });
    await db.sourceAdapterState.deleteMany({
      where: { externalAccount: { author: authors } },
    });
    await db.authorExternalAccount.deleteMany({ where: { author: authors } });
    await db.authorTag.deleteMany({ where: { author: authors } });
    await db.author.deleteMany({ where: authors });
    await db.accountAudit.deleteMany({
      where: { OR: [{ actorId: { in: users } }, { targetId: { in: users } }] },
    });
    await db.authSession.deleteMany({ where: { userId: { in: users } } });
    await db.userRole.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  }
});
