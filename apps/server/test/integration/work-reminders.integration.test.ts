import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { WorkReminderProjection } from "../../src/work-reminders/work-reminder-projection.js";
import {
  WorkRemindersService,
  readWorkDigestCounts,
} from "../../src/work-reminders/work-reminders.service.js";
import type { WorkDigestSnapshot } from "../../src/work-reminders/work-reminder-render.js";
import {
  lockWorkReminderSettings,
  lockWorkReminderSubscription,
  workReminderDeliveryInvalidReason,
} from "../../src/work-reminders/work-reminder-notification-policy.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "work reminder registration fences concurrent workers, slots, cancellations and configuration ABA",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const previous = await db.workReminderSettings.findUnique({
      where: { id: "global" },
    });
    const previousClock = await db.workReminderClock.findUnique({
      where: { id: "global" },
    });
    const token = randomUUID();
    const day = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const morning = new Date(`${day}T01:00:00Z`),
      evening = new Date(`${day}T10:00:00Z`);
    const before = new Date(morning.getTime() - 86_400_000);
    const registry = new NotificationConnectionRegistry({
      env: {
        NOTIFICATIONS_ENABLED: "true",
        SYNTHETIC_REMINDER_TOKEN: "synthetic",
      },
      manifest: [
        {
          key: "reminder-fixture",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_REMINDER_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const actor = await db.user.create({
      data: {
        username: `reminder_${token}`,
        displayName: "Synthetic administrator",
        passwordHash: "synthetic",
        mustChangePassword: false,
        roles: {
          create: [
            { role: "admin" },
            { role: "translator" },
            { role: "typesetter" },
          ],
        },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
    const author = await db.author.create({
      data: {
        displayName: "Synthetic reminder author",
        authorizationStatus: "authorized",
      },
    });
    const channel = await db.notificationChannel.create({
      data: {
        name: "Synthetic reminders",
        groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
        connectionKey: "reminder-fixture",
        connectionFingerprint: registry.get("reminder-fixture")!.fingerprint,
        enabled: true,
        eventTypes: [],
        sourceAcceptAfter: before,
      },
    });
    const channelIds = [channel.id],
      workIds: string[] = [],
      candidateIds: string[] = [],
      participantIds: string[] = [];
    const reminders = new WorkRemindersService(db, registry, env),
      projection = new WorkReminderProjection(db);
    await db.workReminderSettings.upsert({
      where: { id: "global" },
      create: { id: "global", enabled: true, acceptAfter: before },
      update: {
        enabled: true,
        sendTimes: ["09:00", "18:00"],
        note: "",
        generation: 10,
        revision: 0,
        acceptAfter: before,
      },
    });
    await db.workReminderSubscription.create({
      data: { channelId: channel.id, readyEnabled: true, acceptAfter: before },
    });
    async function makeWork(
      status: "pending_translate" | "pending_typeset" = "pending_translate",
    ) {
      const candidate = await db.candidatePost.create({
        data: {
          authorId: author.id,
          platform: "synthetic",
          externalPostId: randomUUID(),
          postedAt: before,
          rawJson: {},
          status: "imported",
        },
      });
      candidateIds.push(candidate.id);
      const work = await db.work.create({
        data: {
          authorId: author.id,
          sourceCandidatePostId: candidate.id,
          importedById: actor.id,
          workflowStatus: status,
          title: "Synthetic reminder work",
        },
      });
      workIds.push(work.id);
      return work;
    }
    async function delivery(
      eventId: string,
      status: "cancelled" | "failed" | "unknown" | "accepted",
      crossed = false,
      route = channel,
    ) {
      const row = await db.notificationDelivery.create({
        data: {
          eventId,
          channelId: route.id,
          audienceGeneration: route.audienceGeneration,
          connectionKey: route.connectionKey,
          connectionFingerprint: route.connectionFingerprint,
          groupId: route.groupId,
          channelRevision: route.revision,
          text: "synthetic frozen text",
          status,
          jobId: randomUUID(),
        },
      });
      if (crossed)
        await db.notificationAttempt.create({
          data: {
            deliveryId: row.id,
            number: 1,
            jobId: row.jobId!,
            leaseId: randomUUID(),
            sendBoundaryCrossed: true,
            status,
          },
        });
      return row;
    }
    t.after(async () => {
      const events = await db.workDigestOccurrence.findMany({
        where: { channelId: { in: channelIds } },
        select: { eventId: true },
      });
      const eventIds = events.flatMap(({ eventId }) =>
        eventId ? [eventId] : [],
      );
      await db.notificationAttempt.deleteMany({
        where: { delivery: { channelId: { in: channelIds } } },
      });
      await db.notificationDelivery.deleteMany({
        where: { channelId: { in: channelIds } },
      });
      await db.workReminderNotice.deleteMany({
        where: { channelId: { in: channelIds } },
      });
      await db.workDigestOccurrence.deleteMany({
        where: { channelId: { in: channelIds } },
      });
      await db.notificationEvent.deleteMany({
        where: { id: { in: eventIds } },
      });
      await db.workReminderSubscription.deleteMany({
        where: { channelId: { in: channelIds } },
      });
      await db.notificationChannel.deleteMany({
        where: { id: { in: channelIds } },
      });
      await db.workReminderEpisode.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.workStageParticipant.deleteMany({
        where: { id: { in: participantIds } },
      });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({
        where: { id: { in: candidateIds } },
      });
      await db.author.delete({ where: { id: author.id } });
      await db.userRole.deleteMany({ where: { userId: actor.id } });
      await db.userLanguageCapability.deleteMany({
        where: { userId: actor.id },
      });
      await db.user.delete({ where: { id: actor.id } });
      if (previous) {
        const { id, ...data } = previous;
        await db.workReminderSettings.upsert({
          where: { id },
          create: previous,
          update: data,
        });
      } else
        await db.workReminderSettings.deleteMany({ where: { id: "global" } });
      if (previousClock) {
        const { id, ...data } = previousClock;
        await db.workReminderClock.upsert({
          where: { id },
          create: previousClock,
          update: data,
        });
      } else await db.workReminderClock.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
    });
    for (let index = 0; index < 6; index++) {
      const work = await makeWork();
      const participant = await db.workStageParticipant.create({
        data: {
          workId: work.id,
          userId: actor.id,
          stage: "typeset",
          participationMode: "owner",
          joinedAt: before,
        },
      });
      participantIds.push(participant.id);
    }
    await projection.maintain(new Date(morning.getTime() - 60_000));
    await db.work.updateMany({
      where: { id: { in: workIds } },
      data: { workflowStatus: "pending_typeset" },
    });

    await t.test(
      "staggered workers freeze the newest projection and consume only five displayed notices in one slot",
      async () => {
        function pausedWorker() {
          let projected!: () => void, release!: () => void;
          const paused = new Promise<void>((resolve) => {
            projected = resolve;
          });
          const resume = new Promise<void>((resolve) => {
            release = resolve;
          });
          const proxy = new Proxy(db, {
            get(target, property) {
              if (property !== "$executeRaw")
                return Reflect.get(target, property, target);
              return async (...args: unknown[]) => {
                if (
                  Array.isArray(args[0]) &&
                  args[0].join("").includes("work_reminder_expired")
                ) {
                  projected();
                  await resume;
                }
                return Reflect.apply(target.$executeRaw, target, args);
              };
            },
          });
          return {
            service: new WorkRemindersService(proxy, registry, env),
            paused,
            release,
          };
        }
        const workerA = pausedWorker(),
          workerB = pausedWorker();
        const first = workerA.service.maintain(morning);
        await workerA.paused;
        const observedAt = new Date(morning.getTime() + 1_000);
        const second = workerB.service.maintain(observedAt);
        await workerB.paused;
        try {
          workerA.release();
          await first;
        } finally {
          workerB.release();
          await second;
        }
        await reminders.maintain(morning);
        const occurrences = await db.workDigestOccurrence.findMany({
          where: { channelId: channel.id },
        });
        assert.equal(occurrences.length, 1);
        const event = await db.notificationEvent.findUniqueOrThrow({
          where: { id: occurrences[0]!.eventId! },
        });
        const snapshot = event.snapshot as unknown as WorkDigestSnapshot;
        assert.equal(snapshot.items.length, 5);
        assert.equal(snapshot.counts.ready, 6);
        assert.equal(snapshot.observedAt, observedAt.toISOString());
        assert.equal(
          await db.workReminderNotice.count({ where: { eventId: event.id } }),
          5,
        );
        assert.match(JSON.stringify(event.routeRefs), /messageSegments/);
        async function guard(value = snapshot, at = observedAt) {
          return db.$transaction(async (tx) => {
            const settings = await lockWorkReminderSettings(tx);
            const scope = await lockWorkReminderSubscription(tx, channel.id);
            return workReminderDeliveryInvalidReason(
              value,
              {
                reminderGeneration: settings!.generation,
                reminderScopeGeneration: scope!.generation,
              },
              settings,
              scope,
              tx,
              at,
            );
          });
        }
        assert.equal(await guard(), null);
        assert.equal(
          await guard(snapshot, new Date(snapshot.validBefore)),
          "work_reminder_expired",
        );
        for (const table of ["works", "users"] as const) {
          let unlock!: () => void, locked!: () => void;
          const ready = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const release = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          const blocker = db.$transaction(async (tx) => {
            if (table === "works")
              await tx.$queryRaw`SELECT id FROM works WHERE id = ${snapshot.items[0]!.workId}::uuid FOR UPDATE`;
            else
              await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id}::uuid FOR UPDATE`;
            locked();
            await release;
          });
          await ready;
          try {
            await assert.rejects(() => guard(), /lock|55P03|obtain/i);
          } finally {
            unlock();
            await blocker;
          }
        }
        await db.user.update({
          where: { id: actor.id },
          data: { qqNumber: "123456789", revision: { increment: 1 } },
        });
        await db.user.update({
          where: { id: actor.id },
          data: { qqNumber: null, revision: { increment: 1 } },
        });
        assert.equal(
          await guard(),
          "work_reminder_task_changed",
          "unbind/rebind ABA changes contact revision even when frozen QQ is equal",
        );
        // Restore only this synthetic fixture so later slot checks share the original frozen observation.
        await db.user.update({
          where: { id: actor.id },
          data: { revision: 0 },
        });
        await db.workStageParticipant.update({
          where: { id: snapshot.items[0]!.participantId },
          data: { submittedAt: morning },
        });
        assert.equal(await guard(), "work_reminder_task_changed");
        await db.workStageParticipant.update({
          where: { id: snapshot.items[0]!.participantId },
          data: { submittedAt: null },
        });
        await delivery(event.id, "cancelled");
      },
    );
    await t.test(
      "unsent cancellation returns displayed items at next slot; accepted and unknown never return",
      async () => {
        await reminders.maintain(evening);
        const eveningOccurrence =
          await db.workDigestOccurrence.findUniqueOrThrow({
            where: {
              channelId_localDate_slot: {
                channelId: channel.id,
                localDate: day,
                slot: "18:00",
              },
            },
          });
        const event = await db.notificationEvent.findUniqueOrThrow({
          where: { id: eveningOccurrence.eventId! },
        });
        assert.equal(
          (event.snapshot as unknown as WorkDigestSnapshot).items.length,
          5,
        );
        await delivery(event.id, "unknown");
        const tomorrow = new Date(morning.getTime() + 86_400_000);
        await reminders.maintain(tomorrow);
        const occurrence = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: channel.id, dueAt: tomorrow },
        });
        const last = await db.notificationEvent.findUniqueOrThrow({
          where: { id: occurrence.eventId! },
        });
        assert.equal(
          (last.snapshot as unknown as WorkDigestSnapshot).items.length,
          1,
        );
        await delivery(last.id, "accepted");
        await reminders.maintain(new Date(evening.getTime() + 86_400_000));
        const empty = await db.workDigestOccurrence.findFirstOrThrow({
          where: {
            channelId: channel.id,
            dueAt: new Date(evening.getTime() + 86_400_000),
          },
        });
        assert.equal(
          empty.eventId,
          null,
          "zero personal items consume a slot without producing a message",
        );
      },
    );
    await t.test(
      "note updates keep scheduling generation, stale CAS fails, subscription ABA keeps old successful notices",
      async () => {
        const original = await db.workReminderSettings.findUniqueOrThrow({
          where: { id: "global" },
        });
        await reminders.updateSettings(actor.id, {
          expectedRevision: original.revision,
          enabled: true,
          sendTimes: original.sendTimes,
          note: "Changed copy",
        });
        const updated = await db.workReminderSettings.findUniqueOrThrow({
          where: { id: "global" },
        });
        assert.equal(updated.generation, original.generation);
        assert.equal(
          updated.acceptAfter.getTime(),
          original.acceptAfter.getTime(),
        );
        await assert.rejects(
          () =>
            reminders.updateSettings(actor.id, {
              expectedRevision: original.revision,
              enabled: true,
              sendTimes: original.sendTimes,
              note: "stale",
            }),
          /已更新/,
        );
        const scope = await db.workReminderSubscription.findUniqueOrThrow({
          where: { channelId: channel.id },
        });
        await reminders.updateSubscription(actor.id, channel.id, {
          expectedChannelRevision: channel.revision,
          expectedRevision: scope.revision,
          digestEnabled: false,
          readyEnabled: false,
          overdueEnabled: false,
          mentionsEnabled: true,
        });
        await reminders.updateSubscription(actor.id, channel.id, {
          expectedChannelRevision: channel.revision,
          expectedRevision: scope.revision + 1,
          digestEnabled: false,
          readyEnabled: true,
          overdueEnabled: false,
          mentionsEnabled: true,
        });
        await reminders.maintain(new Date(morning.getTime() + 2 * 86_400_000));
        const empty = await db.workDigestOccurrence.findFirstOrThrow({
          where: {
            channelId: channel.id,
            dueAt: new Date(morning.getTime() + 2 * 86_400_000),
          },
        });
        assert.equal(empty.eventId, null);
      },
    );
    await t.test(
      "a registration failure rolls back its slot, event and notices together",
      async () => {
        const rollbackTime = new Date(morning.getTime() + 3 * 86_400_000);
        const another = await db.notificationChannel.create({
          data: {
            name: "Synthetic rollback",
            groupId: String(Math.floor(Math.random() * 1e12) + 2e12),
            connectionKey: channel.connectionKey,
            connectionFingerprint: channel.connectionFingerprint,
            enabled: true,
            eventTypes: [],
            sourceAcceptAfter: before,
          },
        });
        channelIds.push(another.id);
        await db.workReminderSubscription.create({
          data: {
            channelId: another.id,
            readyEnabled: true,
            acceptAfter: before,
          },
        });
        const wrapped = new Proxy(db, {
          get(target, property) {
            if (property !== "$transaction")
              return Reflect.get(target, property, target);
            return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(client, name) {
                      if (name === "workReminderNotice")
                        return new Proxy(client.workReminderNotice, {
                          get(model, operation) {
                            if (operation === "createMany")
                              return () => {
                                throw new Error(
                                  "synthetic registration rollback",
                                );
                              };
                            return Reflect.get(model, operation, model);
                          },
                        });
                      return Reflect.get(client, name, client);
                    },
                  }),
                ),
              );
          },
        });
        await assert.rejects(
          () =>
            new WorkRemindersService(wrapped, registry, env).maintain(
              rollbackTime,
            ),
          /synthetic registration rollback/,
        );
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: another.id },
          }),
          0,
        );
        assert.equal(
          await db.workReminderNotice.count({
            where: { channelId: another.id },
          }),
          0,
        );
        await reminders.maintain(rollbackTime);
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: another.id },
          }),
          1,
        );
        const occurrence = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: another.id, dueAt: rollbackTime },
        });
        await delivery(occurrence.eventId!, "failed", false, another);
        const next = new Date(rollbackTime.getTime() + 9 * 3_600_000);
        await reminders.maintain(next);
        const retry = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: another.id, dueAt: next },
        });
        const retryEvent = await db.notificationEvent.findUniqueOrThrow({
          where: { id: retry.eventId! },
        });
        assert.equal(
          (retryEvent.snapshot as unknown as WorkDigestSnapshot).items.length,
          5,
          "conclusive unsent failure returns five items at the next slot",
        );
        await delivery(retryEvent.id, "failed", true, another);
        const following = new Date(rollbackTime.getTime() + 86_400_000);
        await reminders.maintain(following);
        const retained = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: another.id, dueAt: following },
        });
        const retainedEvent = await db.notificationEvent.findUniqueOrThrow({
          where: { id: retained.eventId! },
        });
        assert.equal(
          (retainedEvent.snapshot as unknown as WorkDigestSnapshot).items
            .length,
          1,
          "a failed transport that crossed the boundary does not cause another automatic mention",
        );
      },
    );
    await t.test(
      "current availability matches claim ownership even after the owner's role is revoked",
      async () => {
        const baseline = await readWorkDigestCounts(db);
        await db.workStageParticipant.updateMany({
          where: { id: { in: participantIds } },
          data: { leftAt: morning },
        });
        const vacant = await readWorkDigestCounts(db);
        assert.equal(
          vacant.availableTypesetting - baseline.availableTypesetting,
          6,
        );
        assert.equal(vacant.availableWorks - baseline.availableWorks, 6);
        await db.workStageParticipant.updateMany({
          where: { id: { in: participantIds } },
          data: { leftAt: null },
        });
        await db.userRole.delete({
          where: { userId_role: { userId: actor.id, role: "typesetter" } },
        });
        const unqualified = await readWorkDigestCounts(db);
        assert.equal(unqualified.availableWorks, baseline.availableWorks);
      },
    );
  },
);
