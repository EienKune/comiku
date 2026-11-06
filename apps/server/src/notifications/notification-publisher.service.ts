import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
} from "./notification-events.js";
import type {
  NotificationEventInput,
  NotificationFrozenRoute,
} from "./notifications.contracts.js";

@Injectable()
export class NotificationPublisherService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  /** DB-only entry point: errors abort the caller's transaction rather than being swallowed. */
  async recordTx(tx: Prisma.TransactionClient, input: NotificationEventInput) {
    const event = normalizeNotificationEvent(input);
    const payloadHash = notificationPayloadHash(input);
    const prior = await tx.notificationEvent.findUnique({
      where: { eventKey: event.eventKey },
    });
    if (prior) return this.replay(prior, payloadHash);
    const channels = await tx.notificationChannel.findMany({
      where: { enabled: true, eventTypes: { has: event.type } },
      select: {
        id: true,
        revision: true,
        audienceGeneration: true,
        groupId: true,
        connectionKey: true,
        connectionFingerprint: true,
        includeDetails: true,
      },
      orderBy: { id: "asc" },
      take: 51,
    });
    if (channels.length > 50)
      throw new ConflictException("通知通道数量超过有界路由限制");
    return this.recordFrozenRoutesTx(
      tx,
      input,
      channels.map((c) => ({
        id: c.id,
        revision: c.revision,
        generation: c.audienceGeneration,
        groupId: c.groupId,
        connectionKey: c.connectionKey,
        connectionFingerprint: c.connectionFingerprint,
        includeDetails: c.includeDetails,
        templateVersion: 1,
      })),
    );
  }

  /** Module-internal: replay the capture-time audience, never re-resolve subscriptions. */
  async recordFrozenRoutesTx(
    tx: Prisma.TransactionClient,
    input: NotificationEventInput,
    routes: NotificationFrozenRoute[],
  ) {
    const event = normalizeNotificationEvent(input);
    const payloadHash = notificationPayloadHash(input);
    if (routes.length > 50) throw new Error("notification_routes_invalid");
    await tx.notificationEvent.createMany({
      data: {
        eventKey: event.eventKey,
        payloadHash,
        type: event.type,
        resourceId: event.resourceId,
        aggregateVersion: event.aggregateVersion,
        ordinal: event.ordinal,
        occurredAt: event.occurredAt,
        snapshot: { ...event.snapshot },
        routeRefs: routes.map((r) => ({ ...r })),
      },
      skipDuplicates: true,
    });
    const saved = await tx.notificationEvent.findUniqueOrThrow({
      where: { eventKey: event.eventKey },
    });
    return this.replay(saved, payloadHash);
  }

  async record(input: NotificationEventInput) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction((tx) => this.recordTx(tx, input));
      } catch (error) {
        if (
          attempt >= 2 ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "P2034"
        )
          throw error;
      }
    }
  }

  private replay<T extends { payloadHash: string }>(event: T, hash: string): T {
    if (event.payloadHash !== hash)
      throw new ConflictException("通知事件 key 已存在且数据不一致");
    return event;
  }
}
