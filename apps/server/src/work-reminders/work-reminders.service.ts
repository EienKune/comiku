import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import type {
  NotificationChannel,
  Prisma,
  WorkReminderSubscription,
} from "../generated/prisma/client.js";
import { NotificationConnectionRegistry } from "../notifications/notification-connections.js";
import { assertNotificationAdministrator } from "../notifications/notification-engine.helpers.js";
import {
  lockWorkReminderSettings,
  lockWorkReminderSubscription,
} from "./work-reminder-notification-policy.js";
import {
  WorkReminderProjection,
  WORK_REMINDER_PROJECTION_LOCK,
} from "./work-reminder-projection.js";
import {
  currentWorkReminderSlot,
  normalizeWorkReminderNote,
  normalizeWorkReminderTimes,
  WORK_DIGEST_EVENT,
  WORK_DIGEST_RESOURCE,
} from "./work-reminder-scheduling.js";
import {
  renderWorkReminder,
  workReminderHash,
  type WorkDigestSnapshot,
  type WorkReminderFrozenItem,
} from "./work-reminder-render.js";
import type {
  WorkReminderSettingsInputDto,
  WorkReminderSubscriptionInputDto,
} from "./work-reminders.dto.js";

const asJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const subscribed = (
  scope: Pick<
    WorkReminderSubscription,
    "digestEnabled" | "readyEnabled" | "overdueEnabled"
  >,
) => scope.digestEnabled || scope.readyEnabled || scope.overdueEnabled;

/** Counts use present claimability, never future-stage reservations or dashboard totals. */
export async function readWorkDigestCounts(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<
    {
      availableTranslation: number;
      availableProofreading: number;
      availableTypesetting: number;
      availableWorks: number;
      candidates: number;
    }[]
  >`
    WITH available AS (
      SELECT w.id, CASE
        WHEN w.workflow_status IN ('pending_translate', 'translating') THEN 'translate'
        WHEN w.workflow_status IN ('pending_proofread', 'proofreading') AND w.proofread_skipped_version_id IS NULL THEN 'proofread'
        WHEN w.workflow_status IN ('pending_typeset', 'typesetting') THEN 'typeset'
      END AS stage
      FROM works w WHERE w.review_status = 'normal'
        AND w.workflow_status IN ('pending_translate','translating','pending_proofread','proofreading','pending_typeset','typesetting')
    ), vacant AS (
      SELECT a.* FROM available a WHERE a.stage IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM work_stage_participants p
        WHERE p.work_id = a.id AND p.stage::text = a.stage AND p.left_at IS NULL AND p.submitted_at IS NULL
      )
    ) SELECT
      (COUNT(*) FILTER (WHERE stage = 'translate'))::int AS "availableTranslation",
      (COUNT(*) FILTER (WHERE stage = 'proofread'))::int AS "availableProofreading",
      (COUNT(*) FILTER (WHERE stage = 'typeset'))::int AS "availableTypesetting",
      COUNT(DISTINCT id)::int AS "availableWorks",
      (SELECT COUNT(*)::int FROM candidate_posts c JOIN authors a ON a.id = c.author_id
        WHERE c.status = 'pending' AND a.authorization_status = 'authorized' AND a.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM candidate_media m JOIN file_objects f ON f.id = m.file_object_id
          WHERE m.candidate_post_id = c.id AND f.lifecycle_status = 'active' AND f.deleted_at IS NULL)) AS candidates
    FROM vacant`;
  return row!;
}
const emptyDigest = {
  availableTranslation: 0,
  availableProofreading: 0,
  availableTypesetting: 0,
  availableWorks: 0,
  candidates: 0,
};

