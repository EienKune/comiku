import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  Role,
  ReviewPurpose,
  ReviewCaseStatus,
  ReviewResolution,
  ReviewStatus,
  WorkEventAction,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  captureRevisionText,
  revisionTextChanged,
} from "../workflow/revision-policy.js";
import type {
  OpenReviewCaseDto,
  ResolveReviewCaseDto,
  WithdrawReviewCaseDto,
  ReviewCaseDto,
  ReviewCasePageDto,
  ReviewQueryDto,
} from "./reviews.dto.js";

const details = {
  work: { include: { author: { select: { displayName: true } } } },
  openedTypesetVersion: { select: { versionNumber: true } },
  openedBy: { select: { displayName: true } },
  resolvedBy: { select: { displayName: true } },
} as const;
type ReviewRow = Prisma.WorkReviewCaseGetPayload<{ include: typeof details }>;

@Injectable()
export class ReviewsService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async list(query: ReviewQueryDto): Promise<ReviewCasePageDto> {
    const limit = query.limit ?? 30;
    const rows = await this.db.workReviewCase.findMany({
      where: {
        status: query.status ?? ReviewCaseStatus.open,
        ...(query.discardedOnly === "true"
          ? { resolution: ReviewResolution.discard, restoredAt: null }
          : {}),
        openedFromWorkflowStatus: query.openedFromWorkflowStatus,
        openedById: query.openedById,
        work: { authorId: query.authorId, reviewStatus: query.reviewStatus },
      },
      include: details,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      items: items.map((item) => this.dto(item)),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string, actorId?: string): Promise<ReviewCaseDto> {
    const review = await this.db.workReviewCase.findUnique({
      where: { id },
      include: details,
    });
    if (!review) throw new NotFoundException("审核事项不存在");
    return this.dto(review, actorId);
  }

  async open(
    actorId: string,
    workId: string,
    input: OpenReviewCaseDto,
  ): Promise<ReviewCaseDto> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 2000)
      throw new BadRequestException("请填写 1–2000 字的审核理由");
    if (input.purpose && input.purpose !== ReviewPurpose.production_decision)
      throw new BadRequestException(
        "审核仅用于判断作品是否继续制作，内容修订已停用",
      );
    const operation = `open-review:production_decision:${reason}`;
    const reviewId = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      await this.assertActor(tx, actorId);
      const replay = await this.replay(
        tx,
        actorId,
        workId,
        input.idempotencyKey,
        WorkEventAction.review_opened,
        operation,
      );
      if (replay) return replay;
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      if (work.workflowStatus === WorkflowStatus.archived)
        throw new ConflictException("归档作品不能发起审核事项");
      if (work.reviewStatus !== ReviewStatus.normal)
        throw new ConflictException("作品已有未解决的审核事项");
      this.assertBaseline(work, input);
      const latestText = await tx.translationVersion.findFirst({
        where: { workId },
        orderBy: { versionNumber: "desc" },
        select: { id: true },
      });
      const participants = await tx.workStageParticipant.findMany({
        where: { workId, leftAt: null },
        select: {
          id: true,
          userId: true,
          stage: true,
          submittedAt: true,
          assignments: { select: { workImageId: true } },
        },
      });
      const publication = await tx.publishRecord.findFirst({
        where: { workId },
        orderBy: { publishedAt: "desc" },
        select: { id: true },
      });
      const creditAliases = await tx.workCreditAlias.findMany({
        where: { workId },
        select: { userId: true, stage: true, creditName: true },
      });
      const draftText = await captureRevisionText(tx, workId);
      const review = await tx.workReviewCase.create({
        data: {
          workId,
          purpose: ReviewPurpose.production_decision,
          openedFromWorkflowStatus: work.workflowStatus,
          openedTypesetVersionId: work.currentTypesetVersionId,
          reason,
          openedById: actorId,
          baseline: {
            workflowStatus: work.workflowStatus,
            editorEpoch: work.editorEpoch,
            publicationRecordId: publication?.id ?? null,
            translationVersionId: latestText?.id ?? null,
            typesetVersionId: work.currentTypesetVersionId,
            handoffStartedAt:
              work.typesetHandoffStartedAt?.toISOString() ?? null,
            proofreadSkippedVersionId: work.proofreadSkippedVersionId,
            draftText,
            creditAliases,
            participants: participants.map((p) => ({
              ...p,
              submittedAt: p.submittedAt?.toISOString() ?? null,
            })),
          },
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: {
          reviewStatus: ReviewStatus.needs_review,
          revision: { increment: 1 },
          editorEpoch: { increment: 1 },
        },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: WorkEventAction.review_opened,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: ReviewStatus.needs_review,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            reviewCaseId: review.id,
            reason,
            openedTypesetVersionId: work.currentTypesetVersionId,
          },
        },
      });
      return review.id;
    });
    return this.get(reviewId, actorId);
  }

  async withdraw(
    actorId: string,
    reviewId: string,
    input: WithdrawReviewCaseDto,
  ) {
    return this.decide(actorId, reviewId, input, ReviewResolution.withdrawn);
  }

  async resolve(
    actorId: string,
    reviewId: string,
    input: ResolveReviewCaseDto,
  ) {
    if (
      ![
        ReviewResolution.continue_production,
        ReviewResolution.discard,
        ReviewResolution.restore_production,
      ].includes(input.resolution as never)
    )
      throw new BadRequestException(
        "修订、返工和旧审核结论已停用，请确认继续或舍弃",
      );
    if (input.targetWorkflowStatus)
      throw new BadRequestException("内容审核不改变原阶段");
    if (input.resolution === ReviewResolution.discard && !input.confirmDiscard)
      throw new BadRequestException("舍弃作品需要再次确认");
    return this.decide(actorId, reviewId, input, input.resolution);
  }

  private async decide(
    actorId: string,
    reviewId: string,
    input: WithdrawReviewCaseDto & Partial<ResolveReviewCaseDto>,
    resolution: ReviewResolution,
  ) {
    const before = await this.db.workReviewCase.findUnique({
      where: { id: reviewId },
      select: { workId: true },
    });
    if (!before) throw new NotFoundException("审核事项不存在");
    const withdrawing = resolution === ReviewResolution.withdrawn;
    const restoring = resolution === ReviewResolution.restore_production;
    const discarding = resolution === ReviewResolution.discard;
    const action = withdrawing
      ? WorkEventAction.review_withdrawn
      : discarding
        ? WorkEventAction.archived
        : restoring
          ? WorkEventAction.restored
          : WorkEventAction.review_resumed;
    const operation = `review-decision:${reviewId}:${resolution}:${input.note?.trim() ?? ""}`;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${before.workId}::uuid FOR UPDATE`,
      );
      await this.assertActor(tx, actorId, !withdrawing);
      const review = await tx.workReviewCase.findUnique({
        where: { id: reviewId },
        include: { work: true },
      });
      if (!review) throw new NotFoundException("审核事项不存在");
      if (withdrawing && review.openedById !== actorId)
        throw new ForbiddenException("只能撤销本人发起的审核请求");
      if (
        await this.replay(
          tx,
          actorId,
          before.workId,
          input.idempotencyKey,
          action,
          operation,
        )
      )
        return;
      this.assertBaseline(review.work, input);
      if (
        restoring
          ? review.work.discardedReviewCaseId !== review.id ||
            review.resolution !== ReviewResolution.discard ||
            review.work.workflowStatus !== WorkflowStatus.archived ||
            review.restoredAt !== null
          : review.status !== ReviewCaseStatus.open
      )
        throw new ConflictException("审核事项已处理，请刷新后查看结果");
      if (!restoring && review.work.workflowStatus === WorkflowStatus.archived)
        throw new ConflictException("归档作品不能执行该决定");
      // Old approval already counts as processing; it cannot be withdrawn by its applicant.
      if (withdrawing && review.resolution !== null)
        throw new ConflictException("审核已被处理，不能撤销");
      const legacy = await tx.workReviewRevision.findUnique({
        where: { reviewCaseId: reviewId },
      });
      if (legacy?.status === "active") {
        if (await revisionTextChanged(tx, legacy))
          throw new ConflictException(
            "该历史修订已有实际变更，需保留成果并人工核对基线，不能直接恢复原状态",
          );
        await tx.workReviewRevision.update({
          where: { id: legacy.id },
          data: { status: "completed", completedAt: new Date() },
        });
        await tx.reviewRevisionParticipant.updateMany({
          where: { revisionId: legacy.id, leftAt: null, submittedAt: null },
          data: { leftAt: new Date() },
        });
      }
      if (
        restoring &&
        (await tx.workReviewCase.count({
          where: {
            workId: review.workId,
            status: "open",
            id: { not: reviewId },
          },
        }))
      )
        throw new ConflictException("作品仍有其他未解决的审核事项");
      const target = restoring
        ? review.work.archivedFromWorkflowStatus
        : discarding
          ? WorkflowStatus.archived
          : review.work.workflowStatus;
      if (!target) throw new ConflictException("缺少原制作阶段，不能恢复");
      await tx.work.update({
        where: { id: review.workId },
        data: {
          workflowStatus: target,
          reviewStatus: ReviewStatus.normal,
          ...(discarding
            ? {
                archivedFromWorkflowStatus: review.work.workflowStatus,
                discardedReviewCaseId: review.id,
              }
            : {}),
          ...(restoring
            ? { archivedFromWorkflowStatus: null, discardedReviewCaseId: null }
            : {}),
          revision: { increment: 1 },
          editorEpoch: { increment: 1 },
        },
      });
      await tx.workReviewCase.update({
        where: { id: reviewId },
        data: restoring
          ? {
              restoredAt: new Date(),
              revision: { increment: 1 },
            }
          : {
              status: ReviewCaseStatus.resolved,
              resolution,
              resolutionNote: input.note?.trim() || null,
              resolvedById: actorId,
              resolvedAt: new Date(),
              revision: { increment: 1 },
              // Preserve historic approval target for audit; ordinary requests never have one.
            },
      });
      await tx.workEvent.create({
        data: {
          workId: review.workId,
          actorId,
          action,
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: review.work.workflowStatus,
          toWorkflowStatus: target,
          fromReviewStatus: review.work.reviewStatus,
          toReviewStatus: ReviewStatus.normal,
          detail: {
            operation,
            reviewCaseId: reviewId,
            resolution,
            ...(input.note ? { note: input.note } : {}),
            ...(legacy ? { retiredRevisionId: legacy.id } : {}),
          },
        },
      });
    });
    return this.get(reviewId, actorId);
  }

  private async assertActor(
    tx: Prisma.TransactionClient,
    actorId: string,
    admin = false,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`,
    );
    const user = await tx.user.findUnique({
      where: { id: actorId },
      select: { isActive: true, mustChangePassword: true, roles: true },
    });
    if (
      !user?.isActive ||
      user.mustChangePassword ||
      !user.roles.length ||
      (admin && !user.roles.some((r) => r.role === Role.admin))
    )
      throw new ForbiddenException(
        admin ? "审核决定仅由管理员处理" : "当前账号没有操作此作品的权限",
      );
  }

  private assertBaseline(
    work: { revision: number; editorEpoch: number },
    input: { expectedRevision: number; expectedEditorEpoch?: number },
  ) {
    if (
      work.revision !== input.expectedRevision ||
      (input.expectedEditorEpoch !== undefined &&
        work.editorEpoch !== input.expectedEditorEpoch)
    )
      throw new ConflictException("作品已更新，请刷新后重试");
  }

  private async replay(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    key: string,
    action: WorkEventAction,
    operation: string,
  ) {
    const event = await tx.workEvent.findUnique({
      where: { workId_idempotencyKey: { workId, idempotencyKey: key } },
    });
    if (!event) return null;
    const detail = event.detail as {
      operation?: unknown;
      reviewCaseId?: unknown;
    };
    if (
      event.actorId !== actorId ||
      event.action !== action ||
      detail.operation !== operation ||
      typeof detail.reviewCaseId !== "string"
    )
      throw new ConflictException("幂等键已用于其他审核操作");
    return detail.reviewCaseId;
  }

  private dto(review: ReviewRow, actorId?: string): ReviewCaseDto {
    return {
      id: review.id,
      contentRevision: null,
      purpose: review.purpose,
      editorEpoch: review.work.editorEpoch,
      canWithdraw:
        review.status === ReviewCaseStatus.open &&
        review.resolution === null &&
        review.openedById === actorId,
      canRestore:
        review.status === ReviewCaseStatus.resolved &&
        review.resolution === ReviewResolution.discard &&
        review.work.workflowStatus === WorkflowStatus.archived &&
        review.work.discardedReviewCaseId === review.id &&
        !review.restoredAt,
      restoredAt: review.restoredAt?.toISOString() ?? null,
      workId: review.workId,
      workTitle: review.work.title ?? `#${review.work.workNumber} · 待定标题`,
      authorId: review.work.authorId,
      authorName: review.work.author.displayName,
      workflowStatus: review.work.workflowStatus,
      reviewStatus: review.work.reviewStatus,
      openedFromWorkflowStatus: review.openedFromWorkflowStatus,
      openedTypesetVersionId: review.openedTypesetVersionId,
      openedTypesetVersionNumber:
        review.openedTypesetVersion?.versionNumber ?? null,
      reason: review.reason,
      status: review.status,
      openedById: review.openedById,
      openedByName: review.openedBy.displayName,
      resolvedById: review.resolvedById,
      resolvedByName: review.resolvedBy?.displayName ?? null,
      resolution: review.resolution,
      targetWorkflowStatus: review.targetWorkflowStatus,
      resolutionNote: review.resolutionNote,
      workRevision: review.work.revision,
      revision: review.revision,
      createdAt: review.createdAt.toISOString(),
      resolvedAt: review.resolvedAt?.toISOString() ?? null,
    };
  }
}
