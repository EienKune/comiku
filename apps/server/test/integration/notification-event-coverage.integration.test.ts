import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NOTIFICATION_EVENT_KEYS } from "../../src/notifications/notification-events.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationWorkEventBridgeService } from "../../src/notifications/notification-work-event-bridge.service.js";
import {
  NOTIFICATION_WORK_EVENT_ACTIVATION_ID as baseId,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID as expandedId,
  NOTIFICATION_LEGACY_WORK_EVENT_ACTIONS as legacy,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIONS as expanded,
  buildNotificationWorkEventSourceBranches,
} from "../../src/notifications/notification-work-event-source.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "expanded work coverage preserves independent activation, source locks and bounded discovery",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const registry = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true", SYNTHETIC_TOKEN: "synthetic" },
      manifest: [
        {
          key: "coverage",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const publisher = new NotificationPublisherService(db);
    const bridge = () =>
      new NotificationWorkEventBridgeService(db, publisher, registry);
    const actor = await db.user.create({
      data: {
        username: `coverage_${randomUUID()}`,
        displayName: "Synthetic",
        passwordHash: "synthetic",
        mustChangePassword: false,
      },
    });
    const author = await db.author.create({
      data: { displayName: `coverage_${randomUUID()}` },
    });
    const candidate = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const work = await db.work.create({
      data: {
        authorId: author.id,
        sourceCandidatePostId: candidate.id,
        importedById: actor.id,
        title: "PRIVATE_CURRENT_NAME",
      },
    });
    const channelData = {
      connectionKey: "coverage",
      connectionFingerprint: registry.get("coverage")!.fingerprint,
      enabled: true,
      sourceAcceptAfter: new Date(0),
    };
    const channel = await db.notificationChannel.create({
      data: {
        ...channelData,
        name: "Synthetic expanded",
        groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
        eventTypes: [...NOTIFICATION_EVENT_KEYS],
        receiverMode: "templates",
        subscriptionRules: NOTIFICATION_EVENT_KEYS.map((eventType) => ({
          eventType,
          stages: null,
        })),
      },
    });
    const oldChannel = await db.notificationChannel.create({
      data: {
        ...channelData,
        name: "Synthetic old",
        groupId: String(Math.floor(Math.random() * 1e12) + 2e12),
        eventTypes: ["imported"],
      },
    });
    const previousBase = await db.notificationWorkEventActivation.findUnique({
      where: { id: baseId },
    });
    const previousExpanded =
      await db.notificationWorkEventActivation.findUnique({
        where: { id: expandedId },
      });
    const sourceSince = new Date(Date.now() - 86_400_000);
    const oldAt = new Date(sourceSince.getTime() + 1000);
    const source = (
      action: (typeof NOTIFICATION_EVENT_KEYS)[number],
      createdAt: Date = new Date(),
    ) =>
      db.workEvent.create({
        data: {
          workId: work.id,
          action,
          createdAt,
          detail: {
            stage:
              action === "proofreading_skipped" ? "proofread" : "translate",
            reason: "PRIVATE_REASON",
            fileId: "PRIVATE_FILE",
            url: "https://private.example",
          },
        },
      });
    const clearScenario = async () => {
      await db.notificationWorkEventReceipt.deleteMany({
        where: { resourceId: work.id },
      });
      await db.notificationEvent.deleteMany({ where: { resourceId: work.id } });
      await db.workEvent.deleteMany({ where: { workId: work.id } });
    };
    const drainRecorded = async (sourceIds: string[]) => {
      // Maintenance selects one active receipt head per resource. All sources in
      // this scenario share one Work, so registration deliberately takes rounds.
      for (let round = 0; round <= sourceIds.length; round++) {
        const rows = await db.notificationWorkEventReceipt.findMany({
          where: { sourceEventId: { in: sourceIds } },
          select: { status: true, errorCode: true },
        });
        assert.equal(rows.length, sourceIds.length);
        if (rows.every((row) => row.status === "recorded")) return;
        assert.ok(
          rows.every((row) => ["pending", "recorded"].includes(row.status)),
          `unexpected receipt state: ${JSON.stringify(rows)}`,
        );
        assert.equal((await bridge().maintain())?.success, true);
      }
      assert.fail(
        "bounded registration rounds did not drain the work receipts",
      );
    };
    try {
      await db.notificationWorkEventActivation.upsert({
        where: { id: baseId },
        update: { sourceSince },
        create: { id: baseId, sourceSince },
      });
      await db.notificationWorkEventActivation.deleteMany({
        where: { id: expandedId },
      });
      await t.test(
        "first expansion excludes old new-action history and retains the original fifteen-action boundary",
        async (scenario) => {
          scenario.after(clearScenario);
          const oldSources = await Promise.all(
            legacy.map((action) => source(action, oldAt)),
          );
          const oldExpanded = await Promise.all(
            expanded.map((action) => source(action, oldAt)),
          );
          assert.deepEqual(await bridge().maintain(), {
            success: true,
            captured: 15,
            registered: 1,
          });
          await drainRecorded(oldSources.map((row) => row.id));
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: {
                sourceEventId: { in: oldSources.map((row) => row.id) },
                status: "recorded",
              },
            }),
            15,
          );
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: {
                sourceEventId: { in: oldExpanded.map((row) => row.id) },
              },
            }),
            0,
          );
          assert.equal(
            (
              await db.notificationWorkEventActivation.findUniqueOrThrow({
                where: { id: baseId },
              })
            ).sourceSince.getTime(),
            sourceSince.getTime(),
          );
        },
      );
      const expandedSince = (
        await db.notificationWorkEventActivation.findUniqueOrThrow({
          where: { id: expandedId },
        })
      ).sourceSince;
      await t.test(
        "new nine actions register once, use explicit subscriptions and retain their frozen safe input",
        async (scenario) => {
          scenario.after(clearScenario);
          const fresh = await Promise.all(
            expanded.map((action) =>
              source(action, new Date(expandedSince.getTime() + 1)),
            ),
          );
          assert.deepEqual(await bridge().maintain(), {
            success: true,
            captured: 9,
            registered: 1,
          });
          await drainRecorded(fresh.map((row) => row.id));
          const rows = await db.notificationWorkEventReceipt.findMany({
            where: { sourceEventId: { in: fresh.map((row) => row.id) } },
            orderBy: { id: "asc" },
          });
          assert.equal(rows.length, 9);
          assert.ok(rows.every((row) => row.status === "recorded"));
          assert.doesNotMatch(
            JSON.stringify(rows.map((row) => [row.safeInput, row.routeRefs])),
            /PRIVATE_|private.example/,
          );
          for (const row of rows) {
            const routes = row.routeRefs as {
              id: string;
              content: { matchedRule: { eventType: string } };
            }[];
            assert.deepEqual(
              routes.map((route) => route.id),
              [channel.id],
            );
            assert.equal(
              routes[0]!.content.matchedRule.eventType,
              (row.safeInput as { type: string }).type,
            );
          }
          const frozen = JSON.stringify(rows);
          await db.work.update({
            where: { id: work.id },
            data: { title: "CHANGED_CURRENT_NAME" },
          });
          assert.deepEqual(await bridge().maintain(), {
            success: true,
            captured: 0,
            registered: 0,
          });
          assert.equal(
            JSON.stringify(
              await db.notificationWorkEventReceipt.findMany({
                where: { sourceEventId: { in: fresh.map((row) => row.id) } },
                orderBy: { id: "asc" },
              }),
            ),
            frozen,
          );
          assert.equal(
            (
              await db.notificationWorkEventActivation.findUniqueOrThrow({
                where: { id: expandedId },
              })
            ).sourceSince.getTime(),
            expandedSince.getTime(),
          );
          assert.equal(
            await db.notificationEvent.count({
              where: { resourceId: work.id },
            }),
            9,
          );
        },
      );
      await t.test(
        "a locked head in each source range does not block unlocked followers or create duplicates",
        async (scenario) => {
          scenario.after(clearScenario);
          const lockedLegacy = await source("stage_joined");
          const lockedExpanded = await source("metadata_updated");
          const entered = barrier();
          const release = barrier();
          const held = db.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT id FROM work_events WHERE id IN (${lockedLegacy.id}::uuid, ${lockedExpanded.id}::uuid) FOR UPDATE`;
              entered.resolve();
              await release.promise;
            },
            { timeout: 15_000 },
          );
          await entered.promise;
          try {
            const followers = await Promise.all([
              source("stage_joined"),
              source("metadata_updated"),
            ]);
            const outcomes = await Promise.all([
              bridge().maintain(),
              bridge().maintain(),
            ]);
            assert.equal(
              outcomes.reduce(
                (sum, result) => sum + (result?.captured ?? 0),
                0,
              ),
              2,
            );
            await drainRecorded(followers.map((row) => row.id));
            assert.equal(
              await db.notificationWorkEventReceipt.count({
                where: {
                  sourceEventId: { in: followers.map((row) => row.id) },
                  status: "recorded",
                },
              }),
              2,
            );
            assert.equal(
              await db.notificationWorkEventReceipt.count({
                where: {
                  sourceEventId: { in: [lockedLegacy.id, lockedExpanded.id] },
                },
              }),
              0,
            );
          } finally {
            release.resolve();
            await held;
          }
          await bridge().maintain();
          await drainRecorded([lockedLegacy.id, lockedExpanded.id]);
          assert.equal(
            await db.notificationWorkEventReceipt.count({
              where: {
                sourceEventId: { in: [lockedLegacy.id, lockedExpanded.id] },
                status: "recorded",
              },
            }),
            2,
          );
          assert.equal(
            await db.notificationEvent.count({
              where: { resourceId: work.id },
            }),
            4,
          );
        },
      );
      await t.test(
        "thousands of pre-expansion rows remain unconsumed without repeated discovery scans",
        async (scenario) => {
          scenario.after(clearScenario);
          await db.$executeRaw`INSERT INTO work_events (id, work_id, action, detail, created_at)
        SELECT gen_random_uuid(), ${work.id}::uuid, 'metadata_updated'::"WorkEventAction", '{}'::jsonb, ${oldAt}
        FROM generate_series(1, 5000)`;
          await db.$executeRaw`ANALYZE work_events`;
          const branches = buildNotificationWorkEventSourceBranches({
            sourceSince,
            expandedSourceSince: expandedSince,
          });
          type Plan = {
            "Actual Rows"?: number;
            "Rows Removed by Filter"?: number;
            "Actual Loops"?: number;
            Plans?: Plan[];
          };
          const workUnits = (plan: Plan): number =>
            ((plan["Actual Rows"] ?? 0) +
              (plan["Rows Removed by Filter"] ?? 0)) *
              (plan["Actual Loops"] ?? 1) +
            (plan.Plans ?? []).reduce(
              (sum, child) => sum + workUnits(child),
              0,
            );
          for (const branch of [branches.legacy, branches.expanded!]) {
            const explained = await db.$queryRaw<
              { "QUERY PLAN": { Plan: Plan }[] }[]
            >(
              Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT e.id FROM work_events e WHERE ${branch} ORDER BY e.created_at, e.id LIMIT 1`,
            );
            assert.ok(
              workUnits(explained[0]!["QUERY PLAN"][0]!.Plan) < 100,
              "source discovery must not revisit pre-expansion history",
            );
          }
          assert.deepEqual(await bridge().maintain(), {
            success: true,
            captured: 0,
            registered: 0,
          });
          const uncaptured = await db.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM work_events WHERE work_id = ${work.id}::uuid AND notification_captured_at IS NULL`;
          assert.equal(Number(uncaptured[0]!.count), 5000);
        },
      );
    } finally {
      await clearScenario();
      await db.work.delete({ where: { id: work.id } });
      await db.candidatePost.delete({ where: { id: candidate.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.notificationChannel.deleteMany({
        where: { id: { in: [channel.id, oldChannel.id] } },
      });
      await db.user.delete({ where: { id: actor.id } });
      if (previousBase)
        await db.notificationWorkEventActivation.update({
          where: { id: baseId },
          data: { sourceSince: previousBase.sourceSince },
        });
      else
        await db.notificationWorkEventActivation.deleteMany({
          where: { id: baseId },
        });
      if (previousExpanded)
        await db.notificationWorkEventActivation.upsert({
          where: { id: expandedId },
          update: { sourceSince: previousExpanded.sourceSince },
          create: { id: expandedId, sourceSince: previousExpanded.sourceSince },
        });
      else
        await db.notificationWorkEventActivation.deleteMany({
          where: { id: expandedId },
        });
      await db.$disconnect();
    }
  },
);
