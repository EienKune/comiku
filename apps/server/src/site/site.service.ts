import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Actor } from "../common/access.js";
import { permissionsFor } from "../common/access.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import type { Prisma, SiteSettings } from "../generated/prisma/client.js";
import { lockAccountMembership } from "../users/account-membership-lock.js";
import { normalizeSiteName, siteThemePresetIds } from "./site-theme-presets.js";
import type { SiteSettingsDto, UpdateSiteSettingsDto } from "./site.dto.js";

export const siteDto = (saved: SiteSettings | null): SiteSettingsDto => ({
  name: saved?.name ?? "Comiku",
  themePresetId: (saved?.themePresetId ??
    "teal") as SiteSettingsDto["themePresetId"],
  iconVersion: saved?.iconAssetId ?? null,
  revision: saved?.revision ?? 0,
});

@Injectable()
export class SiteService {
  constructor(
    @Inject(PrismaService) readonly db: PrismaService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}
  async authorize(tx: Prisma.TransactionClient, actor: Actor) {
    await lockAccountMembership(tx);
    const now = new Date();
    const session = await tx.authSession.findFirst({
      where: {
        id: actor.sessionId,
        userId: actor.userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: {
          gt: new Date(
            now.getTime() - this.environment.authSessionIdleSeconds * 1000,
          ),
        },
      },
      include: { user: { include: { roles: true } } },
    });
    if (!session || !session.user.isActive)
      throw new UnauthorizedException("登录已失效，请重新登录");
    if (
      !permissionsFor(
        session.user.roles.map((r) => r.role),
        session.user.mustChangePassword,
      ).includes("system:manage")
    )
      throw new ForbiddenException("需要系统管理权限");
  }
  async lock(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:site-settings'))`;
  }
  async readPublic(): Promise<SiteSettingsDto> {
    return siteDto(
      await this.db.siteSettings.findUnique({ where: { id: "global" } }),
    );
  }
  async readAdmin(actor: Actor) {
    return this.db.$transaction(async (tx) => {
      await this.authorize(tx, actor);
      return siteDto(
        await tx.siteSettings.findUnique({ where: { id: "global" } }),
      );
    });
  }
  async update(actor: Actor, input: UpdateSiteSettingsDto) {
    const name = normalizeSiteName(input.name);
    if (
      !siteThemePresetIds.includes(input.themePresetId) ||
      !["keep", "remove", "adopt"].includes(input.iconAction) ||
      (input.iconAction === "adopt"
        ? !input.assetId
        : input.assetId !== undefined)
    )
      throw new BadRequestException("站点设置字段无效");
    return this.db.$transaction(async (tx) => {
      await this.authorize(tx, actor);
      await this.lock(tx);
      const before = await tx.siteSettings.upsert({
        where: { id: "global" },
        create: {},
        update: {},
      });
      if (before.revision !== input.expectedRevision)
        throw new ConflictException("站点设置已更新，请读取当前设置后重试");
      let iconAssetId = before.iconAssetId;
      if (input.iconAction === "remove") iconAssetId = null;
      if (input.iconAction === "adopt") {
        const asset = await tx.siteBrandAsset.findUnique({
          where: { id: input.assetId! },
        });
        if (
          !asset ||
          asset.createdById !== actor.userId ||
          asset.status !== "ready" ||
          (asset.expiresAt && asset.expiresAt <= new Date())
        )
          throw new NotFoundException("上传的图标已失效，请重新选择");
        iconAssetId = asset.id;
      }
      if (
        before.name === name &&
        before.themePresetId === input.themePresetId &&
        before.iconAssetId === iconAssetId
      )
        return siteDto(before);
      if (before.iconAssetId && before.iconAssetId !== iconAssetId)
        await tx.siteBrandAsset.update({
          where: { id: before.iconAssetId },
          data: {
            status: "retired",
            expiresAt: new Date(Date.now() + 86400_000),
          },
        });
      if (iconAssetId)
        await tx.siteBrandAsset.update({
          where: { id: iconAssetId },
          data: { expiresAt: null },
        });
      const saved = await tx.siteSettings.update({
        where: { id: "global" },
        data: {
          name,
          themePresetId: input.themePresetId,
          iconAssetId,
          revision: { increment: 1 },
        },
      });
      await tx.accountAudit.create({
        data: {
          actorId: actor.userId,
          action: "site.settings.updated",
          detail: {
            before: { ...siteDto(before) },
            after: { ...siteDto(saved) },
          },
        },
      });
      return siteDto(saved);
    });
  }
}
