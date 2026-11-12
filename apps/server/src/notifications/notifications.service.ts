import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { WorkStage } from "../generated/prisma/enums.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { NotificationPublisherService } from "./notification-publisher.service.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_TYPES,
  notificationPreviewEvent,
  renderNotificationMessage,
} from "./notification-events.js";
import type {
  NormalizedNotificationEvent,
  NotificationEventType,
  NotificationFrozenRoute,
} from "./notifications.contracts.js";
import {
  assertNotificationAdministrator,
  channelDto,
  deliveryDto,
  NOTIFICATION_JOB_KIND,
  NOTIFICATION_SCOPE,
} from "./notification-engine.helpers.js";
import { JobLane, JobStatus } from "../generated/prisma/enums.js";
import {
  buildNotificationHistoryQuery,
  normalizeNotificationHistoryQuery,
  notificationHistoryCursor,
  parseNotificationHistoryCursor,
  type NotificationHistoryQuery,
} from "./notification-history-query.js";
import {
  assertNotificationEventType,
  allowedNotificationStages,
  matchesSubscriptionRule,
  normalizeSubscriptionRules,
  normalizeTemplateSettings,
  notificationEventSupportsStages,
  readNotificationTemplates,
  resolveTemplatePolicy,
  type NotificationTemplateSettings,
  type NotificationTemplatePolicy,
  type NotificationSubscriptionRule,
} from "./notification-template-policy.js";
import {
  buildHistoricalReplayText,
  notificationTemplatePreview,
} from "./notification-content.js";
import {
  birthdayDeliveryInvalidReason,
  lockBirthdaySettings,
  lockBirthdaySubscription,
} from "./notification-birthday-policy.js";

export interface NotificationChannelInput {
  name: string;
  connectionKey: string;
  groupId: string;
  enabled: boolean;
  eventTypes: string[];
  includeDetails: boolean;
  receiverMode?: string;
  subscriptionRules?: unknown;
}
export interface NotificationResolveInput {
  expectedRevision: number;
  action: "acknowledge" | "retry";
  idempotencyKey: string;
  confirmPossibleDuplicate?: boolean;
}

function assertAdoptionTemplateRevisions(
  expected: unknown,
  eventTypes: readonly string[],
  templates: readonly NotificationTemplatePolicy[],
) {
  const invalid = () => new BadRequestException("请重新预览并确认所选事件模板");
  if (!Array.isArray(expected) || expected.length !== eventTypes.length)
    throw invalid();
  const revisions = new Map<string, number>();
  for (const entry of expected) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.eventType !== "string" ||
      !eventTypes.includes(entry.eventType) ||
      revisions.has(entry.eventType) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0
    )
      throw invalid();
    revisions.set(entry.eventType, entry.revision);
  }
  for (const [eventType, revision] of revisions) {
    if (
      templates.find((template) => template.eventType === eventType)
        ?.revision !== revision
    )
      throw new ConflictException("事件模板已变更，请重新预览并确认后重试");
  }
}

