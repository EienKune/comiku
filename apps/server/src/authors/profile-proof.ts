import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

export interface VerifiedProfile {
  externalUserId: string;
  platform: "x" | "pixiv";
  handle: string | null;
  avatarFileObjectId: string | null;
  adapterKey: string;
  syncedAt: string;
}
const processKey = randomBytes(32).toString("base64url");

/** Short-lived server evidence, never a client supplied synchronization timestamp. */
export class ProfileProofs {
  constructor(private readonly secret = processKey) {}
  issue(
    profile: VerifiedProfile,
    actorId: string,
    authorId?: string,
    now = Date.now(),
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 2,
        ...profile,
        actorId,
        authorId: authorId ?? null,
        issuedAt: now,
        expiresAt: now + 600_000,
      }),
    ).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }
  verify(
    proof: string | null | undefined,
    platform: "x" | "pixiv",
    actorId?: string,
    authorId?: string,
    now = Date.now(),
  ): VerifiedProfile {
    const bad = (): never => {
      throw new BadRequestException(
        "请重新同步平台资料后保存，身份凭证无效或已过期",
      );
    };
    if (!proof || proof.length > 4096 || !actorId) return bad();
    const [payload, signature, extra] = proof.split(".");
    if (!payload || !signature || extra !== undefined) return bad();
    const actual = Buffer.from(signature, "base64url"),
      expected = Buffer.from(this.mac(payload), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return bad();
    try {
      const value = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (
        !(
          (value.v === 2 && value.platform === platform) ||
          (value.v === 1 && platform === "x")
        ) ||
        value.actorId !== actorId ||
        value.authorId !== (authorId ?? null) ||
        !Number.isSafeInteger(value.issuedAt) ||
        value.issuedAt > now ||
        value.expiresAt !== value.issuedAt + 600_000 ||
        value.expiresAt <= now ||
        typeof value.externalUserId !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(value.externalUserId) ||
        (platform === "x"
          ? typeof value.handle !== "string" ||
            !/^[A-Za-z0-9_]{1,15}$/.test(value.handle)
          : value.handle !== null) ||
        typeof value.adapterKey !== "string" ||
        !Number.isFinite(Date.parse(value.syncedAt)) ||
        (value.avatarFileObjectId !== null &&
          typeof value.avatarFileObjectId !== "string")
      )
        return bad();
      return {
        platform,
        externalUserId: value.externalUserId,
        handle: value.handle,
        avatarFileObjectId: value.avatarFileObjectId,
        adapterKey: value.adapterKey,
        syncedAt: value.syncedAt,
      };
    } catch {
      return bad();
    }
  }
  private mac(payload: string) {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }
}
