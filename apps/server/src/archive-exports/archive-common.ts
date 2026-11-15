import { createHash } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { permissionsFor, type Actor } from "../common/access.js";
import type { Environment } from "../config/environment.js";
import type { Prisma } from "../generated/prisma/client.js";
import { lockAccountMembership } from "../users/account-membership-lock.js";

export const ARCHIVE_SCOPE = "archive:global";
export const ARCHIVE_PREPARE = "archive_export_prepare";
export const ARCHIVE_PACKAGE = "archive_export_package";
export const ARCHIVE_DELETE = "archive_export_delete";
export const terminalArchiveStatuses = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
];
export const archiveHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function archiveBounds(year: number, month?: number | null) {
  const startMonth = month ?? 1;
  return {
    gte: new Date(Date.UTC(year, startMonth - 1, 1, -8)),
    lt: new Date(
      Date.UTC(
        month === 12 ? year + 1 : year + (month ? 0 : 1),
        month ? month % 12 : 0,
        1,
        -8,
      ),
    ),
  };
}
export function encodeArchiveCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeArchiveCursor<T>(
  value: string | undefined,
  valid: (v: unknown) => v is T,
): T | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 200)
      throw new Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!valid(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException("导出分页游标无效");
  }
}
export async function assertArchiveAdministrator(
  tx: Prisma.TransactionClient,
  actor: Actor | string,
  environment: Environment,
) {
  await lockAccountMembership(tx);
  const userId = typeof actor === "string" ? actor : actor.userId;
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { roles: true },
  });
  const now = new Date();
  if (
    typeof actor !== "string" &&
    !(await tx.authSession.count({
      where: {
        id: actor.sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: {
          gt: new Date(
            now.getTime() - environment.authSessionIdleSeconds * 1000,
          ),
        },
      },
    }))
  )
    throw new UnauthorizedException("登录已失效，请重新登录");
  if (
    !user?.isActive ||
    !permissionsFor(
      user.roles.map((r) => r.role),
      user.mustChangePassword,
    ).includes("system:manage")
  )
    throw new ForbiddenException("需要系统管理权限");
}
