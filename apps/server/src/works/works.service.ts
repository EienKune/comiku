import { assertCurrentHandoff } from "../workflow/revision-policy.js";
import { assertProductionWritable } from "../workflow/review-policy.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  ReviewCaseStatus,
  ReviewResolution,
  ReviewStatus,
  Role,
  WorkCollaborationMode,
  WorkEventAction,
  type WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { TranslationsService } from "../translations/translations.service.js";
import {
  canSubmitWorkStage,
  canUserWorkStage,
  claimableWorkStatuses,
  isCoordinatedWorkStage,
  stageTransitions,
} from "../workflow/workflow-policy.js";
import type {
  CancelWorkStageSubmissionDto,
  ClaimWorkStagesDto,
  CompleteStageContributionDto,
  JoinWorkStageDto,
  LeaveWorkStageDto,
  SubmitWorkStageDto,
  SkipProofreadingDto,
  UpdateStageCreditDto,
  UpdateStageAssignmentsDto,
  UpdateWorkCollaborationDto,
  UpdateWorkDto,
  WorkDetailDto,
  WorkClaimBatchResultDto,
  WorkDto,
  WorkMutationDto,
  WorkPageDto,
  WorkQueryDto,
  PersonalWorkTaskDto,
} from "./works.dto.js";
import { WorkClaimOutcome, WorkPhase, WorkView } from "./works.dto.js";
import { proofreadSkipAvailability } from "../workflow/proofread-exemption.js";
import {
  currentStageStatuses,
  personalStageScopes,
  personalTodoWhere,
  personalRecommendationWhere,
  type WorkActor,
} from "./personal-work-policy.js";

const workPhaseStatuses: Record<WorkPhase, WorkflowStatus[]> = {
  [WorkPhase.translation]: [
    WorkflowStatus.pending_translate,
    WorkflowStatus.translating,
  ],
  [WorkPhase.proofread]: [
    WorkflowStatus.pending_proofread,
    WorkflowStatus.proofreading,
  ],
  [WorkPhase.typeset]: [
    WorkflowStatus.pending_typeset,
    WorkflowStatus.typesetting,
  ],
  [WorkPhase.pending_publish]: [WorkflowStatus.pending_publish],
  [WorkPhase.published]: [WorkflowStatus.published],
};

const workPhaseStages: Partial<Record<WorkPhase, WorkStage>> = {
  [WorkPhase.translation]: "translate",
  [WorkPhase.proofread]: "proofread",
  [WorkPhase.typeset]: "typeset",
};

function exceptionMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === "string") return response;
  if (response && typeof response === "object" && "message" in response) {
    const message = response.message;
    return Array.isArray(message) ? message.join("；") : String(message);
  }
  return error.message;
}

const listDetails = {
  proofreadSkippedVersion: { select: { handoffStartedAt: true } },
  author: { select: { displayName: true } },
  images: {
    select: { id: true },
    orderBy: { orderIndex: "asc" },
    take: 1,
  },
  stageParticipants: {
    where: { leftAt: null },
    select: { stage: true },
  },
  _count: { select: { images: true, stageParticipants: true } },
} as const;
const fullDetails = {
  ...listDetails,
  images: { orderBy: { orderIndex: "asc" } },
  stageParticipants: {
    include: {
      user: { select: { displayName: true, avatarFileObjectId: true } },
      assignments: { select: { workImageId: true } },
      contributionSubmissions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { pages: true },
      },
    },
    orderBy: { joinedAt: "asc" },
  },
  creditAliases: true,
  events: {
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  },
  reviewCases: {
    where: { status: "open" },
    select: { id: true },
    take: 1,
  },
} as const;
type WorkListRow = Prisma.WorkGetPayload<{ include: typeof listDetails }>;
type WorkFullRow = Prisma.WorkGetPayload<{ include: typeof fullDetails }>;

const personalDetails = {
  ...listDetails,
  images: {
    select: { id: true, translationRevision: true },
    orderBy: { orderIndex: "asc" },
  },
  stageParticipants: {
    where: { leftAt: null },
    select: {
      stage: true,
      userId: true,
      submittedAt: true,
      assignments: { select: { workImageId: true } },
      contributionSubmissions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { pages: true },
      },
    },
  },
} as const;

