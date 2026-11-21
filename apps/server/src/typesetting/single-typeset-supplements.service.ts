import {
  lockVerifiedTypesetSession,
  verifiedTypesetImage,
  type VerifiedImageSelection,
} from "./verified-typeset-image.js";
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
import { prepareTypesetImages } from "./typeset-image-upload.js";
import {
  lockTypesetWorkTx,
  typesetActorTx,
  type TypesetMutation,
} from "./typeset-page-workflow.js";
import { TypesettingService } from "./typesetting.service.js";
import type { AddSingleTypesetSupplementDto } from "./typeset-collaboration.dto.js";

@Injectable()
export class SingleTypesetSupplementsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(TypesettingService)
    private readonly typesetting: TypesettingService,
  ) {}
  async add(
    actorId: string,
    workId: string,
    versionId: string,
    file: ManualUploadFile | undefined,
    input: AddSingleTypesetSupplementDto,
  ) {
    if (!file) throw new BadRequestException("请选择补充成品图");
    let prepared;
    try {
      prepared = prepareTypesetImages([file]).images[0]!;
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : "图片无效",
      );
    }
    await this.db.$transaction((tx) => typesetActorTx(tx, actorId, workId));
    const stored = await this.files.store({
      body: prepared.body,
      contentType: prepared.contentType,
      bucketScope: "works",
      kind: "typeset-result",
      sourceName: prepared.sourceName,
      createdById: actorId,
    });
    const digest = createHash("sha256").update(prepared.body).digest("hex");
    try {
      await this.mutate(actorId, workId, versionId, input, {
        kind: "add",
        position: input.position,
        fileObjectId: stored.id,
        sourceName: prepared.sourceName,
        width: prepared.width,
        height: prepared.height,
        digest,
      });
      return await this.typesetting.listVersions(workId);
    } finally {
      await this.files.purgeUnreferenced(stored.id).catch(() => undefined);
    }
  }
  async addVerified(
    actorId: string,
    workId: string,
    versionId: string,
    input: TypesetMutation &
      VerifiedImageSelection & { position: "start" | "end" },
  ) {
    await this.mutate(actorId, workId, versionId, input, {
      kind: "session",
      selection: {
        sessionId: input.sessionId,
        uploadImageId: input.uploadImageId,
      },
      position: input.position,
    });
    return this.typesetting.listVersions(workId);
  }
  async remove(
    actorId: string,
    workId: string,
    versionId: string,
    imageId: string,
    input: TypesetMutation,
  ) {
    await this.mutate(actorId, workId, versionId, input, {
      kind: "remove",
      imageId,
    });
    return this.typesetting.listVersions(workId);
  }
  private async mutate(
    actorId: string,
    workId: string,
    versionId: string,
    input: TypesetMutation,
    requested:
      | {
          kind: "session";
          selection: VerifiedImageSelection;
          position: "start" | "end";
        }
      | { kind: "remove"; imageId: string }
      | {
          kind: "add";
          position: "start" | "end";
          fileObjectId: string;
          sourceName: string;
          width: number;
          height: number;
          digest: string;
        },
  ) {
    const operation = `single-typeset-supplement-${requested.kind === "session" ? "add" : requested.kind}`;
    const hash = createHash("sha256")
      .update(
        JSON.stringify(
          requested.kind === "add"
            ? {
                versionId,
                position: requested.position,
                digest: requested.digest,
              }
            : requested.kind === "session"
              ? {
                  versionId,
                  position: requested.position,
                  ...requested.selection,
                }
              : { versionId, imageId: requested.imageId },
        ),
      )
      .digest("hex");
    await this.db.$transaction(async (tx) => {
      if (requested.kind === "session")
        await lockVerifiedTypesetSession(
          tx,
          actorId,
          requested.selection.sessionId,
        );
      const participant = await typesetActorTx(tx, actorId, workId);
      const { work, replay } = await lockTypesetWorkTx(tx, workId, input);
      if (replay) {
        const detail = replay.detail as {
          operation?: string;
          inputHash?: string;
        };
        if (
          replay.actorId !== actorId ||
          detail.operation !== operation ||
          detail.inputHash !== hash
        )
          throw new ConflictException("幂等键已用于不同修订");
        return;
      }
      const change =
        requested.kind === "session"
          ? {
              kind: "add" as const,
              position: requested.position,
              ...(await verifiedTypesetImage(tx, actorId, requested.selection)),
            }
          : requested;
      const responsible = await tx.workStageParticipant.findMany({
        where: { workId, stage: "typeset", leftAt: null },
        select: { id: true },
      });
      if (
        work.collaborationMode !== "single" ||
        responsible.length !== 1 ||
        responsible[0].id !== participant.id
      )
        throw new ForbiddenException("仅当前单人嵌字负责人可以修订补充图");
      if (
        work.workflowStatus !== "pending_publish" ||
        work.currentTypesetVersionId !== versionId
      )
        throw new ConflictException("当前完整版本或阶段已变化，请重新查看");
      const original = await tx.typesetImageVersion.findFirstOrThrow({
        where: { id: versionId, workId, deletedAt: null },
        include: {
          images: {
            orderBy: { orderIndex: "asc" },
            include: { fileObject: true },
          },
        },
      });
      if (
        original.images.some(
          (i) =>
            i.fileObject.lifecycleStatus !== "active" || i.fileObject.deletedAt,
        )
      )
        throw new ConflictException("当前成图文件不可用");
      const images = original.images.map((i) => ({
        fileObjectId: i.fileObjectId,
        workImageId: i.workImageId,
        sourceName: i.sourceName,
        width: i.width,
        height: i.height,
        supplementId: i.supplementId,
        supplementPosition: i.supplementPosition,
      }));
      let supplementId: string;
      if (change.kind === "remove") {
        const index = original.images.findIndex((i) => i.id === change.imageId);
        const target = original.images[index];
        if (!target?.supplementId)
          throw new ConflictException(
            "该条目不是明确添加的补充图，不能按补充图删除",
          );
        supplementId = target.supplementId;
        images.splice(index, 1);
        if (!images.length)
          throw new ConflictException("完整成图至少保留一张，不能删除到零张");
      } else {
        const file = await tx.fileObject.findFirst({
          where: {
            id: change.fileObjectId,
            lifecycleStatus: "active",
            deletedAt: null,
          },
        });
        if (!file) throw new ConflictException("新补充图文件不可用");
        if (
          images.length >= 100 ||
          original.images.reduce((n, i) => n + Number(i.fileObject.size), 0) +
            Number(file.size) >
            250 * 1024 * 1024
        )
          throw new ConflictException("完整成图不能超过100张或250MiB");
        supplementId = randomUUID();
        const image = {
          fileObjectId: file.id,
          workImageId: null,
          sourceName: change.sourceName,
          width: change.width,
          height: change.height,
          supplementId,
          supplementPosition: change.position,
        };
        let index = images.length;
        if (change.position === "start") {
          index = 0;
          while (images[index]?.supplementPosition === "start") index++;
        }
        images.splice(index, 0, image);
      }
      const latest = await tx.typesetImageVersion.aggregate({
        where: { workId },
        _max: { versionNumber: true },
      });
      const version = await tx.typesetImageVersion.create({
        data: {
          workId,
          uploadedById: actorId,
          idempotencyKey: input.idempotencyKey,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          sourceTranslationVersionId: original.sourceTranslationVersionId,
          reviewedTranslationVersionId: original.reviewedTranslationVersionId,
          textReviewedAt: original.textReviewedAt,
          images: {
            create: images.map((i, orderIndex) => ({ ...i, orderIndex })),
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
            operation,
            inputHash: hash,
            previousVersionId: versionId,
            versionId: version.id,
            versionNumber: version.versionNumber,
            supplementId,
            imageCount: images.length,
            affectedPageNumbers: [],
            affectsSupplement: true,
            isRevision: true,
          },
        },
      });
    });
  }
}
