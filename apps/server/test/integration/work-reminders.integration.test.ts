import { notificationResourceKind } from "../../src/notifications/notification-resource.js";
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
import type {
  WorkDigestSnapshot,
  WorkReadySnapshot,
} from "../../src/work-reminders/work-reminder-render.js";
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
      status: "cancelled" | "failed" | "unknown" | "accepted" | "pending",
      crossed = false,
      route = channel,
      replayGeneration = 0,
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
          replayGeneration,
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
      const events = await Promise.all(
        channelIds.map((id) =>
          db.notificationEvent.findMany({
            where: { routeRefs: { array_contains: [{ id }] } },
            select: { id: true },
          }),
        ),
      );
      const eventIds = events.flatMap((rows) => rows.map(({ id }) => id));
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
    const handoffAt = new Date(morning.getTime() - 30 * 60_000);
    await projection.maintain(new Date(handoffAt.getTime() - 60_000));
    await db.work.updateMany({
      where: { id: { in: workIds } },
      data: { workflowStatus: "pending_typeset" },
    });

    await t.test(
      "staggered workers capture one message per ready task before the daily slot without duplicate notices",
      async () => {
        function pausedWorker() {
          const queries: string[] = [];
          const record = (args: unknown[]) => {
            const query = args[0];
            queries.push(
              Array.isArray(query)
                ? query.join("?")
                : ((query as { sql?: string })?.sql ?? ""),
            );
          };
          let projected!: () => void, release!: () => void;
          const paused = new Promise<void>((resolve) => {
            projected = resolve;
          });
          const resume = new Promise<void>((resolve) => {
            release = resolve;
          });
          const proxy = new Proxy(db, {
            get(target, property) {
              if (property === "$transaction")
                return (
                  run: (tx: Prisma.TransactionClient) => Promise<unknown>,
                ) =>
                  target.$transaction((tx) =>
                    run(
                      new Proxy(tx, {
                        get(client, name) {
                          if (name === "$queryRaw" || name === "$executeRaw")
                            return (...args: unknown[]) => {
                              record(args);
                              return Reflect.apply(client[name], client, args);
                            };
                          return Reflect.get(client, name, client);
                        },
                      }),
                    ),
                  );
              if (property !== "$executeRaw")
                return Reflect.get(target, property, target);
              return async (...args: unknown[]) => {
                record(args);
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
            queries,
            paused,
            release,
          };
        }
        const workerA = pausedWorker(),
          workerB = pausedWorker();
        const first = workerA.service.maintain(handoffAt);
        await workerA.paused;
        const observedAt = new Date(handoffAt.getTime() + 1_000);
        const second = workerB.service.maintain(observedAt);
        await workerB.paused;
        try {
          workerA.release();
          await first;
          assert.equal(
            await db.workReminderNotice.count({
              where: { channelId: channel.id },
            }),
            5,
            "one maintenance pass captures at most five handoffs",
          );
        } finally {
          workerB.release();
          await second;
        }
        for (const worker of [workerA, workerB]) {
          assert.equal(
            worker.queries.some(
              (query) =>
                /\bcount\s*\(/i.test(query) &&
                /FROM\s+work_reminder_episodes\b/i.test(query),
            ),
            false,
            "ready-only registration must not count the full eligible episode backlog",
          );
          const deletes = worker.queries.filter((query) =>
            /DELETE\s+FROM\s+work_reminder_notices\b/i.test(query),
          );
          assert.ok(
            deletes.length <= 5,
            "one bounded pass reclaims at most five selected notice identities",
          );
          for (const query of deletes) {
            for (const field of [
              "participant_id",
              "round",
              "kind",
              "channel_id",
            ])
              assert.match(
                query,
                new RegExp(`n\\.${field}\\s*=`),
                "notice reclamation must seek the complete selected identity, never sweep a channel history",
              );
          }
        }
        assert.equal(
          workerA.queries.filter((query) =>
            /DELETE\s+FROM\s+work_reminder_notices\b/i.test(query),
          ).length,
          5,
        );
        await reminders.maintain(observedAt);
        const occurrences = await db.workDigestOccurrence.findMany({
          where: { channelId: channel.id },
        });
        assert.equal(
          occurrences.length,
          0,
          "ready-only subscriptions create no daily occurrence",
        );
        const notices = await db.workReminderNotice.findMany({
          where: { channelId: channel.id },
          orderBy: { eventId: "asc" },
        });
        assert.equal(
          notices.length,
          6,
          "two bounded passes drain six tasks exactly once",
        );
        assert.equal(
          new Set(notices.map((notice) => notice.participantId)).size,
          6,
        );
        const event = await db.notificationEvent.findUniqueOrThrow({
          where: { id: notices[0]!.eventId },
        });
        const snapshot = event.snapshot as unknown as WorkReadySnapshot;
        assert.equal(event.type, "work.ready");
        assert.equal(notificationResourceKind(event), "work_ready");
        assert.equal(snapshot.items.length, 1);
        assert.equal(snapshot.observedAt, observedAt.toISOString());
        assert.equal(
          await db.workReminderNotice.count({ where: { eventId: event.id } }),
          1,
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
        await db.workStageParticipant.update({
          where: { id: snapshot.items[0]!.participantId },
          data: { leftAt: handoffAt },
        });
        assert.equal(await guard(), "work_reminder_task_changed");
        await db.workStageParticipant.update({
          where: { id: snapshot.items[0]!.participantId },
          data: { leftAt: null },
        });
        await db.workReminderSubscription.update({
          where: { channelId: channel.id },
          data: { readyEnabled: false },
        });
        assert.equal(await guard(), "work_reminder_subscription_changed");
        await db.workReminderSubscription.update({
          where: { channelId: channel.id },
          data: { readyEnabled: true },
        });
        await delivery(event.id, "cancelled");
      },
    );
    await t.test(
      "unsent cancellation returns immediately while legacy accepted and unknown ready notices never return",
      async () => {
        const notices = await db.workReminderNotice.findMany({
          where: { channelId: channel.id },
        });
        const cancelled = await db.notificationDelivery.findFirstOrThrow({
          where: { channelId: channel.id, status: "cancelled" },
        });
        const retained = notices.filter(
          (notice) => notice.eventId !== cancelled.eventId,
        );
        for (const [index, notice] of retained.entries()) {
          const event = await db.notificationEvent.findUniqueOrThrow({
            where: { id: notice.eventId },
          });
          const ready = event.snapshot as unknown as WorkReadySnapshot;
          if (index < 2) {
            const legacy: WorkDigestSnapshot = {
              ...ready,
              kind: "work_digest",
              localDate: day,
              slot: "09:00",
              counts: {
                ready: 1,
                overdue: 0,
                availableTranslation: 0,
                availableProofreading: 0,
                availableTypesetting: 0,
                availableWorks: 0,
                candidates: 0,
              },
            };
            await db.notificationEvent.update({
              where: { id: event.id },
              data: {
                type: "work.digest",
                snapshot: legacy as unknown as Prisma.InputJsonValue,
              },
            });
          }
          if (index === 2 || index === 3) {
            await delivery(event.id, "cancelled");
            await delivery(
              event.id,
              index === 2 ? "unknown" : "accepted",
              false,
              channel,
              1,
            );
          } else {
            await delivery(event.id, index === 1 ? "unknown" : "accepted");
          }
        }
        await reminders.maintain(evening);
        const returned = await db.workReminderNotice.findFirstOrThrow({
          where: {
            channelId: channel.id,
            eventId: { notIn: notices.map((row) => row.eventId) },
          },
        });
        const event = await db.notificationEvent.findUniqueOrThrow({
          where: { id: returned.eventId },
        });
        assert.equal(
          (event.snapshot as unknown as WorkReadySnapshot).items.length,
          1,
        );
        await delivery(event.id, "unknown");
        const tomorrow = new Date(morning.getTime() + 86_400_000);
        await reminders.maintain(tomorrow);
        assert.equal(
          await db.workReminderNotice.count({
            where: { channelId: channel.id },
          }),
          6,
        );
        await reminders.maintain(new Date(evening.getTime() + 86_400_000));
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: channel.id },
          }),
          0,
          "a ready-only subscription never consumes a daily slot",
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
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: channel.id },
          }),
          0,
        );
        assert.equal(
          await db.workReminderNotice.count({
            where: { channelId: channel.id },
          }),
          6,
        );
      },
    );
    await t.test(
      "registration rollback is atomic and only conclusive unsent failures release ready notices",
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
        assert.equal(
          await db.notificationEvent.count({
            where: { routeRefs: { array_contains: [{ id: another.id }] } },
          }),
          0,
        );
        await reminders.maintain(rollbackTime);
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: another.id },
          }),
          0,
        );
        const first = await db.workReminderNotice.findMany({
          where: { channelId: another.id },
        });
        assert.equal(first.length, 5);
        for (const notice of first)
          await delivery(notice.eventId, "failed", false, another);
        const next = new Date(rollbackTime.getTime() + 60_000);
        await reminders.maintain(next);
        const retry = await db.workReminderNotice.findMany({
          where: { channelId: another.id },
        });
        assert.equal(
          retry.length,
          5,
          "conclusive unsent failure returns five items on the next maintenance pass",
        );
        assert.ok(
          retry.every(
            (row) => !first.some((old) => old.eventId === row.eventId),
          ),
        );
        for (const notice of retry)
          await delivery(notice.eventId, "failed", true, another);
        const following = new Date(rollbackTime.getTime() + 86_400_000);
        await reminders.maintain(following);
        const retained = await db.workReminderNotice.findMany({
          where: { channelId: another.id },
        });
        assert.equal(
          retained.length,
          6,
          "a failed transport that crossed the boundary does not cause another automatic mention",
        );
        assert.equal(
          retained.filter((row) =>
            retry.some((old) => old.eventId === row.eventId),
          ).length,
          5,
        );
      },
    );
    await t.test(
      "disabling handoffs cancels a pending ready delivery while the scheduled digest retains occupied stage totals and overdue details",
      async () => {
        const digestTime = new Date(morning.getTime() + 5 * 86_400_000);
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
        await projection.maintain(new Date(digestTime.getTime() - 60_000));
        await db.work.update({
          where: { id: work.id },
          data: { workflowStatus: "pending_typeset" },
        });
        await reminders.maintain(new Date(digestTime.getTime() - 30_000));
        const ready = await db.workReminderNotice.findFirstOrThrow({
          where: {
            participantId: participant.id,
            channelId: channel.id,
            kind: "ready",
          },
        });
        const pending = await delivery(ready.eventId, "pending");
        const readyEventCount = await db.notificationEvent.count({
          where: {
            type: "work.ready",
            routeRefs: { array_contains: [{ id: channel.id }] },
          },
        });
        const scope = await db.workReminderSubscription.findUniqueOrThrow({
          where: { channelId: channel.id },
        });
        await reminders.updateSubscription(actor.id, channel.id, {
          expectedChannelRevision: channel.revision,
          expectedRevision: scope.revision,
          digestEnabled: true,
          readyEnabled: false,
          overdueEnabled: true,
          mentionsEnabled: true,
        });
        assert.equal(
          (
            await db.notificationDelivery.findUniqueOrThrow({
              where: { id: pending.id },
            })
          ).status,
          "cancelled",
        );
        await db.workReminderEpisode.update({
          where: { participantId: participant.id },
          data: { eligibleMilliseconds: 72n * 3_600_000n },
        });
        await reminders.maintain(digestTime);
        const occurrence = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: channel.id, dueAt: digestTime },
        });
        const event = await db.notificationEvent.findUniqueOrThrow({
          where: { id: occurrence.eventId! },
        });
        const snapshot = event.snapshot as unknown as WorkDigestSnapshot;
        assert.equal(snapshot.formatVersion, 3);
        assert.equal(snapshot.counts.ready, 0);
        assert.ok(snapshot.counts.typesettingTotal! >= participantIds.length);
        assert.equal(snapshot.items.length, 1);
        assert.equal(snapshot.items[0]!.kind, "overdue");
        assert.equal(snapshot.items[0]!.participantId, participant.id);
        assert.equal(
          await db.workReminderNotice.count({
            where: {
              participantId: participant.id,
              channelId: channel.id,
              kind: "ready",
            },
          }),
          1,
          "a cancelled notice may remain until that exact task is selected again",
        );
        assert.equal(
          (
            await db.workReminderNotice.findFirstOrThrow({
              where: {
                participantId: participant.id,
                channelId: channel.id,
                kind: "ready",
              },
            })
          ).eventId,
          ready.eventId,
        );
        assert.equal(
          await db.notificationEvent.count({
            where: {
              type: "work.ready",
              routeRefs: { array_contains: [{ id: channel.id }] },
            },
          }),
          readyEventCount,
          "disabling handoffs must not recapture the cancelled ready task",
        );
        await reminders.maintain(digestTime);
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: channel.id },
          }),
          1,
        );
      },
    );
    await t.test(
      "one digest captures every overdue task and safely rebuilds only a conclusively unsent changed roster in the same slot",
      async () => {
        const due = new Date(morning.getTime() + 6 * 86_400_000);
        const overdueIds: string[] = [];
        for (let index = 0; index < 8; index++) {
          const work = await makeWork("pending_typeset");
          const participant = await db.workStageParticipant.create({
            data: {
              workId: work.id,
              userId: actor.id,
              stage: "typeset",
              participationMode: "owner",
              joinedAt: before,
            },
          });
          overdueIds.push(participant.id);
          participantIds.push(participant.id);
        }
        await projection.maintain(new Date(due.getTime() - 60_000));
        await db.workReminderEpisode.updateMany({
          where: { participantId: { in: overdueIds } },
          data: { eligibleMilliseconds: 72n * 3_600_000n },
        });
        await reminders.maintain(due);
        const occurrence = await db.workDigestOccurrence.findFirstOrThrow({
          where: { channelId: channel.id, dueAt: due },
        });
        const original = await db.notificationEvent.findUniqueOrThrow({
          where: { id: occurrence.eventId! },
        });
        const originalSnapshot =
          original.snapshot as unknown as WorkDigestSnapshot;
        assert.equal(originalSnapshot.formatVersion, 3);
        assert.equal(originalSnapshot.items.length, 8);
        assert.equal(originalSnapshot.counts.overdue, 8);
        assert.deepEqual(
          new Set(originalSnapshot.items.map((item) => item.participantId)),
          new Set(overdueIds),
        );
        assert.equal(
          await db.workReminderNotice.count({
            where: { eventId: original.id, kind: "overdue" },
          }),
          8,
        );
        await reminders.maintain(due);
        assert.equal(
          (
            await db.workDigestOccurrence.findUniqueOrThrow({
              where: { id: occurrence.id },
            })
          ).eventId,
          original.id,
        );

        const unsent = await delivery(original.id, "cancelled");
        await db.notificationDelivery.update({
          where: { id: unsent.id },
          data: { errorCode: "work_reminder_task_changed" },
        });
        await db.workStageParticipant.update({
          where: { id: overdueIds[0]! },
          data: { submittedAt: due },
        });
        const filtered = await db.$transaction((tx) =>
          projection.readItems(tx, due, {
            channelId: channel.id,
            scopeGeneration: 1,
            readyEnabled: false,
            overdueEnabled: true,
            allOverdue: true,
          }),
        );
        assert.equal(filtered.items.length, 7);
        assert.equal(
          filtered.overdueCount,
          7,
          "the complete count comes from current evidence, not stale projection rows",
        );
        await reminders.maintain(new Date(due.getTime() + 30_000));
        const rebuiltOccurrence =
          await db.workDigestOccurrence.findUniqueOrThrow({
            where: { id: occurrence.id },
          });
        assert.notEqual(rebuiltOccurrence.eventId, original.id);
        const rebuilt = await db.notificationEvent.findUniqueOrThrow({
          where: { id: rebuiltOccurrence.eventId! },
        });
        const rebuiltSnapshot =
          rebuilt.snapshot as unknown as WorkDigestSnapshot;
        assert.equal(rebuiltSnapshot.items.length, 7);
        assert.equal(rebuiltSnapshot.counts.overdue, 7);
        assert.ok(
          !rebuiltSnapshot.items.some(
            (item) => item.participantId === overdueIds[0],
          ),
        );
        assert.equal(
          await db.workReminderNotice.count({
            where: { eventId: rebuilt.id, kind: "overdue" },
          }),
          7,
        );
        assert.deepEqual(
          await db.notificationEvent.findUniqueOrThrow({
            where: { id: original.id },
          }),
          original,
          "rebuilding the current intent preserves the original event and its frozen history",
        );
        await reminders.maintain(new Date(due.getTime() + 31_000));
        assert.equal(
          (
            await db.workDigestOccurrence.findUniqueOrThrow({
              where: { id: occurrence.id },
            })
          ).eventId,
          rebuilt.id,
        );
        const crossed = await delivery(rebuilt.id, "cancelled", true);
        await db.notificationDelivery.update({
          where: { id: crossed.id },
          data: { errorCode: "work_reminder_observation_stale" },
        });
        await reminders.maintain(new Date(due.getTime() + 40_000));
        assert.equal(
          (
            await db.workDigestOccurrence.findUniqueOrThrow({
              where: { id: occurrence.id },
            })
          ).eventId,
          rebuilt.id,
          "a crossed send boundary prohibits rebuilding even a task-change cancellation",
        );

        const unknownChannel = await db.notificationChannel.create({
          data: {
            name: "Synthetic overdue unknown",
            groupId: String(Math.floor(Math.random() * 1e12) + 3e12),
            connectionKey: channel.connectionKey,
            connectionFingerprint: channel.connectionFingerprint,
            enabled: true,
            eventTypes: [],
            sourceAcceptAfter: before,
          },
        });
        channelIds.push(unknownChannel.id);
        await db.workReminderSubscription.create({
          data: {
            channelId: unknownChannel.id,
            overdueEnabled: true,
            acceptAfter: before,
          },
        });
        await reminders.maintain(new Date(due.getTime() + 50_000));
        const unknownOccurrence =
          await db.workDigestOccurrence.findFirstOrThrow({
            where: { channelId: unknownChannel.id, dueAt: due },
          });
        await delivery(
          unknownOccurrence.eventId!,
          "unknown",
          false,
          unknownChannel,
        );
        await reminders.maintain(new Date(due.getTime() + 60_000));
        assert.equal(
          (
            await db.workDigestOccurrence.findUniqueOrThrow({
              where: { id: unknownOccurrence.id },
            })
          ).eventId,
          unknownOccurrence.eventId,
          "an unknown intent cannot be replaced in the same slot",
        );
        await db.workStageParticipant.update({
          where: { id: overdueIds[0]! },
          data: { submittedAt: null },
        });
        const later = new Date(evening.getTime() + 6 * 86_400_000);
        await reminders.maintain(later);
        const eveningOccurrence =
          await db.workDigestOccurrence.findFirstOrThrow({
            where: { channelId: channel.id, dueAt: later },
          });
        const eveningEvent = await db.notificationEvent.findUniqueOrThrow({
          where: { id: eveningOccurrence.eventId! },
        });
        assert.equal(
          (eveningEvent.snapshot as unknown as WorkDigestSnapshot).items.length,
          0,
          "the next scheduled summary does not repeat the already frozen overdue roster",
        );
      },
    );
    await t.test(
      "an oversized full digest consumes no slot and cannot starve handoffs in its own or another group",
      async (budgetTest) => {
        const due = new Date(morning.getTime() + 7 * 86_400_000);
        async function group(name: string, overdueEnabled: boolean) {
          const row = await db.notificationChannel.create({
            data: {
              name,
              groupId: String(Math.floor(Math.random() * 1e12) + 4e12),
              connectionKey: channel.connectionKey,
              connectionFingerprint: channel.connectionFingerprint,
              enabled: true,
              eventTypes: [],
              sourceAcceptAfter: before,
            },
          });
          channelIds.push(row.id);
          await db.workReminderSubscription.create({
            data: {
              channelId: row.id,
              readyEnabled: true,
              overdueEnabled,
              acceptAfter: before,
            },
          });
          return row;
        }
        const oversized = await group("Synthetic capacity", true);
        const unaffected = await group("Synthetic independent handoff", false);
        // Amplify only the selected synthetic candidate result. The real formatter
        // exercises its actual byte budget without seeding thousands of works.
        const wrapped = new Proxy(db, {
          get(target, property) {
            if (property !== "$transaction")
              return Reflect.get(target, property, target);
            return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(client, name) {
                      if (name === "$queryRaw")
                        return async (...args: unknown[]) => {
                          const rows = (await Reflect.apply(
                            client.$queryRaw,
                            client,
                            args,
                          )) as unknown[];
                          const query = args[0];
                          const text = Array.isArray(query)
                            ? query.join("?")
                            : (query as Prisma.Sql).sql;
                          const values = Array.isArray(query)
                            ? args.slice(1)
                            : (query as Prisma.Sql).values;
                          if (
                            /AS "eligibleMilliseconds"/.test(text) &&
                            !/\bLIMIT\b/.test(text) &&
                            values.includes(oversized.id)
                          ) {
                            assert.ok(rows.length > 0);
                            return Array.from(
                              { length: 4096 },
                              (_, index) => rows[index % rows.length],
                            );
                          }
                          return rows;
                        };
                      return Reflect.get(client, name, client);
                    },
                  }),
                ),
              );
          },
        });
        const warning = budgetTest.mock.method(console, "warn", () => {});
        await new WorkRemindersService(wrapped, registry, env).maintain(due);
        assert.equal(warning.mock.calls.length, 1);
        assert.equal(
          await db.workDigestOccurrence.count({
            where: { channelId: oversized.id },
          }),
          0,
        );
        assert.equal(
          await db.workReminderNotice.count({
            where: { channelId: oversized.id, kind: "overdue" },
          }),
          0,
        );
        for (const route of [oversized, unaffected]) {
          assert.equal(
            await db.workReminderNotice.count({
              where: { channelId: route.id, kind: "ready" },
            }),
            5,
            "digest capacity failures preserve each group's independently captured handoffs",
          );
          assert.equal(
            await db.notificationEvent.count({
              where: {
                type: "work.ready",
                routeRefs: { array_contains: [{ id: route.id }] },
              },
            }),
            5,
          );
        }
      },
    );
    await t.test(
      "current availability matches claim ownership even after the owner's role is revoked",
      async () => {
        const baseline = await readWorkDigestCounts(db);
        assert.ok(baseline.typesettingTotal >= participantIds.length);
        await db.workStageParticipant.updateMany({
          where: { id: { in: participantIds } },
          data: { leftAt: morning },
        });
        const vacant = await readWorkDigestCounts(db);
        assert.equal(
          vacant.availableTypesetting - baseline.availableTypesetting,
          participantIds.length,
        );
        assert.equal(
          vacant.availableWorks - baseline.availableWorks,
          participantIds.length,
        );
        assert.equal(vacant.typesettingTotal, baseline.typesettingTotal);
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
