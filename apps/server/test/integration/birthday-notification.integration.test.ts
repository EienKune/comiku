import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BirthdayReminderService } from "../../src/birthdays/birthday-reminder.service.js";
import {
  birthdayAddDays,
  birthdayDueAt,
  birthdayLocalDate,
} from "../../src/birthdays/birthday-policy.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationRuntimeService } from "../../src/notifications/notification-runtime.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import type { OneBotHttpAdapter } from "../../src/notifications/onebot-http.adapter.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "birthday ledger isolates work, activation scopes, stale-source recovery and restart deduplication",
  { skip: !url, timeout: 90_000 },
  async (t) => {
    const env = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: url,
      BIRTHDAYS_ENABLED: "true",
    });
    const db = new PrismaService(env);
    await db.$connect();
    const previousSettings = await db.birthdaySettings.findUnique({
      where: { id: "global" },
    });
    const previousSource = await db.birthdaySyncState.findUnique({
      where: { id: "schaledb" },
    });
    const previousCombined = await db.birthdaySyncState.findUnique({
      where: { id: "combined" },
    });
    const externalIds: number[] = [];
    const now = new Date();
    const date = birthdayLocalDate(now);
    const before = new Date(now.getTime() - 2 * 86_400_000);
    const token = randomUUID();
    const registry = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true", BIRTHDAY_TEST_TOKEN: "synthetic" },
      manifest: [
        {
          key: "birthday-fixture",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "BIRTHDAY_TEST_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const actor = await db.user.create({
      data: {
        username: `bd_${token}`,
        displayName: "Synthetic birthday administrator",
        passwordHash: "synthetic",
        mustChangePassword: false,
        roles: { create: { role: "admin" } },
      },
    });
    const reminders = new BirthdayReminderService(db, registry);
    const publisher = new NotificationPublisherService(db);
    const management = new NotificationsService(db, publisher, registry, env);
    const channel = await management.createChannel(actor.id, {
      name: "Synthetic birthday group",
      connectionKey: "birthday-fixture",
      groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
      enabled: true,
      eventTypes: [],
      includeDetails: false,
    });
    const people = [0, 1, 7].flatMap((offset) => {
      const target = birthdayAddDays(date, offset);
      return [0, 1].map((index) => ({
        key: `synthetic:${offset}:${index}`,
        name: `合成学生${offset}${index}`,
        aliases: [],
        month: Number(target.slice(5, 7)),
        day: Number(target.slice(8, 10)),
        originalEntryId: 100 + offset * 2 + index,
        entryIds: [100 + offset * 2 + index],
        notificationEligible: true,
      }));
    });
    const catalog = await db.birthdayCatalog.create({
      data: {
        contentHash: token.replaceAll("-", "").repeat(2),
        people,
        sourceCounts: { jp: people.length, cn: people.length },
      },
    });
    const ownedCatalogIds = [catalog.id];
    const work = await publisher.record({
      eventKey: `birthday-integration:${token}`,
      type: "imported",
      resourceId: randomUUID(),
      aggregateVersion: 1,
      occurredAt: now,
      workNumber: 42,
    });
    assert.equal(channel.enabled, true);
    assert.deepEqual(channel.eventTypes, []);
    assert.deepEqual(
      work.routeRefs,
      [],
      "birthday-only group must not receive work events",
    );
    const workDelivery = await db.notificationDelivery.create({
      data: {
        eventId: work.id,
        channelId: channel.id,
        audienceGeneration: channel.audienceGeneration,
        connectionKey: "birthday-fixture",
        connectionFingerprint: registry.get("birthday-fixture")!.fingerprint,
        groupId: channel.groupId,
        channelRevision: channel.revision,
        text: "FROZEN WORK MESSAGE",
        jobId: randomUUID(),
      },
    });
    await db.notificationEvent.update({
      where: { id: work.id },
      data: { routedAt: now },
    });
    const workChannelBaseline = await db.notificationChannel.update({
      where: { id: channel.id },
      data: { sourceAcceptAfter: before },
    });
    const sent: string[] = [];
    const adapter = {
      async send(_connection: unknown, _group: string, text: string) {
        // The synthetic transport runs after every birthday policy/send lock commits.
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM birthday_settings WHERE id = 'global' FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channel.id}::uuid FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE channel_id = ${channel.id}::uuid AND status = 'sending' FOR UPDATE NOWAIT`;
        });
        sent.push(text);
        return {
          status: "accepted" as const,
          providerMessageId: `fixture-${sent.length}`,
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
    async function reset() {
      await db.birthdaySyncState.deleteMany({ where: { id: "combined" } });
      await db.birthdaySettings.upsert({
        where: { id: "global" },
        create: { id: "global" },
        update: {},
      });
      await db.birthdaySettings.update({
        where: { id: "global" },
        data: {
          revision: 0,
          displayEnabled: true,
          remindersEnabled: true,
          sendTime: "00:00",
          offsetDays: [0, 1, 7],
          reminderGeneration: 20,
          reminderAcceptAfter: before,
          offsetStates: Object.fromEntries(
            [0, 1, 7].map((offset) => [
              String(offset),
              { generation: 10, acceptAfter: before.toISOString() },
            ]),
          ),
          templateNote: "冻结祝福",
          templateRevision: 1,
        },
      });
      await db.birthdayChannelSubscription.upsert({
        where: { channelId: channel.id },
        create: {
          channelId: channel.id,
          enabled: true,
          audienceGeneration: 30,
          acceptAfter: before,
        },
        update: {
          enabled: true,
          revision: 0,
          audienceGeneration: 30,
          acceptAfter: before,
        },
      });
      await db.birthdaySyncState.upsert({
        where: { id: "schaledb" },
        create: { id: "schaledb", catalogId: catalog.id, lastCheckedAt: now },
        update: { catalogId: catalog.id, lastCheckedAt: now },
      });
    }
    async function clearBirthdays() {
      const occurrences = await db.birthdayReminderOccurrence.findMany({
        where: { catalogId: { in: ownedCatalogIds } },
      });
      const ids = occurrences.flatMap((row) =>
        row.eventId ? [row.eventId] : [],
      );
      const deliveries = await db.notificationDelivery.findMany({
        where: { eventId: { in: ids } },
      });
      await db.notificationAttempt.deleteMany({
        where: { deliveryId: { in: deliveries.map((row) => row.id) } },
      });
      await db.notificationDelivery.deleteMany({
        where: { eventId: { in: ids } },
      });
      await db.backgroundJob.deleteMany({
        where: {
          id: {
            in: deliveries.flatMap((row) => (row.jobId ? [row.jobId] : [])),
          },
        },
      });
      await db.birthdayReminderOccurrence.deleteMany({
        where: { catalogId: { in: ownedCatalogIds } },
      });
      await db.notificationEvent.deleteMany({ where: { id: { in: ids } } });
    }
    async function assertWorkUntouched() {
      assert.deepEqual(
        await db.notificationDelivery.findUniqueOrThrow({
          where: { id: workDelivery.id },
        }),
        workDelivery,
      );
      assert.deepEqual(
        await db.notificationChannel.findUniqueOrThrow({
          where: { id: channel.id },
        }),
        workChannelBaseline,
      );
    }
    try {
      await reset();
      await t.test(
        "an empty combined state does not suppress fresh primary reminders during supplement bootstrap failure",
        async () => {
          await db.birthdaySyncState.create({
            data: { id: "combined", catalogId: null },
          });
          await reminders.maintain(now);
          const occurrences = await db.birthdayReminderOccurrence.findMany({
            where: { catalogId: catalog.id },
          });
          assert.equal(occurrences.length, 3);
          assert.deepEqual(
            occurrences.map((row) => row.offsetDays).sort((a, b) => a - b),
            [0, 1, 7],
          );
          assert.ok(
            occurrences.every(
              (row) =>
                row.namespace === "schaledb" &&
                (row.snapshot as { checkedAt: string }).checkedAt ===
                  now.toISOString(),
            ),
          );
        },
      );
      await clearBirthdays();
      await reset();
      await t.test(
        "stale suppression keeps the slot free; two workers freeze a single occurrence per offset",
        async () => {
          await db.birthdaySyncState.update({
            where: { id: "schaledb" },
            data: { lastCheckedAt: new Date(now.getTime() - 49 * 3_600_000) },
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            0,
          );
          await db.birthdaySyncState.update({
            where: { id: "schaledb" },
            data: { lastCheckedAt: now },
          });
          await Promise.all([
            reminders.maintain(now),
            new BirthdayReminderService(db, registry).maintain(now),
          ]);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            3,
          );
          await runtime.maintain();
          const frozen = await db.notificationDelivery.findMany({
            where: {
              channelId: channel.id,
              event: { resourceKind: "birthday_digest" },
            },
          });
          assert.equal(frozen.length, 3);
          assert.ok(
            frozen.every(
              (row) =>
                row.text.includes("冻结祝福") && !row.text.includes("/works/"),
            ),
          );
          await reminders.updateTemplate(actor.id, {
            expectedRevision: 1,
            note: "新版祝福",
          });
          assert.deepEqual(
            (
              await db.notificationDelivery.findMany({
                where: { id: { in: frozen.map((row) => row.id) } },
                orderBy: { id: "asc" },
              })
            ).map((row) => row.text),
            [...frozen]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((row) => row.text),
          );
          await reminders.updateSubscription(actor.id, channel.id, {
            expectedChannelRevision: channel.revision,
            expectedScopeRevision: 0,
            enabled: false,
          });
          assert.equal(
            await db.notificationDelivery.count({
              where: {
                id: { in: frozen.map((row) => row.id) },
                status: "cancelled",
              },
            }),
            3,
          );
          await assertWorkUntouched();
        },
      );
      await clearBirthdays();
      await reset();
      await t.test(
        "offset cancellation is narrow; global disable retains unknown and fences historical retries",
        async () => {
          await reminders.maintain(now);
          await runtime.maintain();
          const rows = await db.notificationDelivery.findMany({
            where: {
              channelId: channel.id,
              event: { resourceKind: "birthday_digest" },
            },
            include: { event: true },
          });
          const offset = (value: number) =>
            rows.find(
              (row) =>
                (row.event.snapshot as { offsetDays?: number }).offsetDays ===
                value,
            )!;
          const one = offset(1),
            zero = offset(0),
            seven = offset(7);
          await reminders.updateSettings(actor.id, {
            expectedRevision: 0,
            displayEnabled: true,
            remindersEnabled: true,
            sendTime: "00:00",
            offsetDays: [0, 7],
          });
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: one.id },
              })
            ).status,
            "cancelled",
          );
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: seven.id },
              })
            ).status,
            "pending",
          );
          await db.notificationDelivery.update({
            where: { id: zero.id },
            data: { status: "unknown" },
          });
          await reminders.updateSettings(actor.id, {
            expectedRevision: 1,
            displayEnabled: true,
            remindersEnabled: false,
            sendTime: "00:00",
            offsetDays: [0, 7],
          });
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: zero.id },
              })
            ).status,
            "unknown",
          );
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: seven.id },
              })
            ).status,
            "cancelled",
          );
          await assert.rejects(
            management.resolveDelivery(actor.id, zero.id, {
              expectedRevision: zero.revision,
              action: "retry",
              idempotencyKey: randomUUID(),
              confirmPossibleDuplicate: true,
            }),
            /过期|变化/,
          );
          await reminders.updateSettings(actor.id, {
            expectedRevision: 2,
            displayEnabled: true,
            remindersEnabled: true,
            sendTime: "00:00",
            offsetDays: [0, 7],
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            3,
          );
          await assertWorkUntouched();
        },
      );
      await clearBirthdays();
      await reset();
      await t.test(
        "cutoff changes do not backfill an already-past schedule",
        async () => {
          await db.birthdaySettings.update({
            where: { id: "global" },
            data: { reminderAcceptAfter: new Date(now.getTime() + 1) },
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            0,
          );
          await reset();
          await db.birthdayChannelSubscription.update({
            where: { channelId: channel.id },
            data: { acceptAfter: new Date(now.getTime() + 1) },
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            0,
          );
          await reset();
          await db.notificationChannel.update({
            where: { id: channel.id },
            data: { sourceAcceptAfter: new Date(now.getTime() + 1) },
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            0,
          );
          await db.notificationChannel.update({
            where: { id: channel.id },
            data: { sourceAcceptAfter: before },
          });
        },
      );
      await reset();
      await t.test(
        "unknown digest does not block another date digest; restart and transport remain exactly once",
        async () => {
          await reminders.maintain(now);
          await runtime.maintain();
          const rows = await db.notificationDelivery.findMany({
            where: {
              channelId: channel.id,
              event: { resourceKind: "birthday_digest" },
            },
            include: { event: true },
          });
          const unknown = rows.find(
            (row) =>
              (row.event.snapshot as { offsetDays?: number }).offsetDays === 0,
          )!;
          await db.notificationDelivery.update({
            where: { id: unknown.id },
            data: { status: "unknown" },
          });
          for (let index = 0; index < 5; index++) {
            await db.notificationChannel.update({
              where: { id: channel.id },
              data: { nextSendAt: null },
            });
            await runtime.runNext();
          }
          assert.equal(sent.length, 2);
          assert.ok(sent.every((text) => text.includes("冻结祝福")));
          await new BirthdayReminderService(db, registry).maintain(now);
          await worker().maintain();
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: catalog.id },
            }),
            3,
          );
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: unknown.id },
              })
            ).status,
            "unknown",
          );
          assert.equal(sent.length, 2);
          await assert.rejects(
            management.resolveDelivery(actor.id, unknown.id, {
              expectedRevision: unknown.revision,
              action: "retry",
              idempotencyKey: randomUUID(),
            }),
            /可能重复/,
          );
          const retryInput = {
            expectedRevision: unknown.revision,
            action: "retry" as const,
            idempotencyKey: randomUUID(),
            confirmPossibleDuplicate: true,
          };
          await assert.rejects(
            new NotificationsService(db, publisher, registry, {
              ...env,
              birthdays: { enabled: false },
            }).resolveDelivery(actor.id, unknown.id, retryInput),
            /生日功能已停用/,
          );
          const replay = await management.resolveDelivery(
            actor.id,
            unknown.id,
            retryInput,
          );
          assert.match(replay.preview, /^【历史补发】\n/);
          assert.ok(replay.preview.endsWith(unknown.text));
          assert.equal(replay.resourceKind, "birthday_digest");
          assert.equal(replay.birthday?.count, 2);
          assert.equal(
            (await management.resolveDelivery(actor.id, unknown.id, retryInput))
              .id,
            replay.id,
          );
          const savedReplay = await db.notificationDelivery.findUniqueOrThrow({
            where: { id: replay.id },
          });
          assert.equal(
            savedReplay.birthdayGlobalGeneration,
            unknown.birthdayGlobalGeneration,
          );
          assert.equal(
            savedReplay.birthdayOffsetGeneration,
            unknown.birthdayOffsetGeneration,
          );
          assert.equal(
            savedReplay.birthdayScopeGeneration,
            unknown.birthdayScopeGeneration,
          );
          await worker().maintain();
          await db.notificationChannel.update({
            where: { id: channel.id },
            data: { nextSendAt: null },
          });
          await worker().runNext();
          assert.equal(sent.length, 3);
          assert.equal(
            (
              await db.notificationDelivery.findUniqueOrThrow({
                where: { id: replay.id },
              })
            ).status,
            "accepted",
          );
        },
      );
      await clearBirthdays();
      await reset();
      await t.test(
        "mixed-source evidence expires independently and catalog changes do not reopen a frozen daily digest",
        async () => {
          await db.birthdaySettings.update({
            where: { id: "global" },
            data: { offsetDays: [0] },
          });
          const checkedAt = new Date(now.getTime() - 47 * 3_600_000);
          const stale = new Date(now.getTime() - 49 * 3_600_000);
          const primary = people[0]!;
          const entryId = 2_000_000_000 + Math.floor(Math.random() * 1_000_000);
          externalIds.push(entryId, entryId + 1, entryId + 2);
          const supplemental = externalIds.map((id, index) => ({
            ...primary,
            key: `kivo:${id}`,
            name: `合成未实装人物${index}`,
            originalEntryId: null,
            entryIds: [],
            birthdaySource: {
              source: "kivo",
              entryId: id,
              profileHash: "a".repeat(64),
            },
          }));
          await db.birthdayExternalEntry.createMany({
            data: supplemental.map((person, index) => ({
              source: "kivo",
              entryId: person.birthdaySource.entryId,
              personKey: person.key,
              status: "confirmed",
              profileHash:
                index === 2
                  ? "b".repeat(64)
                  : person.birthdaySource.profileHash,
              lastCheckedAt: index === 1 ? stale : checkedAt,
              listedAt: now,
              nextCheckAt: now,
            })),
          });
          const merged = await db.birthdayCatalog.create({
            data: {
              contentHash: randomUUID().replaceAll("-", "").repeat(2),
              people: [primary, ...supplemental],
              sourceCounts: {},
            },
          });
          ownedCatalogIds.push(merged.id);
          await db.birthdaySyncState.create({
            data: {
              id: "combined",
              catalogId: merged.id,
              lastCheckedAt: stale,
            },
          });
          await db.birthdaySyncState.update({
            where: { id: "schaledb" },
            data: { lastCheckedAt: stale },
          });
          await Promise.all([
            reminders.maintain(now),
            new BirthdayReminderService(db, registry).maintain(now),
          ]);
          const occurrence =
            await db.birthdayReminderOccurrence.findFirstOrThrow({
              where: { catalogId: merged.id },
            });
          const frozen = occurrence.snapshot as {
            checkedAt: string;
            validBefore: string;
            people: { key: string; originalEntryId: number | null }[];
          };
          assert.equal(occurrence.namespace, "schaledb");
          assert.deepEqual(
            frozen.people.map((person) => [person.key, person.originalEntryId]),
            [[supplemental[0]!.key, null]],
          );
          assert.equal(frozen.checkedAt, checkedAt.toISOString());
          assert.equal(
            frozen.validBefore,
            new Date(
              Math.min(
                birthdayDueAt(birthdayAddDays(date, 1), "00:00").getTime(),
                checkedAt.getTime() + 48 * 3_600_000,
              ),
            ).toISOString(),
          );
          await db.birthdaySyncState.update({
            where: { id: "schaledb" },
            data: { lastCheckedAt: now },
          });
          await db.birthdayExternalEntry.updateMany({
            where: { source: "kivo", entryId: { in: externalIds } },
            data: { lastCheckedAt: now, profileHash: "a".repeat(64) },
          });
          const refreshed = await db.birthdayCatalog.create({
            data: {
              contentHash: randomUUID().replaceAll("-", "").repeat(2),
              people: [
                primary,
                ...supplemental.map((person) => ({
                  ...person,
                  name: person.name + "新名称",
                })),
              ],
              sourceCounts: {},
            },
          });
          ownedCatalogIds.push(refreshed.id);
          await db.birthdaySyncState.update({
            where: { id: "combined" },
            data: { catalogId: refreshed.id, lastCheckedAt: now },
          });
          await reminders.maintain(now);
          assert.equal(
            await db.birthdayReminderOccurrence.count({
              where: { catalogId: { in: ownedCatalogIds } },
            }),
            1,
          );
          assert.deepEqual(
            (
              await db.birthdayReminderOccurrence.findUniqueOrThrow({
                where: { id: occurrence.id },
              })
            ).snapshot,
            occurrence.snapshot,
            "recovered people must not rewrite or duplicate an already frozen digest",
          );
          await clearBirthdays();
          await db.birthdayExternalEntry.updateMany({
            where: { source: "kivo", entryId: { in: externalIds } },
            data: { lastCheckedAt: stale },
          });
          await reminders.maintain(now);
          const primaryOnly =
            await db.birthdayReminderOccurrence.findFirstOrThrow({
              where: { catalogId: refreshed.id },
            });
          assert.deepEqual(
            (primaryOnly.snapshot as { people: { key: string }[] }).people.map(
              (person) => person.key,
            ),
            [primary.key],
            "stale supplemental evidence must not block the fresh primary source",
          );
        },
      );
    } finally {
      await clearBirthdays();
      await db.notificationDelivery.delete({ where: { id: workDelivery.id } });
      await db.notificationEvent.delete({ where: { id: work.id } });
      await db.birthdayChannelSubscription.deleteMany({
        where: { channelId: channel.id },
      });
      await db.notificationChannel.delete({ where: { id: channel.id } });
      if (previousSource)
        await db.birthdaySyncState.update({
          where: { id: "schaledb" },
          data: previousSource as unknown as Prisma.BirthdaySyncStateUncheckedUpdateInput,
        });
      else await db.birthdaySyncState.deleteMany({ where: { id: "schaledb" } });
      await db.birthdaySyncState.deleteMany({ where: { id: "combined" } });
      if (previousCombined)
        await db.birthdaySyncState.create({
          data: previousCombined as unknown as Prisma.BirthdaySyncStateUncheckedCreateInput,
        });
      await db.birthdayExternalEntry.deleteMany({
        where: { source: "kivo", entryId: { in: externalIds } },
      });
      await db.birthdayCatalog.deleteMany({
        where: { id: { in: ownedCatalogIds } },
      });
      if (previousSettings)
        await db.birthdaySettings.update({
          where: { id: "global" },
          data: previousSettings as unknown as Prisma.BirthdaySettingsUncheckedUpdateInput,
        });
      else await db.birthdaySettings.deleteMany({ where: { id: "global" } });
      await db.userRole.deleteMany({ where: { userId: actor.id } });
      await db.user.delete({ where: { id: actor.id } });
      await db.$disconnect();
    }
  },
);
