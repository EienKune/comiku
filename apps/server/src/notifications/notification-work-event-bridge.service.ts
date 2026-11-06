import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
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
} from "./notification-events.js";
import type {
  NotificationEventInput,
  NotificationFrozenRoute,
} from "./notifications.contracts.js";

// Keep this literal predicate identical to the migration partial index.
const supportedActions = Prisma.sql`e.action IN (
  'imported', 'stage_joined', 'stage_started', 'typeset_handoff_started',
  'stage_left', 'stage_assignment_updated', 'stage_submitted',
  'proofreading_skipped', 'stage_submission_cancelled', 'review_opened',
  'review_withdrawn', 'review_resumed', 'archived', 'restored', 'publish_confirmed')`;
const activeStatuses = ["pending", "retry_wait"];

function frozenRoutes(value: unknown): NotificationFrozenRoute[] {
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
      route.templateVersion !== 1
    )
      throw new Error("notification_routes_invalid");
    ids.add(route.id);
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
  ) {}

  async maintain(): Promise<void> {
    if (!this.registry.enabled || Date.now() < this.unavailableUntil) return;
    try {
      const activation = await this.db.notificationWorkEventActivation.upsert({
        where: { id: "work-events-v1" },
        update: {},
        create: { id: "work-events-v1" },
      });
      for (let count = 0; count < 50; count++) {
        if (!(await this.capture(activation.sourceSince))) break;
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
      for (const row of due) await this.register(row.id);
    } catch {
      this.unavailableUntil = Date.now() + 1000;
      this.logger.warn("notification_work_bridge_database_unavailable");
    }
  }

  private async capture(sourceSince: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const sources = await tx.$queryRaw<
        WorkEventNotificationSource[]
      >(Prisma.sql`
        SELECT e.id, e.work_id AS "workId", w.work_number AS "workNumber", e.action,
          e.created_at AS "createdAt", e.from_workflow_status AS "fromWorkflowStatus",
          e.to_workflow_status AS "toWorkflowStatus", e.from_review_status AS "fromReviewStatus",
          e.to_review_status AS "toReviewStatus", e.detail
        FROM work_events e JOIN works w ON w.id = e.work_id
        WHERE e.notification_captured_at IS NULL AND e.created_at >= ${sourceSince}
          AND ${supportedActions}
        ORDER BY e.created_at, e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
      const source = sources[0];
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
      const routes: NotificationFrozenRoute[] = input
        ? await tx.$queryRaw`
        SELECT id, revision, audience_generation AS generation, group_id AS "groupId",
          connection_key AS "connectionKey", connection_fingerprint AS "connectionFingerprint",
          include_details AS "includeDetails", 1 AS "templateVersion"
        FROM notification_channels WHERE enabled = true AND ${source.action} = ANY(event_types)
          AND source_accept_after <= ${source.createdAt}
        ORDER BY id LIMIT 51 FOR SHARE`
        : [];
      if (routes.length > 50) throw new Error("notification_routes_limit");
      if (input && !routes.length) {
        status = "skipped";
        errorCode = "no_source_subscription";
      }
      await tx.notificationWorkEventReceipt.create({
        data: {
          sourceEventId: source.id,
          resourceId: source.workId,
          resourceOrdinal,
          safeInput: input
            ? (JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue)
            : {},
          payloadHash: input ? notificationPayloadHash(input) : null,
          routeRefs: routes.map((route) => ({ ...route })),
          status,
          errorCode,
        },
      });
      await tx.$executeRaw`UPDATE work_events SET notification_captured_at = clock_timestamp() WHERE id = ${source.id}::uuid`;
      return true;
    });
  }

  private async register(id: string): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const due = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM notification_work_event_receipts WHERE id = ${id}::uuid
          AND status IN ('pending', 'retry_wait') AND next_attempt_at <= clock_timestamp() FOR UPDATE`;
        if (!due.length) return;
        const row = await tx.notificationWorkEventReceipt.findUniqueOrThrow({
          where: { id },
        });
        if (!activeStatuses.includes(row.status)) return;
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
          return;
        if (row.inputVersion !== 1)
          throw new Error("notification_event_invalid");
        const input = row.safeInput as unknown as NotificationEventInput;
        const allowedKeys = new Set([
          "eventKey",
          "type",
          "resourceId",
          "workNumber",
          "aggregateVersion",
          "ordinal",
          "occurredAt",
          "stage",
          "fromWorkflowStatus",
          "toWorkflowStatus",
          "fromReviewStatus",
          "toReviewStatus",
        ]);
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => !allowedKeys.has(key))
        )
          throw new Error("notification_event_invalid");
        const normalized = normalizeNotificationEvent(input);
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
          frozenRoutes(row.routeRefs),
        );
        await tx.notificationWorkEventReceipt.update({
          where: { id },
          data: {
            status: "recorded",
            notificationEventId: saved.id,
            errorCode: null,
          },
        });
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
        return;
      }
      this.logger.warn(
        `${invalid ? "notification_work_receipt_invalid" : "notification_work_receipt_retry"}:${id}`,
      );
    }
  }
}
