import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Actor } from "../common/access.js";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { WorkSeriesService } from "../work-series/work-series.service.js";
import type {
  CandidateCompositionResultDto,
  ComposeCandidatesDto,
} from "./composition.dto.js";
import { normalizeCandidateComposition } from "./composition-intent.js";

@Injectable()
export class CandidateCompositionsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkSeriesService)
    private readonly authorization: WorkSeriesService,
  ) {}

  async result(
    actor: Actor,
    idempotencyKey: string,
  ): Promise<CandidateCompositionResultDto> {
    return this.db.$transaction(async (tx) => {
      await this.authorization.authorizeImport(tx, actor);
      const receipt = await tx.candidateCompositionReceipt.findUnique({
        where: {
          actorId_idempotencyKey: { actorId: actor.userId, idempotencyKey },
        },
      });
      if (!receipt)
        throw new NotFoundException("尚未查到成功入库回执，请保留原请求并重试");
      return receipt.result as unknown as CandidateCompositionResultDto;
    });
  }

  async compose(
    actor: Actor,
    input: ComposeCandidatesDto,
  ): Promise<CandidateCompositionResultDto> {
    const intent = normalizeCandidateComposition(input);
    return this.db.$transaction(
      async (tx) => {
        // Account/session fencing comes before every replay as well as new writes.
        await this.authorization.authorizeImport(tx, actor);
        const actorId = actor.userId;
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`candidate-composition:${actorId}:${intent.idempotencyKey}`}, 0))`;
        const existing = await tx.candidateCompositionReceipt.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId,
              idempotencyKey: intent.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.payloadHash !== intent.payloadHash)
            throw new ConflictException(
              "操作标识已用于其他入库意图，请查看原入库结果",
            );
          return existing.result as unknown as CandidateCompositionResultDto;
        }
        const ids = intent.candidates.map((item) => item.id);
        const observed = await tx.candidatePost.findMany({
          where: { id: { in: ids } },
          select: { id: true, authorId: true },
        });
        if (observed.length !== ids.length)
          throw new NotFoundException("候选不存在");
        const authorId = observed[0].authorId;
        if (observed.some((item) => item.authorId !== authorId))
          throw new ConflictException("请选择同一作者的候选");
        await tx.$queryRaw`SELECT id FROM authors WHERE id=${authorId}::uuid FOR SHARE`;
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM candidate_posts WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
        );
        // Count all originals, not only selected pages, before materializing bodies.
        if (
          (await tx.candidateMedia.count({
            where: { candidatePostId: { in: ids } },
          })) > 1000
        )
          throw new ConflictException("一次入库来源原图总数不能超过1000张");
        const candidates = await tx.candidatePost.findMany({
          where: { id: { in: ids } },
          include: {
            author: true,
            media: { orderBy: [{ orderIndex: "asc" }, { id: "asc" }] },
          },
        });
        const revisions = new Map(
          intent.candidates.map((item) => [item.id, item.expectedRevision]),
        );
        if (
          candidates.length !== ids.length ||
          candidates.some(
            (item) =>
              item.authorId !== authorId ||
              item.revision !== revisions.get(item.id) ||
              item.status !== "pending",
          )
        )
          throw new ConflictException("候选已更新或已处理，请刷新后重试");
        if (
          candidates.some(
            (item) =>
              item.author.deletedAt ||
              item.author.authorizationStatus !== "authorized",
          )
        )
          throw new ConflictException("作者已归档或当前授权无效，无法入库");
        if (
          await tx.workCandidateSource.count({
            where: { candidatePostId: { in: ids } },
          })
        )
          throw new ConflictException("候选已有入库作品，请刷新后重试");
        candidates.sort(
          (a, b) =>
            a.postedAt.getTime() - b.postedAt.getTime() ||
            a.id.localeCompare(b.id),
        );
        const mediaById = new Map(
          candidates.flatMap((candidate) =>
            candidate.media.map((media) => [media.id, media] as const),
          ),
        );
        const adoptedIds = intent.works.flatMap((work) => work.mediaIds);
        if (adoptedIds.some((id) => !mediaById.has(id)))
          throw new ConflictException("所选图片不属于本次来源候选");
        const contributors = new Set(
          adoptedIds.map((id) => mediaById.get(id)!.candidatePostId),
        );
        if (contributors.size !== candidates.length)
          throw new ConflictException(
            "每个来源必须至少贡献一张图片，请明确移出未采用来源",
          );
        if (
          await tx.workImage.count({
            where: { sourceCandidateMediaId: { in: adoptedIds } },
          })
        )
          throw new ConflictException("所选图片已用于其他作品");
        const fileIds = [
          ...new Set(adoptedIds.map((id) => mediaById.get(id)!.fileObjectId)),
        ].sort();
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM file_objects WHERE id IN (${Prisma.join(fileIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`,
        );
        if (
          (await tx.fileObject.count({
            where: {
              id: { in: fileIds },
              lifecycleStatus: "active",
              deletedAt: null,
            },
          })) !== fileIds.length
        )
          throw new ConflictException("所选原图当前不可用，请刷新后重试");
        const receiptId = randomUUID();
        await tx.candidateCompositionReceipt.create({
          data: {
            id: receiptId,
            actorId,
            idempotencyKey: intent.idempotencyKey,
            payloadHash: intent.payloadHash,
            result: {},
          },
        });
        const works: CandidateCompositionResultDto["works"] = [];
        for (const output of intent.works) {
          const outputSourceIds = new Set(
            output.mediaIds.map((id) => mediaById.get(id)!.candidatePostId),
          );
          const sources = candidates.filter((candidate) =>
            outputSourceIds.has(candidate.id),
          );
          const primary = sources[0];
          const work = await tx.work.create({
            data: {
              authorId,
              sourceCandidatePostId: primary.id,
              candidateCompositionId: receiptId,
              sourcePostUrl: primary.externalPostUrl,
              title: output.title,
              sourceText: primary.text,
              sourceLanguage: primary.author.sourceLanguage,
              importedById: actorId,
            },
          });
          await tx.workCandidateSource.createMany({
            data: sources.map((source, orderIndex) => ({
              workId: work.id,
              candidatePostId: source.id,
              orderIndex,
              importedRevision: source.revision,
              sourceText: source.text,
              mappingKnown: true,
            })),
          });
          await tx.workImage.createMany({
            data: output.mediaIds.map((id, orderIndex) => {
              const media = mediaById.get(id)!;
              return {
                workId: work.id,
                sourceCandidateMediaId: id,
                originalFileObjectId: media.fileObjectId,
                orderIndex,
                width: media.width,
                height: media.height,
              };
            }),
          });
          await tx.workEvent.create({
            data: {
              workId: work.id,
              actorId,
              action: "imported",
              toWorkflowStatus: work.workflowStatus,
              toReviewStatus: work.reviewStatus,
              detail: { candidatePostIds: sources.map((source) => source.id) },
            },
          });
          works.push({
            workId: work.id,
            workNumber: work.workNumber,
            title: work.title,
            imageCount: output.mediaIds.length,
            sourceCandidateIds: sources.map((source) => source.id),
          });
        }
        const result: CandidateCompositionResultDto = {
          idempotencyKey: intent.idempotencyKey,
          mode: intent.mode,
          works,
          candidates: [],
          unadoptedMediaIds: [...mediaById.keys()].filter(
            (id) => !adoptedIds.includes(id),
          ),
        };
        for (const candidate of candidates) {
          const changed = await tx.candidatePost.updateMany({
            where: {
              id: candidate.id,
              revision: candidate.revision,
              status: "pending",
              authorId,
            },
            data: {
              status: "imported",
              revision: { increment: 1 },
              reviewedById: actorId,
              reviewedAt: new Date(),
            },
          });
          if (changed.count !== 1)
            throw new ConflictException("候选已更新，请刷新后重试");
          const workIds = works
            .filter((work) => work.sourceCandidateIds.includes(candidate.id))
            .map((work) => work.workId);
          await tx.candidateActionLog.create({
            data: {
              candidatePostId: candidate.id,
              actorId,
              action: "import",
              fromStatus: "pending",
              toStatus: "imported",
              workId: workIds.length === 1 ? workIds[0] : null,
            },
          });
          result.candidates.push({
            id: candidate.id,
            revision: candidate.revision + 1,
            status: "imported",
            workIds,
          });
        }
        await tx.candidateCompositionReceipt.update({
          where: { id: receiptId },
          data: { result: result as unknown as Prisma.InputJsonValue },
        });
        return result;
      },
      { timeout: 30_000 },
    );
  }
}
