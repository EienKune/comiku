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
import { AuthorsService } from "../../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
}

type Browser = { cookie?: string; userId?: string };

test("author, tag, authorization and multi-platform account lifecycle", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  // X CRUD with collection enabled requires a declared source capability.
  // Supply a synthetic gallery capability explicitly; lifecycle tests never
  // execute collection or depend on the retired clients' implicit placeholders.
  app.get(ContentSourceRegistry).register({
    platform: "x",
    adapterKey: "x_gallery_dl",
    priority: 1,
    available: true,
    metered: false,
    supportedFirstSyncModes: ["none", "last_24_hours"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async () => {
      throw new Error(
        "Author lifecycle fixture must not resolve source profiles",
      );
    },
    fetchPage: async () => {
      throw new Error("Author lifecycle fixture must not fetch source pages");
    },
  });
  const db = app.get(PrismaService);
  const authors = app.get(AuthorsService);
  const prefix = `authors_${randomUUID().slice(0, 8)}`;
  const password = "fixture-password-12345";
  const userIds: string[] = [];
  let base = "";

  async function request<T>(
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

  async function createBrowser(role: "source" | "reviewer" | "translator") {
    const user = await db.user.create({
      data: {
        username: `${prefix}_${role}`,
        displayName: role,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    userIds.push(user.id);
    const browser: Browser = { userId: user.id };
    const login = await request<object>(browser, "POST", "/api/auth/login", {
      username: user.username,
      password,
    });
    assert.equal(login.status, 200);
    return browser;
  }

  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const source = await createBrowser("source");
    const reviewer = await createBrowser("reviewer");
    const member = await createBrowser("translator");

    const input = {
      displayName: "测试作者",
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tagNames: ["原创", " 插画 "],
    };
    assert.equal(
      (await request(member, "POST", "/api/authors", input)).status,
      403,
    );
    const created = await request<{
      id: string;
      revision: number;
      tags: { id: string; name: string; revision: number }[];
    }>(source, "POST", "/api/authors", input);
    assert.equal(created.status, 201);
    const authorId = created.data.id;
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64",
    );
    const avatar = await authors.uploadAvatar(
      source.userId!,
      authorId,
      created.data.revision,
      {
        buffer: image,
        mimetype: "image/png",
        originalname: "avatar.png",
        size: image.byteLength,
      },
    );
    assert.equal(avatar.avatarAvailable, true);
    const evidence = await authors.uploadEvidence(
      source.userId!,
      authorId,
      avatar.revision,
      [
        {
          buffer: image,
          mimetype: "image/png",
          originalname: "authorization.png",
          size: image.byteLength,
        },
      ],
    );
    assert.equal(evidence.length, 1);
    assert.match(evidence[0].url, /^memory:\/\//);
    const authorRevision = avatar.revision + 1;

    const visible = await request<{ items: Record<string, unknown>[] }>(
      member,
      "GET",
      "/api/authors",
    );
    assert.equal(visible.status, 200);
    assert.equal("authorizationNote" in visible.data.items[0], false);
    assert.equal(
      (
        await request(
          member,
          "GET",
          `/api/authors/${authorId}/authorization-evidence`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          reviewer,
          "GET",
          `/api/authors/${authorId}/authorization-evidence`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          source,
          "GET",
          `/api/authors/${authorId}/authorization-evidence`,
        )
      ).status,
      200,
    );

    const account = await request<{
      id: string;
      revision: number;
      providerAvailable: boolean;
    }>(source, "POST", `/api/authors/${authorId}/accounts`, {
      platform: "X",
      externalUserId: `fixture-${prefix}`,
      handle: "fixture",
      profileUrl: "https://x.com/fixture",
      displayNameSnapshot: "Fixture",
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
    });
    assert.equal(account.status, 201);
    assert.equal(account.data.providerAvailable, true);
    const managedAccounts = await request<
      { id: string; externalUserId: string; fetchEnabled: boolean }[]
    >(source, "GET", `/api/authors/${authorId}/accounts`);
    assert.equal(managedAccounts.status, 200);
    assert.equal(managedAccounts.data[0].id, account.data.id);
    assert.equal(managedAccounts.data[0].fetchEnabled, true);
    assert.equal(
      (await request(member, "GET", `/api/authors/${authorId}/accounts`))
        .status,
      403,
    );
    const filtered = await request<{ items: { id: string }[] }>(
      member,
      "GET",
      "/api/authors?search=%40fixture&platform=x&tag=%E5%8E%9F%E5%88%9B&authorizationStatus=authorized",
    );
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      filtered.data.items.map((item) => item.id),
      [authorId],
    );
    const publicAccount = (
      await request<{ externalAccounts: Record<string, unknown>[] }>(
        member,
        "GET",
        `/api/authors/${authorId}`,
      )
    ).data.externalAccounts[0];
    assert.equal("fetchEnabled" in publicAccount, false);
    assert.equal(publicAccount.externalUserId, `fixture-${prefix}`);
    const updatedAccount = await request<{ revision: number }>(
      source,
      "PATCH",
      `/api/authors/${authorId}/accounts/${account.data.id}`,
      {
        handle: "updated",
        profileUrl: null,
        displayNameSnapshot: null,
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: account.data.revision,
      },
    );
    assert.equal(updatedAccount.status, 200);
    assert.equal(
      (
        await request(
          source,
          "PATCH",
          `/api/authors/${authorId}/accounts/${account.data.id}`,
          {
            handle: "stale",
            profileUrl: null,
            displayNameSnapshot: null,
            fetchEnabled: false,
            firstSyncMode: "none",
            expectedRevision: account.data.revision,
          },
        )
      ).status,
      409,
    );
    const pixivId = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    ).toString();
    const pixiv = await request<{
      id: string;
      revision: number;
      adapterStates: unknown[];
      providerAvailable: boolean;
      fetchEnabled: boolean;
      profileUrl: string;
      handle: string | null;
    }>(source, "POST", `/api/authors/${authorId}/accounts`, {
      platform: "pixiv",
      externalUserId: pixivId,
      handle: "fixture-pixiv",
      profileUrl: "https://www.pixiv.net/users/123",
      fetchEnabled: false,
      firstSyncMode: "none",
    });
    assert.equal(pixiv.status, 201);
    assert.deepEqual(pixiv.data.adapterStates, []);
    assert.equal(pixiv.data.providerAvailable, false);
    assert.equal(pixiv.data.fetchEnabled, false);
    const unavailableActivation = await request(
      source,
      "PATCH",
      `/api/authors/${authorId}/accounts/${pixiv.data.id}`,
      {
        fetchEnabled: true,
        firstSyncMode: "last_24_hours",
        expectedRevision: pixiv.data.revision,
      },
    );
    assert.equal(unavailableActivation.status, 400);
    const stillPaused = await request<
      { id: string; revision: number; fetchEnabled: boolean }[]
    >(source, "GET", `/api/authors/${authorId}/accounts`);
    assert.equal(stillPaused.status, 200);
    const pausedPixiv = stillPaused.data.find(
      (item) => item.id === pixiv.data.id,
    );
    assert.equal(pausedPixiv?.fetchEnabled, false);
    assert.equal(pausedPixiv?.revision, pixiv.data.revision);
    assert.equal(pixiv.data.handle, null);
    assert.equal(
      pixiv.data.profileUrl,
      `https://www.pixiv.net/users/${pixivId}`,
    );
    assert.equal(
      (
        await request(source, "POST", `/api/authors/${authorId}/accounts`, {
          platform: "pixiv",
          externalUserId: (BigInt(pixivId) + 1n).toString(),
          fetchEnabled: false,
          firstSyncMode: "none",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(source, "POST", `/api/authors/${authorId}/accounts`, {
          platform: "x",
          externalUserId: `other-${prefix}`,
          handle: "other",
          fetchEnabled: false,
          firstSyncMode: "none",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          member,
          "DELETE",
          `/api/authors/${authorId}/accounts/${pixiv.data.id}`,
          { expectedRevision: pixiv.data.revision },
        )
      ).status,
      403,
    );
    const replacement = await request<{ id: string; revision: number }>(
      source,
      "PATCH",
      `/api/authors/${authorId}/accounts/${pixiv.data.id}`,
      {
        externalUserId: (BigInt(pixivId) + 2n).toString(),
        displayNameSnapshot: "新昵称",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: pixiv.data.revision,
      },
    );
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.data.id, pixiv.data.id);
    const archivedAccounts = await request<{ id: string; revision: number }[]>(
      source,
      "GET",
      `/api/authors/${authorId}/accounts/archived`,
    );
    assert.equal(archivedAccounts.data.length, 1);
    const oldAccount = archivedAccounts.data[0];
    assert.equal(oldAccount.id, pixiv.data.id);
    assert.equal(
      (
        await request(
          source,
          "POST",
          `/api/authors/${authorId}/accounts/${oldAccount.id}/restore`,
          { expectedRevision: oldAccount.revision },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          source,
          "DELETE",
          `/api/authors/${authorId}/accounts/${replacement.data.id}`,
          { expectedRevision: replacement.data.revision },
        )
      ).status,
      200,
    );
    const restoredAccount = await request<{ fetchEnabled: boolean }>(
      source,
      "POST",
      `/api/authors/${authorId}/accounts/${oldAccount.id}/restore`,
      { expectedRevision: oldAccount.revision },
    );
    assert.equal(restoredAccount.status, 200);
    assert.equal(restoredAccount.data.fetchEnabled, false);
    assert.equal(
      (
        await request(
          source,
          "PATCH",
          `/api/authors/${authorId}/accounts/${oldAccount.id}`,
          {
            externalUserId: "not-a-number",
            fetchEnabled: false,
            firstSyncMode: "none",
            expectedRevision: oldAccount.revision + 1,
          },
        )
      ).status,
      400,
    );

    const raceAuthor = await request<{ id: string }>(
      source,
      "POST",
      "/api/authors",
      input,
    );
    const races = await Promise.all(
      [1, 2].map((index) =>
        request(source, "POST", `/api/authors/${raceAuthor.data.id}/accounts`, {
          platform: "x",
          externalUserId: `race-${prefix}-${index}`,
          handle: "race",
          fetchEnabled: false,
          firstSyncMode: "none",
        }),
      ),
    );
    assert.deepEqual(races.map((result) => result.status).sort(), [201, 409]);

    const tag = await request<{ id: string; revision: number }>(
      source,
      "POST",
      "/api/authors/tags",
      {
        name: "短篇",
      },
    );
    assert.equal(tag.status, 201);
    assert.equal(
      (
        await request(source, "PATCH", `/api/authors/tags/${tag.data.id}`, {
          name: "短篇漫画",
          expectedRevision: tag.data.revision,
        })
      ).status,
      200,
    );

    assert.equal(
      (
        await request(source, "DELETE", `/api/authors/${authorId}`, {
          expectedRevision: created.data.revision,
        })
      ).status,
      403,
    );
    const archived = await authors.archive(authorId, authorRevision);
    assert.equal(
      (await request(member, "GET", `/api/authors/${authorId}`)).status,
      404,
    );
    assert.equal(
      (await request(source, "GET", "/api/authors/archived")).status,
      403,
    );
    assert.equal(
      (await authors.listArchived()).some((item) => item.id === authorId),
      true,
    );
    assert.equal(
      (await authors.restore(authorId, archived.revision)).id,
      authorId,
    );
  } finally {
    await db.authorTag.deleteMany({
      where: { author: { displayName: "测试作者" } },
    });
    const evidence = await db.authorAuthorizationEvidence.findMany({
      where: { author: { displayName: "测试作者" } },
      select: { fileObjectId: true },
    });
    const authorFiles = await db.author.findMany({
      where: { displayName: "测试作者" },
      select: { avatarFileObjectId: true },
    });
    await db.authorAuthorizationEvidence.deleteMany({
      where: { author: { displayName: "测试作者" } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { author: { displayName: "测试作者" } },
    });
    await db.author.deleteMany({ where: { displayName: "测试作者" } });
    await db.fileObject.deleteMany({
      where: {
        id: {
          in: [
            ...evidence.map((item) => item.fileObjectId),
            ...authorFiles.flatMap((item) =>
              item.avatarFileObjectId ? [item.avatarFileObjectId] : [],
            ),
          ],
        },
      },
    });
    await db.tag.deleteMany({
      where: { name: { in: ["原创", "插画", "短篇", "短篇漫画"] } },
    });
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
