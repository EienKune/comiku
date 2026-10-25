import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, Role } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  permissionsFor,
  type Actor,
  type Permission,
} from "../common/access.js";
import {
  hashPassword,
  normalizeUsername,
  randomCredential,
  tokenHash,
  verifyPassword,
} from "./password.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { inspectImage } from "../files/image-inspection.js";
import {
  USER_AVATAR_MAX_BYTES,
  type CreateUserAvatarUploadDto,
} from "./user-avatar.dto.js";
import type {
  CreateUserDto,
  ManageUserDto,
  ProfileDto,
  UserDto,
} from "./users.dto.js";

type UserWithRoles = Prisma.UserGetPayload<{
  include: { roles: true; languageCapabilities: true };
}>;
type Tx = Prisma.TransactionClient;
export const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const withRoles = { roles: true, languageCapabilities: true } as const;
export function publicUser(user: UserWithRoles): UserDto {
  const roles = user.roles.map(({ role }) => role).sort();
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarVersion: user.avatarFileObjectId,
    canSkipProofreading: user.canSkipProofreading,
    roles,
    languageCapabilities: user.languageCapabilities
      .map(({ language }) => language)
      .sort(),
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    revision: user.revision,
    permissions: permissionsFor(roles, user.mustChangePassword),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
  ) {}

  private async write<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          // One account administration lock per deployment; also serializes session issuance with revocation.
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(20260905, 2)`;
          return action(tx);
        },
        { timeout: 15000, maxWait: 15000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("账户名已存在");
      }
      throw error;
    }
  }
  private audit(
    tx: Tx,
    actorId: string | null,
    targetId: string | null,
    action: string,
    detail: Prisma.InputJsonObject = {},
  ) {
    return tx.accountAudit.create({
      data: { actorId, targetId, action, detail },
    });
  }
  private async session(tx: Tx, actor: Actor) {
    const now = new Date();
    const session = await tx.authSession.findFirst({
      where: {
        id: actor.sessionId,
        userId: actor.userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: new Date(now.getTime() - IDLE_MS) },
        user: { isActive: true },
      },
      include: { user: { include: withRoles } },
    });
    if (!session) throw new UnauthorizedException("登录已失效，请重新登录");
    return session;
  }
  private async authorize(tx: Tx, actor: Actor, permission: Permission) {
    const { user } = await this.session(tx, actor);
    if (
      !permissionsFor(
        user.roles.map((r) => r.role),
        user.mustChangePassword,
      ).includes(permission)
    ) {
      throw new ForbiddenException(
        user.mustChangePassword ? "请先修改临时密码" : "没有执行此操作的权限",
      );
    }
    return user;
  }
  private async confirm(user: UserWithRoles, password: string) {
    if (!(await verifyPassword(password, user.passwordHash)))
      throw new ForbiddenException("当前密码不正确");
  }
  private async issue(tx: Tx, userId: string) {
    const token = randomBytes(32).toString("base64url");
    const session = await tx.authSession.create({
      data: {
        userId,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + SESSION_MS),
      },
    });
    return { token, sessionId: session.id };
  }
  async login(username: string, password: string) {
    const user = await this.db.user.findUnique({
      where: { username: normalizeUsername(username) },
      include: withRoles,
    });
    const matches = await verifyPassword(
      password,
      user?.passwordHash ?? "missing",
    );
    if (!user || !user.isActive || !matches) {
      await this.db.accountAudit.create({
        data: { targetId: user?.id, action: "auth.login_failed", detail: {} },
      });
      throw new UnauthorizedException("账户名或密码不正确");
    }
    return this.write(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: user.id },
        include: withRoles,
      });
      if (!current?.isActive || current.passwordHash !== user.passwordHash)
        throw new UnauthorizedException("账户名或密码不正确");
      const session = await this.issue(tx, current.id);
      await this.audit(tx, current.id, current.id, "auth.login");
      return { ...session, user: publicUser(current) };
    });
  }
  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException("请先登录");
    const now = new Date();
    const session = await this.db.authSession.findFirst({
      where: {
        tokenHash: tokenHash(token),
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: new Date(now.getTime() - IDLE_MS) },
        user: { isActive: true },
      },
      include: { user: { include: withRoles } },
    });
    if (!session) throw new UnauthorizedException("登录已失效，请重新登录");
    // Never resurrect a session that was revoked while this request was being read.
    await this.db.authSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastSeenAt: now },
    });
    return {
      actor: { userId: session.userId, sessionId: session.id },
      user: publicUser(session.user),
    };
  }
  async me(actor: Actor) {
    return publicUser((await this.session(this.db, actor)).user);
  }
  async logout(actor: Actor) {
    return this.write(async (tx) => {
      await tx.authSession.updateMany({
        where: { id: actor.sessionId, userId: actor.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, actor.userId, actor.userId, "auth.logout");
      return { ok: true };
    });
  }
  async revokeOthers(actor: Actor) {
    return this.write(async (tx) => {
      await this.authorize(tx, actor, "self");
      await tx.authSession.updateMany({
        where: {
          userId: actor.userId,
          id: { not: actor.sessionId },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await this.audit(
        tx,
        actor.userId,
        actor.userId,
        "auth.revoke_other_sessions",
      );
      return { ok: true };
    });
  }
  async changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
  ) {
    if (currentPassword === newPassword)
      throw new BadRequestException("新密码不能与当前密码相同");
    const hash = await hashPassword(newPassword);
    return this.write(async (tx) => {
      const user = await this.authorize(tx, actor, "self");
      await this.confirm(user, currentPassword);
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: hash,
          mustChangePassword: false,
          revision: { increment: 1 },
        },
        include: withRoles,
      });
      await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const session = await this.issue(tx, user.id);
      await this.audit(tx, user.id, user.id, "auth.password_changed");
      return { ...session, user: publicUser(updated) };
    });
  }
  async updateProfile(actor: Actor, input: ProfileDto) {
    return this.write(async (tx) => {
      const user = await this.authorize(tx, actor, "self");
      if (user.mustChangePassword)
        throw new ForbiddenException("请先修改临时密码");
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          displayName: input.displayName,
          revision: { increment: 1 },
        },
        include: withRoles,
      });
      await this.audit(tx, user.id, user.id, "account.profile_updated", {
        displayName: updated.displayName,
      });
      return publicUser(updated);
    });
  }
  private async avatarUser(tx: Tx, actor: Actor) {
    const user = await this.authorize(tx, actor, "self");
    if (user.mustChangePassword)
      throw new ForbiddenException("请先修改临时密码");
    return user;
  }
  async createAvatarUpload(actor: Actor, input: CreateUserAvatarUploadDto) {
    const id = randomUUID();
    const key = `staging/user-avatar/${actor.userId}/${id}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.write(async (tx) => {
      const user = await this.avatarUser(tx, actor);
      if (user.revision !== input.expectedRevision)
        throw new ConflictException("资料已更新，请刷新后重新上传");
      // Keep expired session metadata bounded; staging objects use the Bucket lifecycle.
      await tx.userAvatarUploadSession.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });
      await tx.userAvatarUploadSession.create({
        data: { ...input, id, userId: user.id, objectKey: key, expiresAt },
      });
    });
    const target = await this.files.signedStagingWriteUrl(
      {
        key,
        contentType: input.contentType,
        size: input.size,
        checksum: input.checksum,
      },
      900,
    );
    return { id, expiresAt: expiresAt.toISOString(), ...target };
  }
  async completeAvatarUpload(actor: Actor, id: string) {
    await this.avatarUser(this.db, actor);
    const session = await this.db.userAvatarUploadSession.findFirst({
      where: { id, userId: actor.userId },
    });
    if (!session) throw new NotFoundException("头像上传会话不存在");
    if (session.completedAt) return this.me(actor);
    if (session.expiresAt <= new Date())
      throw new BadRequestException("头像上传会话已过期，请重新选择图片");
    const metadata = await this.files.headStagingObject(session.objectKey);
    if (
      !metadata ||
      metadata.size !== session.size ||
      metadata.size > USER_AVATAR_MAX_BYTES ||
      metadata.contentType !== session.contentType
    )
      throw new BadRequestException("上传图片与会话约定不符");
    const body = await this.files.readStagingObject(session.objectKey);
    if (
      body.byteLength !== session.size ||
      createHash("sha256").update(body).digest("hex") !== session.checksum
    )
      throw new BadRequestException("头像校验值不匹配，请重新上传");
    let image;
    try {
      image = inspectImage(session.sourceName, body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "头像格式无效",
      );
    }
    if (
      image.contentType !== session.contentType ||
      !image.width ||
      !image.height
    )
      throw new BadRequestException(
        "头像必须是有效的 PNG、JPEG、WebP 或 GIF 图片",
      );
    const file = await this.files.store({
      body,
      contentType: image.contentType,
      sourceName: session.sourceName,
      bucketScope: "private",
      kind: "user_avatar",
      createdById: actor.userId,
    });
    try {
      const result = await this.write(async (tx) => {
        const user = await this.avatarUser(tx, actor);
        const current = await tx.userAvatarUploadSession.findFirst({
          where: { id, userId: user.id },
        });
        if (!current || current.expiresAt <= new Date())
          throw new BadRequestException("头像上传会话已过期");
        if (current.completedAt)
          return { user: publicUser(user), attached: false };
        if (user.revision !== current.expectedRevision)
          throw new ConflictException("资料已更新，请刷新后重新上传");
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { avatarFileObjectId: file.id, revision: { increment: 1 } },
          include: withRoles,
        });
        await tx.userAvatarUploadSession.update({
          where: { id },
          data: { completedAt: new Date() },
        });
        await this.audit(tx, user.id, user.id, "account.avatar_updated", {
          oldFileId: user.avatarFileObjectId,
          fileId: file.id,
        });
        return { user: publicUser(updated), attached: true };
      });
      if (!result.attached) await this.files.purgeUnreferenced(file.id);
      await this.files
        .deleteStagingObject(session.objectKey)
        .catch(() => undefined);
      return result.user;
    } catch (error) {
      await this.files.purgeUnreferenced(file.id).catch(() => undefined);
      throw error;
    }
  }
  async removeAvatar(actor: Actor, expectedRevision: number) {
    return this.write(async (tx) => {
      const user = await this.avatarUser(tx, actor);
      if (user.revision !== expectedRevision)
        throw new ConflictException("资料已更新，请刷新后重试");
      if (!user.avatarFileObjectId) return publicUser(user);
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { avatarFileObjectId: null, revision: { increment: 1 } },
        include: withRoles,
      });
      await this.audit(tx, user.id, user.id, "account.avatar_removed", {
        fileId: user.avatarFileObjectId,
      });
      return publicUser(updated);
    });
  }
  async avatarUrl(actor: Actor, id: string) {
    await this.avatarUser(this.db, actor);
    if (actor.userId !== id)
      await this.authorize(this.db, actor, "members:read");
    const user = await this.db.user.findFirst({
      where: {
        id,
        isActive: true,
        ...(actor.userId !== id ? { roles: { some: {} } } : {}),
      },
    });
    if (!user?.avatarFileObjectId)
      throw new NotFoundException("成员尚未设置头像");
    return this.files.signedReadUrl(user.avatarFileObjectId);
  }
  async list() {
    return (
      await this.db.user.findMany({
        include: withRoles,
        orderBy: { username: "asc" },
      })
    ).map(publicUser);
  }
  async members() {
    return (
      await this.db.user.findMany({
        where: { isActive: true, roles: { some: {} } },
        include: withRoles,
        orderBy: { username: "asc" },
      })
    ).map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarVersion: user.avatarFileObjectId,
      roles: user.roles.map((r) => r.role),
      languageCapabilities: user.languageCapabilities.map(
        ({ language }) => language,
      ),
    }));
  }
  async audits() {
    return this.db.accountAudit.findMany({
      take: 100,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }
  async create(actor: Actor, input: CreateUserDto) {
    const temporaryPassword = randomCredential();
    const passwordHash = await hashPassword(temporaryPassword);
    return this.write(async (tx) => {
      const admin = await this.authorize(tx, actor, "accounts:manage");
      await this.confirm(admin, input.currentPassword);
      const user = await tx.user.create({
        data: {
          username: normalizeUsername(input.username),
          canSkipProofreading: input.canSkipProofreading ?? false,
          displayName: input.displayName,
          passwordHash,
          roles: { create: input.roles.map((role) => ({ role })) },
          languageCapabilities: {
            create: (input.languageCapabilities ?? []).map((language) => ({
              language,
            })),
          },
        },
        include: withRoles,
      });
      await this.audit(tx, admin.id, user.id, "account.created", {
        username: user.username,
        roles: input.roles,
        canSkipProofreading: user.canSkipProofreading,
        languageCapabilities: input.languageCapabilities ?? [],
      });
      return { user: publicUser(user), temporaryPassword };
    });
  }
  async manage(actor: Actor, id: string, input: ManageUserDto) {
    return this.write(async (tx) => {
      const admin = await this.authorize(tx, actor, "accounts:manage");
      await this.confirm(admin, input.currentPassword);
      const target = await tx.user.findUnique({
        where: { id },
        include: withRoles,
      });
      if (!target) throw new NotFoundException("账号不存在");
      if (target.revision !== input.expectedRevision)
        throw new ConflictException("账号已更新，请刷新后重试");
      if (
        target.isActive &&
        target.roles.some((r) => r.role === Role.admin) &&
        (!input.isActive || !input.roles.includes(Role.admin))
      ) {
        const count = await tx.user.count({
          where: { isActive: true, roles: { some: { role: Role.admin } } },
        });
        if (count <= 1)
          throw new ConflictException("必须保留至少一个启用的管理员");
      }
      const user = await tx.user.update({
        where: { id },
        data: {
          displayName: input.displayName,
          isActive: input.isActive,
          canSkipProofreading: input.canSkipProofreading,
          revision: { increment: 1 },
          roles: {
            deleteMany: {},
            create: input.roles.map((role) => ({ role })),
          },
          ...(input.languageCapabilities
            ? {
                languageCapabilities: {
                  deleteMany: {},
                  create: input.languageCapabilities.map((language) => ({
                    language,
                  })),
                },
              }
            : {}),
        },
        include: withRoles,
      });
      if (!user.isActive)
        await tx.authSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await this.audit(tx, admin.id, id, "account.managed", {
        before: {
          isActive: target.isActive,
          roles: target.roles.map((r) => r.role),
          languageCapabilities: target.languageCapabilities.map(
            ({ language }) => language,
          ),
          displayName: target.displayName,
          canSkipProofreading: target.canSkipProofreading,
        },
        after: {
          isActive: user.isActive,
          roles: input.roles,
          languageCapabilities: user.languageCapabilities.map(
            ({ language }) => language,
          ),
          displayName: user.displayName,
          avatarVersion: user.avatarFileObjectId,
          canSkipProofreading: user.canSkipProofreading,
        },
      });
      return publicUser(user);
    });
  }
  async resetPassword(actor: Actor, id: string, password: string) {
    if (id === actor.userId)
      throw new BadRequestException("请使用修改自己的密码");
    const temporaryPassword = randomCredential();
    const passwordHash = await hashPassword(temporaryPassword);
    return this.write(async (tx) => {
      const admin = await this.authorize(tx, actor, "accounts:manage");
      await this.confirm(admin, password);
      if (!(await tx.user.findUnique({ where: { id } })))
        throw new NotFoundException("账号不存在");
      const user = await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          mustChangePassword: true,
          revision: { increment: 1 },
        },
        include: withRoles,
      });
      await tx.authSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, admin.id, id, "account.password_reset");
      return { user: publicUser(user), temporaryPassword };
    });
  }
  async revokeUserSessions(actor: Actor, id: string, password: string) {
    return this.write(async (tx) => {
      const admin = await this.authorize(tx, actor, "accounts:manage");
      await this.confirm(admin, password);
      if (!(await tx.user.findUnique({ where: { id } })))
        throw new NotFoundException("账号不存在");
      await tx.authSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, admin.id, id, "account.sessions_revoked");
      return { ok: true };
    });
  }
  async initializeAdmin(username: string, displayName: string) {
    const normalizedUsername = normalizeUsername(username);
    if (!/^[a-z0-9]{3,64}$/.test(normalizedUsername)) {
      throw new BadRequestException("账户名仅可使用 3–64 位英文字母和数字");
    }
    const temporaryPassword = randomCredential();
    const passwordHash = await hashPassword(temporaryPassword);
    return this.write(async (tx) => {
      if (
        await tx.user.count({
          where: { roles: { some: { role: Role.admin } } },
        })
      )
        throw new ConflictException("管理员已存在，请使用受控恢复流程");
      const user = await tx.user.create({
        data: {
          username: normalizedUsername,
          displayName,
          passwordHash,
          roles: { create: { role: Role.admin } },
        },
        include: withRoles,
      });
      await this.audit(tx, null, user.id, "account.admin_initialized");
      return { user: publicUser(user), temporaryPassword };
    });
  }
  async recoverAdmin(username: string) {
    const temporaryPassword = randomCredential();
    const passwordHash = await hashPassword(temporaryPassword);
    return this.write(async (tx) => {
      const target = await tx.user.findUnique({
        where: { username: normalizeUsername(username) },
        include: withRoles,
      });
      if (!target?.roles.some((r) => r.role === Role.admin))
        throw new NotFoundException("未找到该管理员");
      const user = await tx.user.update({
        where: { id: target.id },
        data: {
          passwordHash,
          isActive: true,
          mustChangePassword: true,
          revision: { increment: 1 },
        },
        include: withRoles,
      });
      await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, null, user.id, "account.admin_recovered", {
        channel: "server-cli",
      });
      return { user: publicUser(user), temporaryPassword };
    });
  }
}
