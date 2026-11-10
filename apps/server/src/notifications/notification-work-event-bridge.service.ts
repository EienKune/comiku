import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import { NotificationPublisherService } from "./notification-publisher.service.js";
import {
  mapWorkEventNotification,
  type WorkEventNotificationSource,
} from "./notification-work-event-mapper.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
  renderNotificationMessage,
} from "./notification-events.js";
import {
  renderTemplateNotificationMessage,
  validateNotificationReceiptInput,
} from "./notification-content.js";
import {
  readNotificationTemplates,
  matchesSubscriptionRule,
  normalizeSubscriptionRules,
  normalizeTemplateSettings,
} from "./notification-template-policy.js";
import type { NotificationSubscriptionRule } from "./notification-template-policy.js";
import type {
  NotificationEventInput,
  NotificationFrozenRoute,
  NormalizedNotificationEvent,
} from "./notifications.contracts.js";
import {
  NOTIFICATION_WORK_EVENT_ACTIVATION_ID,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID,
  buildNotificationWorkEventSourceBranches,
} from "./notification-work-event-source.js";

const activeStatuses = ["pending", "retry_wait"];
export interface NotificationBridgeMaintenanceResult {
  success: boolean;
  captured: number;
  registered: number;
}

export function validateNotificationFrozenRoutes(
  value: unknown,
  inputVersion: number,
  event?: NormalizedNotificationEvent,
): NotificationFrozenRoute[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("notification_routes_invalid");
  const ids = new Set<string>();
  for (const route of value) {
    if (
      !route ||
      typeof route !== "object" ||
      typeof route.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        route.id,
      ) ||
      ids.has(route.id) ||
      !Number.isInteger(route.revision) ||
      route.revision < 0 ||
      !Number.isInteger(route.generation) ||
      route.generation < 1 ||
      typeof route.groupId !== "string" ||
      !/^[1-9]\d{0,19}$/.test(route.groupId) ||
      typeof route.connectionKey !== "string" ||
      !route.connectionKey ||
      typeof route.connectionFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/i.test(route.connectionFingerprint) ||
      typeof route.includeDetails !== "boolean" ||
      route.templateVersion !== 1 ||
      (inputVersion === 2 &&
        (!route.content ||
          typeof route.content !== "object" ||
          typeof route.content.text !== "string" ||
          [...route.content.text].length > 1000 ||
          !["legacy", "templates"].includes(route.content.receiverMode))) ||
      (inputVersion === 1 && route.content !== undefined)
    )
      throw new Error("notification_routes_invalid");
    ids.add(route.id);
    if (inputVersion === 2) {
      const exactKeys = (object: object, keys: string[]) =>
        Object.keys(object).length === keys.length &&
        Object.keys(object).every((key) => keys.includes(key));
      const content = route.content;
      try {
        if (
          !exactKeys(route, [
            "id",
            "revision",
            "generation",
            "groupId",
            "connectionKey",
            "connectionFingerprint",
            "includeDetails",
            "templateVersion",
            "content",
          ]) ||
          !exactKeys(content, [
            "formatVersion",
            "receiverMode",
            "templatePolicy",
            "matchedRule",
            "text",
            "metadataObservedAt",
            "metadataOrigin",
          ]) ||
          !content.text.trim()
        )
          throw new Error();
        if (
          !content.matchedRule ||
          !exactKeys(content.matchedRule, ["eventType", "stages"])
        )
          throw new Error();
        const rules = normalizeSubscriptionRules([content.matchedRule]);
        if (
          event &&
          !matchesSubscriptionRule(rules, event.type, event.snapshot.stage)
        )
          throw new Error();
        if (content.receiverMode === "legacy") {
          if (
            content.formatVersion !== 1 ||
            content.templatePolicy !== null ||
            content.metadataObservedAt !== null ||
            content.metadataOrigin !== null
          )
            throw new Error();
        } else {
          const policy = content.templatePolicy;
          if (
            content.formatVersion !== 2 ||
            !policy ||
            !exactKeys(policy, [
              "eventType",
              "titleEnabled",
              "authorEnabled",
              "actorEnabled",
              "note",
              "revision",
              "contentRevision",
            ]) ||
            policy.eventType !== content.matchedRule.eventType ||
            !Number.isInteger(policy.revision) ||
            policy.revision < 0 ||
            !Number.isInteger(policy.contentRevision) ||
            policy.contentRevision < 0 ||
            policy.contentRevision > policy.revision ||
            content.metadataOrigin !== "capture_current" ||
            typeof content.metadataObservedAt !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              content.metadataObservedAt,
            ) ||
            !Number.isFinite(Date.parse(content.metadataObservedAt)) ||
            (event &&
              (event.snapshot.metadataObservedAt !==
                content.metadataObservedAt ||
                event.snapshot.metadataOrigin !== content.metadataOrigin))
          )
            throw new Error();
          if (normalizeTemplateSettings(policy).note !== policy.note)
            throw new Error();
        }
      } catch {
        throw new Error("notification_routes_invalid");
      }
    }
  }
  return value as NotificationFrozenRoute[];
}

