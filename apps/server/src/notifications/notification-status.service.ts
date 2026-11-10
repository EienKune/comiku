import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENT_TYPES,
} from "./notification-events.js";
import {
  NOTIFICATION_WORK_EVENT_ACTIVATION_ID,
  NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID,
  buildNotificationWorkEventSourceBranches,
} from "./notification-work-event-source.js";
import {
  notificationReceiptStatuses,
  type NotificationBoundedMetricDto,
  type NotificationReceiptItemDto,
  type NotificationReceiptPageDto,
  type NotificationReceiptStatus,
  type NotificationReceiptsQueryDto,
  type NotificationStatusDto,
} from "./notifications-status.dto.js";

const receiptErrors = new Set([
  "source_mapping_invalid",
  "no_source_subscription",
  "persistent_input_conflict",
  "registration_temporarily_unavailable",
]);
const maintenanceError = "maintenance_failed";
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
type Activation = {
  id: string;
  sourceSince: Date;
  lastMaintenanceAt: Date | null;
  lastCaptureAt: Date | null;
  lastRegistrationAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
};
type ReceiptRow = Omit<
  NotificationReceiptItemDto,
  "nextAttemptAt" | "createdAt" | "updatedAt" | "workNumber" | "eventLabel"
> & {
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  workNumber: string | null;
};
type Cursor = {
  id: string;
  createdAt: string;
  status: NotificationReceiptStatus;
};

function parseCursor(
  raw: string | undefined,
  status: NotificationReceiptStatus,
): Cursor | null {
  if (raw === undefined) return null;
  const invalid = () =>
    new BadRequestException("notification_receipt_cursor_invalid");
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw invalid();
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object") throw invalid();
    const cursor = decoded as Cursor;
    if (
      Object.keys(cursor).length !== 3 ||
      cursor.status !== status ||
      typeof cursor.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cursor.id,
      ) ||
      typeof cursor.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt) ||
      new Date(cursor.createdAt).toISOString() !== cursor.createdAt
    )
      throw invalid();
    return cursor;
  } catch {
    throw invalid();
  }
}

function metric(rows: { createdAt: Date }[]): NotificationBoundedMetricDto {
  return {
    count: Math.min(rows.length, 1000),
    capped: rows.length > 1000,
    oldestAt: iso(rows[0]?.createdAt),
  };
}

