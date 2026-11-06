import { ForbiddenException } from "@nestjs/common";
import { permissionsFor } from "../common/access.js";
import type {
  Prisma,
  NotificationDelivery,
  NotificationEvent,
  NotificationChannel,
} from "../generated/prisma/client.js";
import { normalizeSubscriptionRules } from "./notification-template-policy.js";
import type { NotificationFrozenRoute } from "./notifications.contracts.js";

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
    receiverMode:
      channel.receiverMode === "templates"
        ? ("templates" as const)
        : ("legacy" as const),
    subscriptionRules: normalizeSubscriptionRules(
      Array.isArray(channel.subscriptionRules) &&
        channel.subscriptionRules.length
        ? channel.subscriptionRules
        : channel.eventTypes.map((eventType) => ({ eventType, stages: null })),
    ),
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
  const route = (
    Array.isArray(row.event.routeRefs)
      ? (row.event.routeRefs as unknown as NotificationFrozenRoute[])
      : []
  ).find(
    (ref) =>
      ref.id === row.channelId && ref.generation === row.audienceGeneration,
  );
  return {
    id: row.id,
    channelId: row.channelId,
    channelName: row.channel.name,
    groupId: row.groupId,
    connectionKey: row.connectionKey,
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
    contentRevision: route?.content?.templatePolicy?.contentRevision ?? null,
    metadataObservedAt: route?.content?.metadataObservedAt ?? null,
    metadataOrigin: route?.content?.metadataOrigin ?? null,
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
