import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createApplication } from "../../src/application.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import { SiteIconService } from "../../src/site/site-icon.service.js";
import { SiteService } from "../../src/site/site.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../src/files/object-storage.js";

import type {
  SiteSettingsDto,
  SiteIconUploadDto,
} from "../../src/site/site.dto.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

async function waitForLock(db: PrismaService, objid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<
      { waiting: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=${objid}::bigint::oid AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
    if (rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected advisory lock wait was not observed");
}
test("site settings keep anonymous assets, CAS, account barriers and recoverable preparation separate", async (t) => {
  const app = await createApplication(
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      OBJECT_STORAGE_DRIVER: "memory",
    }),
  );
  await app.listen(0, "127.0.0.1");
  const db = app.get(PrismaService),
    icons = app.get(SiteIconService),
    files = app.get(FileObjectsService),
    storage = app.get<ObjectStorage>(OBJECT_STORAGE),
    base = await app.getUrl();
  const prefix = "site" + randomUUID().slice(0, 8),
    password = "synthetic-site-password",
    passwordHash = await hashPassword(password);
  const ids: string[] = [];
  async function request(
    path: string,
    method = "GET",
    body?: object,
    cookie?: string,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function account(admin: boolean) {
    const user = await db.user.create({
      data: {
        username: prefix + ids.length,
        displayName: prefix,
        passwordHash,
        mustChangePassword: false,
        roles: { create: { role: admin ? "admin" : "translator" } },
      },
    });
    ids.push(user.id);
    const response = await request("/api/auth/login", "POST", {
      username: user.username,
      password,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const session = await db.authSession.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return { cookie, actor: { userId: user.id, sessionId: session.id } };
  }
  const admin = await account(true),
    member = await account(false);
  const original = await db.siteSettings.findUnique({
    where: { id: "global" },
  });
  const png = await sharp({
    create: { width: 40, height: 25, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  const readSettings = async () =>
    (await (await request("/api/site")).json()) as SiteSettingsDto;
  const save = (revision: number, changes: object = {}) =>
    request(
      "/api/site/settings",
      "PATCH",
      {
        name: "Comiku",
        themePresetId: "teal",
        expectedRevision: revision,
        iconAction: "keep",
        ...changes,
      },
      admin.cookie,
    );
  try {
    await t.test(
      "rounded theme presets survive HTTP save and readback",
      async () => {
        for (const themePresetId of ["schale", "archive", "shittim"]) {
          const current = await readSettings();
          const response = await save(current.revision, { themePresetId });
          assert.equal(response.status, 200);
          assert.equal((await readSettings()).themePresetId, themePresetId);
        }
        const current = await readSettings();
        assert.equal((await save(current.revision)).status, 200);
      },
    );
    await t.test("anonymous fields, ETag and administrator scope", async () => {
      const response = await request("/api/site"),
        value = (await response.json()) as SiteSettingsDto;
      assert.deepEqual(Object.keys(value).sort(), [
        "iconVersion",
        "name",
        "revision",
        "themePresetId",
      ]);
      const conditional = await fetch(base + "/api/site", {
        headers: { "If-None-Match": response.headers.get("etag")! },
      });
      assert.equal(conditional.status, 304);
      assert.equal((await request("/api/site/settings")).status, 401);
      assert.equal(
        (await request("/api/site/settings", "GET", undefined, member.cookie))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            "/api/site/settings",
            "PATCH",
            { name: "x" },
            member.cookie,
          )
        ).status,
        403,
      );
    });
    await t.test(
      "real concurrent saves give one success and one conflict; no-op preserves revision",
      async () => {
        const before = await readSettings();
        const results = await Promise.all([
          save(before.revision, { name: "团队一" }),
          save(before.revision, { name: "团队二" }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const current = await readSettings();
        const unchanged = await save(current.revision, { name: current.name });
        assert.equal(
          ((await unchanged.json()) as SiteSettingsDto).revision,
          current.revision,
        );
        assert.equal(
          (await save(current.revision, { name: "a\nb" })).status,
          400,
        );
      },
    );
    await t.test(
      "multipart upload remains private until adoption and only current derivatives are public",
      async () => {
        const body = new FormData();
        body.append("file", new Blob([png], { type: "image/png" }), "logo.png");
        const uploaded = await fetch(base + "/api/site/icon-uploads", {
          method: "POST",
          headers: {
            Cookie: admin.cookie,
            Origin: "http://localhost:5173",
            "X-Comiku-Request": "1",
          },
          body,
        });
        assert.equal(uploaded.status, 201, await uploaded.clone().text());
        const prepared = (await uploaded.json()) as SiteIconUploadDto;
        assert.equal(
          (await request(`/api/site/icon/${prepared.assetId}/32`)).status,
          404,
        );
        const current = await readSettings();
        assert.equal(
          (
            await save(current.revision, {
              iconAction: "adopt",
              assetId: prepared.assetId,
            })
          ).status,
          200,
        );
        for (const size of [32, 256]) {
          const icon = await request(
            `/api/site/icon/${prepared.assetId}/${size}`,
          );
          assert.equal(icon.status, 200);
          assert.equal(icon.headers.get("content-type"), "image/png");
          const metadata = await sharp(
            Buffer.from(await icon.arrayBuffer()),
          ).metadata();
          assert.equal(metadata.width, size);
        }
        const asset = await db.siteBrandAsset.findUniqueOrThrow({
          where: { id: prepared.assetId },
        });
        const adopted = await readSettings();
        const auditCount = await db.accountAudit.count({
          where: {
            actorId: admin.actor.userId,
            action: "site.settings.updated",
          },
        });
        assert.equal(
          (
            await save(current.revision, {
              iconAction: "adopt",
              assetId: prepared.assetId,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await save(adopted.revision, {
              iconAction: "adopt",
              assetId: prepared.assetId,
            })
          ).status,
          200,
        );
        assert.equal((await readSettings()).revision, adopted.revision);
        assert.equal(
          await db.accountAudit.count({
            where: {
              actorId: admin.actor.userId,
              action: "site.settings.updated",
            },
          }),
          auditCount,
        );
        await files.purgeUnreferenced(asset.iconFileId);
        assert.ok(
          await db.fileObject.findUnique({ where: { id: asset.iconFileId } }),
        );
        assert.equal(
          (await request(`/api/site/icon/${asset.iconFileId}/32`)).status,
          404,
        );
        assert.equal(
          (await request(`/api/site/icon/${prepared.assetId}/800`)).status,
          404,
        );
        const beforeRemove = await readSettings();
        await save(beforeRemove.revision, { iconAction: "remove" });
        assert.equal(
          (await request(`/api/site/icon/${prepared.assetId}/32`)).status,
          404,
        );
        await db.siteBrandAsset.update({
          where: { id: asset.id },
          data: { expiresAt: new Date(0) },
        });
        await icons.cleanup();
        assert.equal(
          await db.siteBrandAsset.count({ where: { id: asset.id } }),
          0,
        );
      },
    );
    await t.test(
      "second object failure remains discoverable and cleanup is retryable",
      async () => {
        const originalPut = storage.put.bind(storage);
        let calls = 0;
        storage.put = async (input) => {
          if (++calls === 2) throw new Error("synthetic-second-put");
          await originalPut(input);
        };
        try {
          await assert.rejects(
            icons.prepare(admin.actor, png, "image/png"),
            /synthetic-second-put/,
          );
        } finally {
          storage.put = originalPut;
        }
        const prepared = await db.siteBrandAsset.findFirstOrThrow({
          where: { createdById: admin.actor.userId, status: "preparing" },
        });
        await icons.cleanup();
        assert.equal(
          await db.siteBrandAsset.count({ where: { id: prepared.id } }),
          0,
        );
        assert.equal(
          await db.fileObject.count({
            where: {
              id: { in: [prepared.iconFileId, prepared.faviconFileId] },
            },
          }),
          0,
        );
        const release = icons.acquire();
        assert.throws(
          () => icons.acquire(),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "getStatus" in error &&
            (error as { getStatus(): number }).getStatus() === 429,
        );
        try {
          const body = new FormData();
          body.append(
            "file",
            new Blob([png], { type: "image/png" }),
            "busy.png",
          );
          const busy = await fetch(base + "/api/site/icon-uploads", {
            method: "POST",
            headers: {
              Cookie: admin.cookie,
              Origin: "http://localhost:5173",
              "X-Comiku-Request": "1",
            },
            body,
          });
          assert.equal(busy.status, 429);
        } finally {
          release();
        }
        icons.acquire()();
      },
    );
    await t.test(
      "a ready-transaction failure can be recovered by a fresh service instance",
      async () => {
        const originalTransaction = db.$transaction.bind(db);
        let calls = 0;
        db.$transaction = ((...args: unknown[]) => {
          if (++calls === 3)
            return Promise.reject(new Error("synthetic-ready-transaction"));
          return Reflect.apply(originalTransaction, db, args);
        }) as typeof db.$transaction;
        try {
          await assert.rejects(
            icons.prepare(admin.actor, png, "image/png"),
            /synthetic-ready-transaction/,
          );
        } finally {
          db.$transaction = originalTransaction;
        }
        const asset = await db.siteBrandAsset.findFirstOrThrow({
          where: { createdById: admin.actor.userId, status: "preparing" },
        });
        const restarted = new SiteIconService(app.get(SiteService), storage);
        await restarted.cleanup();
        assert.equal(
          await db.siteBrandAsset.count({ where: { id: asset.id } }),
          0,
        );
        assert.equal(
          await storage.head(`system/site-brand/${asset.id}/256.png`),
          null,
        );
        assert.equal(
          await storage.head(`system/site-brand/${asset.id}/32.png`),
          null,
        );
      },
    );
    await t.test(
      "a settings writer keeps the shared account barrier until commit",
      async () => {
        const site = app.get(SiteService);
        let entered!: () => void, release!: () => void;
        const locked = new Promise<void>((resolve) => (entered = resolve)),
          gate = new Promise<void>((resolve) => (release = resolve));
        const holder = db.$transaction(
          async (tx) => {
            await site.lock(tx);
            entered();
            await gate;
          },
          { timeout: 10000 },
        );
        await locked;
        const current = await readSettings();
        const pending = site.update(admin.actor, {
          name: "commit-before-revocation",
          themePresetId: "teal",
          expectedRevision: current.revision,
          iconAction: "keep",
        });
        try {
          const [{ key }] = await db.$queryRaw<
            { key: number }[]
          >`SELECT (hashtext('comiku:site-settings')::bigint & 4294967295)::bigint AS key`;
          await waitForLock(db, Number(key));
          const revoke = db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260905,2)`;
            await tx.userRole.deleteMany({
              where: { userId: admin.actor.userId },
            });
          });
          await waitForLock(db, 2);
          release();
          await holder;
          await pending;
          await revoke;
          assert.equal((await readSettings()).name, "commit-before-revocation");
          await db.userRole.create({
            data: { userId: admin.actor.userId, role: "admin" },
          });
        } finally {
          release();
          await holder;
        }
      },
    );
    await t.test(
      "one failed icon deletion backs off while later expired assets still clean up",
      async () => {
        const first = await icons.prepare(admin.actor, png, "image/png"),
          second = await icons.prepare(admin.actor, png, "image/png");
        await db.siteBrandAsset.updateMany({
          where: { id: { in: [first.assetId, second.assetId] } },
          data: { expiresAt: new Date(0) },
        });
        const originalDelete = storage.delete.bind(storage);
        storage.delete = async (key) => {
          if (key.includes(first.assetId))
            throw new Error("synthetic-delete-failure");
          await originalDelete(key);
        };
        try {
          await icons.cleanup();
        } finally {
          storage.delete = originalDelete;
        }
        const retained = await db.siteBrandAsset.findUniqueOrThrow({
          where: { id: first.assetId },
        });
        assert.equal(retained.status, "deleting");
        assert.ok(retained.expiresAt! > new Date());
        assert.equal(
          await db.siteBrandAsset.count({ where: { id: second.assetId } }),
          0,
        );
        await db.siteBrandAsset.update({
          where: { id: first.assetId },
          data: { expiresAt: new Date(0) },
        });
        await icons.cleanup();
      },
    );
    await t.test(
      "revocation wins at the account barrier before settings can commit",
      async () => {
        let entered!: () => void, release!: () => void;
        const locked = new Promise<void>((resolve) => (entered = resolve)),
          gate = new Promise<void>((resolve) => (release = resolve));
        const holder = db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260905,2)`;
          await tx.userRole.deleteMany({
            where: { userId: admin.actor.userId },
          });
          entered();
          await gate;
        });
        await locked;
        const current = await readSettings();
        const pending = app
          .get(SiteService)
          .update(admin.actor, {
            name: "must-not-commit",
            themePresetId: "teal",
            expectedRevision: current.revision,
            iconAction: "keep",
          })
          .then(
            () => 200,
            (error: { getStatus(): number }) => error.getStatus(),
          );
        try {
          await waitForLock(db, 2);
        } finally {
          release();
        }
        await holder;
        assert.equal(await pending, 403);
        assert.notEqual((await readSettings()).name, "must-not-commit");
      },
    );
  } finally {
    await db.siteSettings.deleteMany();
    if (original) await db.siteSettings.create({ data: original });
    await db.siteBrandAsset.updateMany({
      where: { createdById: { in: ids } },
      data: { expiresAt: new Date(0) },
    });
    await icons.cleanup();
    await db.accountAudit.deleteMany({ where: { actorId: { in: ids } } });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userRole.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  }
});
