import { ForbiddenException } from "@nestjs/common";
import { permissionsFor } from "../common/access.js";
import type {
  Prisma,
  NotificationDelivery,
  NotificationEvent,
  NotificationChannel,
} from "../generated/prisma/client.js";

export async function assertNotificationAdministrator(
  tx: Prisma.TransactionClient,
  actorId: string,
) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`;
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    include: { roles: true },
  });
  if (
    !actor?.isActive ||
    !permissionsFor(
      actor.roles.map((r) => r.role),
      actor.mustChangePassword,
    ).includes("system:manage")
  )
    throw new ForbiddenException("需要系统管理权限");
}

export function channelDto(channel: NotificationChannel) {
  return {
    id: channel.id,
    name: channel.name,
    connectionKey: channel.connectionKey,
    groupId: channel.groupId,
    enabled: channel.enabled,
    eventTypes: channel.eventTypes,
    includeDetails: channel.includeDetails,
    revision: channel.revision,
    audienceGeneration: channel.audienceGeneration,
  };
}

export function deliveryDto(
  row: NotificationDelivery & {
    event: NotificationEvent;
    channel: NotificationChannel;
  },
) {
  const snapshot = row.event.snapshot as { workNumber?: number | null };
  return {
    id: row.id,
    channelId: row.channelId,
    channelName: row.channel.name,
    eventType: row.event.type,
    workNumber: snapshot.workNumber ?? null,
    status: row.status as (typeof DELIVERY_STATUSES)[number],
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    errorCode: row.errorCode,
    providerMessageId: row.providerMessageId,
    preview: row.text,
    revision: row.revision,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export const DELIVERY_STATUSES = [
  "pending",
  "sending",
  "retry_wait",
  "accepted",
  "failed",
  "unknown",
  "cancelled",
] as const;
export const NOTIFICATION_JOB_KIND = "notification_deliver";
export const NOTIFICATION_SCOPE = "notifications";
