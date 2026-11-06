import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { NotificationPublisherService } from "./notification-publisher.service.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_TYPES,
  notificationPreview,
  renderNotificationMessage,
} from "./notification-events.js";
import type {
  NormalizedNotificationEvent,
  NotificationEventType,
} from "./notifications.contracts.js";
import {
  assertNotificationAdministrator,
  channelDto,
  deliveryDto,
  DELIVERY_STATUSES,
} from "./notification-engine.helpers.js";

export interface NotificationChannelInput {
  name: string;
  connectionKey: string;
  groupId: string;
  enabled: boolean;
  eventTypes: string[];
  includeDetails: boolean;
}
export interface NotificationResolveInput {
  expectedRevision: number;
  action: "acknowledge" | "retry";
  idempotencyKey: string;
  confirmPossibleDuplicate?: boolean;
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
    return {
      enabled: this.registry.enabled,
      configurationError: this.registry.configurationError,
      connections: this.registry.safeConnections(),
      eventTypes: NOTIFICATION_EVENT_TYPES.filter(
        (e) => e.type !== "notification.test",
      ),
      channels: (
        await this.db.notificationChannel.findMany({
          orderBy: { createdAt: "asc" },
          take: 50,
        })
      ).map(channelDto),
    };
  }

  private channelInput(
    input: NotificationChannelInput,
    offline?: { connectionKey: string; connectionFingerprint: string },
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
    return {
      name: input.name.trim(),
      connectionKey: connection.key,
      connectionFingerprint: connection.fingerprint,
      groupId: input.groupId,
      enabled: input.enabled,
      eventTypes: [...new Set(input.eventTypes)].sort(),
      includeDetails: input.includeDetails,
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
    input: NotificationChannelInput & { expectedRevision: number },
  ) {
    return this.db
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${id}::uuid FOR UPDATE`;
        await assertNotificationAdministrator(tx, actorId);
        const channel = await tx.notificationChannel.findUnique({
          where: { id },
        });
        if (!channel) throw new NotFoundException("通知通道不存在");
        if (channel.revision !== input.expectedRevision)
          throw new ConflictException("通知通道已更新");
        const data = this.channelInput(input, channel);
        const policyChanged =
          data.connectionKey !== channel.connectionKey ||
          data.connectionFingerprint !== channel.connectionFingerprint ||
          data.groupId !== channel.groupId ||
          data.enabled !== channel.enabled ||
          data.includeDetails !== channel.includeDetails ||
          JSON.stringify(data.eventTypes) !==
            JSON.stringify([...new Set(channel.eventTypes)].sort());
        if (!policyChanged) {
          if (data.name === channel.name) return channelDto(channel);
          return channelDto(
            await tx.notificationChannel.update({
              where: { id },
              data: {
                name: data.name,
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

  preview(input: { eventType: string; includeDetails: boolean }) {
    if (!NOTIFICATION_EVENT_TYPES.some((e) => e.type === input.eventType))
      throw new BadRequestException("通知事件类型无效");
    return {
      text: notificationPreview(
        input.eventType as NotificationEventType,
        input.includeDetails,
        this.environment.appOrigin,
      ),
    };
  }

  async listDeliveries(
    query: { cursor?: string; status?: string; limit?: number } = {},
  ) {
    const limit = Math.min(50, Math.max(1, query.limit ?? 25));
    if (
      !Number.isInteger(limit) ||
      (query.status && !DELIVERY_STATUSES.includes(query.status as never))
    )
      throw new BadRequestException("通知筛选无效");
    let position: { at: string; id: string; status: string | null } | undefined;
    if (query.cursor) {
      try {
        position = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        );
        if (
          !position ||
          position.status !== (query.status ?? null) ||
          !/^[0-9a-f-]{36}$/i.test(position.id) ||
          !Number.isFinite(new Date(position.at).getTime())
        )
          throw new Error();
      } catch {
        throw new BadRequestException("通知分页游标无效");
      }
    }
    const rows = await this.db.notificationDelivery.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(position
          ? {
              OR: [
                { createdAt: { lt: new Date(position.at) } },
                { createdAt: new Date(position.at), id: { lt: position.id } },
              ],
            }
          : {}),
      },
      include: { event: true, channel: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(deliveryDto),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                at: last.createdAt.toISOString(),
                id: last.id,
                status: query.status ?? null,
              }),
            ).toString("base64url")
          : null,
    };
  }

  async testChannel(
    actorId: string,
    channelId: string,
    idempotencyKey: string,
  ) {
    return this.db.$transaction(async (tx) => {
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
        return deliveryDto(prior);
      }
      const channel = await tx.notificationChannel.findUnique({
        where: { id: channelId },
      });
      if (!channel) throw new NotFoundException("通知通道不存在");
      if (!channel.enabled || !this.registry.get(channel.connectionKey))
        throw new ConflictException("通知通道未启用或连接不可用");
      const event = await this.publisher.recordTx(tx, {
        eventKey: requestKey,
        type: "notification.test",
        resourceId: randomUUID(),
        aggregateVersion: 0,
        occurredAt: new Date(),
      });
      // Test targets exactly the explicitly selected channel, independent of business subscriptions.
      await tx.notificationEvent.update({
        where: { id: event.id },
        data: { routeRefs: [], routedAt: new Date() },
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
          text: renderNotificationMessage(
            event as unknown as NormalizedNotificationEvent,
            {
              includeDetails: channel.includeDetails,
              siteUrl: this.environment.appOrigin,
            },
          ),
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
        select: { channelId: true },
      });
      if (!initial) throw new NotFoundException("通知投递不存在");
      await tx.$queryRaw`SELECT id FROM notification_channels WHERE id = ${initial.channelId}::uuid FOR UPDATE`;
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
            replayGeneration: (max._max.replayGeneration ?? 0) + 1,
            sourceDeliveryId: id,
            requestKey,
            requestedBy: actorId,
            connectionKey: source.connectionKey,
            connectionFingerprint: source.connectionFingerprint,
            groupId: source.groupId,
            channelRevision: source.channelRevision,
            text: renderNotificationMessage(
              source.event as unknown as NormalizedNotificationEvent,
              {
                includeDetails: channel.includeDetails,
                siteUrl: this.environment.appOrigin,
                historicalReplay: true,
              },
            ),
          },
          include: { event: true, channel: true },
        }),
      );
    });
  }
}
