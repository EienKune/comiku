import { BirthdaysService } from "../../src/birthdays/birthdays.service.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  BaBirthdayDataAdapter,
  BIRTHDAY_SYNC_KIND,
  readBirthdayPeople,
} from "../../src/birthdays/adapters/ba/ba-birthday-data.adapter.js";
import { KIVO_SYNC_KIND } from "../../src/birthdays/adapters/ba/birthday-supplement.js";
import { validateKivoProfile } from "../../src/birthdays/adapters/ba/providers/kivo.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type {
  BackgroundJob,
  Prisma,
} from "../../src/generated/prisma/client.js";
import { JobsService, type JobHandler } from "../../src/jobs/jobs.service.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

// Real PostgreSQL persistence/lease predicates inside a rollback-only fixture.
// Sharing the outer transaction does not simulate cross-connection lock scheduling.
function transactionFacade(tx: Prisma.TransactionClient): PrismaService {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$transaction")
        return async <T>(
          action: (client: Prisma.TransactionClient) => Promise<T>,
        ) => action(tx);
      return Reflect.get(target, property);
    },
  }) as unknown as PrismaService;
}

test(
  "real source handlers persist one stable public identity across Kivo discovery, Schale release and lost source edges",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(environment);
    const rollback = new Error(
      "rollback isolated synthetic external birthday fixtures",
    );
    const token = randomUUID();
    const oldId = 1_900_000_000,
      gameId = oldId + 1;
    const kivoId = 1_800_000_000,
      outfitId = kivoId + 1;
    let released = false,
      explicitBridge = false;
    let invalidateLease: BackgroundJob | undefined;
    let abortDuringSecondProfile: AbortController | undefined;
    let fetchCalls = 0;
    let invalidate: ((job: BackgroundJob) => Promise<void>) | undefined;
    const envelope = (data: unknown) =>
      Response.json({ success: true, code: 2000, data });
    const kivoIndex = (id: number) => ({
      id,
      family_name_cn: "合成",
      given_name_cn: "新增学生",
      family_name_jp: "合成",
      given_name_jp: "テスト",
      skin: id === kivoId ? "" : "合成换装",
      avatar: "//static.kivo.wiki/images/students/synthetic/avatar.png",
    });
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0]) => {
        fetchCalls++;
        const source = new URL(String(input));
        if (source.origin === "https://api.kivo.wiki") {
          if (source.pathname === "/api/v1/data/students/") {
            return envelope({
              max_page: 1,
              students: [kivoIndex(kivoId), kivoIndex(outfitId)],
            });
          }
          const match = /^\/api\/v1\/data\/students\/(\d+)$/.exec(
            source.pathname,
          );
          assert.ok(match, "only the synthetic Kivo detail route is allowed");
          const id = Number(match[1]);
          assert.ok(id === kivoId || id === outfitId);
          if (id === outfitId && invalidateLease) {
            const job = invalidateLease;
            invalidateLease = undefined;
            await invalidate!(job);
          }
          if (id === outfitId && abortDuringSecondProfile)
            abortDuringSecondProfile.abort();
          return envelope({
            ...kivoIndex(id),
            birthday: "11-11",
            is_install: explicitBridge,
            is_npc: false,
            skin_list: [
              { id: kivoId, skin: "" },
              { id: outfitId, skin: "合成换装" },
            ],
            character_datas: [{ character_id: explicitBridge ? gameId : 0 }],
          });
        }
        assert.equal(
          source.origin,
          "https://schaledb.com",
          "no real source or arbitrary origin is allowed",
        );
        if (source.pathname === "/data/config.min.json")
          return Response.json({ Regions: [{ Name: "Jp" }] });
        const ids = released ? [oldId, gameId] : [oldId];
        if (source.pathname === "/data/jp/students.min.json")
          return Response.json(
            Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  Id: id,
                  Name: id === oldId ? "合成既存" : "合成テスト",
                  FamilyName: "合成",
                  PersonalName: id === oldId ? "既存" : "テスト",
                  IsReleased: [true],
                  FavorAlts: [],
                  BirthDay: "11/11",
                },
              ]),
            ),
          );
        if (source.pathname === "/data/cn/students.min.json")
          return Response.json(
            Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  Id: id,
                  Name: id === oldId ? "合成旧人" : "合成新增学生",
                  FamilyName: "合成",
                  PersonalName: id === oldId ? "旧人" : "新增学生",
                },
              ]),
            ),
          );
        throw new Error("unexpected synthetic Schale route");
      },
    );
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            // Isolation is temporary: the entire fixture, including pre-existing rows, rolls back.
            await tx.birthdayExternalEntry.deleteMany();
            await tx.birthdayIdentity.deleteMany();
            await tx.birthdayNameOverride.deleteMany();
            await tx.birthdaySyncState.deleteMany({
              where: { id: { in: ["kivo", "combined", "schaledb"] } },
            });
            await tx.birthdaySettings.upsert({
              where: { id: "global" },
              create: { id: "global" },
              update: { displayEnabled: true, remindersEnabled: false },
            });
            const oldCatalog = await tx.birthdayCatalog.create({
              data: {
                contentHash: createHash("sha256").update(token).digest("hex"),
                sourceCounts: { jp: 1, cn: 1 },
                people: [
                  {
                    key: `schaledb:${oldId}`,
                    name: "合成旧人",
                    aliases: ["合成既存", token],
                    month: 11,
                    day: 11,
                    originalEntryId: null,
                    entryIds: [oldId],
                    notificationEligible: true,
                  },
                ],
              },
            });
            const oldIdentity = await tx.birthdayIdentity.create({
              data: {
                entryId: oldId,
                personKey: `schaledb:${oldId}`,
                status: "confirmed",
              },
            });
            await tx.birthdaySyncState.create({
              data: {
                id: "schaledb",
                catalogId: oldCatalog.id,
                lastCheckedAt: new Date(),
                sourceCounts: { jp: 1, cn: 1 },
              },
            });
            const facade = transactionFacade(tx);
            const jobs = new JobsService(facade);
            const handlers = new Map<string, JobHandler>();
            const register = jobs.register.bind(jobs);
            t.mock.method(
              jobs,
              "register",
              (kind: string, handler: JobHandler) => {
                handlers.set(kind, handler);
                register(kind, handler);
              },
            );
            const service = new BaBirthdayDataAdapter(
              facade,
              jobs,
              environment,
            );
            assert.deepEqual(
              [...handlers.keys()].sort(),
              [BIRTHDAY_SYNC_KIND, KIVO_SYNC_KIND].sort(),
            );
            const run = async (
              kind: string,
              phase?: "index" | "profiles",
              signal = new AbortController().signal,
            ) => {
              const job = await tx.backgroundJob.create({
                data: {
                  kind,
                  resourceId: randomUUID(),
                  idempotencyKey: `external-birthday:${token}:${randomUUID()}`,
                  lane: "network",
                  executionScope: "birthdays",
                  status: "running",
                  leaseId: randomUUID(),
                  leaseUntil: new Date(Date.now() + 120_000),
                  ...(phase ? { payload: { phase } } : {}),
                },
              });
              const id = kind === KIVO_SYNC_KIND ? "kivo" : "schaledb";
              await tx.birthdaySyncState.upsert({
                where: { id },
                create: { id, jobId: job.id },
                update: { jobId: job.id },
              });
              await handlers.get(kind)!(job, signal);
              return job;
            };
            const combined = async () => {
              const state = await tx.birthdaySyncState.findUniqueOrThrow({
                where: { id: "combined" },
                include: { catalog: true },
              });
              assert.ok(state.catalog);
              return {
                state,
                people: readBirthdayPeople(state.catalog.people),
              };
            };
            const due = () =>
              tx.birthdayExternalEntry.updateMany({
                where: { source: "kivo" },
                data: { nextCheckAt: new Date(0) },
              });
            const cache = () =>
              tx.birthdayExternalEntry.findMany({
                where: { source: "kivo" },
                orderBy: { entryId: "asc" },
              });
            invalidate = async (job) => {
              await tx.backgroundJob.update({
                where: { id: job.id },
                data: { leaseId: randomUUID() },
              });
            };

            await run(KIVO_SYNC_KIND, "index");
            const discovered = await cache();
            assert.deepEqual(
              discovered.map((row) => row.entryId),
              [kivoId, outfitId],
            );
            assert.ok(
              discovered.every(
                (row) => row.profile === null && row.personKey === null,
              ),
            );
            const emptyCombined = await tx.birthdaySyncState.findUniqueOrThrow({
              where: { id: "combined" },
            });
            assert.equal(emptyCombined.catalogId, null);
            assert.deepEqual(
              (
                await new BirthdaysService(facade, service).calendar()
              ).people.map((person) => person.key),
              [`schaledb:${oldId}`],
            );

            await run(KIVO_SYNC_KIND, "profiles");
            const first = await combined();
            const canonical = `kivo:${kivoId}`;
            assert.deepEqual(
              first.people.map((p) => p.key),
              [canonical, `schaledb:${oldId}`],
            );
            assert.equal(
              first.people.filter((p) => p.key === canonical).length,
              1,
            );
            const stored = await cache();
            assert.ok(
              stored.every(
                (row) =>
                  row.personKey === canonical &&
                  row.profileHash &&
                  row.lastCheckedAt,
              ),
            );
            assert.deepEqual(
              stored.map((row) => validateKivoProfile(row.profile).entryIds),
              [
                [kivoId, outfitId],
                [kivoId, outfitId],
              ],
            );

            released = true;
            await run(BIRTHDAY_SYNC_KIND);
            const raw = await tx.birthdaySyncState.findUniqueOrThrow({
              where: { id: "schaledb" },
              include: { catalog: true },
            });
            assert.ok(raw.catalog);
            assert.deepEqual(
              readBirthdayPeople(raw.catalog.people).map((p) => p.key),
              [`schaledb:${oldId}`, `schaledb:${gameId}`],
            );
            assert.deepEqual(
              (await combined()).people.map((p) => p.key),
              first.people.map((p) => p.key),
            );
            assert.ok(
              (await cache()).every((row) =>
                row.blockedKeys.includes(`schaledb:${gameId}`),
              ),
            );

            explicitBridge = true;
            await due();
            await run(KIVO_SYNC_KIND, "profiles");
            const linked = await combined();
            assert.equal(linked.people.length, 2);
            assert.equal(
              linked.people.filter((p) => p.key === canonical).length,
              1,
            );
            assert.equal(
              linked.people.find((p) => p.key === canonical)?.name,
              "合成新增学生",
            );
            assert.ok(
              (await cache()).every(
                (row) =>
                  row.personKey === canonical &&
                  row.gameEntryIds.includes(gameId) &&
                  row.blockedKeys.length === 0,
              ),
            );
            assert.equal(
              (
                await tx.birthdayIdentity.findUniqueOrThrow({
                  where: { entryId: gameId },
                })
              ).personKey,
              `schaledb:${gameId}`,
            );
            assert.deepEqual(
              await tx.birthdayIdentity.findUniqueOrThrow({
                where: { entryId: oldId },
              }),
              oldIdentity,
            );
            assert.deepEqual(
              await tx.birthdayCatalog.findUniqueOrThrow({
                where: { id: oldCatalog.id },
              }),
              oldCatalog,
            );
            assert.equal(
              (
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "schaledb" },
                })
              ).catalogId,
              raw.catalogId,
            );

            explicitBridge = false;
            await due();
            await run(KIVO_SYNC_KIND, "profiles");
            const disconnected = await combined();
            assert.deepEqual(disconnected.people, linked.people);
            assert.ok(
              (await cache()).every((row) => row.gameEntryIds.includes(gameId)),
            );

            for (const mode of ["lease", "abort"] as const) {
              await due();
              const beforeCache = await cache();
              const beforeCombined =
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "combined" },
                });
              const job = await tx.backgroundJob.create({
                data: {
                  kind: KIVO_SYNC_KIND,
                  resourceId: randomUUID(),
                  idempotencyKey: `external-fence:${token}:${mode}`,
                  lane: "network",
                  executionScope: "birthdays",
                  status: "running",
                  leaseId: randomUUID(),
                  leaseUntil: new Date(Date.now() + 120_000),
                  payload: { phase: "profiles" },
                },
              });
              await tx.birthdaySyncState.update({
                where: { id: "kivo" },
                data: { jobId: job.id },
              });
              const beforeKivo = await tx.birthdaySyncState.findUniqueOrThrow({
                where: { id: "kivo" },
              });
              const controller = new AbortController();
              if (mode === "lease") invalidateLease = job;
              else abortDuringSecondProfile = controller;
              const beforeCalls = fetchCalls;
              await assert.rejects(
                handlers.get(KIVO_SYNC_KIND)!(job, controller.signal),
                mode === "lease" ? /租约/ : /abort/i,
              );
              abortDuringSecondProfile = undefined;
              assert.equal(
                fetchCalls - beforeCalls,
                2,
                "fence after the first successful outcome must discard the entire batch",
              );
              assert.deepEqual(await cache(), beforeCache);
              assert.deepEqual(
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "combined" },
                }),
                beforeCombined,
              );
              assert.deepEqual(
                await tx.birthdaySyncState.findUniqueOrThrow({
                  where: { id: "kivo" },
                }),
                beforeKivo,
              );
            }
            throw rollback;
          },
          { timeout: 45_000 },
        ),
        (error: unknown) => error === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