@Injectable()
export class NotificationStatusService {
  private readonly logger = new Logger(NotificationStatusService.name);
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(NotificationConnectionRegistry)
    private readonly registry: NotificationConnectionRegistry,
  ) {}

  async status(): Promise<NotificationStatusDto> {
    const activations = await this.db.$queryRaw<Activation[]>(Prisma.sql`
      SELECT id, source_since AS "sourceSince", last_maintenance_at AS "lastMaintenanceAt",
        last_capture_at AS "lastCaptureAt", last_registration_at AS "lastRegistrationAt",
        last_error_at AS "lastErrorAt", last_error_code AS "lastErrorCode"
      FROM notification_work_event_activation
      WHERE id IN (${NOTIFICATION_WORK_EVENT_ACTIVATION_ID}, ${NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID})`);
    const activation = activations.find(
      (row) => row.id === NOTIFICATION_WORK_EVENT_ACTIVATION_ID,
    );
    const expanded = activations.find(
      (row) => row.id === NOTIFICATION_EXPANDED_WORK_EVENT_ACTIVATION_ID,
    );
    const receiptMetric = async (status: NotificationReceiptStatus) =>
      metric(
        await this.db.$queryRaw<{ createdAt: Date }[]>(Prisma.sql`
      SELECT created_at AS "createdAt" FROM notification_work_event_receipts
      WHERE status = ${status} ORDER BY created_at ASC, id ASC LIMIT 1001`),
      );
    const [pending, retryWait, invalid] = await Promise.all([
      receiptMetric("pending"),
      receiptMetric("retry_wait"),
      receiptMetric("invalid"),
    ]);
    let uncaptured: NotificationBoundedMetricDto | null = null;
    if (this.registry.enabled && activation) {
      const branches = buildNotificationWorkEventSourceBranches({
        sourceSince: activation.sourceSince,
        expandedSourceSince: expanded?.sourceSince ?? null,
      });
      const sourceMetric = (predicate: Prisma.Sql) =>
        this.db.$queryRaw<{ id: string; createdAt: Date }[]>(Prisma.sql`
        SELECT e.id, e.created_at AS "createdAt" FROM work_events e
        WHERE ${predicate} ORDER BY e.created_at ASC, e.id ASC LIMIT 1001`);
      const [legacy, expandedRows] = await Promise.all([
        sourceMetric(branches.legacy),
        branches.expanded
          ? sourceMetric(branches.expanded)
          : Promise.resolve([]),
      ]);
      uncaptured = metric(
        [...legacy, ...expandedRows]
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .slice(0, 1001),
      );
    }
    const success = activation?.lastMaintenanceAt;
    const error = activation?.lastErrorAt;
    const state = !this.registry.enabled
      ? "disabled"
      : error && (!success || error > success)
        ? "error"
        : !success
          ? "not_started"
          : Date.now() - success.getTime() > 60_000
            ? "stale"
            : "healthy";
    return {
      enabled: this.registry.enabled,
      state,
      sourceSince: iso(activation?.sourceSince),
      expandedSourceSince: iso(expanded?.sourceSince),
      lastMaintenanceAt: iso(success),
      lastCaptureAt: iso(activation?.lastCaptureAt),
      lastRegistrationAt: iso(activation?.lastRegistrationAt),
      lastErrorAt: iso(error),
      lastErrorCode:
        activation?.lastErrorCode === maintenanceError
          ? maintenanceError
          : null,
      counts: { uncaptured, pending, retryWait, invalid },
    };
  }

  async receipts(
    query: NotificationReceiptsQueryDto = {},
  ): Promise<NotificationReceiptPageDto> {
    const status = query.status ?? "retry_wait";
    const limit = query.limit ?? 20;
    if (
      !(notificationReceiptStatuses as readonly string[]).includes(status) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new BadRequestException("notification_receipt_query_invalid");
    const cursor = parseCursor(
      query.cursor,
      status as NotificationReceiptStatus,
    );
    const rows = await this.db.$queryRaw<ReceiptRow[]>(Prisma.sql`
      SELECT id, source_event_id AS "sourceEventId", resource_id AS "resourceId",
        safe_input ->> 'workNumber' AS "workNumber", safe_input ->> 'type' AS "eventType",
        status, attempts, error_code AS "errorCode", next_attempt_at AS "nextAttemptAt",
        created_at AS "createdAt", updated_at AS "updatedAt", notification_event_id AS "notificationEventId"
      FROM notification_work_event_receipts WHERE status = ${status}
        ${cursor ? Prisma.sql`AND (created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)` : Prisma.empty}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`);
    const items: NotificationReceiptItemDto[] = rows
      .slice(0, limit)
      .map((row) => {
        const eventType =
          row.eventType &&
          (NOTIFICATION_EVENT_KEYS as readonly string[]).includes(row.eventType)
            ? row.eventType
            : null;
        const workNumber =
          row.workNumber !== null && /^\d+$/.test(row.workNumber)
            ? Number(row.workNumber)
            : null;
        return {
          id: row.id,
          sourceEventId: row.sourceEventId,
          resourceId: row.resourceId,
          workNumber:
            workNumber !== null &&
            Number.isSafeInteger(workNumber) &&
            workNumber > 0
              ? workNumber
              : null,
          eventType,
          eventLabel: eventType
            ? (NOTIFICATION_EVENT_TYPES.find(
                (event) => event.type === eventType,
              )?.label ?? null)
            : null,
          status: row.status,
          attempts: row.attempts,
          errorCode:
            row.errorCode && receiptErrors.has(row.errorCode)
              ? row.errorCode
              : null,
          nextAttemptAt: row.nextAttemptAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          notificationEventId: row.notificationEventId,
        };
      });
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                createdAt: last.createdAt,
                status,
              }),
            ).toString("base64url")
          : null,
    };
  }

  /** One independent, best-effort observation per completed maintenance pass. */
  async recordMaintenance(result: {
    success: boolean;
    captured: number;
    registered: number;
  }): Promise<void> {
    if (!this.registry.enabled) return;
    try {
      if (result.success) {
        await this.db
          .$executeRaw(Prisma.sql`UPDATE notification_work_event_activation
          SET last_maintenance_at = clock_timestamp(),
            last_capture_at = CASE WHEN ${result.captured > 0} THEN clock_timestamp() ELSE last_capture_at END,
            last_registration_at = CASE WHEN ${result.registered > 0} THEN clock_timestamp() ELSE last_registration_at END
          WHERE id = ${NOTIFICATION_WORK_EVENT_ACTIVATION_ID}`);
      } else {
        await this.db
          .$executeRaw(Prisma.sql`UPDATE notification_work_event_activation
          SET last_error_at = clock_timestamp(), last_error_code = ${maintenanceError}
          WHERE id = ${NOTIFICATION_WORK_EVENT_ACTIVATION_ID}`);
      }
    } catch {
      this.logger.warn("notification_maintenance_observation_unavailable");
    }
  }
}
