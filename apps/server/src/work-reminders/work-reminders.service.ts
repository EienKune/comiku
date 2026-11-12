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
import { Prisma } from "../generated/prisma/client.js";
import type {
  NotificationChannel,
  WorkReminderSettings,
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
  WORK_READY_EVENT,
  WORK_READY_RESOURCE,
} from "./work-reminder-scheduling.js";
import {
  renderWorkReminder,
  renderWorkReady,
  WorkReminderPayloadTooLargeError,
  workReminderHash,
  type WorkDigestSnapshot,
  type WorkReminderFrozenItem,
  type WorkReminderSnapshot,
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
      translationTotal: number;
      proofreadingTotal: number;
      typesettingTotal: number;
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
      (SELECT COUNT(*)::int FROM available WHERE stage = 'translate') AS "translationTotal",
      (SELECT COUNT(*)::int FROM available WHERE stage = 'proofread') AS "proofreadingTotal",
      (SELECT COUNT(*)::int FROM available WHERE stage = 'typeset') AS "typesettingTotal",
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
  translationTotal: 0,
  proofreadingTotal: 0,
  typesettingTotal: 0,
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
            event: {
              resourceKind: { in: [WORK_DIGEST_RESOURCE, WORK_READY_RESOURCE] },
            },
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
          event: {
            resourceKind: { in: [WORK_DIGEST_RESOURCE, WORK_READY_RESOURCE] },
          },
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
  async preview(note?: string, kind: "digest" | "ready" = "digest") {
    const settings = await this.ensureSettings();
    const snapshot: WorkDigestSnapshot = {
      kind: "work_digest",
      formatVersion: 2,
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
        translationTotal: 8,
        proofreadingTotal: 4,
        typesettingTotal: 2,
        ready: 0,
        overdue: 1,
      },
      items: [
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
    if (kind === "ready")
      return {
        text: renderWorkReady(
          {
            kind: "work_ready",
            dueAt: snapshot.dueAt,
            validBefore: snapshot.validBefore,
            observedAt: snapshot.observedAt,
            items: [
              { ...snapshot.items[0]!, kind: "ready", stage: "proofread" },
            ],
          },
          false,
          this.environment?.appOrigin,
        ).text.replace(/\/works\/example-work-two$/, "/works"),
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
        await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${route.channelId}::uuid FOR SHARE`;
        const scope = await lockWorkReminderSubscription(tx, route.channelId);
        const channel = await tx.notificationChannel.findUniqueOrThrow({
          where: { id: route.channelId },
        });
        if (!scope || !subscribed(scope) || !channel.enabled) return;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comiku:work-reminders:${channel.id}`}))`;
        const freeze = (items: WorkReminderFrozenItem[]) =>
          items.map(
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
        if (
          scope.readyEnabled &&
          settings.acceptAfter <= effectiveNow &&
          scope.acceptAfter <= effectiveNow &&
          channel.sourceAcceptAfter <= effectiveNow
        ) {
          const ready = await this.projection.readItems(tx, effectiveNow, {
            channelId: channel.id,
            scopeGeneration: scope.generation,
            readyEnabled: true,
            overdueEnabled: false,
            limit: 5,
            counts: false,
          });
          for (const item of ready.items) {
            const snapshot: WorkReminderSnapshot = {
              kind: "work_ready",
              dueAt: effectiveNow.toISOString(),
              validBefore: new Date(
                effectiveNow.getTime() + 86_400_000,
              ).toISOString(),
              observedAt: effectiveNow.toISOString(),
              items: freeze([item]),
            };
            await this.register(
              tx,
              randomUUID(),
              snapshot,
              channel,
              scope,
              settings,
            );
          }
        }
        if (!scope.digestEnabled && !scope.overdueEnabled) return;
        const slot = currentWorkReminderSlot(settings.sendTimes, effectiveNow);
        if (
          !slot ||
          settings.acceptAfter > slot.dueAt ||
          scope.acceptAfter > slot.dueAt ||
          channel.sourceAcceptAfter > slot.dueAt
        )
          return;
        const occurrence = await tx.workDigestOccurrence.findUnique({
          where: {
            channelId_localDate_slot: {
              channelId: channel.id,
              localDate: slot.localDate,
              slot: slot.slot,
            },
          },
        });
        if (occurrence) {
          if (!occurrence.eventId) return;
          const previous = await tx.notificationEvent.findUniqueOrThrow({
            where: { id: occurrence.eventId },
          });
          const frozen = previous.snapshot as {
            kind?: string;
            formatVersion?: number;
          };
          const ref = (
            previous.routeRefs as unknown as {
              id: string;
              generation: number;
              reminderGeneration?: number;
              reminderScopeGeneration?: number;
            }[]
          ).find((route) => route.id === channel.id);
          if (
            previous.resourceKind !== WORK_DIGEST_RESOURCE ||
            frozen.kind !== "work_digest" ||
            frozen.formatVersion !== 3 ||
            ref?.generation !== channel.audienceGeneration ||
            ref.reminderGeneration !== settings.generation ||
            ref.reminderScopeGeneration !== scope.generation
          )
            return;
          // Channel shared lock excludes send reservations and manual replay;
          // locking every sibling keeps the cancellation proof stable here.
          await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE event_id = ${previous.id}::uuid
            AND channel_id = ${channel.id}::uuid ORDER BY id FOR UPDATE`;
          const [safe] = await tx.$queryRaw<{ rebuild: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id = ${previous.id}::uuid
              AND d.channel_id = ${channel.id}::uuid) AND NOT EXISTS (
              SELECT 1 FROM notification_deliveries d WHERE d.event_id = ${previous.id}::uuid
                AND d.channel_id = ${channel.id}::uuid AND (
                  d.status <> 'cancelled' OR d.error_code IS NULL OR d.error_code NOT IN
                    ('work_reminder_task_changed','work_reminder_observation_stale') OR EXISTS (
                    SELECT 1 FROM notification_attempts a WHERE a.delivery_id = d.id AND a.send_boundary_crossed))) AS rebuild`;
          if (!safe?.rebuild) return;
        }
        const candidates = await this.projection.readItems(tx, effectiveNow, {
          channelId: channel.id,
          scopeGeneration: scope.generation,
          readyEnabled: false,
          overdueEnabled: scope.overdueEnabled,
          allOverdue: true,
        });
        const counts = {
          ...(scope.digestEnabled
            ? (digestCounts ??= await readWorkDigestCounts(tx))
            : emptyDigest),
          ready: candidates.readyCount,
          overdue: candidates.overdueCount,
        };
        const id = occurrence?.id ?? randomUUID();
        if (
          !counts.availableWorks &&
          !counts.translationTotal &&
          !counts.proofreadingTotal &&
          !counts.typesettingTotal &&
          !counts.candidates &&
          !candidates.items.length
        ) {
          if (!occurrence)
            await tx.workDigestOccurrence.create({
              data: { id, channelId: channel.id, ...slot },
            });
          return;
        }
        const items = freeze(candidates.items);
        const snapshot: WorkDigestSnapshot = {
          kind: "work_digest",
          formatVersion: 3,
          ...slot,
          dueAt: slot.dueAt.toISOString(),
          validBefore: slot.validBefore.toISOString(),
          observedAt: effectiveNow.toISOString(),
          counts,
          items,
        };
        let rendered: ReturnType<typeof renderWorkReminder>;
        try {
          rendered = renderWorkReminder(
            snapshot,
            settings.note,
            scope.mentionsEnabled,
            this.environment?.appOrigin,
          );
        } catch (error: unknown) {
          if (error instanceof WorkReminderPayloadTooLargeError) {
            console.warn(
              JSON.stringify({
                scope: "work-reminders",
                event: "digest_capacity_exceeded",
                errorCode: error.message,
                channelId: channel.id,
                localDate: slot.localDate,
                slot: slot.slot,
                itemCount: error.itemCount,
                mentionCount: error.mentionCount,
                textCodeUnits: error.textCodeUnits,
                limitBytes: error.limitBytes,
              }),
            );
            return;
          }
          throw error;
        }
        if (!occurrence)
          await tx.workDigestOccurrence.create({
            data: { id, channelId: channel.id, ...slot },
          });
        const eventId = await this.register(
          tx,
          occurrence ? randomUUID() : id,
          snapshot,
          channel,
          scope,
          settings,
          rendered,
        );
        await tx.workDigestOccurrence.update({
          where: { id },
          data: { eventId },
        });
      });
  }

  private async register(
    tx: Prisma.TransactionClient,
    id: string,
    snapshot: WorkReminderSnapshot,
    channel: NotificationChannel,
    scope: WorkReminderSubscription,
    settings: WorkReminderSettings,
    prepared?: ReturnType<typeof renderWorkReminder>,
  ) {
    const rendered =
      prepared ??
      (snapshot.kind === "work_ready"
        ? renderWorkReady(
            snapshot,
            scope.mentionsEnabled,
            this.environment?.appOrigin,
          )
        : renderWorkReminder(
            snapshot,
            settings.note,
            scope.mentionsEnabled,
            this.environment?.appOrigin,
          ));
    // Bound each statement while seeking only the selected participant identities.
    for (let offset = 0; offset < snapshot.items.length; offset += 100) {
      const rows = snapshot.items
        .slice(offset, offset + 100)
        .map(
          (item) =>
            Prisma.sql`(${item.participantId}::uuid, ${item.round}::int, ${item.kind}::text)`,
        );
      await tx.$executeRaw(Prisma.sql`DELETE FROM work_reminder_notices n
        USING (VALUES ${Prisma.join(rows)}) AS selected(participant_id, round, kind)
        WHERE n.participant_id = selected.participant_id AND n.round = selected.round
          AND n.kind = selected.kind AND n.channel_id = ${channel.id}::uuid
          AND EXISTS (SELECT 1 FROM notification_deliveries d
            WHERE d.event_id = n.event_id AND d.channel_id = n.channel_id AND d.status IN ('cancelled','failed')
              AND NOT EXISTS (SELECT 1 FROM notification_attempts a WHERE a.delivery_id = d.id AND a.send_boundary_crossed)
              AND NOT EXISTS (SELECT 1 FROM notification_deliveries sibling
                WHERE sibling.event_id = n.event_id AND sibling.channel_id = n.channel_id
                  AND (sibling.status NOT IN ('cancelled','failed') OR EXISTS (
                    SELECT 1 FROM notification_attempts a WHERE a.delivery_id = sibling.id AND a.send_boundary_crossed))))`);
    }
    const event = await tx.notificationEvent.create({
      data: {
        eventKey: `${snapshot.kind}:${id}`,
        payloadHash: workReminderHash(id, snapshot),
        type:
          snapshot.kind === "work_ready" ? WORK_READY_EVENT : WORK_DIGEST_EVENT,
        resourceKind:
          snapshot.kind === "work_ready"
            ? WORK_READY_RESOURCE
            : WORK_DIGEST_RESOURCE,
        resourceId: id,
        aggregateVersion: 1,
        ordinal: 0,
        occurredAt: new Date(snapshot.dueAt),
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
    for (let offset = 0; offset < snapshot.items.length; offset += 100)
      await tx.workReminderNotice.createMany({
        data: snapshot.items.slice(offset, offset + 100).map((item) => ({
          participantId: item.participantId,
          round: item.round,
          kind: item.kind,
          channelId: channel.id,
          scopeGeneration: scope.generation,
          eventId: event.id,
        })),
      });
    return event.id;
  }
}
