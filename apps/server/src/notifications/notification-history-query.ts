import { BadRequestException } from "@nestjs/common";
import { isISO8601 } from "class-validator";
import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { NOTIFICATION_EVENT_TYPES } from "./notification-events.js";
import { DELIVERY_STATUSES } from "./notification-engine.helpers.js";

export interface NotificationHistoryQuery {
  cursor?: string;
  status?: string;
  groupId?: string;
  workNumber?: number;
  eventType?: string;
  createdFrom?: string;
  createdBefore?: string;
  limit?: number;
}
export const NOTIFICATION_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const invalid = () => new BadRequestException("通知筛选无效");
function timestamp(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !NOTIFICATION_TIMESTAMP_PATTERN.test(value) ||
    !isISO8601(value, { strict: true, strictSeparator: true }) ||
    !Number.isFinite(Date.parse(value))
  )
    throw invalid();
  return new Date(value).toISOString();
}
export function normalizeNotificationHistoryQuery(
  query: NotificationHistoryQuery,
) {
  const limit = query.limit ?? 20;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (query.status !== undefined &&
      !DELIVERY_STATUSES.includes(query.status as never)) ||
    (query.groupId !== undefined &&
      !/^[1-9][0-9]{0,19}$/.test(query.groupId)) ||
    (query.workNumber !== undefined &&
      (!Number.isInteger(query.workNumber) ||
        query.workNumber < 1 ||
        query.workNumber > 2147483647)) ||
    (query.eventType !== undefined &&
      query.eventType !== "birthday.reminder" &&
      query.eventType !== "work.digest" &&
      query.eventType !== "work.ready" &&
      !NOTIFICATION_EVENT_TYPES.some((event) => event.type === query.eventType))
  )
    throw invalid();
  const createdFrom = timestamp(query.createdFrom);
  const createdBefore = timestamp(query.createdBefore);
  if (
    createdFrom &&
    createdBefore &&
    Date.parse(createdFrom) >= Date.parse(createdBefore)
  )
    throw invalid();
  return {
    status: query.status ?? null,
    groupId: query.groupId ?? null,
    workNumber: query.workNumber ?? null,
    eventType: query.eventType ?? null,
    createdFrom,
    createdBefore,
    limit,
  };
}
export type NotificationHistoryFilters = ReturnType<
  typeof normalizeNotificationHistoryQuery
>;
type Cursor = { v: 2; filter: string; at: string; id: string };
const fingerprint = (filters: NotificationHistoryFilters) =>
  createHash("sha256").update(JSON.stringify(filters)).digest("hex");
export function notificationHistoryCursor(
  filters: NotificationHistoryFilters,
  row: { id: string; createdAt: Date },
) {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      filter: fingerprint(filters),
      at: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}
export function parseNotificationHistoryCursor(
  raw: string | undefined,
  filters: NotificationHistoryFilters,
): Cursor | null {
  if (raw === undefined) return null;
  const invalidCursor = () =>
    new BadRequestException("通知分页游标无效，请刷新列表");
  try {
    if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw))
      throw invalidCursor();
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") throw invalidCursor();
    const cursor = parsed as Cursor;
    if (
      Object.keys(cursor).length !== 4 ||
      cursor.v !== 2 ||
      cursor.filter !== fingerprint(filters) ||
      typeof cursor.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cursor.id,
      ) ||
      typeof cursor.at !== "string" ||
      timestamp(cursor.at) !== cursor.at
    )
      throw invalidCursor();
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

/** Project only a bounded ID page; frozen bodies and relations are hydrated afterward. */
export function buildNotificationHistoryQuery(
  filters: NotificationHistoryFilters,
  cursor: Cursor | null,
  resourceId: string | null,
) {
  const eventFilter = filters.eventType !== null || resourceId !== null;
  // Include the fixed leading key in the row bound. With many equal timestamps,
  // a timestamp-only row bound can look selective and choose the global index,
  // then discard unrelated groups despite an available group-prefixed index.
  const seek = !cursor
    ? Prisma.empty
    : filters.groupId
      ? Prisma.sql`AND (d.group_id, d.created_at, d.id) < (${filters.groupId}, ${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`
      : filters.status
        ? Prisma.sql`AND (d.status, d.created_at, d.id) < (${filters.status}, ${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`
        : Prisma.sql`AND (d.created_at, d.id) < (${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`;
  return Prisma.sql`SELECT d.id FROM notification_deliveries d
    ${eventFilter ? Prisma.sql`JOIN notification_events e ON e.id = d.event_id` : Prisma.empty}
    WHERE TRUE
      ${filters.status ? Prisma.sql`AND d.status = ${filters.status}` : Prisma.empty}
      ${filters.groupId ? Prisma.sql`AND d.group_id = ${filters.groupId}` : Prisma.empty}
      ${filters.eventType ? Prisma.sql`AND e.type = ${filters.eventType}` : Prisma.empty}
      ${resourceId ? Prisma.sql`AND e.resource_id = ${resourceId}::uuid` : Prisma.empty}
      ${filters.createdFrom ? Prisma.sql`AND d.created_at >= ${new Date(filters.createdFrom)}::timestamptz` : Prisma.empty}
      ${filters.createdBefore ? Prisma.sql`AND d.created_at < ${new Date(filters.createdBefore)}::timestamptz` : Prisma.empty}
      ${seek}
    ORDER BY d.created_at DESC, d.id DESC LIMIT ${filters.limit + 1}`;
}
