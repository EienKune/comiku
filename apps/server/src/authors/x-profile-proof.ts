import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

export interface VerifiedXProfile {
  externalUserId: string;
  handle: string;
  avatarFileObjectId: string | null;
  adapterKey: string;
  syncedAt: string;
}
const processKey = randomBytes(32).toString("base64url");

/** Short-lived server evidence, never a client supplied synchronization timestamp. */
export class XProfileProofs {
  constructor(private readonly secret = processKey) {}
  issue(
    profile: VerifiedXProfile,
    actorId: string,
    authorId?: string,
    now = Date.now(),
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
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
    actorId?: string,
    authorId?: string,
    now = Date.now(),
  ): VerifiedXProfile {
    const bad = (): never => {
      throw new BadRequestException(
        "请重新同步 X 资料后保存，身份凭证无效或已过期",
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
        value.v !== 1 ||
        value.actorId !== actorId ||
        value.authorId !== (authorId ?? null) ||
        !Number.isSafeInteger(value.issuedAt) ||
        value.issuedAt > now ||
        value.expiresAt !== value.issuedAt + 600_000 ||
        value.expiresAt <= now ||
        typeof value.externalUserId !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(value.externalUserId) ||
        typeof value.handle !== "string" ||
        !/^[A-Za-z0-9_]{1,15}$/.test(value.handle) ||
        typeof value.adapterKey !== "string" ||
        !Number.isFinite(Date.parse(value.syncedAt)) ||
        (value.avatarFileObjectId !== null &&
          typeof value.avatarFileObjectId !== "string")
      )
        return bad();
      return {
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
