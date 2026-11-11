import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import type {
  Prisma,
  NotificationChannel,
  BirthdayChannelSubscription,
} from "../generated/prisma/client.js";
import { NotificationConnectionRegistry } from "../notifications/notification-connections.js";
import { assertNotificationAdministrator } from "../notifications/notification-engine.helpers.js";
import { lockBirthdaySettings } from "../notifications/notification-birthday-policy.js";
import {
  birthdayAddDays,
  birthdayCutoffEligible,
  birthdayDueAt,
  birthdayLocalDate,
  birthdayOffsetStates,
  BIRTHDAY_NOTIFICATION_EVENT,
  BIRTHDAY_OFFSETS,
  BIRTHDAY_RESOURCE_KIND,
  BIRTHDAY_SOURCE_MAX_AGE_MS,
  normalizeBirthdayNote,
  validateBirthdaySchedule,
} from "./birthday-policy.js";
import {
  birthdayNotificationHash,
  renderBirthdayNotification,
  type BirthdayNotificationPerson,
  type BirthdayNotificationSnapshot,
} from "./birthday-notification.js";
import { readBirthdayPeople } from "./birthdays.service.js";

type SettingsInput = {
  expectedRevision: number;
  displayEnabled: boolean;
  remindersEnabled: boolean;
  sendTime: string;
  offsetDays: number[];
};
const asJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class BirthdayReminderService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
  ) {}

  private ensureSettings(tx: Prisma.TransactionClient = this.db) {
    return tx.birthdaySettings.upsert({
      where: { id: "global" },
      create: { id: "global" },
      update: {},
    });
  }
  private settingsDto(row: Awaited<ReturnType<typeof this.ensureSettings>>) {
    return {
      revision: row.revision,
      displayEnabled: row.displayEnabled,
      remindersEnabled: row.remindersEnabled,
      sendTime: row.sendTime,
      offsetDays: row.offsetDays,
    };
  }
  async settings() {
    return this.settingsDto(await this.ensureSettings());
  }
  async updateSettings(actorId: string, input: SettingsInput) {
    validateBirthdaySchedule(input);
    return this.db.$transaction(async (tx) => {
      await this.ensureSettings(tx);
      await tx.$queryRaw`SELECT id FROM birthday_settings WHERE id = 'global' FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const current = await tx.birthdaySettings.findUniqueOrThrow({
        where: { id: "global" },
      });
      if (current.revision !== input.expectedRevision)
        throw new ConflictException("生日设置已更新");
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const states = birthdayOffsetStates(current.offsetStates);
      const globalChanged = current.remindersEnabled !== input.remindersEnabled;
      for (const offset of BIRTHDAY_OFFSETS) {
        const wasEnabled = current.offsetDays.includes(offset);
        const enabled = input.offsetDays.includes(offset);
        if (wasEnabled !== enabled || (enabled && !states[String(offset)]))
          states[String(offset)] = {
            generation: (states[String(offset)]?.generation ?? 0) + 1,
            acceptAfter: now.toISOString(),
          };
      }
      const removed = current.offsetDays.filter(
        (offset) => !input.offsetDays.includes(offset),
      );
      const updated = await tx.birthdaySettings.update({
        where: { id: "global" },
        data: {
          displayEnabled: input.displayEnabled,
          remindersEnabled: input.remindersEnabled,
          sendTime: input.sendTime,
          offsetDays: [...input.offsetDays].sort((a, b) => a - b),
          revision: { increment: 1 },
          ...(globalChanged && {
            reminderGeneration: { increment: 1 },
            reminderAcceptAfter: now,
          }),
          offsetStates: asJson(states),
        },
      });
      if (globalChanged || removed.length)
        await tx.notificationDelivery.updateMany({
          where: {
            status: { in: ["pending", "retry_wait"] },
            event: {
              resourceKind: BIRTHDAY_RESOURCE_KIND,
              ...(!globalChanged && {
                OR: removed.map((offset) => ({
                  snapshot: { path: ["offsetDays"], equals: offset },
                })),
              }),
            },
          },
          data: {
            status: "cancelled",
            errorCode: "birthday_schedule_changed",
            revision: { increment: 1 },
          },
        });
      return this.settingsDto(updated);
    });
  }
  async template() {
    const settings = await this.ensureSettings();
    return { revision: settings.templateRevision, note: settings.templateNote };
  }
  async updateTemplate(
    actorId: string,
    input: { expectedRevision: number; note: string },
  ) {
    const note = normalizeBirthdayNote(input.note);
    return this.db.$transaction(async (tx) => {
      await this.ensureSettings(tx);
      await tx.$queryRaw`SELECT id FROM birthday_settings WHERE id = 'global' FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const settings = await tx.birthdaySettings.findUniqueOrThrow({
        where: { id: "global" },
      });
      if (settings.templateRevision !== input.expectedRevision)
        throw new ConflictException("生日模板已更新");
      const updated = await tx.birthdaySettings.update({
        where: { id: "global" },
        data: { templateNote: note, templateRevision: { increment: 1 } },
      });
      return { revision: updated.templateRevision, note: updated.templateNote };
    });
  }
  async channels() {
    const channels = await this.db.notificationChannel.findMany({
      orderBy: { createdAt: "asc" },
      take: 50,
      include: { birthdaySubscription: true },
    });
    return channels.map((channel) =>
      this.subscriptionDto(channel, channel.birthdaySubscription),
    );
  }
  private subscriptionDto(
    channel: NotificationChannel,
    scope: BirthdayChannelSubscription | null,
  ) {
    return {
      id: channel.id,
      name: channel.name,
      groupId: channel.groupId,
      enabled: channel.enabled,
      connectionKey: channel.connectionKey,
      revision: channel.revision,
      birthdayEnabled: scope?.enabled ?? false,
      birthdayRevision: scope?.revision ?? 0,
    };
  }
  async updateSubscription(
    actorId: string,
    channelId: string,
    input: {
      expectedChannelRevision: number;
      expectedScopeRevision: number;
      enabled: boolean;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      await lockBirthdaySettings(tx);
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channelId}::uuid FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const channel = await tx.notificationChannel.findUnique({
        where: { id: channelId },
      });
      if (!channel) throw new NotFoundException("通知通道不存在");
      if (channel.revision !== input.expectedChannelRevision)
        throw new ConflictException("通知通道已更新");
      const current = await tx.birthdayChannelSubscription.findUnique({
        where: { channelId },
      });
      if ((current?.revision ?? 0) !== input.expectedScopeRevision)
        throw new ConflictException("生日订阅已更新");
      if ((current?.enabled ?? false) === input.enabled)
        return this.subscriptionDto(channel, current);
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const subscription = await tx.birthdayChannelSubscription.upsert({
        where: { channelId },
        create: {
          channelId,
          enabled: input.enabled,
          revision: 1,
          acceptAfter: now,
        },
        update: {
          enabled: input.enabled,
          revision: { increment: 1 },
          audienceGeneration: { increment: 1 },
          acceptAfter: now,
        },
      });
      await tx.notificationDelivery.updateMany({
        where: {
          channelId,
          status: { in: ["pending", "retry_wait"] },
          event: { resourceKind: BIRTHDAY_RESOURCE_KIND },
        },
        data: {
          status: "cancelled",
          errorCode: "birthday_subscription_changed",
          revision: { increment: 1 },
        },
      });
      return this.subscriptionDto(channel, subscription);
    });
  }
  async preview(offset = 0, note?: string) {
    if (!BIRTHDAY_OFFSETS.includes(offset as never))
      throw new ConflictException("生日提醒日期无效");
    const saved = await this.template();
    return {
      text: renderBirthdayNotification(
        {
          targetLocalDate: birthdayAddDays("2026-01-01", offset),
          offsetDays: offset,
          people: [
            {
              key: "example",
              name: "示例学生",
              month: 1,
              day: 1 + offset,
              originalEntryId: 1,
            },
          ],
        },
        note ?? saved.note,
      ),
    };
  }

  /** One bounded DB-only pass; the existing notification engine owns all sends. */
  async maintain(now = new Date()) {
    if (!this.registry.enabled) return;
    const initial = await this.db.birthdaySettings.findUnique({
      where: { id: "global" },
    });
    if (!initial?.remindersEnabled) return;
    if (
      !(await this.db.birthdayChannelSubscription.count({
        where: { enabled: true, channel: { enabled: true } },
      }))
    )
      return;
    await this.db.$executeRaw`
      UPDATE notification_deliveries SET status = 'cancelled', error_code = 'birthday_expired', revision = revision + 1, updated_at = NOW()
      WHERE id IN (
        SELECT d.id FROM notification_deliveries d
        JOIN birthday_reminder_occurrences o ON o.event_id = d.event_id
        WHERE d.status IN ('pending', 'retry_wait') AND o.valid_before <= ${now}
        ORDER BY o.valid_before, d.id LIMIT 50
      )`;
    for (const offset of BIRTHDAY_OFFSETS)
      await this.db.$transaction(async (tx) => {
        const settings = await lockBirthdaySettings(tx);
        if (
          !settings?.remindersEnabled ||
          !settings.offsetDays.includes(offset)
        )
          return;
        const sendLocalDate = birthdayLocalDate(now);
        const dueAt = birthdayDueAt(sendLocalDate, settings.sendTime);
        const offsetState = birthdayOffsetStates(settings.offsetStates)[
          String(offset)
        ];
        if (
          dueAt > now ||
          !offsetState ||
          !birthdayCutoffEligible(settings.reminderAcceptAfter, dueAt) ||
          !birthdayCutoffEligible(offsetState.acceptAfter, dueAt)
        )
          return;
        // Serialize same-date writers without taking a write lock on global settings.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comiku:birthday:${sendLocalDate}:${offset}`}))`;
        const unique = {
          namespace: "schaledb",
          sendLocalDate,
          offsetDays: offset,
        };
        if (
          await tx.birthdayReminderOccurrence.findUnique({
            where: { namespace_sendLocalDate_offsetDays: unique },
          })
        )
          return;
        await tx.$queryRaw`SELECT id FROM birthday_sync_states WHERE id = 'schaledb' FOR SHARE`;
        const source = await tx.birthdaySyncState.findUnique({
          where: { id: "schaledb" },
          include: { catalog: true },
        });
        if (
          !source?.catalog ||
          !source.lastCheckedAt ||
          source.lastCheckedAt > now ||
          now.getTime() - source.lastCheckedAt.getTime() >
            BIRTHDAY_SOURCE_MAX_AGE_MS
        )
          return;
        const targetLocalDate = birthdayAddDays(sendLocalDate, offset);
        const people: BirthdayNotificationPerson[] = readBirthdayPeople(
          source.catalog.people,
        )
          .filter(
            (person) =>
              person.notificationEligible &&
              person.originalEntryId !== null &&
              person.month === Number(targetLocalDate.slice(5, 7)) &&
              person.day === Number(targetLocalDate.slice(8, 10)),
          )
          .map(({ key, name, month, day, originalEntryId }) => ({
            key,
            name,
            month: month!,
            day: day!,
            originalEntryId: originalEntryId!,
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
        if (!people.length) return;
        const routes = [];
        const subscriptions = await tx.birthdayChannelSubscription.findMany({
          where: {
            enabled: true,
            acceptAfter: { lte: dueAt },
            channel: { enabled: true },
          },
          orderBy: { channelId: "asc" },
          take: 51,
        });
        if (subscriptions.length > 50)
          throw new Error("birthday_routes_invalid");
        for (const subscription of subscriptions) {
          await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${subscription.channelId}::uuid FOR SHARE`;
          await tx.$queryRaw`SELECT channel_id FROM birthday_channel_subscriptions WHERE channel_id = ${subscription.channelId}::uuid FOR SHARE`;
          const channel = await tx.notificationChannel.findUniqueOrThrow({
            where: { id: subscription.channelId },
          });
          const scope = await tx.birthdayChannelSubscription.findUniqueOrThrow({
            where: { channelId: channel.id },
          });
          if (
            !channel.enabled ||
            !birthdayCutoffEligible(channel.sourceAcceptAfter, dueAt) ||
            !scope.enabled ||
            !birthdayCutoffEligible(scope.acceptAfter, dueAt)
          )
            continue;
          routes.push({
            id: channel.id,
            revision: channel.revision,
            generation: channel.audienceGeneration,
            groupId: channel.groupId,
            connectionKey: channel.connectionKey,
            connectionFingerprint: channel.connectionFingerprint,
            birthdayGlobalGeneration: settings.reminderGeneration,
            birthdayOffsetGeneration: offsetState.generation,
            birthdayScopeGeneration: scope.audienceGeneration,
          });
        }
        if (!routes.length) return;
        const id = randomUUID();
        const validBefore = new Date(
          Math.min(
            birthdayDueAt(birthdayAddDays(sendLocalDate, 1), "00:00").getTime(),
            source.lastCheckedAt.getTime() + BIRTHDAY_SOURCE_MAX_AGE_MS,
          ),
        );
        if (validBefore <= now) return;
        const snapshot: BirthdayNotificationSnapshot = {
          kind: "birthday_digest",
          sendLocalDate,
          targetLocalDate,
          offsetDays: offset,
          dueAt: dueAt.toISOString(),
          validBefore: validBefore.toISOString(),
          catalogId: source.catalog.id,
          catalogVersion: source.catalog.contentHash,
          checkedAt: source.lastCheckedAt.toISOString(),
          people,
          count: people.length,
        };
        const text = renderBirthdayNotification(
          snapshot,
          settings.templateNote,
        );
        await tx.birthdayReminderOccurrence.create({
          data: {
            id,
            ...unique,
            targetLocalDate,
            dueAt,
            validBefore,
            catalogId: source.catalog.id,
            snapshot: asJson(snapshot),
            globalGeneration: settings.reminderGeneration,
            offsetGeneration: offsetState.generation,
          },
        });
        const event = await tx.notificationEvent.create({
          data: {
            eventKey: `birthday:schaledb:${sendLocalDate}:${offset}`,
            payloadHash: birthdayNotificationHash(id, snapshot),
            type: BIRTHDAY_NOTIFICATION_EVENT,
            resourceKind: BIRTHDAY_RESOURCE_KIND,
            resourceId: id,
            aggregateVersion: 1,
            ordinal: 0,
            occurredAt: dueAt,
            snapshot: asJson(snapshot),
            routeRefs: asJson(
              routes.map((route) => ({
                ...route,
                content: {
                  formatVersion: 1,
                  text,
                  templateRevision: settings.templateRevision,
                },
              })),
            ),
          },
        });
        await tx.birthdayReminderOccurrence.update({
          where: { id },
          data: { eventId: event.id },
        });
      });
  }
}
