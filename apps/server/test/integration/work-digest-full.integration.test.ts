import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationRuntimeService } from "../../src/notifications/notification-runtime.service.js";
import {
  notificationMessageSegments,
  type NotificationMessagePolicy,
} from "../../src/notifications/notification-message-segments.js";
import type { OneBotHttpAdapter } from "../../src/notifications/onebot-http.adapter.js";
import { WorkReminderProjection } from "../../src/work-reminders/work-reminder-projection.js";
import { WorkRemindersService } from "../../src/work-reminders/work-reminders.service.js";
import type { WorkDigestSnapshot } from "../../src/work-reminders/work-reminder-render.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "a full overdue digest reaches Jobs and the adapter once with every task and contact",
  {
    skip: !url,
    timeout: 45_000,
  },
  async (t) => {
    // Avoid crossing either real slot boundary within the test timeout,
    // without changing global Date or persisted business clocks.
    const localMilliseconds = (Date.now() + 8 * 3_600_000) % 86_400_000;
    const nextBoundary =
      localMilliseconds < 43_200_000 ? 43_200_000 : 86_400_000;
    if (nextBoundary - localMilliseconds < 60_000) {
      t.skip("Current digest slot closes within one minute");
      return;
    }
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const priorSettings = await db.workReminderSettings.findUnique({
      where: { id: "global" },
    });
    const priorClock = await db.workReminderClock.findUnique({
      where: { id: "global" },
    });
    const userIds: string[] = [],
      candidateIds: string[] = [],
      workIds: string[] = [];
    const authorId = randomUUID(),
      channelId = randomUUID();
    const token = randomUUID();
    const registry = new NotificationConnectionRegistry({
      env: {
        NOTIFICATIONS_ENABLED: "true",
        FULL_DIGEST_TEST_TOKEN: "synthetic",
      },
      manifest: [
        {
          key: "full-digest-fixture",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "FULL_DIGEST_TEST_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    try {
      await db.author.create({
        data: {
          id: authorId,
          displayName: "Synthetic full digest author",
          authorizationStatus: "authorized",
        },
      });
      const before = new Date(Date.now() - 86_400_000);
      await db.notificationChannel.create({
        data: {
          id: channelId,
          name: "Synthetic full digest",
          groupId: `${Date.now()}`,
          connectionKey: "full-digest-fixture",
          connectionFingerprint: registry.get("full-digest-fixture")!
            .fingerprint,
          eventTypes: [],
          enabled: true,
          sourceAcceptAfter: before,
        },
      });
      await db.workReminderSubscription.create({
        data: {
          channelId,
          digestEnabled: true,
          overdueEnabled: true,
          readyEnabled: false,
          mentionsEnabled: true,
          acceptAfter: before,
        },
      });
      await db.workReminderSettings.upsert({
        where: { id: "global" },
        create: {
          id: "global",
          enabled: true,
          sendTimes: ["00:00", "12:00"],
          acceptAfter: before,
        },
        update: {
          enabled: true,
          sendTimes: ["00:00", "12:00"],
          acceptAfter: before,
          note: "",
        },
      });
      for (let index = 0; index < 24; index++) {
        const userId = randomUUID(),
          candidateId = randomUUID(),
          workId = randomUUID();
        userIds.push(userId);
        candidateIds.push(candidateId);
        workIds.push(workId);
        await db.user.create({
          data: {
            id: userId,
            username: `full_${token}_${index}`,
            displayName: `合成成员${index}${"名".repeat(30)}`,
            qqNumber: `${Date.now()}${index}`,
            passwordHash: "synthetic",
            mustChangePassword: false,
            roles: { create: { role: "translator" } },
            languageCapabilities: { create: { language: "ja" } },
          },
        });
        await db.candidatePost.create({
          data: {
            id: candidateId,
            authorId,
            platform: "synthetic",
            externalPostId: `${token}_${index}`,
            postedAt: before,
            rawJson: {},
            status: "imported",
          },
        });
        await db.work.create({
          data: {
            id: workId,
            authorId,
            sourceCandidatePostId: candidateId,
            importedById: userId,
            title: `合成作品${index}${"完整标题".repeat(20)}`,
            workflowStatus: "pending_translate",
            stageParticipants: {
              create: {
                userId,
                stage: "translate",
                participationMode: "owner",
              },
            },
          },
        });
      }
      const now = new Date();
      await db.workReminderClock.upsert({
        where: { id: "global" },
        create: { id: "global", elapsedMilliseconds: 0n, lastObservedAt: now },
        update: { elapsedMilliseconds: 0n, lastObservedAt: now },
      });
      await new WorkReminderProjection(db).maintain(now);
      await db.workReminderEpisode.updateMany({
        where: { workId: { in: workIds } },
        data: { eligibleMilliseconds: 259_201_000n },
      });
      const reminders = new WorkRemindersService(db, registry, env);
      await reminders.maintain(now);
      const occurrence = await db.workDigestOccurrence.findFirstOrThrow({
        where: { channelId },
      });
      const event = await db.notificationEvent.findUniqueOrThrow({
        where: { id: occurrence.eventId! },
      });
      const snapshot = event.snapshot as unknown as WorkDigestSnapshot;
      assert.equal(snapshot.formatVersion, 3);
      assert.equal(snapshot.counts.overdue, 24);
      assert.equal(snapshot.items.length, 24);
      const sent: string[] = [];
      const adapter = {
        async send(
          _connection: unknown,
          groupId: string,
          text: string,
          _signal: AbortSignal,
          segments: unknown,
          policy: NotificationMessagePolicy,
        ) {
          assert.equal(
            policy,
            "work_digest",
            "the trusted full-list policy must survive routing and send reservation",
          );
          assert.ok([...text].length > 1000);
          assert.doesNotMatch(text, /另有/);
          const parsed = notificationMessageSegments(segments, policy);
          assert.ok(parsed);
          assert.equal(parsed.filter((part) => part.type === "at").length, 24);
          for (const item of snapshot.items)
            assert.ok(text.includes(`#${item.workNumber} `));
          assert.equal(
            groupId,
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: channelId },
              })
            ).groupId,
          );
          await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channelId}::uuid FOR UPDATE NOWAIT`;
          });
          sent.push(text);
          return {
            status: "accepted" as const,
            providerMessageId: "synthetic-full-1",
            sendBoundaryCrossed: true,
          };
        },
      };
      const worker = () => {
        const runtime = new NotificationRuntimeService(
          db,
          new JobsService(db),
          registry,
          adapter as unknown as OneBotHttpAdapter,
          env,
        );
        runtime.onModuleInit();
        return runtime;
      };
      const runtime = worker();
      await runtime.maintain();
      for (let iteration = 0; iteration < 10 && !sent.length; iteration++)
        await runtime.runNext();
      assert.equal(sent.length, 1);
      const delivery = await db.notificationDelivery.findFirstOrThrow({
        where: { eventId: event.id, channelId },
      });
      assert.equal(delivery.status, "accepted");
      assert.equal(delivery.attempts, 1);
      assert.equal(
        await db.workReminderNotice.count({ where: { channelId } }),
        24,
      );
      await reminders.maintain(new Date());
      const restarted = worker();
      await restarted.maintain();
      await restarted.runNext();
      assert.equal(sent.length, 1);
      assert.equal(
        await db.workDigestOccurrence.count({ where: { channelId } }),
        1,
      );
      assert.equal(
        await db.notificationDelivery.count({ where: { channelId } }),
        1,
      );
    } finally {
      const events = await db.notificationEvent.findMany({
        where: { routeRefs: { array_contains: [{ id: channelId }] } },
        select: { id: true },
      });
      const deliveries = await db.notificationDelivery.findMany({
        where: { channelId },
        select: { id: true, jobId: true },
      });
      await db.notificationAttempt.deleteMany({
        where: { deliveryId: { in: deliveries.map((row) => row.id) } },
      });
      await db.notificationDelivery.deleteMany({ where: { channelId } });
      await db.backgroundJob.deleteMany({
        where: {
          id: {
            in: deliveries.flatMap((row) => (row.jobId ? [row.jobId] : [])),
          },
        },
      });
      await db.workReminderNotice.deleteMany({ where: { channelId } });
      await db.workDigestOccurrence.deleteMany({ where: { channelId } });
      await db.notificationEvent.deleteMany({
        where: { id: { in: events.map((row) => row.id) } },
      });
      await db.workReminderSubscription.deleteMany({ where: { channelId } });
      await db.notificationChannel.deleteMany({ where: { id: channelId } });
      await db.workReminderEpisode.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({
        where: { id: { in: candidateIds } },
      });
      await db.author.deleteMany({ where: { id: authorId } });
      await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
      await db.userLanguageCapability.deleteMany({
        where: { userId: { in: userIds } },
      });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      if (priorSettings) {
        const { id, ...data } = priorSettings;
        await db.workReminderSettings.upsert({
          where: { id },
          create: priorSettings,
          update: data,
        });
      } else
        await db.workReminderSettings.deleteMany({ where: { id: "global" } });
      if (priorClock) {
        const { id, ...data } = priorClock;
        await db.workReminderClock.upsert({
          where: { id },
          create: priorClock,
          update: data,
        });
      } else await db.workReminderClock.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
    }
  },
);