/** Independent durable compensation. No producer calls or network activity. */
@Injectable()
export class NotificationWorkEventBridgeService {
  private readonly logger = new Logger(NotificationWorkEventBridgeService.name);
  private unavailableUntil = 0;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(NotificationPublisherService)
    private readonly publisher: NotificationPublisherService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
    @Optional() @Inject(ENVIRONMENT) private readonly environment?: Environment,
  ) {}

  async maintain(): Promise<NotificationBridgeMaintenanceResult | null> {
    if (!this.registry.enabled || Date.now() < this.unavailableUntil)
      return null;
    let captured = 0;
    let registered = 0;
    try {
      const activation = await this.db.notificationWorkEventActivation.upsert({
        where: { id: NOTIFICATION_WORK_EVENT_ACTIVATION_ID },
        update: {},
        create: { id: NOTIFICATION_WORK_EVENT_ACTIVATION_ID },
      });
      const expandedActivation =
        await this.db.notificationWorkEventActivation.upsert({
          where: { id: NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID },
          update: {},
          create: { id: NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID },
        });
      for (let count = 0; count < 50; count++) {
        if (
          !(await this.capture(
            activation.sourceSince,
            expandedActivation.sourceSince,
          ))
        )
          break;
        captured++;
      }
      const due = await this.db.$queryRaw<{ id: string }[]>`
        SELECT head.id FROM (
          SELECT DISTINCT ON (resource_id) id, next_attempt_at, created_at
          FROM notification_work_event_receipts
          WHERE status IN ('pending', 'retry_wait')
          ORDER BY resource_id, resource_ordinal
        ) head
        WHERE head.next_attempt_at <= clock_timestamp()
        ORDER BY head.next_attempt_at, head.created_at, head.id LIMIT 50`;
      for (const row of due) if (await this.register(row.id)) registered++;
      return { success: true, captured, registered };
    } catch {
      this.unavailableUntil = Date.now() + 1000;
      this.logger.warn("notification_work_bridge_database_unavailable");
      return { success: false, captured, registered };
    }
  }

  private async capture(
    sourceSince: Date,
    expandedSourceSince: Date,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const branches = buildNotificationWorkEventSourceBranches({
        sourceSince,
        expandedSourceSince,
      });
      const select = (eligibility: Prisma.Sql) =>
        tx.$queryRaw<WorkEventNotificationSource[]>(Prisma.sql`
        SELECT e.id, e.work_id AS "workId", w.work_number AS "workNumber", e.action,
          e.created_at AS "createdAt", e.from_workflow_status AS "fromWorkflowStatus",
          e.to_workflow_status AS "toWorkflowStatus", e.from_review_status AS "fromReviewStatus",
          e.to_review_status AS "toReviewStatus", e.detail
        FROM work_events e JOIN works w ON w.id = e.work_id
        WHERE ${eligibility}
        ORDER BY e.created_at, e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
      // Lock at most one candidate per independent indexed source range. SKIP LOCKED
      // lets another worker progress even when a source in either range is in flight.
      const legacy = await select(branches.legacy);
      const expanded = branches.expanded ? await select(branches.expanded) : [];
      const source = [...legacy, ...expanded].sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0];
      if (!source) return false;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-work:${source.workId}`}, 0))`;
      const prior = await tx.notificationWorkEventReceipt.findFirst({
        where: { resourceId: source.workId },
        orderBy: { resourceOrdinal: "desc" },
        select: { resourceOrdinal: true },
      });
      const resourceOrdinal = (prior?.resourceOrdinal ?? 0) + 1;
      let input: NotificationEventInput | null = null;
      let status = "pending";
      let errorCode: string | null = null;
      try {
        input = mapWorkEventNotification(source, resourceOrdinal);
        if (!input) throw new Error("notification_event_invalid");
      } catch {
        status = "invalid";
        errorCode = "source_mapping_invalid";
      }
      // Templates and channels share one capture transaction. Match management's lock order.
      const templates = input
        ? await readNotificationTemplates(tx, { lock: true })
        : [];
      type CaptureRoute = NotificationFrozenRoute & {
        receiverMode: string;
        subscriptionRules: NotificationSubscriptionRule[];
      };
      let routes: CaptureRoute[] = input
        ? await tx.$queryRaw`
        SELECT id, revision, audience_generation AS generation, group_id AS "groupId",
          connection_key AS "connectionKey", connection_fingerprint AS "connectionFingerprint",
          include_details AS "includeDetails", 1 AS "templateVersion",
          receiver_mode AS "receiverMode", subscription_rules AS "subscriptionRules"
        FROM notification_channels WHERE enabled = true AND ${source.action} = ANY(event_types)
          AND source_accept_after <= ${source.createdAt}
        ORDER BY id LIMIT 51 FOR SHARE`
        : [];
      if (routes.length > 50) throw new Error("notification_routes_limit");
      const sourceInput = input;
      if (input) {
        routes = routes.filter((route) =>
          matchesSubscriptionRule(
            route.subscriptionRules.length
              ? route.subscriptionRules
              : [{ eventType: input!.type as never, stages: null }],
            input!.type as never,
            input!.stage,
          ),
        );
        const template = templates.find(
          (item) => item.eventType === input!.type,
        )!;
        const hasTemplates = routes.some(
          (route) => route.receiverMode === "templates",
        );
        const needsTitle = hasTemplates && template.titleEnabled;
        const needsAuthor = hasTemplates && template.authorEnabled;
        const needsActor = hasTemplates && template.actorEnabled;
        let metadata = {
          title: null as string | null,
          authorName: null as string | null,
          actorName: null as string | null,
          observedAt: new Date(),
        };
        if (needsTitle || needsAuthor || needsActor) {
          const rows = await tx.$queryRaw<(typeof metadata)[]>`
            SELECT CASE WHEN ${needsTitle} THEN w.title ELSE NULL END AS title,
              CASE WHEN ${needsAuthor} THEN a.display_name ELSE NULL END AS "authorName",
              CASE WHEN ${needsActor} THEN u.display_name ELSE NULL END AS "actorName",
              clock_timestamp() AS "observedAt"
            FROM work_events e JOIN works w ON w.id = e.work_id
              LEFT JOIN authors a ON a.id = w.author_id
              LEFT JOIN users u ON u.id = e.actor_id
            WHERE e.id = ${source.id}::uuid LIMIT 1`;
          if (!rows[0]) throw new Error("notification_metadata_unavailable");
          metadata = rows[0];
        }
        input = {
          ...input,
          ...(needsTitle && { title: metadata.title }),
          ...(needsAuthor && { authorName: metadata.authorName }),
          ...(needsActor && { actorName: metadata.actorName }),
          metadataOrigin: "capture_current",
          metadataObservedAt: metadata.observedAt.toISOString(),
        };
        const normalized = normalizeNotificationEvent(input);
        routes = routes.map((route) => {
          const { receiverMode, subscriptionRules, ...frozen } = route;
          const isTemplate = receiverMode === "templates";
          return {
            ...frozen,
            receiverMode,
            subscriptionRules,
            content: {
              formatVersion: isTemplate ? 2 : 1,
              receiverMode: isTemplate ? "templates" : "legacy",
              templatePolicy: isTemplate ? { ...template } : null,
              matchedRule: matchesSubscriptionRule(
                subscriptionRules.length
                  ? subscriptionRules
                  : [{ eventType: input!.type as never, stages: null }],
                input!.type as never,
                input!.stage,
              ),
              text: isTemplate
                ? renderTemplateNotificationMessage(
                    normalized,
                    template,
                    this.environment?.appOrigin,
                  )
                : renderNotificationMessage(
                    normalizeNotificationEvent(sourceInput!),
                    {
                      includeDetails: route.includeDetails,
                      siteUrl: this.environment?.appOrigin,
                    },
                  ),
              metadataObservedAt: isTemplate
                ? input!.metadataObservedAt!
                : null,
              metadataOrigin: isTemplate ? "capture_current" : null,
            },
          };
        });
      }
      if (input && !routes.length) {
        status = "skipped";
        errorCode = "no_source_subscription";
      }
      await tx.notificationWorkEventReceipt.create({
        data: {
          sourceEventId: source.id,
          resourceId: source.workId,
          resourceOrdinal,
          inputVersion: 2,
          safeInput: input
            ? (JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue)
            : {},
          payloadHash: input ? notificationPayloadHash(input) : null,
          routeRefs: JSON.parse(
            JSON.stringify(
              routes.map((route) => ({
                id: route.id,
                revision: route.revision,
                generation: route.generation,
                groupId: route.groupId,
                connectionKey: route.connectionKey,
                connectionFingerprint: route.connectionFingerprint,
                includeDetails: route.includeDetails,
                templateVersion: route.templateVersion,
                content: route.content,
              })),
            ),
          ) as Prisma.InputJsonValue,
          status,
          errorCode,
        },
      });
      await tx.$executeRaw`UPDATE work_events SET notification_captured_at = clock_timestamp() WHERE id = ${source.id}::uuid`;
      return true;
    });
  }

  private async register(id: string): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const due = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM notification_work_event_receipts WHERE id = ${id}::uuid
          AND status IN ('pending', 'retry_wait') AND next_attempt_at <= clock_timestamp() FOR UPDATE`;
        if (!due.length) return false;
        const row = await tx.notificationWorkEventReceipt.findUniqueOrThrow({
          where: { id },
        });
        if (!activeStatuses.includes(row.status)) return false;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-work:${row.resourceId}`}, 0))`;
        if (
          await tx.notificationWorkEventReceipt.count({
            where: {
              resourceId: row.resourceId,
              resourceOrdinal: { lt: row.resourceOrdinal },
              status: { in: activeStatuses },
            },
          })
        )
          return false;
        const input = row.safeInput as unknown as NotificationEventInput;
        const normalized = validateNotificationReceiptInput(
          input,
          row.inputVersion,
        );
        if (row.payloadHash !== notificationPayloadHash(input))
          throw new Error("notification_event_invalid");
        if (
          input.eventKey !== `work-event:${row.sourceEventId}` ||
          normalized.resourceId !== row.resourceId ||
          normalized.aggregateVersion !== 0 ||
          normalized.ordinal !== row.resourceOrdinal
        )
          throw new Error("notification_event_invalid");
        const saved = await this.publisher.recordFrozenRoutesTx(
          tx,
          input,
          validateNotificationFrozenRoutes(
            row.routeRefs,
            row.inputVersion,
            normalized,
          ),
        );
        await tx.notificationWorkEventReceipt.update({
          where: { id },
          data: {
            status: "recorded",
            notificationEventId: saved.id,
            errorCode: null,
          },
        });
        return true;
      });
    } catch (error) {
      const invalid =
        error instanceof ConflictException ||
        (error instanceof Error &&
          [
            "notification_event_invalid",
            "notification_routes_invalid",
          ].includes(error.message));
      try {
        await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM notification_work_event_receipts WHERE id = ${id}::uuid FOR UPDATE`;
          const row = await tx.notificationWorkEventReceipt.findUniqueOrThrow({
            where: { id },
          });
          if (!activeStatuses.includes(row.status)) return;
          const attempts = Math.min(2_147_483_647, row.attempts + 1);
          await tx.notificationWorkEventReceipt.update({
            where: { id },
            data: {
              attempts,
              status: invalid ? "invalid" : "retry_wait",
              errorCode: invalid
                ? "persistent_input_conflict"
                : "registration_temporarily_unavailable",
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(300_000, 1000 * 2 ** Math.min(9, attempts - 1)),
              ),
            },
          });
        });
      } catch {
        // A failed failure-record write must not starve unrelated receipts in this bounded batch.
        this.unavailableUntil = Date.now() + 1000;
        this.logger.warn(`notification_work_receipt_state_unavailable:${id}`);
        return false;
      }
      this.logger.warn(
        `${invalid ? "notification_work_receipt_invalid" : "notification_work_receipt_retry"}:${id}`,
      );
      return false;
    }
  }
}
