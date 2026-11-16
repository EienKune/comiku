import { createHash, randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
} from "@nestjs/common";
import type { Actor } from "../common/access.js";
import { OBJECT_STORAGE, type ObjectStorage } from "../files/object-storage.js";
import { SiteService } from "./site.service.js";
import { processSiteIcon } from "./site-icon-processor.js";

@Injectable()
export class SiteIconService {
  private uploading = false;
  constructor(
    @Inject(SiteService) private readonly site: SiteService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}
  acquire() {
    if (this.uploading)
      throw new HttpException("正在处理站点图标，请稍后重试", 429);
    this.uploading = true;
    return () => {
      this.uploading = false;
    };
  }
  async prepare(actor: Actor, bytes: Uint8Array, contentType: string) {
    await this.site.db.$transaction((tx) => this.site.authorize(tx, actor));
    const images = await processSiteIcon(bytes, contentType);
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 15 * 60_000);
    const entries = ([256, 32] as const).map((size) => ({
      id: randomUUID(),
      objectKey: `system/site-brand/${id}/${size}.png`,
      body: images[size],
      checksum: createHash("sha256").update(images[size]).digest("hex"),
    }));
    // Register both deterministic keys before network writes: every crash is discoverable.
    await this.site.db.$transaction(async (tx) => {
      await this.site.authorize(tx, actor);
      await this.site.lock(tx);
      if (
        (await tx.siteBrandAsset.count({
          where: {
            status: { in: ["preparing", "ready"] },
            expiresAt: { not: null },
          },
        })) >= 20
      )
        throw new HttpException("待处理图标较多，请稍后重试", 429);
      for (const entry of entries)
        await tx.fileObject.create({
          data: {
            id: entry.id,
            objectKey: entry.objectKey,
            bucketScope: "system",
            kind: "site-brand",
            contentType: "image/png",
            size: BigInt(entry.body.byteLength),
            checksum: entry.checksum,
            createdById: actor.userId,
          },
        });
      await tx.siteBrandAsset.create({
        data: {
          id,
          createdById: actor.userId,
          iconFileId: entries[0].id,
          faviconFileId: entries[1].id,
          expiresAt,
          status: "preparing",
        },
      });
    });
    try {
      for (const entry of entries)
        await this.storage.put({
          key: entry.objectKey,
          body: entry.body,
          contentType: "image/png",
          size: entry.body.byteLength,
          checksum: entry.checksum,
          signal: AbortSignal.timeout(60_000),
        });
      await this.site.db.$transaction(async (tx) => {
        await this.site.authorize(tx, actor);
        await this.site.lock(tx);
        const current = await tx.siteBrandAsset.findUnique({ where: { id } });
        if (
          !current ||
          current.status !== "preparing" ||
          !current.expiresAt ||
          current.expiresAt <= new Date()
        )
          throw new NotFoundException("上传已失效");
        await tx.siteBrandAsset.update({
          where: { id },
          data: { status: "ready" },
        });
      });
      return { assetId: id, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await this.site.db.siteBrandAsset
        .updateMany({
          where: { id, status: "preparing" },
          data: { expiresAt: new Date(0) },
        })
        .catch(() => {});
      throw error;
    }
  }
  async readPublic(version: string, size: number) {
    if (size !== 32 && size !== 256) throw new NotFoundException("图标不存在");
    const settings = await this.site.db.siteSettings.findUnique({
      where: { id: "global" },
      include: {
        iconAsset: { include: { iconFile: true, faviconFile: true } },
      },
    });
    const asset = settings?.iconAsset;
    if (!asset || asset.id !== version || asset.status !== "ready")
      throw new NotFoundException("图标不存在");
    const file = size === 32 ? asset.faviconFile : asset.iconFile;
    return this.storage.readStream(file.objectKey);
  }
  async cleanup() {
    const deadline = Date.now() + 10_000;
    let failures = 0;
    const candidates = await this.site.db.siteBrandAsset.findMany({
      where: { expiresAt: { lte: new Date() } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 20,
      select: { id: true },
    });
    for (const { id } of candidates) {
      if (Date.now() >= deadline) break;
      try {
        const asset = await this.site.db.$transaction(async (tx) => {
          await this.site.lock(tx);
          const current = await tx.siteBrandAsset.findUnique({
            where: { id },
            include: { iconFile: true, faviconFile: true },
          });
          if (
            !current?.expiresAt ||
            current.expiresAt > new Date() ||
            (await tx.siteSettings.count({ where: { iconAssetId: id } }))
          )
            return null;
          await tx.siteBrandAsset.update({
            where: { id },
            data: { status: "deleting" },
          });
          return current;
        });
        if (!asset) continue;
        // Deleting state fences adoption; failed network deletion retries next maintenance.
        const signal = AbortSignal.timeout(
          Math.max(1, Math.min(5000, deadline - Date.now())),
        );
        await this.storage.delete(asset.iconFile.objectKey, signal);
        await this.storage.delete(asset.faviconFile.objectKey, signal);
        await this.site.db.$transaction(async (tx) => {
          await this.site.lock(tx);
          const current = await tx.siteBrandAsset.findUnique({ where: { id } });
          if (!current || current.status !== "deleting") return;
          await tx.siteBrandAsset.delete({ where: { id } });
          await tx.fileObject.deleteMany({
            where: { id: { in: [asset.iconFileId, asset.faviconFileId] } },
          });
        });
      } catch {
        failures += 1;
        await this.site.db.siteBrandAsset.updateMany({
          where: { id, status: "deleting" },
          data: { expiresAt: new Date(Date.now() + 60_000) },
        });
      }
    }
    if (failures) console.error("站点图标清理未完成，将稍后重试。");
  }
}
