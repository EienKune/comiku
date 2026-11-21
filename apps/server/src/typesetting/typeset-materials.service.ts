import { lockAccountMembership } from "../users/account-membership-lock.js";
import { formalMaterialDocument } from "./formal-materials.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { TranslationsService } from "../translations/translations.service.js";
import { assertProductionWritable } from "../workflow/review-policy.js";
import {
  encodeLabelPlus,
  LabelPlusParseError,
} from "../labelplus/labelplus-codec.js";
import {
  targetImageFileName,
  typesetHandoffPackageFileName,
  typesetTranslationFileName,
} from "./handoff-package.js";
import { assertMaterialCurrent } from "./typeset-materials-identity.js";
import type {
  CreateTypesetMaterialDto,
  TypesetMaterialDto,
} from "./typeset-materials.dto.js";

const includeImages = {
  images: {
    orderBy: { orderIndex: "asc" as const },
    include: { fileObject: true },
  },
};
@Injectable()
export class TypesetMaterialsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(TranslationsService)
    private readonly translations: TranslationsService,
  ) {}

  async create(
    actorId: string,
    workId: string,
    input: CreateTypesetMaterialDto,
  ): Promise<TypesetMaterialDto> {
    await this.translations.assertCanExportHandoffMaterials(actorId, workId);
    const record = await this.db.$transaction(async (tx) => {
      await lockAccountMembership(tx);
      await this.translations.assertCanExportHandoffMaterials(
        actorId,
        workId,
        tx,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
      );
      const work = await tx.work.findUnique({
        where: { id: workId },
        include: {
          images: {
            orderBy: { orderIndex: "asc" },
            include: { originalFileObject: true },
          },
        },
      });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      const replay = await tx.typesetMaterial.findUnique({
        where: {
          actorId_idempotencyKey: {
            actorId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (
          replay.workId !== workId ||
          replay.workRevision !== input.expectedRevision ||
          replay.editorEpoch !== input.expectedEditorEpoch ||
          replay.requireCurrentParticipation !==
            (input.requireCurrentParticipation !== false)
        )
          throw new ConflictException("该下载标识已用于其他材料请求");
        await assertMaterialCurrent(tx, workId, replay.id);
        return tx.typesetMaterial.findUniqueOrThrow({
          where: { id: replay.id },
          include: includeImages,
        });
      }
      if (
        !["pending_typeset", "typesetting"].includes(work.workflowStatus) ||
        work.revision !== input.expectedRevision ||
        work.editorEpoch !== input.expectedEditorEpoch ||
        !work.images.length
      )
        throw new ConflictException("作品状态或材料已变化，请刷新后重新领取");
      const version = await tx.translationVersion.findFirst({
        where: work.requiredHandoffVersionId
          ? { id: work.requiredHandoffVersionId, workId }
          : { workId },
        orderBy: { versionNumber: "desc" },
        include: { entries: { orderBy: { orderIndex: "asc" } } },
      });
      if (!version)
        throw new ConflictException("作品尚无正式译文，请先提交翻译或校对");
      let translation: Uint8Array;
      try {
        translation = encodeLabelPlus(
          formalMaterialDocument(work.workNumber, work.images, version.entries),
        );
      } catch (error) {
        if (error instanceof LabelPlusParseError)
          throw new BadRequestException(error.message);
        throw error;
      }
      return tx.typesetMaterial.create({
        data: {
          actorId,
          workId,
          translationVersionId: version.id,
          sourceAssetRevision: work.sourceAssetRevision,
          workRevision: work.revision,
          editorEpoch: work.editorEpoch,
          idempotencyKey: input.idempotencyKey,
          requireCurrentParticipation:
            input.requireCurrentParticipation !== false,
          fileName: typesetHandoffPackageFileName(work.workNumber),
          translationFileName: typesetTranslationFileName(work.workNumber),
          translationBase64: Buffer.from(translation).toString("base64"),
          images: {
            create: work.images.map((image, index) => ({
              workImageId: image.id,
              fileObjectId: image.originalFileObjectId,
              orderIndex: image.orderIndex,
              fileName: targetImageFileName(
                work.workNumber,
                index,
                image.originalFileObject.contentType,
              ),
            })),
          },
        },
        include: includeImages,
      });
    });
    return this.dto(record);
  }

  async deliver(
    actorId: string,
    workId: string,
    id: string,
  ): Promise<TypesetMaterialDto> {
    await this.translations.assertCanExportHandoffMaterials(actorId, workId);
    const record = await this.db.typesetMaterial.findFirst({
      where: { id, workId, actorId },
      include: includeImages,
    });
    if (!record) throw new NotFoundException("材料清单不存在");
    // Sign in bounded groups without reading image bytes through the application server.
    const urls: string[] = [];
    for (let i = 0; i < record.images.length; i += 6) {
      const group = await Promise.all(
        record.images
          .slice(i, i + 6)
          .map((image) =>
            this.files.signedDownloadUrl(image.fileObjectId, image.fileName),
          ),
      );
      urls.push(...group.map((signed) => signed.url));
    }
    await this.translations.beginTypesetHandoff(actorId, workId, {
      material: "browser_materials",
      fileId: id,
      expectedRevision: record.workRevision,
      expectedEditorEpoch: record.editorEpoch,
      requireCurrentParticipation: record.requireCurrentParticipation,
    });
    const current = await this.db.work.findUniqueOrThrow({
      where: { id: workId },
      select: { revision: true, editorEpoch: true },
    });
    return {
      ...this.dto(record),
      workRevision: current.revision,
      editorEpoch: current.editorEpoch,
      expiresInSeconds: 300,
      images: this.dto(record).images.map((image, i) => ({
        ...image,
        url: urls[i],
      })),
    };
  }

  private dto(
    record: Prisma.TypesetMaterialGetPayload<{ include: typeof includeImages }>,
  ): TypesetMaterialDto {
    const images = record.images.map((image) => ({
      workImageId: image.workImageId,
      fileObjectId: image.fileObjectId,
      fileName: image.fileName,
      size: Number(image.fileObject.size),
      checksum: image.fileObject.checksum,
    }));
    return {
      id: record.id,
      fileName: record.fileName,
      translationVersionId: record.translationVersionId,
      sourceAssetRevision: record.sourceAssetRevision,
      workRevision: record.workRevision,
      editorEpoch: record.editorEpoch,
      translationFileName: record.translationFileName,
      translationBase64: record.translationBase64,
      totalBytes:
        images.reduce((sum, image) => sum + image.size, 0) +
        Buffer.from(record.translationBase64, "base64").length,
      images,
    };
  }
}
