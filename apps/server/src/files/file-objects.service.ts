import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  validateReadExpiry,
} from "./object-storage.js";
import type { SignedWriteInput } from "./object-storage.js";
import { JobsService } from "../jobs/jobs.service.js";
import { type FileObject, type Prisma } from "../generated/prisma/client.js";
import { generateThumbnail, THUMBNAIL_RECIPE } from "./image-processor.js";
import type { ImageUrlDto } from "./image-url.dto.js";

export interface StoreFileInput {
  body: Uint8Array;
  contentType: string;
  bucketScope: string;
  kind: string;
  sourceName?: string;
  createdById?: string;
}

export interface StoreFilePathInput extends Omit<StoreFileInput, "body"> {
  path: string;
}

const extensionByType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

@Injectable()
export class FileObjectsService {
  private readonly signedUrls = new Map<
    string,
    { url: string; expiresAt: number }
  >();
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register("image_thumbnail", async (job, signal) => {
      const derivative = await this.db.imageDerivative.findUnique({
        where: { id: job.resourceId },
        include: { sourceFile: true },
      });
      if (!derivative || ["ready", "reused"].includes(derivative.status))
        return;
      if (
        derivative.sourceFile.lifecycleStatus !== "active" ||
        derivative.sourceFile.deletedAt
      )
        return;
      await this.db.imageDerivative.update({
        where: { id: derivative.id },
        data: { status: "processing" },
      });
      let output: FileObject | undefined;
      try {
        signal.throwIfAborted();
        const body = await this.storage.read(derivative.sourceFile.objectKey);
        const thumbnail = await generateThumbnail(body);
        signal.throwIfAborted();
        if (thumbnail.keep)
          output = await this.store({
            body: thumbnail.body,
            contentType: "image/webp",
            bucketScope: derivative.sourceFile.bucketScope,
            kind: "image-thumbnail",
          });
        signal.throwIfAborted();
        const adopted = await this.db.$transaction(async (tx) => {
          if (
            !(await tx.backgroundJob.count({
              where: {
                id: job.id,
                leaseId: job.leaseId,
                status: "running",
                leaseUntil: { gt: new Date() },
              },
            }))
          )
            return { count: 0 };
          return tx.imageDerivative.updateMany({
            where: {
              id: derivative.id,
              sourceFile: { lifecycleStatus: "active", deletedAt: null },
            },
            data: {
              status: thumbnail.keep ? "ready" : "reused",
              outputFileId: output?.id ?? null,
              width: thumbnail.width,
              height: thumbnail.height,
              lastError: null,
            },
          });
        });
        if (!adopted.count && output) await this.purgeUnreferenced(output.id);
      } catch (error) {
        if (output) await this.purgeUnreferenced(output.id).catch(() => {});
        await this.db.imageDerivative.updateMany({
          where: {
            id: derivative.id,
            status: { in: ["queued", "processing"] },
            outputFileId: null,
          },
          data: {
            status: job.attempts >= 3 ? "failed" : "queued",
            lastError: "缩略图处理未完成，原文件保留",
          },
        });
        throw error;
      }
    });
  }

  private thumbnailEligible(file: Pick<FileObject, "kind" | "contentType">) {
    return (
      file.contentType.startsWith("image/") &&
      ["candidate-media", "typeset-result", "typeset-upload-preview"].includes(
        file.kind,
      )
    );
  }

  private async registerThumbnail(
    file: FileObject,
    tx: Prisma.TransactionClient | PrismaService,
    priority = 10,
  ) {
    if (!this.thumbnailEligible(file)) return;
    await tx.imageDerivative.createMany({
      data: { sourceFileId: file.id, recipe: THUMBNAIL_RECIPE },
      skipDuplicates: true,
    });
    const derivative = await tx.imageDerivative.findUniqueOrThrow({
      where: {
        sourceFileId_recipe: {
          sourceFileId: file.id,
          recipe: THUMBNAIL_RECIPE,
        },
      },
    });
    await this.jobs.enqueue(
      {
        kind: "image_thumbnail",
        resourceId: derivative.id,
        idempotencyKey: `thumbnail:${file.id}:${THUMBNAIL_RECIPE}`,
        priority,
      },
      tx,
    );
  }

  async backfillThumbnails(limit = 100, retryFailed = false) {
    const files = await this.db.fileObject.findMany({
      where: {
        lifecycleStatus: "active",
        deletedAt: null,
        kind: {
          in: ["candidate-media", "typeset-result", "typeset-upload-preview"],
        },
        OR: [
          { imageDerivatives: { none: { recipe: THUMBNAIL_RECIPE } } },
          ...(retryFailed
            ? [
                {
                  imageDerivatives: {
                    some: {
                      recipe: THUMBNAIL_RECIPE,
                      status: "failed" as const,
                    },
                  },
                },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    for (const file of files)
      await this.db.$transaction(async (tx) => {
        await this.registerThumbnail(file, tx, 1);
        if (retryFailed) {
          const changed = await tx.imageDerivative.updateMany({
            where: {
              sourceFileId: file.id,
              recipe: THUMBNAIL_RECIPE,
              status: "failed",
            },
            data: { status: "queued", lastError: null },
          });
          if (changed.count)
            await tx.backgroundJob.updateMany({
              where: {
                idempotencyKey: `thumbnail:${file.id}:${THUMBNAIL_RECIPE}`,
                status: "failed",
              },
              data: {
                status: "queued",
                attempts: 0,
                completedAt: null,
                availableAt: new Date(),
              },
            });
        }
      });
    return files.length;
  }

  async imageUrl(
    id: string,
    variant: "original" | "thumbnail" = "original",
  ): Promise<ImageUrlDto> {
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
      include: { imageDerivatives: { where: { recipe: THUMBNAIL_RECIPE } } },
    });
    if (!file) throw new NotFoundException("文件不存在");
    const derivative = file.imageDerivatives[0];
    if (derivative && ["queued", "processing"].includes(derivative.status)) {
      const exhausted = await this.db.backgroundJob.count({
        where: {
          resourceId: derivative.id,
          kind: "image_thumbnail",
          status: "failed",
        },
      });
      if (exhausted) {
        await this.db.imageDerivative.update({
          where: { id: derivative.id },
          data: { status: "failed", lastError: "重试已用尽，暂时显示原图" },
        });
        derivative.status = "failed";
      }
    }
    if (variant === "original")
      return {
        ...(await this.signedReadUrl(id)),
        fileId: id,
        status: "ready",
        width: null,
        height: null,
      };
    if (!derivative && this.thumbnailEligible(file)) {
      await this.db.$transaction((tx) => this.registerThumbnail(file, tx));
      return {
        url: null,
        expiresInSeconds: 0,
        fileId: id,
        status: "queued",
        width: null,
        height: null,
      };
    }
    if (derivative && ["queued", "processing"].includes(derivative.status))
      return {
        url: null,
        expiresInSeconds: 0,
        fileId: id,
        status: derivative.status,
        width: derivative.width,
        height: derivative.height,
      };
    const outputId = derivative?.outputFileId ?? id;
    return {
      ...(await this.signedReadUrl(outputId)),
      fileId: id,
      status: derivative?.status ?? "reused",
      width: derivative?.width ?? null,
      height: derivative?.height ?? null,
    };
  }

  async store(input: StoreFileInput) {
    const checksum = createHash("sha256").update(input.body).digest("hex");
    const sourceExtension = input.sourceName
      ? extname(
          new URL(input.sourceName, "https://local.invalid").pathname,
        ).toLowerCase()
      : "";
    const extension = extensionByType[input.contentType] ?? sourceExtension;
    const objectKey = `${input.bucketScope}/${input.kind}/${randomUUID()}${extension}`;
    await this.storage.put({
      key: objectKey,
      body: input.body,
      size: input.body.byteLength,
      contentType: input.contentType,
      checksum,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        const file = await tx.fileObject.create({
          data: {
            objectKey,
            bucketScope: input.bucketScope,
            kind: input.kind,
            contentType: input.contentType,
            size: BigInt(input.body.byteLength),
            checksum,
            createdById: input.createdById,
          },
        });
        await this.registerThumbnail(file, tx);
        return file;
      });
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async storePath(input: StoreFilePathInput) {
    const checksum = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(input.path)) {
      checksum.update(chunk);
      size += chunk.length;
    }
    const sourceExtension = input.sourceName
      ? extname(
          new URL(input.sourceName, "https://local.invalid").pathname,
        ).toLowerCase()
      : "";
    const extension = extensionByType[input.contentType] ?? sourceExtension;
    const objectKey = `${input.bucketScope}/${input.kind}/${randomUUID()}${extension}`;
    const digest = checksum.digest("hex");
    await this.storage.put({
      key: objectKey,
      body: createReadStream(input.path),
      size,
      contentType: input.contentType,
      checksum: digest,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        const file = await tx.fileObject.create({
          data: {
            objectKey,
            bucketScope: input.bucketScope,
            kind: input.kind,
            contentType: input.contentType,
            size: BigInt(size),
            checksum: digest,
            createdById: input.createdById,
          },
        });
        await this.registerThumbnail(file, tx);
        return file;
      });
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async readStream(id: string) {
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
    });
    if (!file) throw new NotFoundException("文件不存在或不可用");
    return { file, body: await this.storage.readStream(file.objectKey) };
  }
  async exists(id: string) {
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
    });
    return Boolean(file && (await this.storage.head(file.objectKey)));
  }
  async signedDownloadUrl(id: string, fileName: string) {
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
    });
    if (!file) throw new NotFoundException("文件不存在或不可用");
    if (!(await this.storage.head(file.objectKey)))
      throw new NotFoundException("导出文件已失效，请重新生成");
    return {
      url: await this.storage.signedReadUrl(file.objectKey, 300, fileName),
      expiresInSeconds: 300,
    };
  }

  async signedReadUrl(id: string, expiresInSeconds = 300) {
    validateReadExpiry(expiresInSeconds);
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
    });
    if (!file) throw new NotFoundException("文件不存在");
    const cacheKey = `${id}:${expiresInSeconds}`;
    const cached = this.signedUrls.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000)
      return {
        url: cached.url,
        expiresInSeconds: Math.floor((cached.expiresAt - Date.now()) / 1_000),
      };
    const url = await this.storage.signedReadUrl(
      file.objectKey,
      expiresInSeconds,
    );
    if (this.signedUrls.size >= 1_000)
      this.signedUrls.delete(this.signedUrls.keys().next().value!);
    this.signedUrls.set(cacheKey, {
      url,
      expiresAt: Date.now() + expiresInSeconds * 1_000,
    });
    return { url, expiresInSeconds };
  }

  async read(id: string) {
    const file = await this.db.fileObject.findFirst({
      where: { id, lifecycleStatus: "active", deletedAt: null },
    });
    if (!file) throw new NotFoundException("文件不存在");
    return { file, body: await this.storage.read(file.objectKey) };
  }

  signedStagingWriteUrl(input: SignedWriteInput, expiresInSeconds: number) {
    return this.storage.signedWriteUrl(input, expiresInSeconds);
  }

  headStagingObject(key: string) {
    return this.storage.head(key);
  }

  readStagingObject(key: string) {
    return this.storage.read(key);
  }

  deleteStagingObject(key: string) {
    return this.storage.delete(key);
  }

  async purgeUnreferenced(id: string): Promise<void> {
    for (const key of this.signedUrls.keys())
      if (key.startsWith(`${id}:`)) this.signedUrls.delete(key);
    const file = await this.db.fileObject.findUnique({ where: { id } });
    if (!file) return;
    await this.db.fileObject.update({
      where: { id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    await this.storage.delete(file.objectKey);
    const derivatives = await this.db.imageDerivative.findMany({
      where: { sourceFileId: id },
      select: { outputFileId: true },
    });
    await this.db.imageDerivative.deleteMany({ where: { sourceFileId: id } });
    await this.db.fileObject.delete({ where: { id } });
    for (const derivative of derivatives)
      if (derivative.outputFileId && derivative.outputFileId !== id)
        await this.purgeUnreferenced(derivative.outputFileId);
  }
}