@Injectable()
export class WorksService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(TranslationsService)
    private readonly translations: TranslationsService,
  ) {}

  async list(actorId: string, query: WorkQueryDto): Promise<WorkPageDto> {
    if (query.claimStage && query.view !== WorkView.recommended)
      throw new BadRequestException("可接职责只能用于推荐接取视角");
    const limit = query.limit ?? 24;
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: {
        isActive: true,
        roles: { select: { role: true } },
        languageCapabilities: { select: { language: true } },
      },
    });
    const actor: WorkActor = {
      id: actorId,
      roles: user?.isActive ? user.roles.map(({ role }) => role) : [],
      languageCapabilities: user?.isActive
        ? user.languageCapabilities.map(({ language }) => language)
        : [],
    };
    const numericSearch = query.search?.match(/^#?(\d+)$/)?.[1];
    const base: Prisma.WorkWhereInput = {
      ...(query.unassignedStage === "proofread"
        ? { proofreadSkippedVersionId: null }
        : {}),
      sourceLanguage: query.sourceLanguage,
      workflowStatus:
        query.workflowStatus === WorkflowStatus.archived
          ? WorkflowStatus.archived
          : { not: WorkflowStatus.archived },
      reviewStatus: query.reviewStatus,
      authorId: query.authorId,
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: "insensitive" } },
              {
                author: {
                  displayName: { contains: query.search, mode: "insensitive" },
                },
              },
              ...(numericSearch ? [{ workNumber: Number(numericSearch) }] : []),
            ],
          }
        : {}),
      ...(query.unassignedStage
        ? {
            AND: [
              {
                OR: [
                  {
                    workflowStatus: {
                      in: currentStageStatuses(query.unassignedStage),
                    },
                    stageParticipants: {
                      none: {
                        stage: query.unassignedStage,
                        submittedAt: null,
                        leftAt: null,
                      },
                    },
                  },
                  {
                    workflowStatus: {
                      notIn: currentStageStatuses(query.unassignedStage),
                    },
                    stageParticipants: {
                      none: { stage: query.unassignedStage, leftAt: null },
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    };
    const todoScope: Prisma.WorkWhereInput = {
      AND: [base, personalTodoWhere(actor)],
    };
    const statisticsScope: Prisma.WorkWhereInput = {
      AND: [
        base,
        ...(query.mine && query.view !== WorkView.todo
          ? [{ stageParticipants: { some: { userId: actorId, leftAt: null } } }]
          : []),
      ],
    };
    const publishScope: Prisma.WorkWhereInput = {
      AND: [
        statisticsScope,
        {
          ...(actor.roles.some(
            (role) => role === Role.operator || role === Role.admin,
          )
            ? {}
            : { id: { in: [] } }),
          workflowStatus: WorkflowStatus.pending_publish,
          reviewStatus: ReviewStatus.normal,
        },
      ],
    };
    const scope: Prisma.WorkWhereInput = {
      AND: [
        statisticsScope,
        ...(query.view === WorkView.todo
          ? [personalTodoWhere(actor)]
          : query.view === WorkView.recommended
            ? [personalRecommendationWhere(actor, false, query.claimStage)]
            : query.view === WorkView.publish
              ? [publishScope]
              : []),
        ...(query.workflowStatus
          ? [{ workflowStatus: query.workflowStatus }]
          : query.phase
            ? [{ workflowStatus: { in: workPhaseStatuses[query.phase] } }]
            : []),
      ],
    };
    const [todoTotal, total, phaseCounts, claimCounts, publishTotal] =
      await Promise.all([
        this.db.work.count({ where: todoScope }),
        this.db.work.count({ where: scope }),
        Promise.all(
          Object.values(WorkPhase).map(async (phase) => ({
            phase,
            count: await this.db.work.count({
              where: {
                AND: [
                  statisticsScope,
                  { workflowStatus: { in: workPhaseStatuses[phase] } },
                ],
              },
            }),
          })),
        ),
        Promise.all(
          personalStageScopes(actor).map(async ({ stage }) => ({
            stage,
            count: await this.db.work.count({
              where: {
                AND: [
                  statisticsScope,
                  personalRecommendationWhere(actor, false, stage),
                ],
              },
            }),
          })),
        ),
        this.db.work.count({ where: publishScope }),
      ]);
    const sortStage =
      query.unassignedStage ??
      (query.phase ? workPhaseStages[query.phase] : undefined);
    const priorityScope: Prisma.WorkWhereInput | undefined =
      query.view === WorkView.recommended
        ? personalRecommendationWhere(actor, true, query.claimStage)
        : query.view !== WorkView.todo && sortStage
          ? {
              stageParticipants: {
                none: { stage: sortStage, submittedAt: null, leftAt: null },
              },
            }
          : undefined;
    const groups = priorityScope
      ? [priorityScope, { NOT: priorityScope }]
      : [{}];
    const cursor = query.cursor
      ? await this.db.work.findFirst({
          where: { AND: [scope, { id: query.cursor }] },
          select: { id: true, workNumber: true },
        })
      : null;
    if (query.cursor && !cursor)
      throw new ConflictException("列表已变化，请重新加载第一页");
    let firstGroup = 0;
    if (
      cursor &&
      priorityScope &&
      !(await this.db.work.count({
        where: { AND: [scope, priorityScope, { id: cursor.id }] },
      }))
    )
      firstGroup = 1;
    const rows: Prisma.WorkGetPayload<{ include: typeof personalDetails }>[] =
      [];
    for (
      let index = firstGroup;
      index < groups.length && rows.length < limit + 1;
      index++
    ) {
      rows.push(
        ...(await this.db.work.findMany({
          where: {
            AND: [
              scope,
              groups[index],
              ...(cursor && index === firstGroup
                ? [{ workNumber: { lt: cursor.workNumber } }]
                : []),
            ],
          },
          orderBy: { workNumber: "desc" },
          take: limit + 1 - rows.length,
          include: personalDetails,
        })),
      );
    }
    const items = rows.slice(0, limit).map((work) => {
      const dto = this.listDto(work);
      if (query.view === WorkView.todo || query.view === WorkView.recommended) {
        dto.personalTasks = personalStageScopes(actor)
          .filter(
            ({ stage }) => !query.claimStage || query.claimStage === stage,
          )
          .flatMap<PersonalWorkTaskDto>(({ stage, sourceLanguage }) => {
            if (stage === "proofread" && work.proofreadSkippedVersionId)
              return [];
            if (!sourceLanguage.in.includes(work.sourceLanguage)) return [];
            const readyToStart = currentStageStatuses(stage).includes(
              work.workflowStatus,
            );
            const participant = work.stageParticipants.find(
              (item) =>
                item.userId === actorId &&
                item.stage === stage &&
                item.submittedAt === null,
            );
            if (query.view === WorkView.todo) {
              if (!participant || !readyToStart) return [];
              const latest = participant.contributionSubmissions[0];
              return [
                {
                  stage,
                  readyToStart,
                  contributionCurrent: Boolean(
                    work.collaborationMode === WorkCollaborationMode.multi &&
                    latest &&
                    participant.assignments.length &&
                    participant.assignments.every(({ workImageId }) =>
                      latest.pages.some(
                        (page) =>
                          page.workImageId === workImageId &&
                          page.imageRevision ===
                            work.images.find(({ id }) => id === workImageId)
                              ?.translationRevision,
                      ),
                    ),
                  ),
                },
              ];
            }
            const opposite =
              stage === "translate"
                ? "proofread"
                : stage === "proofread"
                  ? "translate"
                  : null;
            if (
              !claimableWorkStatuses(stage).includes(work.workflowStatus) ||
              work.stageParticipants.some(
                (item) =>
                  item.stage === stage &&
                  (item.submittedAt === null || item.userId === actorId),
              ) ||
              (work.collaborationMode === WorkCollaborationMode.single &&
                opposite &&
                work.stageParticipants.some(
                  (item) => item.stage === opposite && item.userId === actorId,
                ))
            )
              return [];
            return [{ stage, readyToStart, contributionCurrent: false }];
          });
      }
      return dto;
    });
    return {
      items,
      claimCounts,
      publishTotal,
      todoTotal,
      total,
      phaseCounts,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }
  async claimStages(
    actorId: string,
    input: ClaimWorkStagesDto,
  ): Promise<WorkClaimBatchResultDto> {
    const results: WorkClaimBatchResultDto["results"] = [];
    for (const item of input.items) {
      try {
        await this.claimStage(actorId, item.id, {
          stage: input.stage,
          expectedRevision: item.expectedRevision,
          idempotencyKey: item.idempotencyKey,
        });
        results.push({
          id: item.id,
          outcome: WorkClaimOutcome.succeeded,
          message: null,
        });
      } catch (error) {
        const outcome =
          error instanceof NotFoundException
            ? WorkClaimOutcome.not_found
            : error instanceof ForbiddenException
              ? WorkClaimOutcome.forbidden
              : error instanceof ConflictException
                ? WorkClaimOutcome.conflict
                : WorkClaimOutcome.failed;
        results.push({
          id: item.id,
          outcome,
          message:
            error instanceof HttpException
              ? exceptionMessage(error)
              : "认领失败，请稍后重试",
        });
      }
    }
    return { results };
  }

  async get(id: string, actorId?: string): Promise<WorkDetailDto> {
    const work = await this.db.work.findUnique({
      where: { id },
      include: fullDetails,
    });
    if (!work) throw new NotFoundException("作品不存在");
    const capability = actorId
      ? await proofreadSkipAvailability(this.db, actorId, id)
      : { canSkipProofreading: false, skipProofreadingUnavailableReason: null };
    return {
      ...this.detailDto(work),
      canSkipProofreading: capability.canSkipProofreading,
      skipProofreadingUnavailableReason:
        capability.skipProofreadingUnavailableReason,
    };
  }

  async imageUrl(
    workId: string,
    imageId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    const image = await this.db.workImage.findFirst({
      where: { id: imageId, workId },
    });
    if (!image) throw new NotFoundException("作品图片不存在");
    return this.files.imageUrl(image.originalFileObjectId, variant);
  }

  async update(
    actorId: string,
    workId: string,
    input: UpdateWorkDto,
  ): Promise<WorkDetailDto> {
    if (
      input.title === undefined &&
      input.priority === undefined &&
      input.publicationBody === undefined
    ) {
      throw new BadRequestException("至少提供一项要修改的作品信息");
    }
    const operation = `metadata:${input.title ?? ""}:${input.priority ?? ""}${
      input.publicationBody !== undefined
        ? `:body:${JSON.stringify(input.publicationBody)}`
        : ""
    }`;
    if (
      await this.isReplay(
        workId,
        input.idempotencyKey,
        WorkEventAction.metadata_updated,
        operation,
      )
    ) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          WorkEventAction.metadata_updated,
          operation,
        )
      )
        return;
      const current = await tx.work.findUnique({ where: { id: workId } });
      if (!current) throw new NotFoundException("作品不存在");
      assertProductionWritable(current);
      if (current.workflowStatus === WorkflowStatus.archived)
        throw new ConflictException("归档作品不能修改");
      if (
        input.publicationBody !== undefined &&
        current.workflowStatus === WorkflowStatus.published
      ) {
        throw new ConflictException("已发布作品的正文已冻结，不能修改");
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: {
          title: input.title,
          priority: input.priority,
          publicationBody: input.publicationBody,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) this.stale();
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: WorkEventAction.metadata_updated,
          fromWorkflowStatus: current.workflowStatus,
          toWorkflowStatus: current.workflowStatus,
          fromReviewStatus: current.reviewStatus,
          toReviewStatus: current.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.publicationBody !== undefined
              ? { publicationBody: input.publicationBody }
              : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async updateCollaboration(
    actorId: string,
    workId: string,
    input: UpdateWorkCollaborationDto,
  ): Promise<WorkDetailDto> {
    const action = WorkEventAction.collaboration_mode_updated;
    const operation = `collaboration:${input.collaborationMode}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (work.workflowStatus === WorkflowStatus.archived) {
        throw new ConflictException("归档作品不能修改协作模式");
      }
      if (input.collaborationMode === WorkCollaborationMode.single) {
        const active = await tx.workStageParticipant.findMany({
          where: { workId, submittedAt: null, leftAt: null },
          select: { stage: true, userId: true },
        });
        for (const stage of ["translate", "proofread", "typeset"] as const) {
          if (
            active.filter((participant) => participant.stage === stage).length >
            1
          ) {
            throw new ConflictException("请先将每个阶段整理为至多一名参与者");
          }
        }
        const preserved = await tx.workStageParticipant.findMany({
          where: {
            workId,
            stage: { in: ["translate", "proofread"] },
            leftAt: null,
          },
          select: { stage: true, userId: true },
        });
        const translated = new Set(
          preserved
            .filter(({ stage }) => stage === "translate")
            .map(({ userId }) => userId),
        );
        if (
          preserved.some(
            ({ stage, userId }) =>
              stage === "proofread" && translated.has(userId),
          )
        ) {
          throw new ConflictException(
            "当前参与历史包含同一用户翻译并校对，不能切换为单人模式",
          );
        }
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: {
          collaborationMode: input.collaborationMode,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) this.stale();
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            from: work.collaborationMode,
            to: input.collaborationMode,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async joinStage(
    actorId: string,
    workId: string,
    input: JoinWorkStageDto,
  ): Promise<WorkDetailDto> {
    this.assertCoordinatedStage(input.stage);
    await this.assertStagePermission(actorId, input.stage, workId);
    const transition = stageTransitions[input.stage];
    const operation = `join:${input.stage}:${input.creditName ?? ""}`;
    if (
      await this.isReplay(
        workId,
        input.idempotencyKey,
        WorkEventAction.stage_joined,
        operation,
      )
    )
      return this.get(workId, actorId);

    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          WorkEventAction.stage_joined,
          operation,
        )
      )
        return;
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (
        ![transition.pending, transition.active].includes(work.workflowStatus)
      )
        throw new ConflictException("作品当前阶段不允许加入此项工作");
      if (input.stage === "proofread" && work.proofreadSkippedVersionId)
        throw new ConflictException("本轮已跳过校对");
      const existing = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          userId: actorId,
          submittedAt: null,
          leftAt: null,
        },
      });
      if (existing) return;
      const activeCount = await tx.workStageParticipant.count({
        where: {
          workId,
          stage: input.stage,
          submittedAt: null,
          leftAt: null,
        },
      });
      if (
        work.collaborationMode === WorkCollaborationMode.single &&
        activeCount &&
        !existing
      ) {
        throw new ConflictException("单人模式下该职责已有参与者，只能查看");
      }
      await this.assertSingleStageSeparation(
        tx,
        work.collaborationMode,
        workId,
        actorId,
        input.stage,
      );
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) this.stale();
      if (!existing) {
        await tx.workStageParticipant.create({
          data: {
            workId,
            stage: input.stage,
            userId: actorId,
            participationMode: activeCount ? "collaborator" : "owner",
          },
        });
      }
      if (input.creditName) {
        await tx.workCreditAlias.upsert({
          where: {
            workId_userId_stage: {
              workId,
              userId: actorId,
              stage: input.stage,
            },
          },
          create: {
            workId,
            userId: actorId,
            stage: input.stage,
            creditName: input.creditName,
          },
          update: { creditName: input.creditName },
        });
      }
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: WorkEventAction.stage_joined,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            participationRegistered: true,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async claimStage(
    actorId: string,
    workId: string,
    input: JoinWorkStageDto,
  ): Promise<WorkDetailDto> {
    this.assertCoordinatedStage(input.stage);
    await this.assertStagePermission(actorId, input.stage, workId);
    return this.reserveStage(
      actorId,
      actorId,
      workId,
      input,
      WorkEventAction.stage_joined,
      "claim",
    );
  }

  async updateStageCredit(
    actorId: string,
    workId: string,
    input: UpdateStageCreditDto,
  ): Promise<WorkDetailDto> {
    this.assertCoordinatedStage(input.stage);
    await this.assertStagePermission(actorId, input.stage, workId);
    const action = WorkEventAction.stage_credit_updated;
    const creditName = input.creditName?.trim() || null;
    const operation = `stage-credit:${input.stage}:${creditName ?? "display-name"}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (
        work.workflowStatus === WorkflowStatus.archived ||
        work.workflowStatus === WorkflowStatus.published
      ) {
        throw new ConflictException("作品发布或归档后不能修改临时署名");
      }
      const participant = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          userId: actorId,
          leftAt: null,
        },
      });
      if (!participant) {
        throw new ConflictException("只有当前阶段的参与者可以设置作品临时署名");
      }
      const previous = await tx.workCreditAlias.findUnique({
        where: {
          workId_userId_stage: { workId, userId: actorId, stage: input.stage },
        },
      });
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) this.stale();
      if (creditName) {
        await tx.workCreditAlias.upsert({
          where: {
            workId_userId_stage: {
              workId,
              userId: actorId,
              stage: input.stage,
            },
          },
          create: { workId, userId: actorId, stage: input.stage, creditName },
          update: { creditName },
        });
      } else {
        await tx.workCreditAlias.deleteMany({
          where: { workId, userId: actorId, stage: input.stage },
        });
      }
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            previousCreditName: previous?.creditName ?? null,
            creditName,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async leaveStage(
    actorId: string,
    workId: string,
    input: LeaveWorkStageDto,
  ): Promise<WorkDetailDto> {
    this.assertCoordinatedStage(input.stage);
    const action = WorkEventAction.stage_left;
    const operation = `leave:${input.stage}:${actorId}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    const transition = stageTransitions[input.stage];
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (work.workflowStatus === WorkflowStatus.archived) {
        throw new ConflictException("归档作品不能取消职责");
      }
      const participant = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          userId: actorId,
          submittedAt: null,
          leftAt: null,
        },
      });
      if (!participant) {
        throw new ConflictException("当前没有可取消的职责");
      }
      const remaining = await tx.workStageParticipant.findMany({
        where: {
          workId,
          stage: input.stage,
          submittedAt: null,
          leftAt: null,
          id: { not: participant.id },
        },
        orderBy: { joinedAt: "asc" },
      });
      const nextWorkflowStatus =
        work.workflowStatus === transition.active && !remaining.length
          ? transition.pending
          : work.workflowStatus;
      const resetsTextDraft =
        work.workflowStatus === transition.active &&
        !remaining.length &&
        (input.stage === "translate" || input.stage === "proofread");
      const resetsTypesetHandoff =
        input.stage === "typeset" &&
        !remaining.length &&
        (work.workflowStatus === transition.active ||
          work.workflowStatus === transition.pending);
      if (resetsTextDraft) {
        await this.translations.resetDraftForStage(
          tx,
          actorId,
          workId,
          input.stage,
        );
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: {
          workflowStatus: nextWorkflowStatus,
          revision: { increment: 1 },
          ...(resetsTextDraft ? { editorEpoch: { increment: 1 } } : {}),
          ...(resetsTextDraft && input.stage === "translate"
            ? { translationContributorIds: [], proofreadSkippedVersionId: null }
            : {}),
          ...(resetsTypesetHandoff ? { typesetHandoffStartedAt: null } : {}),
        },
      });
      if (!changed.count) this.stale();
      await tx.workStageParticipant.update({
        where: { id: participant.id },
        data: { leftAt: new Date() },
      });
      await tx.workCreditAlias.deleteMany({
        where: { workId, userId: actorId, stage: input.stage },
      });
      if (
        participant.participationMode === "owner" &&
        remaining.length &&
        remaining[0].participationMode !== "owner"
      ) {
        await tx.workStageParticipant.update({
          where: { id: remaining[0].id },
          data: { participationMode: "owner" },
        });
      }
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: nextWorkflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            participationMode: participant.participationMode,
            draftReset: resetsTextDraft,
            typesetHandoffReset: resetsTypesetHandoff,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  private async reserveStage(
    actorId: string,
    targetUserId: string,
    workId: string,
    input: JoinWorkStageDto,
    action: WorkEventAction,
    actionName: "claim" | "assign",
  ): Promise<WorkDetailDto> {
    const operation = `${actionName}:${input.stage}:${targetUserId}:${input.creditName ?? ""}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (!claimableWorkStatuses(input.stage).includes(work.workflowStatus)) {
        throw new ConflictException("只能认领当前或尚未开始的后续职责");
      }
      if (input.stage === "proofread" && work.proofreadSkippedVersionId)
        throw new ConflictException("本轮已跳过校对");
      if (work.reviewStatus !== ReviewStatus.normal) {
        throw new ConflictException("请先处理作品审核，再认领职责");
      }
      const existing = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          submittedAt: null,
          leftAt: null,
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(
          "该职责已有负责人；需要多人处理时请加入协作",
        );
      }
      await this.assertSingleStageSeparation(
        tx,
        work.collaborationMode,
        workId,
        targetUserId,
        input.stage,
      );
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) this.stale();
      await tx.workStageParticipant.create({
        data: {
          workId,
          stage: input.stage,
          userId: targetUserId,
          participationMode: "owner",
        },
      });
      if (input.creditName) {
        await tx.workCreditAlias.upsert({
          where: {
            workId_userId_stage: {
              workId,
              userId: targetUserId,
              stage: input.stage,
            },
          },
          create: {
            workId,
            userId: targetUserId,
            stage: input.stage,
            creditName: input.creditName,
          },
          update: { creditName: input.creditName },
        });
      }
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            userId: targetUserId,
            participationRegistered: true,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async updateStageAssignments(
    actorId: string,
    workId: string,
    input: UpdateStageAssignmentsDto,
  ): Promise<WorkDetailDto> {
    if (input.stage !== "translate" && input.stage !== "proofread") {
      throw new BadRequestException("当前只支持翻译和校对的页码分工");
    }
    const operation = `stage-assignment:${input.stage}:${input.participantId ?? actorId}:${[...input.imageIds].sort().join(",")}`;
    const action = WorkEventAction.stage_assignment_updated;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (work.collaborationMode !== WorkCollaborationMode.multi) {
        throw new ConflictException("单人模式不需要设置页码分工");
      }
      const participant = input.participantId
        ? await tx.workStageParticipant.findFirst({
            where: {
              id: input.participantId,
              workId,
              stage: input.stage,
              submittedAt: null,
              leftAt: null,
            },
          })
        : await tx.workStageParticipant.findFirst({
            where: {
              workId,
              userId: actorId,
              stage: input.stage,
              submittedAt: null,
              leftAt: null,
            },
          });
      if (!participant)
        throw new ConflictException("没有可分配页面的活跃参与者");
      if (participant.userId !== actorId) await this.assertAdmin(tx, actorId);
      const imageCount = await tx.workImage.count({
        where: { workId, id: { in: input.imageIds } },
      });
      if (imageCount !== input.imageIds.length) {
        throw new BadRequestException("页码分工包含不属于该作品的图片");
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) this.stale();
      await tx.workStageAssignment.deleteMany({
        where: { participantId: participant.id },
      });
      if (input.imageIds.length) {
        await tx.workStageAssignment.createMany({
          data: input.imageIds.map((workImageId) => ({
            participantId: participant.id,
            workImageId,
            assignedById: actorId,
          })),
        });
      }
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            participantId: participant.id,
            userId: participant.userId,
            imageIds: input.imageIds,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async completeStageContribution(
    actorId: string,
    workId: string,
    input: CompleteStageContributionDto,
  ): Promise<WorkDetailDto> {
    const action = WorkEventAction.stage_contribution_completed;
    const operation = `stage-contribution:${input.stage}:${actorId}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (work.collaborationMode !== WorkCollaborationMode.multi) {
        throw new ConflictException("单人模式直接提交完整阶段");
      }
      if (!canSubmitWorkStage(input.stage, work.workflowStatus)) {
        throw new ConflictException("当前不是可完成分工的活动阶段");
      }
      if (work.reviewStatus !== ReviewStatus.normal) {
        throw new ConflictException("作品存在未解决的审核事项");
      }
      if (
        work.revision !== input.expectedRevision ||
        work.editorEpoch !== input.expectedEditorEpoch
      ) {
        this.stale();
      }
      const participant = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          userId: actorId,
          stage: input.stage,
          submittedAt: null,
          leftAt: null,
        },
        include: { assignments: true },
      });
      if (!participant) throw new ForbiddenException("需要先加入当前阶段");
      if (!participant.assignments.length) {
        throw new ConflictException("请先选择本人负责的页码");
      }
      const images = await tx.workImage.findMany({
        where: {
          workId,
          id: {
            in: participant.assignments.map(({ workImageId }) => workImageId),
          },
        },
        select: { id: true, translationRevision: true },
      });
      const submission = await tx.stageContributionSubmission.create({
        data: {
          participantId: participant.id,
          createdById: actorId,
          idempotencyKey: input.idempotencyKey,
          pages: {
            create: images.map((image) => ({
              workImageId: image.id,
              imageRevision: image.translationRevision,
            })),
          },
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: { revision: { increment: 1 } },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            participantId: participant.id,
            submissionId: submission.id,
            imageIds: images.map(({ id }) => id),
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async submitStage(
    actorId: string,
    workId: string,
    input: SubmitWorkStageDto,
  ): Promise<WorkDetailDto> {
    await this.assertStagePermission(actorId, input.stage, workId);
    if (input.stage === "publish")
      throw new ConflictException("发布记录模块接入后才能确认发布");
    const operation = `submit:${input.stage}`;
    if (
      await this.isReplay(
        workId,
        input.idempotencyKey,
        WorkEventAction.stage_submitted,
        operation,
      )
    )
      return this.get(workId, actorId);

    await this.db.$transaction((tx) =>
      this.submitStageTx(tx, actorId, workId, input),
    );
    return this.get(workId, actorId);
  }

  // Shared transaction entry for explicit submissions and atomic batch upload/submit.
  async submitStageTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    input: SubmitWorkStageDto,
  ): Promise<void> {
    await this.assertStagePermission(actorId, input.stage, workId, tx);
    if (input.stage === "publish")
      throw new ConflictException("发布记录模块接入后才能确认发布");
    const transition = stageTransitions[input.stage];
    const operation = `submit:${input.stage}`;
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
    );
    if (
      await this.isReplayTx(
        tx,
        workId,
        input.idempotencyKey,
        WorkEventAction.stage_submitted,
        operation,
      )
    )
      return;
    const work = await tx.work.findUnique({
      where: { id: workId },
      include: {
        currentTypesetVersion: {
          include: { _count: { select: { images: true } } },
        },
        reviewCases: {
          where: {
            status: ReviewCaseStatus.resolved,
            resolution: ReviewResolution.revise,
            openedTypesetVersionId: { not: null },
          },
          orderBy: [{ resolvedAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          include: {
            openedTypesetVersion: { select: { versionNumber: true } },
          },
        },
        _count: { select: { images: true } },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    assertProductionWritable(work);
    if (!canSubmitWorkStage(input.stage, work.workflowStatus))
      throw new ConflictException("作品当前阶段不允许提交");
    if (work.reviewStatus !== ReviewStatus.normal)
      throw new ConflictException("作品存在未解决的审核事项");
    if (work.editorEpoch !== input.expectedEditorEpoch)
      throw new ConflictException(
        "作品已产生新的正式版本，请刷新后重新确认提交内容",
      );
    if (
      input.stage === "typeset" &&
      (!work.currentTypesetVersion ||
        work.currentTypesetVersion.deletedAt ||
        work.currentTypesetVersion._count.images < 1)
    ) {
      throw new ConflictException("请先选择一份至少包含一张图片的有效成图版本");
    }
    if (input.stage === "typeset") {
      await assertCurrentHandoff(tx, work);
      if (
        work.requiredHandoffVersionId &&
        work.currentTypesetVersion?.reviewedTranslationVersionId !==
          work.requiredHandoffVersionId
      )
        throw new ConflictException(
          "当前成图尚未对最新文本复核，不能提交或发布",
        );
    }
    const latestTypesetRework = work.reviewCases[0];
    if (
      input.stage === "typeset" &&
      latestTypesetRework?.openedTypesetVersion &&
      work.currentTypesetVersion!.versionNumber <=
        latestTypesetRework.openedTypesetVersion.versionNumber
    ) {
      throw new ConflictException(
        `审核返工后需上传比 v${latestTypesetRework.openedTypesetVersion.versionNumber} 更新的成图版本`,
      );
    }
    const active = await tx.workStageParticipant.findMany({
      where: {
        workId,
        stage: input.stage,
        submittedAt: null,
        leftAt: null,
      },
      include: {
        user: {
          select: { displayName: true },
        },
        assignments: true,
        contributionSubmissions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { pages: true },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
    if (!active.length) {
      throw new ConflictException("当前阶段没有活动参与者，不能提交");
    }
    if (!active.some((participant) => participant.userId === actorId))
      throw new ForbiddenException("需要先加入该阶段才能提交");
    let creditedParticipants = active;
    if (
      work.collaborationMode === WorkCollaborationMode.multi &&
      (input.stage === "translate" || input.stage === "proofread")
    ) {
      const images = await tx.workImage.findMany({
        where: { workId },
        select: { id: true, translationRevision: true },
      });
      const currentContributors = active.filter((participant) => {
        const submission = participant.contributionSubmissions[0];
        return Boolean(
          submission &&
          participant.assignments.length > 0 &&
          participant.assignments.every(({ workImageId }) =>
            submission.pages.some(
              (page) =>
                page.workImageId === workImageId &&
                page.imageRevision ===
                  images.find(({ id }) => id === workImageId)
                    ?.translationRevision,
            ),
          ),
        );
      });
      const uncovered = images.filter(
        (image) =>
          !currentContributors.some(
            (participant) =>
              participant.assignments.some(
                ({ workImageId }) => workImageId === image.id,
              ) &&
              participant.contributionSubmissions[0]?.pages.some(
                (page) =>
                  page.workImageId === image.id &&
                  page.imageRevision === image.translationRevision,
              ),
          ),
      );
      if (uncovered.length) {
        throw new ConflictException(
          `多人协作还有 ${uncovered.length} 页未分配、未完成或完成后又被修改`,
        );
      }
      creditedParticipants = currentContributors;
    }
    const now = new Date();
    const nextWorkRevision = work.revision + 1;
    const changesTextVersion =
      input.stage === "translate" || input.stage === "proofread";
    const nextEditorEpoch = work.editorEpoch + (changesTextVersion ? 1 : 0);
    const changed = await tx.work.updateMany({
      where: {
        id: workId,
        revision: input.expectedRevision,
        reviewStatus: ReviewStatus.normal,
      },
      data: {
        workflowStatus: transition.next,
        ...(input.stage === "typeset" ? { typesetReviewRequired: false } : {}),
        ...(transition.next === WorkflowStatus.published
          ? { publishedAt: now }
          : {}),
        ...(input.stage === "proofread"
          ? { typesetHandoffStartedAt: null }
          : {}),
        revision: { increment: 1 },
        ...(changesTextVersion ? { editorEpoch: { increment: 1 } } : {}),
        ...(work.translationAttentionStage === input.stage
          ? {
              translationAttentionStage: null,
              translationAttentionVersionNumber: null,
            }
          : {}),
      },
    });
    if (!changed.count) this.stale();
    const version = changesTextVersion
      ? await this.translations.createStageVersion(tx, {
          actorId,
          workId,
          stage: input.stage,
          workRevision: nextWorkRevision,
          editorEpoch: nextEditorEpoch,
          contributorUserIds:
            input.stage === "translate"
              ? [
                  ...new Set([
                    ...work.translationContributorIds,
                    ...creditedParticipants.map(({ userId }) => userId),
                  ]),
                ]
              : [],
        })
      : null;
    const credits: { userId: string; creditName: string }[] = [];
    const workCredits = new Map(
      (
        await tx.workCreditAlias.findMany({
          where: {
            workId,
            userId: {
              in: creditedParticipants.map((participant) => participant.userId),
            },
            stage: input.stage,
          },
        })
      ).map((credit) => [credit.userId, credit.creditName]),
    );
    for (const participant of creditedParticipants) {
      const creditName =
        workCredits.get(participant.userId) ?? participant.user.displayName;
      await tx.workStageParticipant.update({
        where: { id: participant.id },
        data: { submittedAt: now, creditNameSnapshot: creditName },
      });
      credits.push({ userId: participant.userId, creditName });
    }
    const creditedIds = new Set(
      creditedParticipants.map((participant) => participant.id),
    );
    await tx.workStageParticipant.updateMany({
      where: {
        id: {
          in: active
            .filter((item) => !creditedIds.has(item.id))
            .map((item) => item.id),
        },
      },
      data: { leftAt: now },
    });
    await tx.workEvent.create({
      data: {
        workId,
        actorId,
        action: WorkEventAction.stage_submitted,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: transition.next,
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        idempotencyKey: input.idempotencyKey,
        detail: {
          operation,
          stage: input.stage,
          credits,
          participantIds: creditedParticipants.map(
            (participant) => participant.id,
          ),
          ...(version
            ? {
                translationVersionId: version.id,
                translationVersionNumber: version.versionNumber,
                translationVersionKind: version.kind,
              }
            : {
                typesetVersionId: work.currentTypesetVersionId,
                typesetVersionNumber:
                  work.currentTypesetVersion?.versionNumber ?? null,
              }),
          editorEpoch: nextEditorEpoch,
        },
      },
    });
  }

  async skipProofreading(
    actorId: string,
    workId: string,
    input: SkipProofreadingDto,
  ): Promise<WorkDetailDto> {
    const operation = `skip-proofread:${actorId}`;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      // Account updates acquire this row too, so revocation cannot race authorization.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`,
      );
      await this.assertStagePermission(actorId, "translate", workId, tx);
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          WorkEventAction.proofreading_skipped,
          operation,
        )
      )
        return;
      const availability = await proofreadSkipAvailability(tx, actorId, workId);
      if (!availability.canSkipProofreading || !availability.sourceVersionId)
        throw new ConflictException(
          availability.skipProofreadingUnavailableReason,
        );
      const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
      if (
        work.revision !== input.expectedRevision ||
        work.editorEpoch !== input.expectedEditorEpoch
      )
        this.stale();
      const claims = await tx.workStageParticipant.findMany({
        where: { workId, stage: "proofread", leftAt: null, submittedAt: null },
      });
      const expected = new Set(input.proofreadParticipantIds);
      if (
        expected.size !== claims.length ||
        claims.some(({ id }) => !expected.has(id))
      )
        throw new ConflictException("校对认领已变化，请刷新并重新确认");
      if (claims.length && !input.confirmCancelClaims)
        throw new ConflictException("请明确确认取消已有校对认领");
      const now = new Date();
      const version = await this.translations.createSkippedProofreadVersion(
        tx,
        {
          actorId,
          workId,
          sourceVersionId: availability.sourceVersionId,
          workRevision: work.revision + 1,
          editorEpoch: work.editorEpoch + 1,
        },
      );
      await tx.workStageParticipant.updateMany({
        where: { id: { in: claims.map(({ id }) => id) } },
        data: { leftAt: now },
      });
      await tx.workCreditAlias.deleteMany({
        where: {
          workId,
          stage: "proofread",
          userId: { in: claims.map(({ userId }) => userId) },
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: {
          workflowStatus: WorkflowStatus.pending_typeset,
          proofreadSkippedVersionId: version.id,
          typesetHandoffStartedAt: null,
          revision: { increment: 1 },
          editorEpoch: { increment: 1 },
        },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: WorkEventAction.proofreading_skipped,
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: WorkflowStatus.pending_typeset,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          detail: {
            operation,
            stage: "proofread",
            sourceTranslationVersionId: availability.sourceVersionId,
            translationVersionId: version.id,
            cancelledParticipantIds: claims.map(({ id }) => id),
            cancelledUserIds: claims.map(({ userId }) => userId),
            credits: [],
            editorEpoch: work.editorEpoch + 1,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async cancelStageSubmission(
    actorId: string,
    workId: string,
    input: CancelWorkStageSubmissionDto,
  ): Promise<WorkDetailDto> {
    await this.assertStagePermission(actorId, input.stage, workId);
    const action = WorkEventAction.stage_submission_cancelled;
    const operation = `cancel-submission:${input.stage}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }

    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      ) {
        return;
      }
      await this.assertStagePermission(actorId, input.stage, workId, tx);
      const work = await tx.work.findUnique({
        where: { id: workId },
        include: { proofreadSkippedVersion: true },
      });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      const cancellingSkippedTranslation =
        input.stage === "translate" && Boolean(work.proofreadSkippedVersionId);
      const expectedStatus =
        input.stage === "translate"
          ? cancellingSkippedTranslation
            ? WorkflowStatus.pending_typeset
            : WorkflowStatus.pending_proofread
          : input.stage === "proofread"
            ? WorkflowStatus.pending_typeset
            : WorkflowStatus.pending_publish;
      if (work.workflowStatus !== expectedStatus) {
        throw new ConflictException("下游已开始或作品状态已变化，不能取消提交");
      }
      if (
        cancellingSkippedTranslation &&
        (work.proofreadSkippedVersion?.handoffStartedAt ||
          work.typesetHandoffStartedAt)
      )
        throw new ConflictException("嵌字已下载交接材料，不能取消翻译提交");
      if (
        cancellingSkippedTranslation &&
        work.reviewStatus !== ReviewStatus.normal
      )
        throw new ConflictException("请先处理作品审核");
      if (
        input.stage === "typeset" &&
        work.reviewStatus !== ReviewStatus.normal
      ) {
        throw new ConflictException("审核处理期间不能取消嵌字提交");
      }
      if (
        input.stage === "proofread" &&
        work.typesetHandoffStartedAt !== null
      ) {
        throw new ConflictException("嵌字已下载交接材料，不能取消校对提交");
      }
      if (work.editorEpoch !== input.expectedEditorEpoch) {
        throw new ConflictException(
          "作品已产生新的正式版本，请刷新后重新确认取消提交",
        );
      }
      const latest = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          submittedAt: { not: null },
          leftAt: null,
        },
        orderBy: { submittedAt: "desc" },
      });
      if (!latest?.submittedAt) {
        throw new ConflictException("没有可取消的阶段提交");
      }
      const submittedRound = await tx.workStageParticipant.findMany({
        where: {
          workId,
          stage: input.stage,
          submittedAt: latest.submittedAt,
          leftAt: null,
        },
        select: { id: true, userId: true },
      });
      if (!submittedRound.some(({ userId }) => userId === actorId)) {
        throw new ForbiddenException("只有本轮提交参与者可以取消提交");
      }
      const transition = stageTransitions[input.stage];
      const changed = await tx.work.updateMany({
        where: {
          id: workId,
          revision: input.expectedRevision,
          workflowStatus: expectedStatus,
          editorEpoch: input.expectedEditorEpoch,
        },
        data: {
          workflowStatus: transition.active,
          ...(cancellingSkippedTranslation
            ? { proofreadSkippedVersionId: null }
            : {}),
          revision: { increment: 1 },
          ...(input.stage !== "typeset"
            ? { editorEpoch: { increment: 1 } }
            : {}),
        },
      });
      if (!changed.count) this.stale();
      await tx.workStageParticipant.updateMany({
        where: { id: { in: submittedRound.map(({ id }) => id) } },
        data: { submittedAt: null },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: transition.active,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation,
            stage: input.stage,
            restoredParticipantIds: submittedRound.map(({ id }) => id),
            previousEditorEpoch: work.editorEpoch,
            editorEpoch: work.editorEpoch + (input.stage === "typeset" ? 0 : 1),
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async archive(
    actorId: string,
    workId: string,
    input: WorkMutationDto,
  ): Promise<WorkDetailDto> {
    return this.setArchived(actorId, workId, input, true);
  }

  async restore(
    actorId: string,
    workId: string,
    input: WorkMutationDto,
  ): Promise<WorkDetailDto> {
    return this.setArchived(actorId, workId, input, false);
  }

  private async setArchived(
    actorId: string,
    workId: string,
    input: WorkMutationDto,
    archive: boolean,
  ): Promise<WorkDetailDto> {
    const action = archive
      ? WorkEventAction.archived
      : WorkEventAction.restored;
    const operation = archive ? "archive" : "restore";
    if (await this.isReplay(workId, input.idempotencyKey, action, operation))
      return this.get(workId, actorId);
    await this.db.$transaction(async (tx) => {
      if (
        await this.isReplayTx(
          tx,
          workId,
          input.idempotencyKey,
          action,
          operation,
        )
      )
        return;
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      if (
        work.reviewStatus !== ReviewStatus.normal ||
        work.discardedReviewCaseId
      )
        throw new ConflictException("请从审核事项处理挂起或舍弃作品");
      const target = archive
        ? WorkflowStatus.archived
        : work.archivedFromWorkflowStatus;
      if (
        (archive && work.workflowStatus === WorkflowStatus.archived) ||
        (!archive &&
          (work.workflowStatus !== WorkflowStatus.archived || !target))
      ) {
        throw new ConflictException(
          archive ? "作品已经归档" : "作品当前不能恢复",
        );
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: {
          workflowStatus: target!,
          archivedFromWorkflowStatus: archive ? work.workflowStatus : null,
          editorEpoch: { increment: 1 },
          revision: { increment: 1 },
        },
      });
      if (!changed.count) this.stale();
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: target,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: { operation },
        },
      });
    });
    return this.get(workId, actorId);
  }

  private async assertStagePermission(
    actorId: string,
    stage: WorkStage,
    workId: string,
    db: PrismaService | Prisma.TransactionClient = this.db,
  ) {
    const [user, work] = await Promise.all([
      db.user.findUnique({
        where: { id: actorId },
        select: {
          isActive: true,
          roles: { select: { role: true } },
          languageCapabilities: { select: { language: true } },
        },
      }),
      db.work.findUnique({
        where: { id: workId },
        select: { sourceLanguage: true },
      }),
    ]);
    if (!work) throw new NotFoundException("作品不存在");
    if (
      !user ||
      !user.isActive ||
      !canUserWorkStage(
        user.roles.map(({ role }) => role),
        user.languageCapabilities.map(({ language }) => language),
        stage,
        work.sourceLanguage,
      )
    ) {
      throw new ForbiddenException("没有执行该语言阶段工作的资格");
    }
  }

  private assertCoordinatedStage(stage: WorkStage) {
    if (!isCoordinatedWorkStage(stage)) {
      throw new BadRequestException("任务组协调只支持翻译、校对和嵌字职责");
    }
  }

  private async assertSingleStageSeparation(
    tx: Prisma.TransactionClient,
    collaborationMode: WorkCollaborationMode,
    workId: string,
    userId: string,
    stage: WorkStage,
  ) {
    if (
      collaborationMode !== WorkCollaborationMode.single ||
      (stage !== "translate" && stage !== "proofread")
    ) {
      return;
    }
    const oppositeStage = stage === "translate" ? "proofread" : "translate";
    const opposite = await tx.workStageParticipant.findFirst({
      where: {
        workId,
        userId,
        stage: oppositeStage,
        leftAt: null,
      },
      select: { id: true },
    });
    if (opposite) {
      throw new ConflictException(
        "单人模式下同一用户不能同时承担该作品的翻译和校对",
      );
    }
  }

  private async assertAdmin(tx: Prisma.TransactionClient, actorId: string) {
    const admin = await tx.user.findFirst({
      where: {
        id: actorId,
        isActive: true,
        roles: { some: { role: Role.admin } },
      },
      select: { id: true },
    });
    if (!admin)
      throw new ForbiddenException("只有管理员可以调整他人的页码分工");
  }

  private async isAdmin(actorId: string) {
    return Boolean(
      await this.db.user.findFirst({
        where: {
          id: actorId,
          isActive: true,
          roles: { some: { role: Role.admin } },
        },
        select: { id: true },
      }),
    );
  }

  private async isReplay(
    workId: string,
    idempotencyKey: string,
    action: WorkEventAction,
    operation: string,
  ) {
    return this.isReplayTx(this.db, workId, idempotencyKey, action, operation);
  }

  private async isReplayTx(
    tx: Prisma.TransactionClient | PrismaService,
    workId: string,
    idempotencyKey: string,
    action: WorkEventAction,
    operation: string,
  ) {
    const existing = await tx.workEvent.findUnique({
      where: { workId_idempotencyKey: { workId, idempotencyKey } },
    });
    if (!existing) return false;
    const detail = existing.detail as { operation?: unknown };
    if (existing.action !== action || detail.operation !== operation)
      throw new ConflictException("幂等键已用于其他作品操作");
    return true;
  }

  private stale(): never {
    throw new ConflictException("作品已更新，请刷新后重试");
  }

  private listDto(work: WorkListRow): WorkDto {
    return {
      requiredHandoffVersionId: work.requiredHandoffVersionId,
      typesetReviewRequired: work.typesetReviewRequired,
      proofreadingSkipped: Boolean(work.proofreadSkippedVersionId),
      proofreadSkipHandoffStartedAt:
        work.proofreadSkippedVersion?.handoffStartedAt?.toISOString() ?? null,
      id: work.id,
      workNumber: work.workNumber,
      authorId: work.authorId,
      authorName: work.author.displayName,
      title: work.title,
      sourceLanguage: work.sourceLanguage,
      collaborationMode: work.collaborationMode,
      sourcePostUrl: work.sourcePostUrl,
      workflowStatus: work.workflowStatus,
      reviewStatus: work.reviewStatus,
      priority: work.priority,
      revision: work.revision,
      editorEpoch: work.editorEpoch,
      typesetHandoffStartedAt:
        work.typesetHandoffStartedAt?.toISOString() ?? null,
      translationAttentionStage: work.translationAttentionStage,
      translationAttentionVersionNumber: work.translationAttentionVersionNumber,
      imageCount: work._count.images,
      coverImageId: work.images[0]?.id ?? null,
      participantCount: work._count.stageParticipants,
      assignedStages: [
        ...new Set(work.stageParticipants.map(({ stage }) => stage)),
      ],
      importedAt: work.importedAt.toISOString(),
      publishedAt: work.publishedAt?.toISOString() ?? null,
      updatedAt: work.updatedAt.toISOString(),
    };
  }

  private detailDto(work: WorkFullRow): WorkDetailDto {
    return {
      canSkipProofreading: false,
      skipProofreadingUnavailableReason: null,
      ...this.listDto(work),
      assignedStages: [
        ...new Set(
          work.stageParticipants
            .filter(({ leftAt }) => !leftAt)
            .map(({ stage }) => stage),
        ),
      ],
      sourceText: work.sourceText,
      images: work.images.map((image) => ({
        id: image.id,
        orderIndex: image.orderIndex,
        width: image.width,
        height: image.height,
      })),
      participants: work.stageParticipants.map((participant) => {
        const latestContribution = participant.contributionSubmissions[0];
        const currentRevisions = new Map(
          work.images.map((image) => [image.id, image.translationRevision]),
        );
        return {
          id: participant.id,
          userId: participant.userId,
          displayName: participant.user.displayName,
          avatarVersion: participant.user.avatarFileObjectId,
          stage: participant.stage,
          participationMode: participant.participationMode,
          workCreditName:
            work.creditAliases.find(
              (credit) =>
                credit.userId === participant.userId &&
                credit.stage === participant.stage,
            )?.creditName ?? null,
          creditNameSnapshot: participant.creditNameSnapshot,
          joinedAt: participant.joinedAt.toISOString(),
          submittedAt: participant.submittedAt?.toISOString() ?? null,
          leftAt: participant.leftAt?.toISOString() ?? null,
          assignedImageIds: participant.assignments.map(
            ({ workImageId }) => workImageId,
          ),
          contributionSubmittedAt:
            latestContribution?.createdAt.toISOString() ?? null,
          contributionCurrent: Boolean(
            latestContribution &&
            participant.assignments.length > 0 &&
            participant.assignments.every(({ workImageId }) =>
              latestContribution.pages.some(
                (page) =>
                  page.workImageId === workImageId &&
                  page.imageRevision === currentRevisions.get(workImageId),
              ),
            ),
          ),
        };
      }),
      events: work.events.map((event) => ({
        id: event.id,
        action: event.action,
        actorId: event.actorId,
        actorName: event.actor?.displayName ?? null,
        fromWorkflowStatus: event.fromWorkflowStatus,
        toWorkflowStatus: event.toWorkflowStatus,
        fromReviewStatus: event.fromReviewStatus,
        toReviewStatus: event.toReviewStatus,
        detail: event.detail as object,
        createdAt: event.createdAt.toISOString(),
      })),
      openReviewCaseId: work.reviewCases[0]?.id ?? null,
    };
  }
}
