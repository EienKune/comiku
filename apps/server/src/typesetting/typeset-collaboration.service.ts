import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import {
  prepareTypesetBatchFile,
  typesetName,
} from "./typeset-batch-upload.js";
import {
  aggregateTypesetTx,
  currentTypesetCreditsTx,
  lockTypesetWorkTx,
  typesetActorTx,
  type TypesetMutation,
} from "./typeset-page-workflow.js";
import type { ApplyTypesetImportDto } from "./typeset-collaboration.dto.js";

@Injectable()
export class TypesetCollaborationService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
  ) {}

  async state(workId: string) {
    const work = await this.db.work.findUniqueOrThrow({
      where: { id: workId },
      select: {
        revision: true,
        editorEpoch: true,
        workflowStatus: true,
        collaborationMode: true,
        currentTypesetVersionId: true,
        typesetHandoffStartedAt: true,
      },
    });
    const pages = await this.db.workImage.findMany({
      where: { workId },
      orderBy: { orderIndex: "asc" },
      select: { id: true, orderIndex: true },
    });
    const assignments = await this.db.workPageAssignment.findMany({
      where: { workId, stage: "typeset" },
    });
    const participants = await this.db.workStageParticipant.findMany({
      where: { workId, stage: "typeset", leftAt: null },
      select: {
        id: true,
        userId: true,
        user: { select: { displayName: true } },
      },
    });
    const drafts = await this.db.workTypesetDraft.findMany({
      where: { workId },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        workImageId: true,
        participantId: true,
        position: true,
        orderIndex: true,
        sourceName: true,
        revision: true,
        submittedRevision: true,
      },
    });
    return {
      ...work,
      handoffReady: !!work.typesetHandoffStartedAt,
      pages: pages.map((page) => ({
        ...page,
        assignment: assignments.find((a) => a.workImageId === page.id) ?? null,
      })),
      participants,
      drafts,
    };
  }

  async imageUrl(
    workId: string,
    draftId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    const draft = await this.db.workTypesetDraft.findFirstOrThrow({
      where: { id: draftId, workId },
    });
    return this.files.imageUrl(draft.fileObjectId, variant);
  }

  async preview(
    actorId: string,
    workId: string,
    uploads: ManualUploadFile[],
    input: TypesetMutation,
  ) {
    const { work } = await this.db.$transaction(async (tx) => {
      await typesetActorTx(tx, actorId, workId);
      return lockTypesetWorkTx(tx, workId, input);
    });
    if (!uploads.length || uploads.length > 100)
      throw new BadRequestException("请选择 1–100 个图片或 ZIP");
    const prepared = [];
    let preparedBytes = 0;
    try {
      for (const upload of uploads) {
        const named = typesetName(
          upload.originalname,
          upload.originalname.toLowerCase().endsWith(".zip"),
        );
        if (named.workNumber && named.workNumber !== work.workNumber)
          throw new Error("文件明确指向其他作品，已停止导入");
        const group = prepareTypesetBatchFile(upload).images;
        preparedBytes += group.reduce((n, i) => n + i.body.byteLength, 0);
        if (
          prepared.length + group.length > 100 ||
          preparedBytes > 250 * 1024 * 1024
        )
          throw new Error("解包后超过 100 张或 250 MiB");
        prepared.push(...group);
      }
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : "图片解析失败",
      );
    }
    for (const image of prepared) {
      const named = typesetName(image.sourceName);
      if (named.workNumber && named.workNumber !== work.workNumber)
        throw new BadRequestException("ZIP 中包含其他作品的图片，已停止导入");
    }
    const storedIds: string[] = [];
    try {
      const images = [];
      for (const [orderIndex, image] of prepared.entries()) {
        const file = await this.files.store({
          body: image.body,
          contentType: image.contentType,
          bucketScope: "works",
          kind: "typeset-upload-preview",
          sourceName: image.sourceName,
          createdById: actorId,
        });
        storedIds.push(file.id);
        images.push({
          fileObjectId: file.id,
          sourceName: image.sourceName,
          width: image.width!,
          height: image.height!,
          orderIndex,
        });
      }
      const session = await this.db.typesetUploadSession.create({
        data: {
          actorId,
          status: "previewed",
          expiresAt: new Date(Date.now() + 24 * 3600000),
          files: {
            create: {
              sourceName: "detail-import",
              objectKey: `unused-detail-preview/${randomUUID()}`,
              contentType: "application/zip",
              size: 0,
              checksum: "0".repeat(64),
              status: "processed",
              orderIndex: 0,
              images: { create: images },
            },
          },
          previews: {
            create: {
              workId,
              workRevision: work.revision,
              editorEpoch: work.editorEpoch,
              handoffStartedAt: work.typesetHandoffStartedAt!,
              imageIds: [],
              idempotencyKey: randomUUID(),
            },
          },
        },
        include: { files: { include: { images: true } } },
      });
      const pages = await this.db.workImage.findMany({
        where: { workId },
        orderBy: { orderIndex: "asc" },
      });
      return {
        sessionId: session.id,
        expectedRevision: work.revision,
        images: session.files
          .flatMap((f) => f.images)
          .map((image) => {
            const number = typesetName(image.sourceName).pageNumber;
            return {
              id: image.id,
              sourceName: image.sourceName,
              suggestedWorkImageId: number
                ? (pages[number - 1]?.id ?? null)
                : null,
            };
          }),
      };
    } catch (e) {
      for (const id of storedIds)
        await this.files.purgeUnreferenced(id).catch(() => undefined);
      throw e;
    }
  }

  async apply(actorId: string, workId: string, input: ApplyTypesetImportDto) {
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          sessionId: input.sessionId,
          mappings: input.mappings,
        }),
      )
      .digest("hex");
    return this.db.$transaction(async (tx) => {
      const participant = await typesetActorTx(tx, actorId, workId);
      const { work, replay } = await lockTypesetWorkTx(tx, workId, input);
      if (replay) {
        const detail = replay.detail as {
          operation?: string;
          inputHash?: string;
        };
        if (
          replay.actorId !== actorId ||
          detail.operation !== "typeset-page-save" ||
          detail.inputHash !== inputHash
        )
          throw new ConflictException("幂等键已用于其他操作或不同页映射");
        return { revision: work.revision };
      }
      const session = await tx.typesetUploadSession.findFirst({
        where: {
          id: input.sessionId,
          actorId,
          status: "previewed",
          expiresAt: { gt: new Date() },
          previews: { some: { workId, workRevision: input.expectedRevision } },
        },
      });
      if (!session)
        throw new ConflictException("上传预览已过期或不属于本作品，请重新预览");
      const allPages = await tx.workImage.findMany({
        where: { workId },
        orderBy: { orderIndex: "asc" },
      });
      const assignments = await tx.workPageAssignment.findMany({
        where: { workId, stage: "typeset" },
      });
      if (
        work.collaborationMode === "multi" &&
        !assignments.some((a) => a.participantId === participant.id)
      )
        throw new ForbiddenException("至少认领一张原稿页才可添加成图");
      const current = await tx.workTypesetDraft.findMany({ where: { workId } });
      const pageMappings = input.mappings.filter((m) => m.position === "page");
      if (
        pageMappings.some((m) => !m.workImageId) ||
        input.mappings.some((m) => m.position !== "page" && !!m.workImageId)
      )
        throw new BadRequestException(
          "原稿成图须明确配页，补充图不得冒充原稿页",
        );
      if (
        new Set(input.mappings.map((m) => m.imageId)).size !==
          input.mappings.length ||
        new Set(pageMappings.map((m) => m.workImageId)).size !==
          pageMappings.length
      )
        throw new BadRequestException("同一图片或原稿页不可重复映射");
      if (
        work.collaborationMode === "multi" &&
        input.mappings.some((m) => m.position === "free")
      )
        throw new BadRequestException(
          "多人原稿成图必须明确映射，补充图须明确选择首尾",
        );
      const stagedImages = await tx.typesetUploadImage.findMany({
        where: {
          id: { in: input.mappings.map((m) => m.imageId) },
          uploadFile: { sessionId: session.id },
        },
        include: { fileObject: true },
      });
      if (work.collaborationMode === "single") {
        if (
          work.workflowStatus === "pending_publish" ||
          participant.submittedAt
        )
          throw new ConflictException(
            "完整交付后的单人修订请替换具体当前成图；暂停交付请先取消提交",
          );
        const images = input.mappings.map((m) => {
          const image = stagedImages.find((i) => i.id === m.imageId);
          if (
            !image ||
            image.fileObject.lifecycleStatus !== "active" ||
            image.fileObject.deletedAt
          )
            throw new ConflictException("预览文件不可用");
          if (m.workImageId && !allPages.some((p) => p.id === m.workImageId))
            throw new BadRequestException("原稿页不属于本作品");
          return { image, mapping: m };
        });
        const latest = await tx.typesetImageVersion.aggregate({
          where: { workId },
          _max: { versionNumber: true },
        });
        const textId =
          work.requiredHandoffVersionId ??
          (
            await tx.translationVersion.findFirst({
              where: { workId },
              orderBy: { versionNumber: "desc" },
              select: { id: true },
            })
          )?.id;
        const version = await tx.typesetImageVersion.create({
          data: {
            workId,
            versionNumber: (latest._max.versionNumber ?? 0) + 1,
            uploadedById: actorId,
            idempotencyKey: input.idempotencyKey,
            sourceTranslationVersionId: textId,
            reviewedTranslationVersionId: textId,
            textReviewedAt: new Date(),
            images: {
              create: images.map(({ image, mapping }, orderIndex) => ({
                fileObjectId: image.fileObjectId,
                workImageId: mapping.workImageId ?? null,
                sourceName: image.sourceName,
                width: image.width,
                height: image.height,
                orderIndex,
              })),
            },
          },
        });
        await tx.work.update({
          where: { id: workId },
          data: {
            currentTypesetVersionId: version.id,
            revision: { increment: 1 },
          },
        });
        await tx.workEvent.create({
          data: {
            workId,
            actorId,
            action: "typeset_version_uploaded",
            idempotencyKey: input.idempotencyKey,
            fromWorkflowStatus: work.workflowStatus,
            toWorkflowStatus: work.workflowStatus,
            fromReviewStatus: work.reviewStatus,
            toReviewStatus: work.reviewStatus,
            detail: {
              operation: "typeset-page-save",
              inputHash,
              versionId: version.id,
              versionNumber: version.versionNumber,
              imageCount: images.length,
              affectedPageNumbers: images.map((_, i) => i + 1),
              affectsSupplement: images.some((i) => !i.mapping.workImageId),
              source: "single-detail-import",
            },
          },
        });
        return { revision: work.revision + 1, versionId: version.id };
      }
      for (const [index, m] of input.mappings.entries()) {
        const image = stagedImages.find((i) => i.id === m.imageId);
        if (
          !image ||
          image.fileObject.lifecycleStatus !== "active" ||
          image.fileObject.deletedAt
        )
          throw new ConflictException("预览文件不可用");
        const assignment = assignments.find(
          (a) => a.workImageId === m.workImageId,
        );
        const old = m.draftId
          ? current.find((d) => d.id === m.draftId)
          : m.workImageId
            ? current.find((d) => d.workImageId === m.workImageId)
            : undefined;
        if (m.draftId && !old)
          throw new ConflictException("目标成图条目已变化");
        if (old && old.participantId !== participant.id)
          throw new ForbiddenException("不能替换他人成图");
        if (
          work.collaborationMode === "multi" &&
          m.position === "page" &&
          (!m.workImageId || assignment?.participantId !== participant.id)
        )
          throw new ForbiddenException("仅可映射本人当前负责的原稿页");
        if (m.workImageId && !allPages.some((p) => p.id === m.workImageId))
          throw new BadRequestException("原稿页不属于当前作品");
        if (old && old.workImageId !== (m.workImageId ?? null))
          throw new ConflictException("替换不可改变原稿对应关系");
        if (
          m.position !== "page" &&
          work.collaborationMode === "multi" &&
          !old &&
          allPages.some(
            (p) =>
              !current.some((d) => d.workImageId === p.id) &&
              !pageMappings.some((pm) => pm.workImageId === p.id),
          )
        )
          throw new ConflictException("原稿页全部齐图后才可添加补充图");
        if (
          work.workflowStatus !== "pending_publish" &&
          old &&
          old.submittedRevision === old.revision
        )
          throw new ConflictException("本人已提交页须先取消提交再替换");
        const revision = (old?.revision ?? 0) + 1;
        const data = {
          fileObjectId: image.fileObjectId,
          sourceName: image.sourceName,
          width: image.width,
          height: image.height,
          revision,
          submittedRevision:
            work.workflowStatus === "pending_publish" ? revision : null,
        };
        if (old)
          await tx.workTypesetDraft.update({ where: { id: old.id }, data });
        else
          await tx.workTypesetDraft.create({
            data: {
              ...data,
              workId,
              workImageId: m.workImageId ?? null,
              participantId: participant.id,
              assignmentGeneration: assignment?.generation ?? 0,
              position: m.position,
              orderIndex:
                m.position === "page"
                  ? allPages.find((p) => p.id === m.workImageId)!.orderIndex
                  : current.length + index,
            },
          });
        if (assignment && work.collaborationMode === "multi")
          await tx.workPageAssignment.update({
            where: { id: assignment.id },
            data: {
              draftRevision: { increment: 1 },
              ...(work.workflowStatus === "pending_publish"
                ? {
                    submittedRevision: assignment.draftRevision + 1,
                    submittedGeneration: assignment.generation,
                    submittedAt: new Date(),
                  }
                : {}),
            },
          });
      }
      if ((await tx.workTypesetDraft.count({ where: { workId } })) > 100)
        throw new ConflictException("完整成图集合不能超过 100 张");
      const version =
        work.workflowStatus === "pending_publish"
          ? await aggregateTypesetTx(tx, workId, actorId, input.idempotencyKey)
          : null;
      if (work.workflowStatus === "pending_publish" && !version)
        throw new ConflictException("修订必须保留完整有效成图集合");
      await tx.work.update({
        where: { id: workId },
        data: { revision: { increment: 1 } },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: "typeset_version_uploaded",
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          detail: {
            operation: "typeset-page-save",
            inputHash,
            affectedPageNumbers: [
              ...new Set(
                input.mappings.flatMap((m) => {
                  const page = allPages.find((p) => p.id === m.workImageId);
                  return page ? [page.orderIndex + 1] : [];
                }),
              ),
            ].sort((a, b) => a - b),
            affectsSupplement: input.mappings.some(
              (m) => m.position !== "page",
            ),
            stage: "typeset",
            imageCount: input.mappings.length,
            isRevision: !!version,
            ...(version
              ? {
                  versionId: version.id,
                  versionNumber: version.versionNumber,
                  message: "成图已更新，请重新查看或下载",
                }
              : {}),
          },
        },
      });
      return { revision: work.revision + 1, versionId: version?.id ?? null };
    });
  }

  async remove(
    actorId: string,
    workId: string,
    draftId: string,
    input: TypesetMutation,
  ) {
    return this.db.$transaction(async (tx) => {
      const participant = await typesetActorTx(tx, actorId, workId);
      const { work, replay } = await lockTypesetWorkTx(tx, workId, input);
      if (replay) {
        if (
          replay.actorId !== actorId ||
          (replay.detail as { draftId?: string }).draftId !== draftId
        )
          throw new ConflictException("幂等键冲突");
        return;
      }
      const draft = await tx.workTypesetDraft.findFirstOrThrow({
        where: { id: draftId, workId, participantId: participant.id },
      });
      if (draft.workImageId && work.collaborationMode === "multi")
        throw new ConflictException("必需原稿页请通过取消提交和退领清稿");
      if (
        work.workflowStatus !== "pending_publish" &&
        draft.submittedRevision === draft.revision
      )
        throw new ConflictException("请先取消本人提交");
      await tx.workTypesetDraft.delete({ where: { id: draft.id } });
      const version = await aggregateTypesetTx(
        tx,
        workId,
        actorId,
        input.idempotencyKey,
      );
      if (work.workflowStatus === "pending_publish" && !version)
        throw new ConflictException("不能删除到缺少完整成图");
      const advanced = !!version && work.workflowStatus !== "pending_publish";
      const credits = advanced ? await currentTypesetCreditsTx(tx, workId) : [];
      await tx.work.update({
        where: { id: workId },
        data: { revision: { increment: 1 } },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: advanced ? "stage_submitted" : "typeset_version_uploaded",
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: version ? "pending_publish" : work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          detail: {
            operation: advanced
              ? "submit:typeset"
              : "typeset-supplement-delete",
            sourceOperation: "typeset-supplement-delete",
            affectedPageNumbers: [],
            affectsSupplement: true,
            isRevision: work.workflowStatus === "pending_publish",
            stage: "typeset",
            draftId,
            ...(version
              ? { versionId: version.id, typesetVersionId: version.id, credits }
              : {}),
          },
        },
      });
    });
  }
}
