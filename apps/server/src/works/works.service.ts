import { matchesSourceAssetLineage } from "./source-asset-lineage.js";
import {
  submitTypesetPagesTx,
  cancelTypesetPagesTx,
  clearTypesetPagesTx,
} from "../typesetting/typeset-page-workflow.js";
import {
  ensurePageAssignments,
  pageSubmissionCurrent,
} from "./page-ownership.js";
import { toSourceAccountSummary } from "../authors/source-account-summary.js";
import {
  assertSourceFilterAccount,
  normalizeSourceFilter,
  sourceCandidateWhere,
} from "../source-identity/source-filter.js";
import { lockAccountMembership } from "../users/account-membership-lock.js";
import { createHash } from "node:crypto";
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
  AddWorkProofreaderDto,
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
  WorkAlbumQueryDto,
  WorkAlbumPageDto,
  PersonalWorkTaskDto,
  WorkSourceDto,
} from "./works.dto.js";
import { WorkClaimOutcome, WorkPhase, WorkView } from "./works.dto.js";
import { proofreadSkipAvailability } from "../workflow/proofread-exemption.js";
import {
  currentStageStatuses,
  personalStageScopes,
  personalTodoWhere,
  personalRecommendationWhere,
  availableStageWhere,
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
    select: { stage: true, userId: true, leftAt: true },
  },
  _count: { select: { images: true } },
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
  pageAssignments: {
    include: { participant: { select: { userId: true } } },
    orderBy: { workImage: { orderIndex: "asc" } },
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
  pageAssignments: {
    select: {
      workImageId: true,
      stage: true,
      participantId: true,
      generation: true,
      draftRevision: true,
      submittedAt: true,
      submittedRevision: true,
      submittedGeneration: true,
    },
  },

  images: {
    select: { id: true, translationRevision: true },
    orderBy: { orderIndex: "asc" },
  },
  stageParticipants: {
    where: { leftAt: null },
    select: {
      stage: true,
      id: true,
      userId: true,
      leftAt: true,
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

  private async listScopes(actorId: string, query: WorkQueryDto) {
    if (query.claimStage && query.view !== WorkView.recommended)
      throw new BadRequestException("可接职责只能用于推荐接取视角");
    const sourceFilter = normalizeSourceFilter(query);
    await assertSourceFilterAccount(this.db, sourceFilter, query.authorId);
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
      ...(Object.keys(sourceFilter).length
        ? {
            sources: {
              some: { candidatePost: sourceCandidateWhere(sourceFilter) },
            },
          }
        : {}),
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
            collaborationMigrationIssue: null,
            AND: [availableStageWhere(query.unassignedStage)],
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
    return { limit, actor, todoScope, statisticsScope, publishScope, scope };
  }

  async album(
    actorId: string,
    query: WorkAlbumQueryDto,
  ): Promise<WorkAlbumPageDto> {
    if (query.view !== undefined || query.claimStage !== undefined)
      throw new BadRequestException("相册仅用于作品查看视图");
    const { scope, actor } = await this.listScopes(actorId, {
      ...query,
      cursor: undefined,
    });
    if (!actor.roles.length)
      throw new ForbiddenException("当前账号不能查看作品");
    const filter = createHash("sha256")
      .update(
        JSON.stringify({
          actorId,
          search: query.search ?? "",
          sourceLanguage: query.sourceLanguage ?? null,
          phase: query.phase ?? null,
          workflowStatus: query.workflowStatus ?? null,
          reviewStatus: query.reviewStatus ?? null,
          authorId: query.authorId ?? null,
          mine: query.mine ?? false,
          unassignedStage: query.unassignedStage ?? null,
          ...normalizeSourceFilter(query),
        }),
      )
      .digest("hex");
    let seek: Prisma.WorkImageWhereInput = {};
    if (query.cursor) {
      try {
        const c: unknown = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        );
        if (!c || typeof c !== "object") throw Error();
        const v = c as Record<string, unknown>;
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (
          v.v !== 1 ||
          v.f !== filter ||
          typeof v.t !== "string" ||
          !Number.isFinite(Date.parse(v.t)) ||
          typeof v.w !== "string" ||
          !uuid.test(v.w) ||
          typeof v.i !== "string" ||
          !uuid.test(v.i) ||
          !Number.isInteger(v.o) ||
          Number(v.o) < 0
        )
          throw Error();
        const date = new Date(v.t),
          workId = v.w,
          imageId = v.i,
          orderIndex = Number(v.o);
        seek = {
          OR: [
            { work: { importedAt: { lt: date } } },
            { work: { importedAt: date }, workId: { lt: workId } },
            { workId, orderIndex: { gt: orderIndex } },
            { workId, orderIndex, id: { gt: imageId } },
          ],
        };
      } catch {
        throw new BadRequestException("相册游标无效，请重新加载");
      }
    }
    const where: Prisma.WorkImageWhereInput = { work: scope };
    const [total, workTotal, rows] = await Promise.all([
      this.db.workImage.count({ where }),
      this.db.work.count({ where: scope }),
      this.db.workImage.findMany({
        where: { AND: [where, seek] },
        select: {
          id: true,
          workId: true,
          orderIndex: true,
          work: {
            select: {
              workNumber: true,
              title: true,
              importedAt: true,
              sourceLanguage: true,
              workflowStatus: true,
              reviewStatus: true,
              author: { select: { displayName: true } },
              _count: { select: { images: true } },
            },
          },
        },
        orderBy: [
          { work: { importedAt: "desc" } },
          { workId: "desc" },
          { orderIndex: "asc" },
          { id: "asc" },
        ],
        take: query.limit + 1,
      }),
    ]);
    const items = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      workId: row.workId,
      orderIndex: row.orderIndex,
      workNumber: row.work.workNumber,
      workTitle: row.work.title,
      authorName: row.work.author.displayName,
      imageCount: row.work._count.images,
      sourceLanguage: row.work.sourceLanguage,
      workflowStatus: row.work.workflowStatus,
      reviewStatus: row.work.reviewStatus,
      importedAt: row.work.importedAt.toISOString(),
    }));
    const last = items.at(-1);
    return {
      total,
      workTotal,
      items,
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                f: filter,
                t: last.importedAt,
                w: last.workId,
                o: last.orderIndex,
                i: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }

  async list(actorId: string, query: WorkQueryDto): Promise<WorkPageDto> {
    const { limit, actor, todoScope, statisticsScope, publishScope, scope } =
      await this.listScopes(actorId, query);
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
              const assigned = work.pageAssignments.filter(
                (p) => p.stage === stage && p.participantId === participant.id,
              );
              return [
                {
                  stage,
                  readyToStart,
                  contributionCurrent:
                    assigned.length > 0 &&
                    assigned.every(
                      (p) =>
                        p.submittedAt !== null &&
                        p.submittedRevision === p.draftRevision &&
                        p.submittedGeneration === p.generation,
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
              (work.collaborationMode === "multi" &&
              (stage === "translate" || stage === "typeset")
                ? !work.images.some(
                    (i) =>
                      !work.pageAssignments.some(
                        (p) =>
                          p.stage === stage &&
                          p.workImageId === i.id &&
                          p.participantId,
                      ),
                  )
                : work.stageParticipants.some(
                    (item) => item.stage === stage,
                  )) ||
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

  async source(workId: string): Promise<WorkSourceDto> {
    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: {
        sourceCandidatePostId: true,
        sources: {
          orderBy: { orderIndex: "asc" },
          select: {
            sourceText: true,
            mappingKnown: true,
            candidatePost: {
              select: {
                id: true,
                platform: true,
                authorExternalAccount: {
                  select: {
                    id: true,
                    platform: true,
                    externalUserId: true,
                    handle: true,
                    profileUrl: true,
                    displayNameSnapshot: true,
                    avatarFileObjectId: true,
                    fetchEnabled: true,
                    deletedAt: true,
                  },
                },
                externalPostId: true,
                externalPostUrl: true,
                text: true,
                media: {
                  orderBy: { orderIndex: "asc" },
                  select: {
                    id: true,
                    orderIndex: true,
                    width: true,
                    height: true,
                    mediaType: true,
                    fileObjectId: true,
                    fileObject: {
                      select: { lifecycleStatus: true, deletedAt: true },
                    },
                    workImage: {
                      select: {
                        id: true,
                        workId: true,
                        originalFileObjectId: true,
                        sourceAssetReplacements: {
                          select: {
                            oldFileObjectId: true,
                            newFileObjectId: true,
                          },
                          orderBy: { assetRevision: "asc" },
                        },
                        orderIndex: true,
                        work: {
                          select: { id: true, workNumber: true, title: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    const sources = work.sources.map((source) => {
      const candidate = source.candidatePost;
      return {
        candidateId: candidate.id,
        sourceAccount: candidate.authorExternalAccount
          ? toSourceAccountSummary(candidate.authorExternalAccount)
          : null,
        platform: candidate.platform,
        externalPostId: candidate.externalPostId,
        sourceUrl: candidate.externalPostUrl,
        sourceText: candidate.text,
        importedSourceText: source.sourceText,
        mappingKnown: source.mappingKnown,
        media: candidate.media.map((media) => {
          const image =
            media.workImage &&
            matchesSourceAssetLineage(
              media.fileObjectId,
              media.workImage.originalFileObjectId,
              media.workImage.sourceAssetReplacements,
            )
              ? media.workImage
              : null;
          const disposition = image
            ? image.workId === workId
              ? ("this_work" as const)
              : ("other_work" as const)
            : source.mappingKnown
              ? ("unadopted" as const)
              : ("unknown" as const);
          return {
            id: media.id,
            orderIndex: media.orderIndex,
            width: media.width,
            height: media.height,
            mediaType: media.mediaType,
            disposition,
            adoptedByWork: image?.work ?? null,
            adopted:
              disposition === "this_work"
                ? true
                : disposition === "unadopted"
                  ? false
                  : null,
            workImageId: disposition === "this_work" ? image!.id : null,
            workOrderIndex:
              disposition === "this_work" ? image!.orderIndex : null,
            available:
              media.fileObject.lifecycleStatus === "active" &&
              media.fileObject.deletedAt === null,
          };
        }),
      };
    });
    const primary =
      sources.find(
        (source) => source.candidateId === work.sourceCandidatePostId,
      ) ?? sources[0];
    if (!primary) throw new ConflictException("作品缺少来源记录，请联系管理员");
    return {
      candidateId: primary.candidateId,
      sourceAccount: primary.sourceAccount,
      platform: primary.platform,
      externalPostId: primary.externalPostId,
      sourceUrl: primary.sourceUrl,
      sourceText: primary.sourceText,
      importedSourceText: primary.importedSourceText,
      media: primary.media,
      sources,
    };
  }

  async sourceMediaUrl(
    workId: string,
    mediaId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    const media = await this.db.candidateMedia.findFirst({
      where: {
        id: mediaId,
        candidatePost: { workSources: { some: { workId } } },
      },
      select: { fileObjectId: true },
    });
    if (!media) throw new NotFoundException("作品来源图片不存在");
    return this.files.imageUrl(media.fileObjectId, variant);
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
    const operation = `collaboration:${input.collaborationMode}:${[...(input.retainedTranslationImageIds ?? [])].sort().join(",")}:${[...(input.retainedTypesetImageIds ?? [])].sort().join(",")}`;
    await this.db.$transaction(async (tx) => {
      await lockAccountMembership(tx);
      await this.assertAdmin(tx, actorId);
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
      );
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
      const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
      assertProductionWritable(work);
      if (work.workflowStatus === "published")
        throw new ConflictException("已发布作品不能修改模式");
      if (work.revision !== input.expectedRevision) this.stale();
      if (work.collaborationMode === input.collaborationMode) return;
      await ensurePageAssignments(tx, workId, "translate");
      await ensurePageAssignments(tx, workId, "typeset");
      const members = await tx.workStageParticipant.findMany({
        where: { workId, leftAt: null },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      });
      const pages = await tx.workPageAssignment.findMany({ where: { workId } });
      const cleared: string[] = [];
      if (input.collaborationMode === "single") {
        const progress =
          work.productionStartedAt ||
          work.typesetHandoffStartedAt ||
          (await tx.translationEntry.count({
            where: { workImage: { workId } },
          })) ||
          (await tx.workTypesetDraft.count({ where: { workId } })) ||
          (await tx.translationVersion.count({ where: { workId } })) ||
          (await tx.typesetImageVersion.count({ where: { workId } }));
        if (progress)
          throw new ConflictException("曾有实际进展的作品不能切回单人模式");
        const keep = (["translate", "proofread", "typeset"] as const).flatMap(
          (stage) => members.filter((p) => p.stage === stage).slice(0, 1),
        );
        const translator = keep.find((p) => p.stage === "translate");
        const proofreader = keep.find((p) => p.stage === "proofread");
        if (
          translator &&
          proofreader &&
          translator.userId === proofreader.userId
        )
          throw new ConflictException(
            "最早成员同时承担翻译与校对，请先调整职责",
          );
        for (const member of keep)
          await this.assertStagePermission(
            member.userId,
            member.stage,
            workId,
            tx,
          );
        const keepIds = new Set(keep.map((p) => p.id));
        const removed = members.filter((p) => !keepIds.has(p.id));
        await tx.workStageParticipant.updateMany({
          where: { id: { in: removed.map((p) => p.id) } },
          data: { leftAt: new Date() },
        });
        await tx.workStageAssignment.deleteMany({
          where: { participantId: { in: removed.map((p) => p.id) } },
        });
        await tx.proofreadPageLease.deleteMany({ where: { workId } });
        for (const stage of ["translate", "typeset"] as const) {
          const owner = keep.find((p) => p.stage === stage);
          await tx.workPageAssignment.updateMany({
            where: { workId, stage },
            data: {
              participantId: owner?.id ?? null,
              generation: { increment: 1 },
              submittedAt: null,
              submittedGeneration: null,
              submittedRevision: null,
            },
          });
          if (owner)
            await tx.workStageAssignment.createMany({
              data: pages
                .filter((p) => p.stage === stage)
                .map((p) => ({
                  participantId: owner.id,
                  workImageId: p.workImageId,
                  assignedById: actorId,
                })),
              skipDuplicates: true,
            });
        }
      } else {
        for (const stage of ["translate", "typeset"] as const) {
          const mutable = claimableWorkStatuses(stage).includes(
            work.workflowStatus,
          );
          const owner = members.find((p) => p.stage === stage);
          if (!owner || !mutable) continue;
          const owned = pages.filter(
            (p) => p.stage === stage && p.participantId === owner.id,
          );
          const requested =
            stage === "translate"
              ? input.retainedTranslationImageIds
              : input.retainedTypesetImageIds;
          const hasDraft =
            stage === "translate"
              ? await tx.translationEntry.count({
                  where: {
                    workImageId: { in: owned.map((p) => p.workImageId) },
                  },
                })
              : Boolean(work.currentTypesetVersionId) ||
                (await tx.workTypesetDraft.count({
                  where: { workId, participantId: owner.id },
                }));
          if (hasDraft && requested === undefined)
            throw new ConflictException("有稿转多人须由原负责人明确选择保留页");
          const retain = requested ?? owned.map((p) => p.workImageId);
          if (retain.some((id) => !owned.some((p) => p.workImageId === id)))
            throw new ConflictException("保留范围包含不属于原负责人的页面");
          const release = owned
            .filter((p) => !retain.includes(p.workImageId))
            .map((p) => p.workImageId);
          cleared.push(...release);
          if (stage === "typeset" && work.currentTypesetVersionId) {
            const version = await tx.typesetImageVersion.findUniqueOrThrow({
              where: { id: work.currentTypesetVersionId },
              include: { images: true },
            });
            const mapped = version.images.map((i) => i.workImageId);
            if (
              mapped.some((id) => !id) ||
              new Set(mapped).size !== mapped.length
            )
              throw new ConflictException(
                "当前单人成图映射不明确，请先整理后转换；不会猜测页码或删除稿件",
              );
            for (const image of version.images) {
              const assignment = owned.find(
                (p) => p.workImageId === image.workImageId,
              );
              if (!assignment)
                throw new ConflictException("成图映射不属于当前负责人");
              await tx.workTypesetDraft.upsert({
                where: { workImageId: image.workImageId! },
                create: {
                  workId,
                  workImageId: image.workImageId,
                  participantId: owner.id,
                  assignmentGeneration: assignment.generation,
                  fileObjectId: image.fileObjectId,
                  sourceName: image.sourceName,
                  width: image.width,
                  height: image.height,
                  orderIndex: image.orderIndex,
                },
                update: {},
              });
            }
          }
          await this.releasePagesTx(
            tx,
            actorId,
            workId,
            owner.id,
            stage,
            release,
            input,
          );
        }
        this.assertClearConfirmation([...new Set(cleared)], input);
      }
      await tx.work.update({
        where: { id: workId },
        data: {
          collaborationMode: input.collaborationMode,
          revision: { increment: 1 },
        },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: work.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          detail: {
            operation,
            from: work.collaborationMode,
            to: input.collaborationMode,
            clearedImageIds: [...new Set(cleared)],
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
    return this.claimStage(actorId, workId, input);
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
    if (input.stage !== "proofread")
      return this.updateStageAssignments(actorId, workId, {
        ...input,
        imageIds: [],
      });
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
      if (resetsTextDraft && !input.confirmClearDraft)
        throw new ConflictException(
          "最后一名校对退出将放弃本轮校对改动，请确认",
        );
      await tx.proofreadPageLease.deleteMany({
        where: { workId, userId: actorId },
      });
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
    const operation = `${actionName}:${input.stage}:${targetUserId}:${input.creditName ?? ""}:${[...(input.imageIds ?? [])].sort().join(",")}`;
    await this.db.$transaction(async (tx) => {
      await lockAccountMembership(tx);
      await this.assertStagePermission(targetUserId, input.stage, workId, tx);
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
      )
        return;
      const work = await tx.work.findUnique({ where: { id: workId } });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (actionName === "assign") {
        if (work.collaborationMode !== "multi")
          throw new ConflictException("单人模式不支持独立添加二校");
        const manager = await tx.user.findUniqueOrThrow({
          where: { id: actorId },
          include: { roles: true },
        });
        if (!manager.roles.some((r) => r.role === Role.admin)) {
          await this.assertStagePermission(actorId, "proofread", workId, tx);
          if (
            !(await tx.workStageParticipant.findFirst({
              where: {
                workId,
                stage: "proofread",
                userId: actorId,
                leftAt: null,
              },
            }))
          )
            throw new ForbiddenException("只有当前校对或管理员可以添加校对");
        }
      }

      if (!claimableWorkStatuses(input.stage).includes(work.workflowStatus))
        throw new ConflictException("只能认领当前或尚未开始的后续职责");
      if (input.stage === "proofread" && work.proofreadSkippedVersionId)
        throw new ConflictException("本轮已跳过校对");
      const current = await tx.workStageParticipant.findMany({
        where: { workId, stage: input.stage, leftAt: null },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      });
      let participant = current.find((p) => p.userId === targetUserId);
      if (
        work.collaborationMode === "single" &&
        current.some((p) => p.userId !== targetUserId)
      )
        throw new ConflictException("单人模式下该职责已有负责人");
      await this.assertSingleStageSeparation(
        tx,
        work.collaborationMode,
        workId,
        targetUserId,
        input.stage,
      );
      let selected: string[] = [];
      if (input.stage !== "proofread") {
        await ensurePageAssignments(tx, workId, input.stage);
        const pages = await tx.workPageAssignment.findMany({
          where: { workId, stage: input.stage },
          include: { workImage: { select: { orderIndex: true } } },
          orderBy: { workImage: { orderIndex: "asc" } },
        });
        selected =
          input.imageIds ??
          pages.filter((p) => !p.participantId).map((p) => p.workImageId);
        if (
          !selected.length &&
          work.collaborationMode === "single" &&
          participant &&
          !input.imageIds &&
          pages.length
        ) {
          if (!participant.submittedAt) return;
          // A historic, explicitly reopened single stage retains its previous owner's pages.
          const previousOwnerId = participant.id;
          selected = pages
            .filter((page) => page.participantId === previousOwnerId)
            .map((page) => page.workImageId);
        }
        if (!selected.length) throw new ConflictException("没有可认领的空闲页");
        if (work.collaborationMode === "single")
          selected = pages.map((p) => p.workImageId);
        const conflicts = selected.filter(
          (id) =>
            !pages.some(
              (p) =>
                p.workImageId === id &&
                (!p.participantId || p.participantId === participant?.id),
            ),
        );
        if (conflicts.length)
          throw new ConflictException({
            message: "部分页面已被认领，请重新选择",
            conflictImageIds: conflicts,
          });
      }
      const changed = await tx.work.updateMany({
        where: { id: workId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) this.stale();
      if (!participant)
        participant = await tx.workStageParticipant.create({
          data: {
            workId,
            stage: input.stage,
            userId: targetUserId,
            participationMode: current.length ? "collaborator" : "owner",
          },
        });
      if (selected.length) {
        await tx.workStageParticipant.update({
          where: { id: participant.id },
          data: { submittedAt: null },
        });
        await tx.workPageAssignment.updateMany({
          where: {
            workId,
            stage: input.stage,
            workImageId: { in: selected },
            participantId: null,
          },
          data: { participantId: participant.id, generation: { increment: 1 } },
        });
        await tx.workStageAssignment.createMany({
          data: selected.map((workImageId) => ({
            participantId: participant!.id,
            workImageId,
            assignedById: actorId,
          })),
          skipDuplicates: true,
        });
      }
      if (input.creditName)
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
            participantId: participant.id,
            imageIds: selected,
            ...(actionName === "assign" &&
              input.stage === "proofread" && {
                addedProofreader: (
                  await tx.user.findUniqueOrThrow({
                    where: { id: targetUserId },
                    select: { displayName: true },
                  })
                ).displayName,
              }),
            participationRegistered: true,
          },
        },
      });
    });
    return this.get(workId, actorId);
  }

  async addProofreader(
    actorId: string,
    workId: string,
    input: AddWorkProofreaderDto,
  ): Promise<WorkDetailDto> {
    const actor = await this.db.user.findUniqueOrThrow({
      where: { id: actorId },
      include: { roles: true },
    });
    const current = await this.db.workStageParticipant.findFirst({
      where: { workId, userId: actorId, stage: "proofread", leftAt: null },
    });
    if (!actor.roles.some((r) => r.role === Role.admin)) {
      if (!current)
        throw new ForbiddenException("只有当前校对或管理员可以添加校对");
      await this.assertStagePermission(actorId, "proofread", workId);
    }
    const work = await this.db.work.findUniqueOrThrow({
      where: { id: workId },
    });
    if (work.collaborationMode !== "multi")
      throw new ConflictException("单人模式不支持独立添加二校");
    return this.reserveStage(
      actorId,
      input.userId,
      workId,
      { ...input, stage: "proofread" },
      WorkEventAction.stage_joined,
      "assign",
    );
  }

  private assertClearConfirmation(
    ids: string[],
    input: { confirmClearDraft?: boolean; impactImageIds?: string[] },
  ) {
    const expected = [...ids].sort();
    const confirmed = [...(input.impactImageIds ?? [])].sort();
    if (
      ids.length &&
      (!input.confirmClearDraft ||
        expected.length !== confirmed.length ||
        expected.some((id, i) => id !== confirmed[i]))
    )
      throw new ConflictException({
        code: "CLEAR_DRAFT_CONFIRMATION_REQUIRED",
        message: "取消认领将清空这些页的当前稿件，请确认影响范围",
        impactImageIds: ids,
      });
  }

  private async releasePagesTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    participantId: string,
    stage: WorkStage,
    ids: string[],
    confirmation: { impactSupplementIds?: string[] } = {},
  ) {
    if (!ids.length) return;
    const remaining = await tx.workPageAssignment.count({
      where: { workId, stage, participantId, workImageId: { notIn: ids } },
    });
    const pages = await tx.workPageAssignment.findMany({
      where: { workId, stage, participantId, workImageId: { in: ids } },
    });
    if (pages.some(pageSubmissionCurrent))
      throw new ConflictException("请先取消本人提交，再取消认领");
    if (stage === "translate") {
      await tx.translationEntry.deleteMany({
        where: { workImageId: { in: ids } },
      });
      await tx.workImage.updateMany({
        where: { id: { in: ids }, workId },
        data: { translationRevision: { increment: 1 } },
      });
    } else {
      if (!remaining) {
        const supplements = await tx.workTypesetDraft.findMany({
          where: { workId, participantId, workImageId: null },
          select: { id: true, sourceName: true },
        });
        const expected = supplements.map((p) => p.id).sort(),
          confirmed = [...(confirmation.impactSupplementIds ?? [])].sort();
        if (
          expected.length !== confirmed.length ||
          expected.some((id, i) => id !== confirmed[i])
        )
          throw new ConflictException({
            code: "CLEAR_SUPPLEMENTS_CONFIRMATION_REQUIRED",
            message: "取消最后原稿页认领将同时清除本人补充图，请确认完整范围",
            impactSupplementIds: expected,
            supplements,
          });
      }
      await clearTypesetPagesTx(tx, participantId, ids, {
        lastPage: remaining === 0,
      });
    }
    await tx.workPageAssignment.updateMany({
      where: { workId, stage, participantId, workImageId: { in: ids } },
      data: {
        participantId: null,
        generation: { increment: 1 },
        draftRevision: { increment: 1 },
        submittedAt: null,
        submittedGeneration: null,
        submittedRevision: null,
      },
    });
    await tx.workStageAssignment.deleteMany({
      where: { participantId, workImageId: { in: ids } },
    });
    if (!remaining)
      await tx.workStageParticipant.update({
        where: { id: participantId },
        data: { leftAt: new Date() },
      });
  }

  async updateStageAssignments(
    actorId: string,
    workId: string,
    input: UpdateStageAssignmentsDto,
  ): Promise<WorkDetailDto> {
    if (input.stage === "proofread")
      throw new BadRequestException("校对共享全篇，无需分配页码");
    const operation = `stage-assignment:${input.stage}:${input.participantId ?? actorId}:${[...input.imageIds].sort().join(",")}`;
    const action = WorkEventAction.stage_assignment_updated;
    await this.db.$transaction(async (tx) => {
      await lockAccountMembership(tx);
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
      )
        return;
      const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
      assertProductionWritable(work);
      if (!claimableWorkStatuses(input.stage).includes(work.workflowStatus))
        throw new ConflictException(
          "当前阶段不能修改页归属；已提交页须先合法取消提交",
        );
      await ensurePageAssignments(tx, workId, input.stage);
      const participant = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          stage: input.stage,
          leftAt: null,
          ...(input.participantId
            ? { id: input.participantId }
            : { userId: actorId }),
        },
      });
      if (!participant) throw new ConflictException("当前没有可调整的职责");
      if (participant.userId !== actorId) await this.assertAdmin(tx, actorId);
      else await this.assertStagePermission(actorId, input.stage, workId, tx);
      const pages = await tx.workPageAssignment.findMany({
        where: { workId, stage: input.stage },
      });
      const owned = pages.filter((p) => p.participantId === participant.id);
      const released = owned
        .filter((p) => !input.imageIds.includes(p.workImageId))
        .map((p) => p.workImageId);
      const selected = new Set(input.imageIds);
      const conflicts = input.imageIds.filter(
        (id) =>
          !pages.some(
            (p) =>
              p.workImageId === id &&
              (!p.participantId || p.participantId === participant.id),
          ),
      );
      if (
        work.collaborationMode === "single" &&
        selected.size > 0 &&
        selected.size !== pages.length
      )
        throw new ConflictException(
          "单人职责须保留整作，请先开启多人协作再分配部分页",
        );
      if (
        participant.userId !== actorId &&
        input.imageIds.some((id) => !owned.some((p) => p.workImageId === id))
      )
        throw new ForbiddenException("管理员代释放只可减少该成员的负责页");
      if (conflicts.length)
        throw new ConflictException({
          message: "页面已由其他成员负责，不能替换归属",
          conflictImageIds: conflicts,
        });
      this.assertClearConfirmation(released, input);
      if (work.revision !== input.expectedRevision) this.stale();
      await this.releasePagesTx(
        tx,
        actorId,
        workId,
        participant.id,
        input.stage,
        released,
        input,
      );
      const added = pages
        .filter((p) => !p.participantId && selected.has(p.workImageId))
        .map((p) => p.workImageId);
      if (added.length) {
        await tx.workPageAssignment.updateMany({
          where: {
            workId,
            stage: input.stage,
            workImageId: { in: added },
            participantId: null,
          },
          data: { participantId: participant.id, generation: { increment: 1 } },
        });
        await tx.workStageAssignment.createMany({
          data: added.map((workImageId) => ({
            participantId: participant.id,
            workImageId,
            assignedById: actorId,
          })),
          skipDuplicates: true,
        });
        await tx.workStageParticipant.update({
          where: { id: participant.id },
          data: { leftAt: null, submittedAt: null },
        });
      }
      const transition = stageTransitions[input.stage];
      const lastOwnerLeft =
        !selected.size &&
        released.length > 0 &&
        !pages.some(
          (page) => page.participantId && page.participantId !== participant.id,
        );
      const nextWorkflowStatus =
        lastOwnerLeft && work.workflowStatus === transition.active
          ? transition.pending
          : work.workflowStatus;
      if (!selected.size && released.length)
        await tx.workCreditAlias.deleteMany({
          where: { workId, stage: input.stage, userId: participant.userId },
        });
      await tx.work.update({
        where: { id: workId },
        data: {
          workflowStatus: nextWorkflowStatus,
          revision: { increment: 1 },
          ...(lastOwnerLeft &&
            input.stage === "translate" &&
            work.collaborationMode === "single" && {
              editorEpoch: { increment: 1 },
            }),
        },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          idempotencyKey: input.idempotencyKey,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: nextWorkflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          detail: {
            operation,
            stage: input.stage,
            participantId: participant.id,
            imageIds: input.imageIds,
            clearedImageIds: released,
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
    // Compatibility endpoint follows the unified submit path; there is no second completion gate.
    return this.submitStage(actorId, workId, input);
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

  private async submitTranslationTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    input: SubmitWorkStageDto,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
    );
    const operation = "submit:translate";
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
    const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
    assertProductionWritable(work);
    if (
      ![WorkflowStatus.pending_translate, WorkflowStatus.translating].some(
        (s) => s === work.workflowStatus,
      )
    )
      throw new ConflictException("作品当前阶段不允许提交翻译");
    if (
      work.revision !== input.expectedRevision ||
      work.editorEpoch !== input.expectedEditorEpoch
    )
      this.stale();
    await ensurePageAssignments(tx, workId, "translate");
    const participant = await tx.workStageParticipant.findFirst({
      where: { workId, stage: "translate", userId: actorId, leftAt: null },
    });
    if (!participant) throw new ForbiddenException("需要先认领本人翻译页");
    const pages = await tx.workPageAssignment.findMany({
      where: { workId, stage: "translate" },
      orderBy: { workImage: { orderIndex: "asc" } },
    });
    const own = pages.filter((p) => p.participantId === participant.id);
    if (!own.length) throw new ConflictException("至少负责一页才能提交");
    const pending = own.filter((p) => !pageSubmissionCurrent(p));
    const heads = input.pageHeads ?? [];
    if (
      heads.length !== pending.length ||
      new Set(heads.map((h) => h.imageId)).size !== heads.length ||
      pending.some(
        (p) =>
          !heads.some(
            (h) =>
              h.imageId === p.workImageId &&
              h.generation === p.generation &&
              h.draftRevision === p.draftRevision,
          ),
      )
    ) {
      throw new ConflictException({
        code: "SUBMISSION_PAGE_HEADS_STALE",
        message: "待提交页内容或归属已变化，请刷新后重新确认确切内容",
        pageHeads: pending.map((p) => ({
          imageId: p.workImageId,
          generation: p.generation,
          draftRevision: p.draftRevision,
        })),
      });
    }
    if (!pending.length) throw new ConflictException("本人页面均已提交");
    const now = new Date();
    for (const page of pending)
      await tx.workPageAssignment.update({
        where: { id: page.id },
        data: {
          submittedAt: now,
          submittedGeneration: page.generation,
          submittedRevision: page.draftRevision,
        },
      });
    const complete =
      pages.length > 0 &&
      pages.every(
        (p) => p.participantId === participant.id || pageSubmissionCurrent(p),
      );
    const active = await tx.workStageParticipant.findMany({
      where: { workId, stage: "translate", leftAt: null },
      include: { user: { select: { displayName: true } } },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
    const credited = active
      .filter((p) => pages.some((page) => page.participantId === p.id))
      .sort(
        (a, b) =>
          pages.findIndex((p) => p.participantId === a.id) -
          pages.findIndex((p) => p.participantId === b.id),
      );
    const credit = await tx.workCreditAlias.findUnique({
      where: {
        workId_userId_stage: { workId, userId: actorId, stage: "translate" },
      },
    });
    const ownUser = active.find((p) => p.id === participant.id)!;
    await tx.workStageParticipant.update({
      where: { id: participant.id },
      data: {
        submittedAt: now,
        creditNameSnapshot: credit?.creditName ?? ownUser.user.displayName,
      },
    });
    await tx.stageContributionSubmission.create({
      data: {
        participantId: participant.id,
        createdById: actorId,
        idempotencyKey: input.idempotencyKey,
        pages: {
          create: pending.map((p) => ({
            workImageId: p.workImageId,
            imageRevision: p.draftRevision,
          })),
        },
      },
    });
    const status = complete
      ? WorkflowStatus.pending_proofread
      : work.workflowStatus;
    await tx.work.update({
      where: { id: workId },
      data: {
        workflowStatus: status,
        revision: { increment: 1 },
        productionStartedAt: work.productionStartedAt ?? now,
        ...(complete
          ? {
              editorEpoch: { increment: 1 },
              translationAttentionStage: null,
              translationAttentionVersionNumber: null,
            }
          : {}),
      },
    });
    const version = complete
      ? await this.translations.createStageVersion(tx, {
          actorId,
          workId,
          stage: "translate",
          workRevision: work.revision + 1,
          editorEpoch: work.editorEpoch + 1,
          contributorUserIds: [...new Set(credited.map((p) => p.userId))],
        })
      : null;
    await tx.workEvent.create({
      data: {
        workId,
        actorId,
        action: WorkEventAction.stage_submitted,
        idempotencyKey: input.idempotencyKey,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: status,
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        detail: {
          operation,
          stage: "translate",
          participantIds: complete
            ? credited.map((p) => p.id)
            : [participant.id],
          imageIds: pending.map((p) => p.workImageId),
          editorEpoch: work.editorEpoch + (complete ? 1 : 0),
          ...(version
            ? {
                translationVersionId: version.id,
                translationVersionNumber: version.versionNumber,
                translationVersionKind: version.kind,
              }
            : {}),
          credits: credited.map((p) => ({
            userId: p.userId,
            creditName: p.creditNameSnapshot ?? p.user.displayName,
          })),
        },
      },
    });
  }

  // Shared transaction entry for explicit submissions and atomic batch upload/submit.
  async submitStageTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    input: SubmitWorkStageDto,
  ): Promise<void> {
    await lockAccountMembership(tx);
    await this.assertStagePermission(actorId, input.stage, workId, tx);
    if (input.stage === "publish")
      throw new ConflictException("发布记录模块接入后才能确认发布");
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
    );
    if (input.stage === "translate")
      return this.submitTranslationTx(tx, actorId, workId, input);
    if (input.stage === "typeset") {
      const target = await tx.work.findUniqueOrThrow({
        where: { id: workId },
        select: { collaborationMode: true },
      });
      if (target.collaborationMode === "multi")
        return submitTypesetPagesTx(tx, actorId, workId, input);
    }
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
    const creditedParticipants = active;
    if (input.stage === "proofread")
      await this.translations.assertNoProofreadLeases(
        tx,
        workId,
        work.editorEpoch,
      );
    const now = new Date();
    const nextWorkRevision = work.revision + 1;
    const changesTextVersion = input.stage === "proofread";
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
        productionStartedAt: work.productionStartedAt ?? now,
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
          contributorUserIds: [],
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
      // Account updates acquire this row too, so revocation cannot race authorization.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
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
      await tx.proofreadPageLease.deleteMany({ where: { workId } });
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

  private async cancelTranslationTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    input: CancelWorkStageSubmissionDto,
  ) {
    await lockAccountMembership(tx);
    await this.assertStagePermission(actorId, "translate", workId, tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM works WHERE id=${workId}::uuid FOR UPDATE`,
    );
    const operation = "cancel-submission:translate";
    const action = WorkEventAction.stage_submission_cancelled;
    if (
      await this.isReplayTx(tx, workId, input.idempotencyKey, action, operation)
    )
      return;
    const work = await tx.work.findUniqueOrThrow({
      where: { id: workId },
      include: { proofreadSkippedVersion: true },
    });
    assertProductionWritable(work);
    const early = [
      WorkflowStatus.pending_translate,
      WorkflowStatus.translating,
      WorkflowStatus.pending_proofread,
    ].some((s) => s === work.workflowStatus);
    const skipped =
      work.workflowStatus === "pending_typeset" &&
      !!work.proofreadSkippedVersionId;
    if (!early && !skipped)
      throw new ConflictException("下游已开始处理，不能取消翻译提交");
    if (
      skipped &&
      (work.typesetHandoffStartedAt ||
        work.proofreadSkippedVersion?.handoffStartedAt)
    )
      throw new ConflictException("嵌字已经承接材料，不能取消翻译提交");
    if (
      work.revision !== input.expectedRevision ||
      work.editorEpoch !== input.expectedEditorEpoch
    )
      this.stale();
    const participant = await tx.workStageParticipant.findFirst({
      where: { workId, stage: "translate", userId: actorId, leftAt: null },
    });
    if (!participant)
      throw new ForbiddenException("只有当前译者可以取消本人提交");
    const pages = await tx.workPageAssignment.findMany({
      where: {
        workId,
        stage: "translate",
        participantId: participant.id,
        submittedAt: { not: null },
      },
    });
    if (!pages.length) throw new ConflictException("本人没有可取消的提交");
    await tx.workPageAssignment.updateMany({
      where: { id: { in: pages.map((p) => p.id) } },
      data: {
        submittedAt: null,
        submittedRevision: null,
        submittedGeneration: null,
      },
    });
    await tx.workStageParticipant.update({
      where: { id: participant.id },
      data: { submittedAt: null },
    });
    const rollback = work.workflowStatus === "pending_proofread" || skipped;
    if (rollback) await tx.proofreadPageLease.deleteMany({ where: { workId } });
    await tx.work.update({
      where: { id: workId },
      data: {
        workflowStatus: "translating",
        revision: { increment: 1 },
        ...(rollback
          ? { editorEpoch: { increment: 1 }, proofreadSkippedVersionId: null }
          : {}),
      },
    });
    await tx.workEvent.create({
      data: {
        workId,
        actorId,
        action,
        idempotencyKey: input.idempotencyKey,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: "translating",
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        detail: {
          operation,
          stage: "translate",
          restoredParticipantIds: [participant.id],
          imageIds: pages.map((p) => p.workImageId),
          editorEpoch: work.editorEpoch + (rollback ? 1 : 0),
        },
      },
    });
  }

  async cancelStageSubmission(
    actorId: string,
    workId: string,
    input: CancelWorkStageSubmissionDto,
  ): Promise<WorkDetailDto> {
    await this.assertStagePermission(actorId, input.stage, workId);
    if (input.stage === "translate") {
      await this.db.$transaction((tx) =>
        this.cancelTranslationTx(tx, actorId, workId, input),
      );
      return this.get(workId, actorId);
    }
    if (input.stage === "typeset") {
      const target = await this.db.work.findUniqueOrThrow({
        where: { id: workId },
        select: { collaborationMode: true },
      });
      if (target.collaborationMode === "multi") {
        await this.db.$transaction((tx) =>
          cancelTypesetPagesTx(tx, actorId, workId, input),
        );
        return this.get(workId, actorId);
      }
    }
    const action = WorkEventAction.stage_submission_cancelled;
    const operation = `cancel-submission:${input.stage}`;
    if (await this.isReplay(workId, input.idempotencyKey, action, operation)) {
      return this.get(workId, actorId);
    }

    await this.db.$transaction(async (tx) => {
      await lockAccountMembership(tx);

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
      if (input.stage === "typeset" && work.collaborationMode === "multi") {
        await cancelTypesetPagesTx(tx, actorId, workId, input);
        return;
      }

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
          ...(input.stage === "proofread"
            ? {}
            : { submittedAt: latest.submittedAt }),
          leftAt: null,
        },
        select: { id: true, userId: true },
      });
      if (!submittedRound.some(({ userId }) => userId === actorId)) {
        throw new ForbiddenException("只有本轮提交参与者可以取消提交");
      }
      const restoredUsers = await tx.user.findMany({
        where: { id: { in: submittedRound.map(({ userId }) => userId) } },
        include: { roles: true, languageCapabilities: true },
      });
      if (
        restoredUsers.length !== submittedRound.length ||
        restoredUsers.some(
          (user) =>
            !user.isActive ||
            !canUserWorkStage(
              user.roles.map((r) => r.role),
              user.languageCapabilities.map((l) => l.language),
              input.stage,
              work.sourceLanguage,
            ),
        )
      ) {
        throw new ConflictException(
          "本轮参与者已失去工作资格，请先由管理员恢复职责和语言再取消提交",
        );
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
      if (input.stage === "proofread")
        await tx.proofreadPageLease.deleteMany({ where: { workId } });
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
      participantCount: new Set(
        work.stageParticipants.filter((p) => !p.leftAt).map((p) => p.userId),
      ).size,
      assignedStages: [
        ...new Set(
          work.stageParticipants
            .filter((p) => !p.leftAt)
            .map(({ stage }) => stage),
        ),
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
      hasProductionProgress: Boolean(
        work.productionStartedAt || work.typesetHandoffStartedAt,
      ),
      collaborationMigrationIssue: work.collaborationMigrationIssue,
      pageAssignments: (work.pageAssignments ?? []).map((page) => ({
        id: page.id,
        workImageId: page.workImageId,
        stage: page.stage,
        participantId: page.participantId,
        userId: page.participant?.userId ?? null,
        generation: page.generation,
        draftRevision: page.draftRevision,
        submittedRevision: page.submittedRevision,
        submittedGeneration: page.submittedGeneration,
        submittedAt: pageSubmissionCurrent(page)
          ? page.submittedAt!.toISOString()
          : null,
        isSubmitted: pageSubmissionCurrent(page),
      })),
      participants: work.stageParticipants.map((participant) => {
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
          assignedImageIds:
            participant.stage === "translate" || participant.stage === "typeset"
              ? (work.pageAssignments ?? [])
                  .filter((p) => p.participantId === participant.id)
                  .map((p) => p.workImageId)
              : [],
          contributionSubmittedAt:
            participant.submittedAt?.toISOString() ?? null,
          contributionCurrent:
            participant.stage === "proofread"
              ? Boolean(participant.submittedAt && !participant.leftAt)
              : (work.pageAssignments ?? []).some(
                  (p) => p.participantId === participant.id,
                ) &&
                (work.pageAssignments ?? [])
                  .filter((p) => p.participantId === participant.id)
                  .every(pageSubmissionCurrent),
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
