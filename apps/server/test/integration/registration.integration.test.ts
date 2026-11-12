import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../../src/application.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";
import { UsersService } from "../../src/users/users.service.js";
import { WorksService } from "../../src/works/works.service.js";
import type {
  Role,
  WorkStage,
  WorkflowStatus,
} from "../../src/generated/prisma/client.js";
import type { RegistrationOptionsDto } from "../../src/users/registration.dto.js";
import type { UserDto } from "../../src/users/users.dto.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

test("public registration and administrator qualifications preserve account and task boundaries", async (t) => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl(),
    db = app.get(PrismaService),
    users = app.get(UsersService),
    works = app.get(WorksService);
  const prefix = "reg" + randomUUID().slice(0, 8),
    password = "synthetic-registration-password",
    passwordHash = await hashPassword(password);
  const original = await db.accountRegistrationSettings.findUnique({
    where: { id: "global" },
  });
  const author = await db.author.create({
    data: { displayName: prefix, authorizationStatus: "authorized" },
  });
  const workIds: string[] = [];
  const candidateIds: string[] = [];
  type Browser = { cookie?: string; id?: string };
  const anonymous: Browser = {};
  async function request<T = UserDto>(
    who: Browser,
    method: string,
    path: string,
    body?: object,
    origin = "http://localhost:5173",
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
        ...(who.cookie ? { Cookie: who.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) who.cookie = cookie.split(";")[0];
    return {
      status: response.status,
      data: (await response.json()) as T,
      headers: response.headers,
    };
  }
  async function account(suffix: string, roles: Role[] = ["translator"]) {
    const row = await db.user.create({
      data: {
        username: prefix + suffix,
        displayName: suffix,
        passwordHash,
        mustChangePassword: false,
        roles: { create: roles.map((role) => ({ role })) },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
    const browser: Browser = { id: row.id };
    assert.equal(
      (
        await request(browser, "POST", "/api/auth/login", {
          username: row.username,
          password,
        })
      ).status,
      200,
    );
    return browser as Browser & { id: string };
  }
  async function options() {
    const r = await request<RegistrationOptionsDto>(
      anonymous,
      "GET",
      "/api/auth/registration",
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    return r.data;
  }
  async function settings(
    admin: Browser,
    enabled: boolean,
    allowRoleSelection: boolean,
  ) {
    const before = await options();
    const r = await request<RegistrationOptionsDto>(
      admin,
      "PATCH",
      "/api/users/registration-settings",
      {
        enabled,
        allowRoleSelection,
        expectedRevision: before.revision,
        currentPassword: password,
      },
    );
    assert.equal(r.status, 200);
    return r.data;
  }
  async function work(status: WorkflowStatus = "pending_translate") {
    const candidate = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "manual",
        externalPostId: randomUUID(),
        externalPostUrl: "https://fixture.invalid/registration",
        postedAt: new Date(),
        rawJson: {},
      },
    });
    candidateIds.push(candidate.id);
    const row = await db.work.create({
      data: {
        authorId: author.id,
        sourceCandidatePostId: candidate.id,
        importedById: admin.id,
        sourcePostUrl: "https://fixture.invalid/registration",
        sourceLanguage: "ja",
        workflowStatus: status,
        title: prefix,
      },
    });
    workIds.push(row.id);
    return row;
  }
  async function actor(who: Browser & { id: string }) {
    const session = await db.authSession.findFirstOrThrow({
      where: { userId: who.id, revokedAt: null },
    });
    return { userId: who.id, sessionId: session.id };
  }
  async function manage(
    who: Browser & { id: string },
    roles: Role[],
    languageCapabilities: ("ja" | "ko")[] = ["ja"],
  ) {
    const current = await db.user.findUniqueOrThrow({ where: { id: who.id } });
    return users.manage(await actor(admin), who.id, {
      displayName: current.displayName,
      roles,
      languageCapabilities,
      isActive: true,
      expectedRevision: current.revision,
      currentPassword: password,
    });
  }
  async function waitForLock(
    mode: "ShareLock" | "ExclusiveLock",
    granted: boolean,
    minimum = 1,
  ) {
    for (let i = 0; i < 600; i++) {
      const [row] = await db.$queryRaw<
        { waiting: boolean }[]
      >`SELECT count(*) >= ${minimum}::int AS waiting FROM pg_locks WHERE locktype='advisory' AND classid=20260905 AND objid=2 AND granted=${granted}::boolean AND mode=${mode} AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
      if (row.waiting) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Account writer did not reach the shared barrier");
  }
  const admin = await account("admin", ["admin"]),
    member = await account("member");
  try {
    await db.accountRegistrationSettings.deleteMany();
    await t.test(
      "defaults closed, protects settings, and exposes only public options",
      async () => {
        const o = await options();
        assert.equal(o.enabled, false);
        assert.equal(o.allowRoleSelection, false);
        assert.equal(o.revision, 0);
        assert(!o.roles.some((r) => r.value === "admin"));
        assert.deepEqual(
          o.languageCapabilities.map((l) => l.value),
          ["ja", "ko"],
        );
        assert.equal(
          (await request(anonymous, "GET", "/api/users/registration-settings"))
            .status,
          401,
        );
        assert.equal(
          (await request(member, "GET", "/api/users/registration-settings"))
            .status,
          403,
        );
        assert.equal(
          (
            await request(admin, "PATCH", "/api/users/registration-settings", {
              enabled: true,
              allowRoleSelection: true,
              expectedRevision: 0,
              currentPassword: "wrong",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(anonymous, "POST", "/api/auth/register", {
              username: prefix + "closed",
              displayName: "Closed",
              password,
              roles: ["translator"],
              languageCapabilities: ["ja"],
              expectedSettingsRevision: 0,
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "settings CAS and no-op keep history and stale changes fenced",
      async () => {
        const first = await settings(admin, true, true);
        assert.equal(first.revision, 1);
        const again = await settings(admin, true, true);
        assert.deepEqual(again, first);
        assert.equal(
          (
            await request(admin, "PATCH", "/api/users/registration-settings", {
              enabled: false,
              allowRoleSelection: false,
              expectedRevision: 0,
              currentPassword: password,
            })
          ).status,
          409,
        );
        assert.equal(
          await db.accountAudit.count({
            where: {
              actorId: admin.id,
              action: "account.registration_settings_updated",
            },
          }),
          1,
        );
      },
    );
    let registered: Browser & { id: string };
    await t.test(
      "self selection creates an authenticated account without management powers or mandatory password rotation",
      async () => {
        const browser: Browser = {},
          o = await options();
        const body = {
          username: (prefix + "new").toUpperCase(),
          displayName: " New member ",
          password,
          roles: ["translator", "typesetter"],
          languageCapabilities: ["ja", "ko"],
          expectedSettingsRevision: o.revision,
        };
        assert.equal(
          (
            await request(
              anonymous,
              "POST",
              "/api/auth/register",
              body,
              "https://wrong.invalid",
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(anonymous, "POST", "/api/auth/register", {
              ...body,
              roles: ["admin"],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(anonymous, "POST", "/api/auth/register", {
              ...body,
              canSkipProofreading: true,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(anonymous, "POST", "/api/auth/register", {
              ...body,
              roles: [],
            })
          ).status,
          400,
        );
        const result = await request(
          browser,
          "POST",
          "/api/auth/register",
          body,
        );
        assert.equal(result.status, 200);
        assert(browser.cookie);
        assert.equal(result.data.username, body.username.toLowerCase());
        assert.equal(result.data.displayName, "New member");
        assert.equal(result.data.mustChangePassword, false);
        assert.deepEqual(result.data.roles, ["translator", "typesetter"]);
        assert.equal(result.data.canSkipProofreading, false);
        assert(!result.data.permissions.includes("accounts:manage"));
        assert.equal(
          (await request(browser, "GET", "/api/auth/me")).status,
          200,
        );
        registered = { ...browser, id: result.data.id };
        const stored = await db.user.findUniqueOrThrow({
          where: { id: registered.id },
        });
        assert.notEqual(stored.passwordHash, password);
        const audit = await db.accountAudit.findFirstOrThrow({
          where: { actorId: registered.id, action: "account.self_registered" },
        });
        assert(!JSON.stringify(audit).includes(password));
        assert.equal(
          (
            await request(browser, "PATCH", "/api/users/me", {
              roles: ["operator"],
              displayName: "New member",
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "concurrent names create only one account, and a stale selection policy creates none",
      async () => {
        const o = await options(),
          body = {
            username: prefix + "unique",
            displayName: "Unique",
            password,
            roles: ["typesetter"],
            languageCapabilities: [],
            expectedSettingsRevision: o.revision,
          };
        const results = await Promise.all([
          request({}, "POST", "/api/auth/register", body),
          request({}, "POST", "/api/auth/register", body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          await db.user.count({ where: { username: body.username } }),
          1,
        );
        await settings(admin, true, false);
        assert.equal(
          (
            await request({}, "POST", "/api/auth/register", {
              ...body,
              username: prefix + "stale",
            })
          ).status,
          409,
        );
        assert.equal(
          await db.user.count({ where: { username: prefix + "stale" } }),
          0,
        );
        const current = await options();
        assert.equal(
          (
            await request({}, "POST", "/api/auth/register", {
              ...body,
              username: prefix + "forged",
              expectedSettingsRevision: current.revision,
            })
          ).status,
          400,
        );
        const waiting = await request({}, "POST", "/api/auth/register", {
          ...body,
          username: prefix + "waiting",
          roles: [],
          languageCapabilities: [],
          expectedSettingsRevision: current.revision,
        });
        assert.equal(waiting.status, 200);
        assert.deepEqual(waiting.data.roles, []);
        assert.deepEqual(waiting.data.permissions, ["self"]);
        await settings(admin, false, false);
        assert.equal(
          (await request(registered!, "GET", "/api/auth/me")).status,
          200,
        );
      },
    );
    await t.test(
      "a registration waiting behind closure rechecks policy before persisting",
      async () => {
        await settings(admin, true, true);
        const o = await options();
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>((r) => (unlock = r)),
          ready = new Promise<void>((r) => (locked = r));
        const blocker = db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(20260905,2)`;
            locked();
            await gate;
            await tx.accountRegistrationSettings.update({
              where: { id: "global" },
              data: { enabled: false, revision: { increment: 1 } },
            });
          },
          { timeout: 15000 },
        );
        await ready;
        const result = request({}, "POST", "/api/auth/register", {
          username: prefix + "closing",
          displayName: "Closing",
          password,
          roles: ["typesetter"],
          languageCapabilities: [],
          expectedSettingsRevision: o.revision,
        });
        try {
          await waitForLock("ExclusiveLock", false);
        } finally {
          unlock();
        }
        await blocker;
        assert.equal((await result).status, 403);
        assert.equal(
          await db.user.count({ where: { username: prefix + "closing" } }),
          0,
        );
      },
    );
    await t.test(
      "administrator cannot remove qualification for unsubmitted or archived reservations",
      async () => {
        const row = await work();
        const participant = await db.workStageParticipant.create({
          data: {
            workId: row.id,
            userId: member.id,
            stage: "translate",
            participationMode: "owner",
          },
        });
        const revision = (
          await db.user.findUniqueOrThrow({ where: { id: member.id } })
        ).revision;
        await assert.rejects(manage(member, []), /仍认领作品/);
        await assert.rejects(manage(member, ["translator"], []), /仍认领作品/);
        await db.work.update({
          where: { id: row.id },
          data: { workflowStatus: "archived" },
        });
        await assert.rejects(manage(member, []), /归档作品/);
        assert.equal(
          (await db.user.findUniqueOrThrow({ where: { id: member.id } }))
            .revision,
          revision,
        );
        assert.equal(
          (
            await db.workStageParticipant.findUniqueOrThrow({
              where: { id: participant.id },
            })
          ).leftAt,
          null,
        );
        await manage(member, ["translator", "typesetter"]);
        await db.workStageParticipant.update({
          where: { id: participant.id },
          data: { leftAt: new Date() },
        });
        await manage(member, ["typesetter"], []);
      },
    );
    for (const mode of ["claim", "join"] as const)
      await t.test(
        `${mode} rechecks qualifications after waiting for account administration`,
        async () => {
          const who = await account(mode),
            row = await work();
          let unlock!: () => void, locked!: () => void;
          const gate = new Promise<void>((r) => (unlock = r)),
            ready = new Promise<void>((r) => (locked = r));
          const blocker = db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(20260905,2)`;
              locked();
              await gate;
              await tx.userRole.deleteMany({ where: { userId: who.id } });
            },
            { timeout: 10000 },
          );
          await ready;
          const result = request(
            who,
            "POST",
            `/api/works/${row.id}/stages/${mode}`,
            {
              stage: "translate",
              expectedRevision: 0,
              idempotencyKey: randomUUID(),
            },
          );
          // Both variants must wait before touching the work row, while the writer changes qualification.
          try {
            await waitForLock("ShareLock", false);
          } finally {
            unlock();
          }
          await blocker;
          assert.equal((await result).status, 403);
          assert.equal(
            await db.workStageParticipant.count({ where: { workId: row.id } }),
            0,
          );
        },
      );
    await t.test(
      "a claim admitted first blocks role removal without releasing or corrupting the task",
      async () => {
        const who = await account("first"),
          row = await work();
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>((r) => (unlock = r)),
          ready = new Promise<void>((r) => (locked = r));
        const blocker = db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(20260905,2)`;
            await tx.$queryRaw`SELECT id FROM works WHERE id=${row.id}::uuid FOR UPDATE`;
            locked();
            await gate;
          },
          { timeout: 10000 },
        );
        await ready;
        const claiming = works.claimStage(who.id, row.id, {
          stage: "translate",
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        });
        await waitForLock("ShareLock", true, 2);
        const removing = manage(who, []);
        const rejected = assert.rejects(removing, /仍认领作品/);
        try {
          await waitForLock("ExclusiveLock", false);
        } finally {
          unlock();
        }
        await blocker;
        await claiming;
        await rejected;
        assert.equal(
          await db.workStageParticipant.count({
            where: { workId: row.id, userId: who.id, leftAt: null },
          }),
          1,
        );
      },
    );
    await t.test(
      "completed history stays intact and cancellation cannot revive an ineligible participant",
      async () => {
        const one = await account("roundone"),
          two = await account("roundtwo"),
          row = await work("pending_proofread"),
          submittedAt = new Date();
        await db.workStageParticipant.createMany({
          data: [one, two].map((who) => ({
            workId: row.id,
            userId: who.id,
            stage: "translate" as WorkStage,
            participationMode: "owner",
            submittedAt,
          })),
        });
        await manage(two, []);
        const result = await request(
          one,
          "POST",
          `/api/works/${row.id}/stages/submission/cancel`,
          {
            stage: "translate",
            expectedRevision: 0,
            expectedEditorEpoch: 0,
            idempotencyKey: randomUUID(),
          },
        );
        assert.equal(result.status, 409);
        assert.equal(
          (await db.work.findUniqueOrThrow({ where: { id: row.id } }))
            .workflowStatus,
          "pending_proofread",
        );
        assert.equal(
          await db.workStageParticipant.count({
            where: { workId: row.id, submittedAt },
          }),
          2,
        );
      },
    );
    await t.test(
      "registration limit applies before more expensive account creation",
      async () => {
        await settings(admin, true, true);
        const o = await options();
        let limited = false;
        for (let i = 0; i < 6; i++) {
          const result = await request({}, "POST", "/api/auth/register", {
            username: prefix + "new",
            displayName: "Repeat",
            password,
            roles: ["typesetter"],
            languageCapabilities: [],
            expectedSettingsRevision: o.revision,
          });
          if (result.status === 429) {
            limited = true;
            break;
          }
          assert.equal(result.status, 409);
        }
        assert(limited);
      },
    );
  } finally {
    await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
    await db.workStageParticipant.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workCreditAlias.deleteMany({ where: { workId: { in: workIds } } });
    await db.work.deleteMany({ where: { id: { in: workIds } } });
    await db.candidatePost.deleteMany({ where: { id: { in: candidateIds } } });
    await db.author.delete({ where: { id: author.id } });
    const ids = (
      await db.user.findMany({
        where: { username: { startsWith: prefix } },
        select: { id: true },
      })
    ).map((u) => u.id);
    await db.accountAudit.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userRole.deleteMany({ where: { userId: { in: ids } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: ids } },
    });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    if (original)
      await db.accountRegistrationSettings.upsert({
        where: { id: "global" },
        create: original,
        update: original,
      });
    else await db.accountRegistrationSettings.deleteMany();
    await app.close();
  }
});