@Injectable()
export class WorkRemindersService {
  private readonly projection: WorkReminderProjection;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
    @Optional() @Inject(ENVIRONMENT) private readonly environment?: Environment,
  ) {
    this.projection = new WorkReminderProjection(db);
  }
  private ensureSettings(tx: Prisma.TransactionClient = this.db) {
    return tx.workReminderSettings.upsert({
      where: { id: "global" },
      create: { id: "global" },
      update: {},
    });
  }
  private settingsDto(row: Awaited<ReturnType<typeof this.ensureSettings>>) {
    return {
      enabled: row.enabled,
      sendTimes: row.sendTimes,
      note: row.note,
      revision: row.revision,
    };
  }
  private channelDto(
    channel: NotificationChannel,
    scope: WorkReminderSubscription | null,
  ) {
    return {
      id: channel.id,
      name: channel.name,
      groupId: channel.groupId,
      enabled: channel.enabled,
      connectionKey: channel.connectionKey,
      revision: channel.revision,
      subscription: {
        digestEnabled: scope?.digestEnabled ?? false,
        readyEnabled: scope?.readyEnabled ?? false,
        overdueEnabled: scope?.overdueEnabled ?? false,
        mentionsEnabled: scope?.mentionsEnabled ?? true,
        revision: scope?.revision ?? 0,
      },
    };
  }
  async management() {
    const [settings, channels] = await Promise.all([
      this.ensureSettings(),
      this.db.notificationChannel.findMany({
        orderBy: { createdAt: "asc" },
        take: 50,
        include: { workReminderSubscription: true },
      }),
    ]);
    return {
      settings: this.settingsDto(settings),
      channels: channels.map((channel) =>
        this.channelDto(channel, channel.workReminderSubscription),
      ),
    };
  }
  async updateSettings(actorId: string, input: WorkReminderSettingsInputDto) {
    const sendTimes = normalizeWorkReminderTimes(input.sendTimes),
      note = normalizeWorkReminderNote(input.note);
    return this.db.$transaction(async (tx) => {
      await this.ensureSettings(tx);
      await tx.$queryRaw`SELECT id FROM work_reminder_settings WHERE id = 'global' FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const current = await tx.workReminderSettings.findUniqueOrThrow({
        where: { id: "global" },
      });
      if (current.revision !== input.expectedRevision)
        throw new ConflictException("工作摘要设置已更新");
      const changed =
        current.enabled !== input.enabled ||
        JSON.stringify(current.sendTimes) !== JSON.stringify(sendTimes);
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const updated = await tx.workReminderSettings.update({
        where: { id: "global" },
        data: {
          enabled: input.enabled,
          sendTimes,
          note,
          revision: { increment: 1 },
          ...(changed && { generation: { increment: 1 }, acceptAfter: now }),
        },
      });
      if (changed)
        await tx.notificationDelivery.updateMany({
          where: {
            status: { in: ["pending", "retry_wait"] },
            event: { resourceKind: WORK_DIGEST_RESOURCE },
          },
          data: {
            status: "cancelled",
            errorCode: "work_reminder_settings_changed",
            revision: { increment: 1 },
          },
        });
      return this.settingsDto(updated);
    });
  }
  async updateSubscription(
    actorId: string,
    channelId: string,
    input: WorkReminderSubscriptionInputDto,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockWorkReminderSettings(tx);
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channelId}::uuid FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const channel = await tx.notificationChannel.findUnique({
        where: { id: channelId },
      });
      if (!channel) throw new NotFoundException("通知通道不存在");
      if (channel.revision !== input.expectedChannelRevision)
        throw new ConflictException("通知通道已更新");
      const current = await tx.workReminderSubscription.findUnique({
        where: { channelId },
      });
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException("工作摘要订阅已更新");
      const data = {
        digestEnabled: input.digestEnabled,
        readyEnabled: input.readyEnabled,
        overdueEnabled: input.overdueEnabled,
        mentionsEnabled: input.mentionsEnabled,
      };
      if (
        Object.entries(data).every(
          ([key, value]) =>
            value ===
            (current?.[key as keyof typeof data] ?? key === "mentionsEnabled"),
        )
      )
        return this.channelDto(channel, current);
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const scope = await tx.workReminderSubscription.upsert({
        where: { channelId },
        create: { channelId, ...data, revision: 1, acceptAfter: now },
        update: {
          ...data,
          revision: { increment: 1 },
          generation: { increment: 1 },
          acceptAfter: now,
        },
      });
      await tx.notificationDelivery.updateMany({
        where: {
          channelId,
          status: { in: ["pending", "retry_wait"] },
          event: { resourceKind: WORK_DIGEST_RESOURCE },
        },
        data: {
          status: "cancelled",
          errorCode: "work_reminder_subscription_changed",
          revision: { increment: 1 },
        },
      });
      return this.channelDto(channel, scope);
    });
  }
  async preview(note?: string) {
    const settings = await this.ensureSettings();
    const snapshot: WorkDigestSnapshot = {
      kind: "work_digest",
      localDate: "2026-01-01",
      slot: "09:00",
      dueAt: "2026-01-01T01:00:00.000Z",
      validBefore: "2026-01-01T10:00:00.000Z",
      observedAt: "2026-01-01T01:00:00.000Z",
      counts: {
        availableTranslation: 3,
        availableProofreading: 2,
        availableTypesetting: 1,
        availableWorks: 6,
        candidates: 4,
        ready: 1,
        overdue: 1,
      },
      items: [
        {
          participantId: "example-ready",
          round: 1,
          userId: "example-user",
          workId: "example-work",
          workNumber: 42,
          title: "示例作品",
          displayName: "示例成员",
          stage: "typeset",
          kind: "ready",
          qqNumber: null,
          userRevision: 0,
          sourceKey: "example",
        },
        {
          participantId: "example-overdue",
          round: 1,
          userId: "example-user-two",
          workId: "example-work-two",
          workNumber: 43,
          title: "另一部示例作品",
          displayName: "另一位成员",
          stage: "translate",
          kind: "overdue",
          qqNumber: null,
          userRevision: 0,
          sourceKey: "example",
        },
      ],
    };
    return {
      text: renderWorkReminder(
        snapshot,
        note ?? settings.note,
        false,
        this.environment?.appOrigin,
      ).text,
    };
  }
  /** Bounded projection/registration only. Notification runtime owns the send boundary. */
  async maintain(now = new Date()) {
    if (!this.registry.enabled) return;
    const settings = await this.db.workReminderSettings.findUnique({
      where: { id: "global" },
    });
    if (!settings?.enabled) return;
    const scopes = await this.db.workReminderSubscription.findMany({
      where: {
        channel: { enabled: true },
        OR: [
          { digestEnabled: true },
          { readyEnabled: true },
          { overdueEnabled: true },
        ],
      },
      orderBy: { channelId: "asc" },
      take: 50,
    });
    if (!scopes.length) return;
    const observation = await this.projection.maintain(now);
    if (!observation.acquired) return;
    await this.db
      .$executeRaw`UPDATE notification_deliveries SET status = 'cancelled', error_code = 'work_reminder_expired', revision = revision + 1, updated_at = NOW()
      WHERE status IN ('pending','retry_wait') AND id IN (SELECT d.id FROM notification_deliveries d JOIN work_digest_occurrences o ON o.event_id = d.event_id
        WHERE d.status IN ('pending','retry_wait') AND o.valid_before <= ${now} ORDER BY o.valid_before, d.id LIMIT 50)`;
    let digestCounts:
      Awaited<ReturnType<typeof readWorkDigestCounts>> | undefined;
    for (const route of scopes)
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${WORK_REMINDER_PROJECTION_LOCK}, 0))`;
        const clock = await tx.workReminderClock.findUniqueOrThrow({
          where: { id: "global" },
        });
        const effectiveNow = new Date(
          Math.max(now.getTime(), clock.lastObservedAt.getTime()),
        );
        const settings = await lockWorkReminderSettings(tx);
        if (!settings?.enabled) return;
        const slot = currentWorkReminderSlot(settings.sendTimes, effectiveNow);
        if (!slot || settings.acceptAfter > slot.dueAt) return;
        await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${route.channelId}::uuid FOR SHARE`;
        const scope = await lockWorkReminderSubscription(tx, route.channelId);
        const channel = await tx.notificationChannel.findUniqueOrThrow({
          where: { id: route.channelId },
        });
        if (
          !scope ||
          !subscribed(scope) ||
          !channel.enabled ||
          scope.acceptAfter > slot.dueAt ||
          channel.sourceAcceptAfter > slot.dueAt
        )
          return;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comiku:work-digest:${channel.id}:${slot.localDate}:${slot.slot}`}))`;
        if (
          await tx.workDigestOccurrence.findUnique({
            where: {
              channelId_localDate_slot: {
                channelId: channel.id,
                localDate: slot.localDate,
                slot: slot.slot,
              },
            },
          })
        )
          return;
        // Only a conclusively unsent cancelled delivery releases its displayed notices.
        await tx.$executeRaw`DELETE FROM work_reminder_notices n WHERE n.channel_id = ${channel.id}::uuid
        AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id = n.event_id AND d.channel_id = n.channel_id AND d.status IN ('cancelled','failed')
          AND NOT EXISTS (SELECT 1 FROM notification_attempts a WHERE a.delivery_id = d.id AND a.send_boundary_crossed))`;
        const candidates = await this.projection.readItems(tx, effectiveNow, {
          channelId: channel.id,
          scopeGeneration: scope.generation,
          readyEnabled: scope.readyEnabled,
          overdueEnabled: scope.overdueEnabled,
          limit: 5,
        });
        const counts = {
          ...(scope.digestEnabled
            ? (digestCounts ??= await readWorkDigestCounts(tx))
            : emptyDigest),
          ready: candidates.readyCount,
          overdue: candidates.overdueCount,
        };
        const id = randomUUID();
        await tx.workDigestOccurrence.create({
          data: { id, channelId: channel.id, ...slot },
        });
        if (
          !counts.availableWorks &&
          !counts.candidates &&
          !candidates.items.length
        )
          return;
        const items: WorkReminderFrozenItem[] = candidates.items.map(
          ({
            participantId,
            round,
            userId,
            workId,
            workNumber,
            title,
            displayName,
            stage,
            kind,
            qqNumber,
            userRevision,
            sourceKey,
          }) => ({
            participantId,
            round,
            userId,
            workId,
            workNumber,
            title,
            displayName,
            stage,
            kind,
            qqNumber: scope.mentionsEnabled ? qqNumber : null,
            userRevision,
            sourceKey,
          }),
        );
        const snapshot: WorkDigestSnapshot = {
          kind: "work_digest",
          ...slot,
          dueAt: slot.dueAt.toISOString(),
          validBefore: slot.validBefore.toISOString(),
          observedAt: effectiveNow.toISOString(),
          counts,
          items,
        };
        const rendered = renderWorkReminder(
          snapshot,
          settings.note,
          scope.mentionsEnabled,
          this.environment?.appOrigin,
        );
        const event = await tx.notificationEvent.create({
          data: {
            eventKey: `work-digest:${id}`,
            payloadHash: workReminderHash(id, snapshot),
            type: WORK_DIGEST_EVENT,
            resourceKind: WORK_DIGEST_RESOURCE,
            resourceId: id,
            aggregateVersion: 1,
            ordinal: 0,
            occurredAt: slot.dueAt,
            snapshot: asJson(snapshot),
            routeRefs: asJson([
              {
                id: channel.id,
                revision: channel.revision,
                generation: channel.audienceGeneration,
                groupId: channel.groupId,
                connectionKey: channel.connectionKey,
                connectionFingerprint: channel.connectionFingerprint,
                includeDetails: false,
                templateVersion: 1,
                reminderGeneration: settings.generation,
                reminderScopeGeneration: scope.generation,
                content: {
                  formatVersion: 1,
                  receiverMode: "legacy",
                  templatePolicy: null,
                  matchedRule: null,
                  text: rendered.text,
                  metadataObservedAt: null,
                  metadataOrigin: null,
                },
                messageSegments: rendered.messageSegments,
              },
            ]),
          },
        });
        await tx.workDigestOccurrence.update({
          where: { id },
          data: { eventId: event.id },
        });
        if (items.length)
          await tx.workReminderNotice.createMany({
            data: items.map((item) => ({
              participantId: item.participantId,
              round: item.round,
              kind: item.kind,
              channelId: channel.id,
              scopeGeneration: scope.generation,
              eventId: event.id,
            })),
          });
      });
  }
}
