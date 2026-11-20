import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import {
  inspectImage,
  type ManualUploadFile,
} from "../candidates/manual-candidate-upload.js";
import { assertProductionWritable } from "../workflow/review-policy.js";
import type { SourceHdReplaceDto } from "./typeset-collaboration.dto.js";

@Injectable()
export class SourceHdService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
  ) {}
  async replace(
    actorId: string,
    workId: string,
    imageId: string,
    file: ManualUploadFile | undefined,
    input: SourceHdReplaceDto,
  ) {
    if (!file || !input.sameContentConfirmed)
      throw new BadRequestException("请核对新旧图片内容和构图一致后确认");
    const image = inspectImage(file.originalname, file.buffer);
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(image.contentType) ||
      !image.width ||
      !image.height
    )
      throw new BadRequestException("需要尺寸可读取的 PNG、JPEG 或 WebP 图片");
    const authorize = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id=${actorId}::uuid FOR SHARE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT user_id FROM user_roles WHERE user_id=${actorId}::uuid FOR SHARE`,
      );
      const actor = await tx.user.findFirst({
        where: {
          id: actorId,
          isActive: true,
          roles: { some: { role: { in: ["source", "admin"] } } },
        },
        select: { id: true },
      });
      if (!actor) throw new ForbiddenException("需要图源或管理权限");
    };
    await this.db.$transaction(authorize);
    const stored = await this.files.store({
      body: image.body,
      contentType: image.contentType,
      bucketScope: "works",
      kind: "source-hd-replacement",
      sourceName: image.sourceName,
      createdById: actorId,
    });
    try {
      const result = await this.db.$transaction(async (tx) => {
        await authorize(tx);
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
        );
        const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
        assertProductionWritable(work);
        const replay = await tx.workEvent.findUnique({
          where: {
            workId_idempotencyKey: {
              workId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (replay) {
          if (
            replay.actorId !== actorId ||
            (replay.detail as { imageId?: string }).imageId !== imageId
          )
            throw new ConflictException("幂等键冲突");
          return { revision: work.revision };
        }
        if (work.revision !== input.expectedRevision)
          throw new ConflictException("作品已更新，请重新核对原图");
        if (
          work.typesetHandoffStartedAt ||
          ["published", "archived"].includes(work.workflowStatus)
        )
          throw new ConflictException(
            "本轮嵌字已正式承接或作品已发布，不能普通替换原图",
          );
        const current = await tx.workImage.findFirstOrThrow({
          where: { id: imageId, workId },
        });
        await tx.workSourceAssetReplacement.create({
          data: {
            workId,
            workImageId: imageId,
            oldFileObjectId: current.originalFileObjectId,
            newFileObjectId: stored.id,
            actorId,
            assetRevision: work.sourceAssetRevision + 1,
          },
        });
        await tx.workImage.update({
          where: { id: imageId },
          data: {
            originalFileObjectId: stored.id,
            width: image.width,
            height: image.height,
          },
        });
        await tx.work.update({
          where: { id: workId },
          data: {
            sourceAssetRevision: { increment: 1 },
            revision: { increment: 1 },
          },
        });
        await tx.workEvent.create({
          data: {
            workId,
            actorId,
            action: "metadata_updated",
            idempotencyKey: input.idempotencyKey,
            fromWorkflowStatus: work.workflowStatus,
            toWorkflowStatus: work.workflowStatus,
            fromReviewStatus: work.reviewStatus,
            toReviewStatus: work.reviewStatus,
            detail: {
              operation: "source-hd-replaced",
              imageId,
              pageNumber: current.orderIndex + 1,
              sourceAssetRevision: work.sourceAssetRevision + 1,
              message: "原图材料已更新，请刷新查看",
            },
          },
        });
        return { revision: work.revision + 1 };
      });
      await this.files.purgeUnreferenced(stored.id);
      return result;
    } catch (error) {
      await this.files.purgeUnreferenced(stored.id).catch(() => undefined);
      throw error;
    }
  }
}
