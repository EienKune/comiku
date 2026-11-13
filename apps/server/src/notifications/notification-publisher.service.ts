import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
  renderNotificationMessage,
} from "./notification-events.js";
import { renderTemplateNotificationMessage } from "./notification-content.js";
import {
  readNotificationTemplates,
  matchesSubscriptionRule,
  normalizeSubscriptionRules,
} from "./notification-template-policy.js";
import type {
  NotificationEventInput,
  NotificationFrozenRoute,
} from "./notifications.contracts.js";

@Injectable()
export class NotificationPublisherService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Optional() @Inject(ENVIRONMENT) private readonly environment?: Environment,
  ) {}

  /** DB-only entry point: errors abort the caller's transaction rather than being swallowed. */
  async recordTx(tx: Prisma.TransactionClient, input: NotificationEventInput) {
    const event = normalizeNotificationEvent(input);
    const payloadHash = notificationPayloadHash(input);
    const prior = await tx.notificationEvent.findUnique({
      where: { eventKey: event.eventKey },
    });
    if (prior) return this.replay(prior, payloadHash);
    // Saved samples explicitly target one group in the management service.
    if (event.type === "notification.test")
      return this.recordFrozenRoutesTx(tx, input, []);
    const eventType = event.type;
    // Same lock order as capture and sample management: templates, then groups.
    const templates = await readNotificationTemplates(tx, { lock: true });
    const template = templates.find((row) => row.eventType === eventType)!;
    const channels = await tx.$queryRaw<
      (Omit<NotificationFrozenRoute, "templateVersion"> & {
        receiverMode: string;
        subscriptionRules: Prisma.JsonValue;
      })[]
    >`
      SELECT id, revision, audience_generation AS generation, group_id AS "groupId",
        connection_key AS "connectionKey", connection_fingerprint AS "connectionFingerprint",
        include_details AS "includeDetails", receiver_mode AS "receiverMode", subscription_rules AS "subscriptionRules"
      FROM notification_channels WHERE enabled = true AND ${eventType} = ANY(event_types)
      ORDER BY id LIMIT 51 FOR SHARE`;
    if (channels.length > 50)
      throw new ConflictException("通知通道数量超过有界路由限制");
    return this.recordFrozenRoutesTx(
      tx,
      input,
      channels.flatMap((c): NotificationFrozenRoute[] => {
        const rules = normalizeSubscriptionRules(
          Array.isArray(c.subscriptionRules) && c.subscriptionRules.length
            ? c.subscriptionRules
            : [{ eventType, stages: null }],
        );
        const rule = matchesSubscriptionRule(rules, eventType, input.stage);
        if (!rule) return [];
        const isTemplate = c.receiverMode === "templates";
        return [
          {
            id: c.id,
            revision: c.revision,
            generation: c.generation,
            groupId: c.groupId,
            connectionKey: c.connectionKey,
            connectionFingerprint: c.connectionFingerprint,
            includeDetails: c.includeDetails,
            templateVersion: 1,
            content: {
              formatVersion: isTemplate ? 2 : 1,
              receiverMode: isTemplate ? "templates" : "legacy",
              templatePolicy: isTemplate ? { ...template } : null,
              matchedRule: rule,
              text: isTemplate
                ? renderTemplateNotificationMessage(
                    event,
                    template,
                    this.environment?.appOrigin,
                  )
                : renderNotificationMessage(event, {
                    includeDetails: c.includeDetails,
                    siteUrl: this.environment?.appOrigin,
                  }),
              metadataObservedAt: isTemplate
                ? (input.metadataObservedAt ?? null)
                : null,
              metadataOrigin: isTemplate
                ? (input.metadataOrigin ?? null)
                : null,
            },
          },
        ];
      }),
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
        resourceKind:
          event.type === "notification.test" ? "notification_test" : "work",
        resourceId: event.resourceId,
        aggregateVersion: event.aggregateVersion,
        ordinal: event.ordinal,
        occurredAt: event.occurredAt,
        snapshot: { ...event.snapshot },
        routeRefs: JSON.parse(JSON.stringify(routes)) as Prisma.InputJsonValue,
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
