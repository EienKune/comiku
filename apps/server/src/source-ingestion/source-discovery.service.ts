import type { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import type { NormalizedSourceContent } from "./content-source.js";

/** Signed query refreshes do not change the provider asset; original path/version does. */
export function stableSourceAssetIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.origin + url.pathname
      : null;
  } catch {
    return null;
  }
}
export function recoveryDue(failures: number, now = new Date()): Date | null {
  if (failures >= 8) return null;
  return new Date(
    now.getTime() +
      (failures <= 1 ? 900000 : failures === 2 ? 3600000 : 21600000),
  );
}
export function recoveryKey(discoveryId: string, campaign: number) {
  return `source-recover:${discoveryId}:${campaign}`;
}
export function readyManifest(
  expected: number | null,
  media: readonly {
    externalMediaId: string;
    orderIndex: number;
    fileObjectId: string | null;
  }[],
) {
  return (
    expected !== null &&
    expected >= 1 &&
    expected === media.length &&
    new Set(media.map((m) => m.externalMediaId)).size === expected &&
    media.every((m, i) => m.orderIndex === i && Boolean(m.fileObjectId))
  );
}
export interface DiscoveryContext {
  accountId: string;
  platform: string;
  sourceUserId: string;
  adapterKey: string;
  actorId: string | null;
  discoveredRunId: string;
  windowJson: Prisma.InputJsonValue;
}
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** All mutations use the caller's transaction after its source/job/epoch fences. */
export class SourceDiscoveryService {
  constructor(private readonly db: PrismaService) {}
  async record(
    tx: Prisma.TransactionClient,
    context: DiscoveryContext,
    content: NormalizedSourceContent,
  ) {
    const count = content.ownMedia.length;
    if (
      !count ||
      count > 1000 ||
      new Set(content.ownMedia.map((m) => m.externalMediaId)).size !== count
    )
      throw new Error("Invalid complete source manifest");
    const post = await tx.sourceDiscoveryPost.upsert({
      where: {
        accountId_platform_externalPostId: {
          accountId: context.accountId,
          platform: context.platform,
          externalPostId: content.externalContentId,
        },
      },
      create: {
        ...context,
        externalPostId: content.externalContentId,
        state: "media_pending",
        nextRetryAt: recoveryDue(0),
        metadataJson: json(content),
        expectedMediaCount: count,
      },
      update: {},
    });
    if (post.sourceUserId !== context.sourceUserId)
      throw new Error("Discovery source identity changed");
    if (["complete", "excluded", "needs_attention"].includes(post.state))
      return post;
    const previous = await tx.sourceDiscoveryMedia.findMany({
      where: { discoveryPostId: post.id },
    });
    if (
      (post.expectedMediaCount !== null && post.expectedMediaCount !== count) ||
      previous.some(
        (m) =>
          content.ownMedia[m.orderIndex]?.externalMediaId !== m.externalMediaId,
      )
    )
      throw new Error("Source manifest changed identity");
    if (
      previous.some((media) => {
        if (!media.fileObjectId) return false;
        const old = media.metadataJson as { url?: unknown };
        const prior = stableSourceAssetIdentity(old.url);
        return (
          !prior ||
          prior !==
            stableSourceAssetIdentity(content.ownMedia[media.orderIndex]?.url)
        );
      })
    )
      return tx.sourceDiscoveryPost.update({
        where: { id: post.id },
        data: {
          state: "needs_attention",
          failureCode: "asset_identity_changed",
          nextRetryAt: null,
          revision: { increment: 1 },
        },
      });
    await tx.sourceDiscoveryPost.update({
      where: { id: post.id },
      data: {
        metadataJson: json(content),
        expectedMediaCount: count,
        state: "media_pending",
        revision: { increment: 1 },
      },
    });
    const known = new Set(previous.map((m) => m.externalMediaId));
    await tx.sourceDiscoveryMedia.createMany({
      data: content.ownMedia.flatMap((media, orderIndex) =>
        known.has(media.externalMediaId)
          ? []
          : [
              {
                discoveryPostId: post.id,
                externalMediaId: media.externalMediaId,
                orderIndex,
                metadataJson: json(media),
              },
            ],
      ),
      skipDuplicates: true,
    });
    // Successful files are immutable; only pending URLs need a refreshed row.
    for (const media of previous.filter((m) => !m.fileObjectId))
      await tx.sourceDiscoveryMedia.update({
        where: { id: media.id },
        data: { metadataJson: json(content.ownMedia[media.orderIndex]) },
      });
    return post;
  }
  async missingMetadata(
    tx: Prisma.TransactionClient,
    context: DiscoveryContext,
    externalPostId: string,
    evidence: unknown,
  ) {
    const proof = evidence as { kind?: unknown; sourceId?: unknown };
    if (
      !/^[1-9][0-9]{0,19}$/.test(externalPostId) ||
      !["author_catalog", "author_timeline"].includes(String(proof?.kind)) ||
      proof.sourceId !== context.sourceUserId
    )
      throw new Error("Unverified source discovery");
    return tx.sourceDiscoveryPost.upsert({
      where: {
        accountId_platform_externalPostId: {
          accountId: context.accountId,
          platform: context.platform,
          externalPostId,
        },
      },
      create: {
        ...context,
        externalPostId,
        evidenceJson: json(evidence),
        failureCode: "metadata_unavailable",
        nextRetryAt: recoveryDue(0),
      },
      update: {},
    });
  }
  async attach(
    tx: Prisma.TransactionClient,
    discoveryId: string,
    mediaId: string,
    fileId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM file_objects WHERE id = ${fileId}::uuid FOR UPDATE`;
    if (
      !(await tx.fileObject.count({
        where: { id: fileId, lifecycleStatus: "active", deletedAt: null },
      }))
    )
      throw new Error("Discovery file is no longer active");
    const saved = await tx.sourceDiscoveryMedia.updateMany({
      where: {
        discoveryPostId: discoveryId,
        externalMediaId: mediaId,
        fileObjectId: null,
      },
      data: { fileObjectId: fileId, state: "stored", failureCode: null },
    });
    if (!saved.count) throw new Error("Discovery media already attached");
  }
  async failedMedia(
    tx: Prisma.TransactionClient,
    discoveryId: string,
    mediaId: string,
    failureCode = "media_unavailable",
  ) {
    await tx.sourceDiscoveryMedia.updateMany({
      where: {
        discoveryPostId: discoveryId,
        externalMediaId: mediaId,
        fileObjectId: null,
      },
      data: {
        state: "failed",
        failureCode,
        attempts: { increment: 1 },
      },
    });
    await tx.sourceDiscoveryPost.updateMany({
      where: {
        id: discoveryId,
        state: { notIn: ["complete", "excluded", "needs_attention"] },
      },
      data: {
        failureCode,
        nextRetryAt: recoveryDue(0),
        revision: { increment: 1 },
      },
    });
  }
  async complete(tx: Prisma.TransactionClient, discoveryId: string) {
    const post = await tx.sourceDiscoveryPost.findUniqueOrThrow({
      where: { id: discoveryId },
      include: { media: { orderBy: { orderIndex: "asc" } } },
    });
    if (
      !post.metadataJson ||
      !readyManifest(post.expectedMediaCount, post.media)
    )
      throw new Error("Incomplete discovery manifest");
    await tx.sourceDiscoveryPost.update({
      where: { id: discoveryId },
      data: {
        state: "complete",
        failureCode: null,
        nextRetryAt: null,
        revision: { increment: 1 },
      },
    });
  }
  /** Bounded safe projection; caller must enforce system:manage. */
  attention() {
    return this.db.sourceDiscoveryPost.findMany({
      where: { state: "needs_attention" },
      take: 100,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        accountId: true,
        platform: true,
        externalPostId: true,
        state: true,
        attempts: true,
        failureCode: true,
        updatedAt: true,
      },
    });
  }
}