function channelConstraintConflict(error: unknown): never {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  )
    throw new ConflictException("该群已有通知通道");
  throw error;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(NotificationPublisherService)
    private readonly publisher: NotificationPublisherService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  async configuration() {
    const [channels, templates] = await Promise.all([
      this.db.notificationChannel.findMany({
        orderBy: { createdAt: "asc" },
        take: 50,
      }),
      readNotificationTemplates(this.db),
    ]);
    return {
      enabled: this.registry.enabled,
      configurationError: this.registry.configurationError,
      connections: this.registry.safeConnections(),
      eventTypes: NOTIFICATION_EVENT_TYPES.filter(
        (e) => e.type !== "notification.test",
      ).map((e) => ({
        ...e,
        supportsStages: notificationEventSupportsStages(e.type),
        allowedStages: allowedNotificationStages(e.type),
      })),
      channels: channels.map(channelDto),
      templates: templates.map((t) => ({
        ...t,
        referencedGroupCount: channels.filter(
          (c) =>
            c.receiverMode === "templates" &&
            c.eventTypes.includes(t.eventType),
        ).length,
      })),
    };
  }

  async updateTemplate(
    actorId: string,
    eventType: string,
    input: NotificationTemplateSettings & { expectedRevision: number },
  ) {
    assertNotificationEventType(eventType);
    const settings = normalizeTemplateSettings(input);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:notification-templates'))`;
      await assertNotificationAdministrator(tx, actorId);
      const existing = await tx.notificationTemplate.findUnique({
        where: { eventType },
      });
      const before = resolveTemplatePolicy(eventType, existing);
      if (before.revision !== input.expectedRevision)
        throw new ConflictException("消息模板已更新");
      const changed = Object.entries(settings).some(
        ([key, value]) =>
          before[key as keyof NotificationTemplateSettings] !== value,
      );
      const saved = changed
        ? existing
          ? await tx.notificationTemplate.update({
              where: { eventType },
              data: {
                ...settings,
                revision: before.revision + 1,
                contentRevision: before.contentRevision + 1,
              },
            })
          : await tx.notificationTemplate.create({
              data: { eventType, ...settings, revision: 1, contentRevision: 1 },
            })
        : before;
      const channels = await tx.notificationChannel.findMany({
        where: { receiverMode: "templates", eventTypes: { has: eventType } },
        take: 50,
      });
      return {
        ...resolveTemplatePolicy(eventType, saved),
        referencedGroupCount: channels.length,
      };
    });
  }

  private channelInput(
    input: NotificationChannelInput,
    offline?: {
      connectionKey: string;
      connectionFingerprint: string;
      receiverMode?: string;
    },
  ) {
    const connection =
      this.registry.get(input.connectionKey) ??
      (!input.enabled && offline?.connectionKey === input.connectionKey
        ? {
            key: offline.connectionKey,
            fingerprint: offline.connectionFingerprint,
          }
        : undefined);
    if (!connection) throw new BadRequestException("通知连接不可用");
    if (
      !input.name.trim() ||
      input.name.length > 80 ||
      !/^[1-9]\d{0,19}$/.test(input.groupId) ||
      typeof input.enabled !== "boolean" ||
      typeof input.includeDetails !== "boolean" ||
      !Array.isArray(input.eventTypes) ||
      input.eventTypes.some(
        (t) => !NOTIFICATION_EVENT_KEYS.includes(t as never),
      )
    )
      throw new BadRequestException("通知通道配置无效");
    const receiverMode =
      input.receiverMode ??
      offline?.receiverMode ??
      (offline ? "legacy" : "templates");
    if (!["legacy", "templates"].includes(receiverMode))
      throw new BadRequestException("通知模式无效");
    if (
      offline?.receiverMode === "templates" &&
      (input.receiverMode !== "templates" ||
        input.subscriptionRules === undefined)
    )
      throw new ConflictException("请刷新后使用事件模板订阅设置");
    const rules = normalizeSubscriptionRules(
      input.subscriptionRules ??
        [...new Set(input.eventTypes)].map((eventType) => ({
          eventType,
          stages: null,
        })),
      input.eventTypes,
    );
    return {
      name: input.name.trim(),
      connectionKey: connection.key,
      connectionFingerprint: connection.fingerprint,
      groupId: input.groupId,
      enabled: input.enabled,
      eventTypes: [...new Set(input.eventTypes)].sort(),
      includeDetails: input.includeDetails,
      receiverMode,
      subscriptionRules: rules,
    };
  }

  async createChannel(actorId: string, input: NotificationChannelInput) {
    const data = this.channelInput(input);
    return this.db
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:notification-channels'))`;
        await assertNotificationAdministrator(tx, actorId);
        if ((await tx.notificationChannel.count()) >= 50)
          throw new ConflictException("通知通道数量已达上限");
        if (
          await tx.notificationChannel.findUnique({
            where: { groupId: data.groupId },
          })
        )
          throw new ConflictException("该群已有通知通道");
        return channelDto(await tx.notificationChannel.create({ data }));
      })
      .catch(channelConstraintConflict);
  }

  async updateChannel(
    actorId: string,
    id: string,
    input: NotificationChannelInput & {
      expectedRevision: number;
      expectedTemplateRevisions?: { eventType: string; revision: number }[];
    },
  ) {
    return this.db
      .$transaction(async (tx) => {
        // Capture and sample transactions take this lock before channel locks.
        const templates =
          input.receiverMode === "templates"
            ? await readNotificationTemplates(tx, { lock: true })
            : [];
        await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${id}::uuid FOR UPDATE`;
        await assertNotificationAdministrator(tx, actorId);
        const channel = await tx.notificationChannel.findUnique({
          where: { id },
        });
        if (!channel) throw new NotFoundException("通知通道不存在");
        if (channel.revision !== input.expectedRevision)
          throw new ConflictException("通知通道已更新");
        const data = this.channelInput(input, channel);
        if (
          (channel.receiverMode ?? "legacy") === "legacy" &&
          data.receiverMode === "templates"
        )
          assertAdoptionTemplateRevisions(
            input.expectedTemplateRevisions,
            data.eventTypes,
            templates,
          );
        const oldRules = normalizeSubscriptionRules(
          Array.isArray(channel.subscriptionRules) &&
            channel.subscriptionRules.length
            ? channel.subscriptionRules
            : channel.eventTypes.map((eventType) => ({
                eventType,
                stages: null,
              })),
        );
        const policyChanged =
          data.connectionKey !== channel.connectionKey ||
          data.connectionFingerprint !== channel.connectionFingerprint ||
          data.groupId !== channel.groupId ||
          data.enabled !== channel.enabled ||
          (data.receiverMode === "legacy" &&
            data.includeDetails !== channel.includeDetails) ||
          JSON.stringify(data.subscriptionRules) !== JSON.stringify(oldRules);
        if (!policyChanged) {
          if (
            data.name === channel.name &&
            data.receiverMode === (channel.receiverMode ?? "legacy")
          )
            return channelDto(channel);
          return channelDto(
            await tx.notificationChannel.update({
              where: { id },
              data: {
                name: data.name,
                receiverMode: data.receiverMode,
                subscriptionRules: data.subscriptionRules,
                revision: { increment: 1 },
              },
            }),
          );
        }
        const duplicate = await tx.notificationChannel.findUnique({
          where: { groupId: data.groupId },
        });
        if (duplicate && duplicate.id !== id)
          throw new ConflictException("该群已有通知通道");
        const changed = await tx.notificationChannel.update({
          where: { id },
          data: {
            ...data,
            revision: { increment: 1 },
            audienceGeneration: { increment: 1 },
            sourceAcceptAfter: (
              await tx.$queryRaw<
                { now: Date }[]
              >`SELECT clock_timestamp() AS now`
            )[0]!.now,
          },
        });
        await tx.notificationDelivery.updateMany({
          where: { channelId: id, status: { in: ["pending", "retry_wait"] } },
          data: {
            status: "cancelled",
            errorCode: "channel_configuration_changed",
            revision: { increment: 1 },
          },
        });
        return channelDto(changed);
      })
      .catch(channelConstraintConflict);
  }

  preview(input: {
    eventType: string;
    includeDetails: boolean;
    template?: NotificationTemplateSettings;
    stage?: WorkStage;
    missingMetadata?: boolean;
  }) {
    if (!NOTIFICATION_EVENT_TYPES.some((e) => e.type === input.eventType))
      throw new BadRequestException("通知事件类型无效");
    if (
      input.stage &&
      !allowedNotificationStages(input.eventType).includes(input.stage)
    )
      throw new BadRequestException("该事件不支持所选职责");
    return {
      text: input.template
        ? notificationTemplatePreview(
            input.eventType as NotificationEventType,
            normalizeTemplateSettings(input.template),
            this.environment.appOrigin,
            input.stage,
            input.missingMetadata,
          )
        : renderNotificationMessage(
            notificationPreviewEvent(
              input.eventType as NotificationEventType,
              input.stage,
              input.missingMetadata,
            ),
            {
              includeDetails: input.includeDetails,
              siteUrl: this.environment.appOrigin,
              synthetic: true,
            },
          ),
    };
  }

  async listDeliveries(query: NotificationHistoryQuery = {}) {
    const filters = normalizeNotificationHistoryQuery(query);
    const position = parseNotificationHistoryCursor(query.cursor, filters);
    const work =
      filters.workNumber === null
        ? null
        : await this.db.work.findUnique({
            where: { workNumber: filters.workNumber },
            select: { id: true },
          });
    if (filters.workNumber !== null && !work)
      return { items: [], nextCursor: null };
    const ids = await this.db.$queryRaw<{ id: string }[]>(
      buildNotificationHistoryQuery(filters, position, work?.id ?? null),
    );
    if (!ids.length) return { items: [], nextCursor: null };
    const rows = await this.db.notificationDelivery.findMany({
      where: { id: { in: ids.slice(0, filters.limit).map((row) => row.id) } },
      include: { event: true, channel: true },
      take: filters.limit,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const page = ids
      .slice(0, filters.limit)
      .flatMap(({ id }) => (byId.get(id) ? [byId.get(id)!] : []));
    const jobIds = page
      .filter((row) => row.status === "pending" || row.status === "retry_wait")
      .flatMap((row) => (row.jobId ? [row.jobId] : []));
    const jobs = jobIds.length
      ? await this.db.backgroundJob.findMany({
          where: {
            id: { in: jobIds },
            kind: NOTIFICATION_JOB_KIND,
            lane: JobLane.network,
            executionScope: NOTIFICATION_SCOPE,
            status: JobStatus.queued,
            attempts: { lt: 3 },
          },
          select: { id: true, resourceId: true, availableAt: true },
          take: filters.limit,
        })
      : [];
    const scheduled = new Map(jobs.map((job) => [job.id, job]));
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const job = row.jobId ? scheduled.get(row.jobId) : undefined;
        const nextEligibleAt =
          job?.resourceId === row.id &&
          (row.status === "pending" || row.status === "retry_wait")
            ? new Date(
                Math.max(
                  job.availableAt.getTime(),
                  row.nextAttemptAt?.getTime() ?? 0,
                ),
              )
            : null;
        return deliveryDto(row, nextEligibleAt);
      }),
      nextCursor:
        ids.length > filters.limit && last
          ? notificationHistoryCursor(filters, last)
          : null,
    };
  }

  async testChannel(
    actorId: string,
    channelId: string,
    idempotencyKey: string,
    options: {
      eventType?: string;
      stage?: WorkStage;
      expectedRevision?: number;
      expectedTemplateRevision?: number;
    } = {},
  ) {
    return this.db.$transaction(async (tx) => {
      const templates = options.eventType
        ? await readNotificationTemplates(tx, { lock: true })
        : [];
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${channelId}::uuid FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const requestKey = `test:${actorId}:${idempotencyKey}`;
      const prior = await tx.notificationDelivery.findUnique({
        where: { requestKey },
        include: { event: true, channel: true },
      });
      if (prior) {
        if (prior.channelId !== channelId)
          throw new ConflictException("测试请求 key 已用于其他通道");
        const expectedType = options.eventType ?? "notification.test";
        const priorSnapshot = prior.event.snapshot as {
          stage?: string;
          sampleEventType?: string;
        };
        if (
          (priorSnapshot.sampleEventType ?? prior.event.type) !==
            expectedType ||
          (priorSnapshot.stage ?? null) !== (options.stage ?? null)
        )
          throw new ConflictException("测试请求 key 已用于其他事件或职责");
        return deliveryDto(prior);
      }
      const channel = await tx.notificationChannel.findUnique({
        where: { id: channelId },
      });
      if (!channel) throw new NotFoundException("通知通道不存在");
      if (
        !this.registry.enabled ||
        !channel.enabled ||
        !this.registry.get(channel.connectionKey)
      )
        throw new ConflictException("通知通道未启用或连接不可用");
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== channel.revision
      )
        throw new ConflictException("通知通道已更新");
      if (
        channel.receiverMode === "templates" &&
        (!options.eventType || options.expectedRevision === undefined)
      )
        throw new BadRequestException("请选择已保存的事件并确认群配置版本");
      let sampleText: string | undefined;
      let sampleTemplate: NotificationTemplatePolicy | null = null;
      let sampleRule: NotificationSubscriptionRule | null = null;
      if (options.eventType) {
        assertNotificationEventType(options.eventType);
        if (
          options.stage &&
          !allowedNotificationStages(options.eventType).includes(options.stage)
        )
          throw new BadRequestException("该事件不支持所选职责");
        const rules = normalizeSubscriptionRules(
          Array.isArray(channel.subscriptionRules) &&
            channel.subscriptionRules.length
            ? channel.subscriptionRules
            : channel.eventTypes.map((eventType) => ({
                eventType,
                stages: null,
              })),
        );
        sampleRule = matchesSubscriptionRule(
          rules,
          options.eventType,
          options.stage,
        );
        if (!sampleRule)
          throw new BadRequestException("所选事件或职责未被该群订阅");
        const template = templates.find(
          (t) => t.eventType === options.eventType,
        )!;
        if (
          channel.receiverMode === "templates" &&
          options.expectedTemplateRevision !== template.revision
        )
          throw new ConflictException("消息模板已更新，请重新确认样例");
        if (channel.receiverMode === "templates") sampleTemplate = template;
        sampleText =
          channel.receiverMode === "templates"
            ? notificationTemplatePreview(
                options.eventType,
                template,
                this.environment.appOrigin,
                options.stage,
              )
            : renderNotificationMessage(
                notificationPreviewEvent(options.eventType, options.stage),
                {
                  includeDetails: channel.includeDetails,
                  siteUrl: this.environment.appOrigin,
                  synthetic: true,
                },
              );
      }
      const event = await this.publisher.recordTx(tx, {
        eventKey: requestKey,
        type: "notification.test",
        resourceId: randomUUID(),
        aggregateVersion: 0,
        occurredAt: new Date(),
        ...(options.stage && { stage: options.stage }),
      });
      const text =
        sampleText ??
        renderNotificationMessage(
          event as unknown as NormalizedNotificationEvent,
          {
            includeDetails: channel.includeDetails,
            siteUrl: this.environment.appOrigin,
          },
        );
      const sampleRoute: NotificationFrozenRoute = {
        id: channel.id,
        revision: channel.revision,
        generation: channel.audienceGeneration,
        groupId: channel.groupId,
        connectionKey: channel.connectionKey,
        connectionFingerprint: channel.connectionFingerprint,
        includeDetails: channel.includeDetails,
        templateVersion: 1,
        content: {
          formatVersion: sampleTemplate ? 2 : 1,
          receiverMode: sampleTemplate ? "templates" : "legacy",
          templatePolicy: sampleTemplate,
          matchedRule: sampleRule,
          text,
          // Synthetic examples never represent observations of current business metadata.
          metadataObservedAt: null,
          metadataOrigin: null,
        },
      };
      // Test targets exactly the explicitly selected channel, independent of business subscriptions.
      await tx.notificationEvent.update({
        where: { id: event.id },
        data: {
          routeRefs: [sampleRoute] as unknown as Prisma.InputJsonValue,
          routedAt: new Date(),
          ...(options.eventType && {
            snapshot: {
              ...(event.snapshot as Prisma.JsonObject),
              sampleEventType: options.eventType,
            },
          }),
        },
      });
      const delivery = await tx.notificationDelivery.create({
        data: {
          eventId: event.id,
          channelId,
          audienceGeneration: channel.audienceGeneration,
          connectionKey: channel.connectionKey,
          connectionFingerprint: channel.connectionFingerprint,
          groupId: channel.groupId,
          channelRevision: channel.revision,
          requestedBy: actorId,
          requestKey,
          text,
        },
        include: { event: true, channel: true },
      });
      return deliveryDto(delivery);
    });
  }

  async resolveDelivery(
    actorId: string,
    id: string,
    input: NotificationResolveInput,
  ) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.notificationDelivery.findUnique({
        where: { id },
        select: { channelId: true, birthdayGlobalGeneration: true },
      });
      if (!initial) throw new NotFoundException("通知投递不存在");
      const birthdaySettings =
        initial.birthdayGlobalGeneration != null &&
        this.environment.birthdays?.enabled
          ? await lockBirthdaySettings(tx)
          : null;
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${initial.channelId}::uuid FOR UPDATE`;
      const birthdaySubscription =
        initial.birthdayGlobalGeneration != null &&
        this.environment.birthdays?.enabled
          ? await lockBirthdaySubscription(tx, initial.channelId)
          : null;
      await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id = ${id}::uuid FOR UPDATE`;
      await assertNotificationAdministrator(tx, actorId);
      const requestKey = `resolve:${actorId}:${input.idempotencyKey}`;
      const replay = await tx.notificationDelivery.findFirst({
        where: { OR: [{ requestKey }, { resolutionKey: requestKey }] },
        include: { event: true, channel: true },
      });
      if (replay) {
        if (
          (input.action === "retry" ? replay.sourceDeliveryId : replay.id) !==
            id ||
          (input.action === "retry"
            ? replay.requestKey
            : replay.resolutionKey) !== requestKey
        )
          throw new ConflictException("处理请求 key 已用于其他操作");
        return deliveryDto(replay);
      }
      const source = await tx.notificationDelivery.findUnique({
        where: { id },
        include: { event: true, channel: true },
      });
      if (!source) throw new NotFoundException("通知投递不存在");
      if (source.revision !== input.expectedRevision)
        throw new ConflictException("通知投递已更新");
      if (!["failed", "unknown", "cancelled"].includes(source.status))
        throw new ConflictException("该通知当前不可人工处理");
      if (source.resolvedAt)
        throw new ConflictException("该通知已完成人工处理");
      if (input.action === "acknowledge")
        return deliveryDto(
          await tx.notificationDelivery.update({
            where: { id },
            data: {
              resolvedAt: new Date(),
              resolutionKey: requestKey,
              revision: { increment: 1 },
            },
            include: { event: true, channel: true },
          }),
        );
      if (source.status === "unknown" && !input.confirmPossibleDuplicate)
        throw new ConflictException("请明确确认补发可能重复");
      if (source.event.resourceKind === "work_digest")
        throw new ConflictException(
          "工作提醒按当前任务重新汇总，请等待下一发送时段",
        );
      if (source.event.resourceKind === "birthday_digest") {
        if (!this.environment.birthdays?.enabled)
          throw new ConflictException("生日功能已停用，不能补发");
        const invalid = birthdayDeliveryInvalidReason(
          source.event.snapshot,
          source,
          birthdaySettings,
          birthdaySubscription,
        );
        if (invalid)
          throw new ConflictException("生日提醒已过期或订阅已变化，不能补发");
      }
      const channel = source.channel;
      if (
        !channel.enabled ||
        channel.audienceGeneration !== source.audienceGeneration ||
        channel.connectionFingerprint !== source.connectionFingerprint ||
        !this.registry.get(channel.connectionKey)
      )
        throw new ConflictException("原通知目标已变化，不能向新群补发历史通知");
      const max = await tx.notificationDelivery.aggregate({
        where: {
          eventId: source.eventId,
          channelId: source.channelId,
          audienceGeneration: source.audienceGeneration,
        },
        _max: { replayGeneration: true },
      });
      let replayText: string;
      try {
        replayText = buildHistoricalReplayText(source.text);
      } catch {
        throw new ConflictException(
          "原消息无法在1000字符内安全添加历史补发标记",
        );
      }
      await tx.notificationDelivery.update({
        where: { id },
        data: { resolvedAt: new Date(), revision: { increment: 1 } },
      });
      return deliveryDto(
        await tx.notificationDelivery.create({
          data: {
            eventId: source.eventId,
            channelId: source.channelId,
            audienceGeneration: source.audienceGeneration,
            birthdayGlobalGeneration: source.birthdayGlobalGeneration,
            birthdayOffsetGeneration: source.birthdayOffsetGeneration,
            birthdayScopeGeneration: source.birthdayScopeGeneration,
            replayGeneration: (max._max.replayGeneration ?? 0) + 1,
            sourceDeliveryId: id,
            requestKey,
            requestedBy: actorId,
            connectionKey: source.connectionKey,
            connectionFingerprint: source.connectionFingerprint,
            groupId: source.groupId,
            channelRevision: source.channelRevision,
            text: replayText,
          },
          include: { event: true, channel: true },
        }),
      );
    });
  }
}
