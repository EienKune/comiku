import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { SourceCredentialsService } from "../../src/source-ingestion/source-credentials.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import { credentialFingerprint } from "../../src/source-ingestion/source-platform-state.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

test("controlled credential changes serialize administrators and recover a promoted file after a real database rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comiku-credential-pg-"));
  const stateDirectory = join(directory, "state"),
    configPath = join(directory, "x.json");
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(
    configPath,
    JSON.stringify({
      extractor: {
        twitter: {
          cookies: { auth_token: "synthetic-old", ct0: "old-csrf" },
          retweets: false,
        },
      },
    }),
    { mode: 0o600 },
  );
  const env = parseEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: url,
    OBJECT_STORAGE_DRIVER: "memory",
    GALLERY_DL_PYTHON: "/synthetic/python",
    GALLERY_DL_X_CONFIG: configPath,
    SOURCE_CREDENTIALS_STATE_DIRECTORY: stateDirectory,
  });
  // Use the documented environment names rather than silently falling back to no adapter.
  assert.ok(env.galleryDl?.xConfigPath);
  const app = await createApplication(env),
    db = app.get(PrismaService),
    service = app.get(SourceCredentialsService),
    platforms = app.get(SourceFetchService).platforms;
  const prefix = `credentials_${randomUUID()}`,
    userIds: string[] = [];
  const previous = await db.sourcePlatformState.findUnique({
    where: { platform: "x" },
  });
  const generation = await credentialFingerprint("x", env.galleryDl);
  assert.ok(generation);
  try {
    const admins = await Promise.all(
      ["a", "b"].map(async (suffix) => {
        const user = await db.user.create({
          data: {
            username: `${prefix}_${suffix}`,
            displayName: suffix,
            passwordHash: await hashPassword("synthetic-password-12345"),
            mustChangePassword: false,
            roles: { create: { role: "admin" } },
          },
        });
        userIds.push(user.id);
        return user.id;
      }),
    );
    await db.sourcePlatformState.upsert({
      where: { platform: "x" },
      create: { platform: "x", credentialGeneration: generation },
      update: {
        credentialGeneration: generation,
        status: "unverified",
        errorCode: null,
        cooldownUntil: null,
        maintenancePaused: false,
        maintenanceEpoch: 0,
      },
    });
    const paused = await service.pause("x", admins[0], {
      expectedEpoch: 0,
      expectedGeneration: generation,
    });
    assert.equal(paused.maintenancePaused, true);
    assert.equal(paused.maintenanceEpoch, 1);
    assert.equal(paused.canSave, true);
    const expected = { expectedEpoch: 1, expectedGeneration: generation };
    const inputs = [
      {
        ...expected,
        requestId: randomUUID(),
        authToken: "synthetic-first",
        ct0: "synthetic-csrf-one",
      },
      {
        ...expected,
        requestId: randomUUID(),
        authToken: "synthetic-second",
        ct0: "synthetic-csrf-two",
      },
    ];
    const results = await Promise.allSettled(
      admins.map((actor, index) => service.save("x", actor, inputs[index])),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const result = results[winner];
    assert.equal(result.status, "fulfilled");
    if (result.status !== "fulfilled") throw new Error("No winning receipt");
    assert.equal(result.value.phase, "activated");
    assert.notEqual(result.value.targetGeneration, generation);
    const after = await db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    assert.equal(after.maintenancePaused, true);
    assert.equal(after.credentialGeneration, result.value.targetGeneration);
    const replay = await service.save("x", admins[winner], inputs[winner]);
    assert.equal(replay.id, result.value.id);
    assert.equal(
      await db.sourceCredentialChangeOperation.count({
        where: { actorId: { in: admins } },
      }),
      1,
    );
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.extractor.twitter.retweets, false);
    await assert.rejects(
      service.receipt("pixiv", admins[0], replay.id),
      /不存在/,
    );

    // File promotion survives, but the database activation transaction rolls back.
    const originalActivate = platforms.activateMaintenance.bind(platforms);
    platforms.activateMaintenance = async (
      ...args: Parameters<typeof originalActivate>
    ) => {
      await originalActivate(...args);
      throw new Error("synthetic transaction rollback after state CAS");
    };
    const secondInput = {
      expectedEpoch: 1,
      expectedGeneration: after.credentialGeneration,
      requestId: randomUUID(),
      authToken: "synthetic-third",
      ct0: "synthetic-csrf-three",
    };
    await assert.rejects(service.save("x", admins[0], secondInput), /尚未确认/);
    platforms.activateMaintenance = originalActivate;
    const pending = await db.sourceCredentialChangeOperation.findUniqueOrThrow({
      where: {
        actorId_requestId: {
          actorId: admins[0],
          requestId: secondInput.requestId,
        },
      },
    });
    assert.equal(pending.phase, "blocked");
    const rolledBack = await db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    assert.equal(rolledBack.credentialGeneration, after.credentialGeneration);
    assert.equal(rolledBack.maintenancePaused, true);
    assert.notEqual(
      await credentialFingerprint("x", env.galleryDl),
      rolledBack.credentialGeneration,
    );
    await assert.rejects(
      service.resume("x", admins[0], secondInput),
      /unresolved/,
    );
    const readOnlyBefore =
      await db.sourceCredentialChangeOperation.findUniqueOrThrow({
        where: { id: pending.id },
      });
    const receipt = await service.receipt("x", admins[0], pending.id);
    assert.equal(receipt.phase, "blocked");
    assert.deepEqual(
      await db.sourceCredentialChangeOperation.findUniqueOrThrow({
        where: { id: pending.id },
      }),
      readOnlyBefore,
    );
    const recovered = await service.reconcile(
      "x",
      admins[0],
      pending.id,
      secondInput,
    );
    assert.equal(recovered.phase, "activated");
    assert.equal(recovered.id, pending.id);
    assert.equal(
      (
        await db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).credentialGeneration,
      await credentialFingerprint("x", env.galleryDl),
    );
    await service.resume("x", admins[0], {
      expectedEpoch: 1,
      expectedGeneration: recovered.targetGeneration!,
    });
    assert.equal(
      (
        await db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).maintenancePaused,
      false,
    );
  } finally {
    await db.sourceCredentialChangeOperation.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.sourcePlatformState.deleteMany({ where: { platform: "x" } });
    if (previous) await db.sourcePlatformState.create({ data: previous });
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
