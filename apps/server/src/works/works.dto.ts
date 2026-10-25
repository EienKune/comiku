import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ReviewStatus,
  SourceLanguage,
  WorkCollaborationMode,
  WorkEventAction,
  WorkflowStatus,
  WorkParticipationMode,
  WorkStage,
} from "../generated/prisma/client.js";
import { coordinatedWorkStages } from "../workflow/workflow-policy.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const optionalBoolean = ({ value }: { value: unknown }) =>
  value === "true" ? true : value === "false" ? false : value;

export enum WorkPhase {
  translation = "translation",
  proofread = "proofread",
  typeset = "typeset",
  pending_publish = "pending_publish",
  published = "published",
}

export enum WorkView {
  todo = "todo",
  recommended = "recommended",
  publish = "publish",
}

export class WorkQueryDto {
  @ApiPropertyOptional({ enum: WorkView, enumName: "WorkView" })
  @IsOptional()
  @IsEnum(WorkView)
  view?: WorkView;

  @ApiPropertyOptional({
    enum: coordinatedWorkStages,
    description: "推荐接取限定到一个具备资格的职责，仅与 recommended 视角组合",
  })
  @IsOptional()
  @IsIn(coordinatedWorkStages)
  claimStage?: (typeof coordinatedWorkStages)[number];

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: WorkPhase, enumName: "WorkPhase" })
  @IsOptional()
  @IsEnum(WorkPhase)
  phase?: WorkPhase;

  @ApiPropertyOptional({ enum: SourceLanguage, enumName: "SourceLanguage" })
  @IsOptional()
  @IsEnum(SourceLanguage)
  sourceLanguage?: SourceLanguage;

  @ApiPropertyOptional({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  @IsOptional()
  @IsEnum(WorkflowStatus)
  workflowStatus?: WorkflowStatus;

  @ApiPropertyOptional({ enum: ReviewStatus, enumName: "ReviewStatus" })
  @IsOptional()
  @IsEnum(ReviewStatus)
  reviewStatus?: ReviewStatus;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  authorId?: string;

  @ApiPropertyOptional({ enum: coordinatedWorkStages })
  @IsOptional()
  @IsIn(coordinatedWorkStages)
  unassignedStage?: (typeof coordinatedWorkStages)[number];

  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  mine = false;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 24;
}

export class WorkImageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
}

export class WorkParticipantDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "头像文件标识，仅用于读取与缓存更新，不可由资料 PATCH 写入",
  })
  avatarVersion?: string | null;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage" }) stage!: WorkStage;
  @ApiProperty({
    enum: WorkParticipationMode,
    enumName: "WorkParticipationMode",
  })
  participationMode!: WorkParticipationMode;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "当前用户针对本作品、本职责设置的临时署名",
  })
  workCreditName!: string | null;
  @ApiProperty({ type: String, nullable: true }) creditNameSnapshot!:
    string | null;
  @ApiProperty({ type: String, format: "date-time" }) joinedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  submittedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  leftAt!: string | null;
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  assignedImageIds!: string[];
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  contributionSubmittedAt!: string | null;
  @ApiProperty({ type: Boolean }) contributionCurrent!: boolean;
}

export class WorkEventDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: WorkEventAction, enumName: "WorkEventAction" })
  action!: WorkEventAction;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) actorId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ enum: WorkflowStatus, nullable: true })
  fromWorkflowStatus!: WorkflowStatus | null;
  @ApiProperty({ enum: WorkflowStatus, nullable: true })
  toWorkflowStatus!: WorkflowStatus | null;
  @ApiProperty({ enum: ReviewStatus, nullable: true })
  fromReviewStatus!: ReviewStatus | null;
  @ApiProperty({ enum: ReviewStatus, nullable: true })
  toReviewStatus!: ReviewStatus | null;
  @ApiProperty({ type: Object }) detail!: object;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class PersonalWorkTaskDto {
  @ApiPropertyOptional({ type: String, nullable: true }) revisionCaseId?:
    string | null;
  @ApiProperty({ enum: coordinatedWorkStages })
  stage!: (typeof coordinatedWorkStages)[number];
  @ApiProperty({ type: Boolean }) readyToStart!: boolean;
  @ApiProperty({ type: Boolean }) contributionCurrent!: boolean;
}

export class WorkDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  requiredHandoffVersionId?: string | null;
  @ApiPropertyOptional({ type: Boolean }) typesetReviewRequired?: boolean;
  @ApiProperty({ type: Boolean }) proofreadingSkipped!: boolean;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  proofreadSkipHandoffStartedAt!: string | null;
  @ApiPropertyOptional({ type: PersonalWorkTaskDto, isArray: true })
  personalTasks?: PersonalWorkTaskDto[];
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number, minimum: 1 }) workNumber!: number;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ enum: SourceLanguage, enumName: "SourceLanguage" })
  sourceLanguage!: SourceLanguage;
  @ApiProperty({
    enum: WorkCollaborationMode,
    enumName: "WorkCollaborationMode",
  })
  collaborationMode!: WorkCollaborationMode;
  @ApiProperty({ type: String, nullable: true }) sourcePostUrl!: string | null;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ enum: ReviewStatus, enumName: "ReviewStatus" })
  reviewStatus!: ReviewStatus;
  @ApiProperty({ type: Number }) priority!: number;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number, minimum: 0 }) editorEpoch!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  typesetHandoffStartedAt!: string | null;
  @ApiProperty({ enum: WorkStage, nullable: true })
  translationAttentionStage!: WorkStage | null;
  @ApiProperty({ type: Number, minimum: 1, nullable: true })
  translationAttentionVersionNumber!: number | null;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  coverImageId!: string | null;
  @ApiProperty({ type: Number }) participantCount!: number;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage", isArray: true })
  assignedStages!: WorkStage[];
  @ApiProperty({ type: String, format: "date-time" }) importedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  publishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class WorkDetailDto extends WorkDto {
  @ApiProperty({ type: Boolean }) canSkipProofreading!: boolean;
  @ApiProperty({ type: String, nullable: true })
  skipProofreadingUnavailableReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceText!: string | null;
  @ApiProperty({ type: WorkImageDto, isArray: true }) images!: WorkImageDto[];
  @ApiProperty({ type: WorkParticipantDto, isArray: true })
  participants!: WorkParticipantDto[];
  @ApiProperty({ type: WorkEventDto, isArray: true }) events!: WorkEventDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  openReviewCaseId!: string | null;
}

export class WorkPhaseCountDto {
  @ApiProperty({ enum: WorkPhase, enumName: "WorkPhase" }) phase!: WorkPhase;
  @ApiProperty({ type: Number, minimum: 0 }) count!: number;
}

export class WorkClaimCountDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  stage!: (typeof coordinatedWorkStages)[number];
  @ApiProperty({ type: Number, minimum: 0 }) count!: number;
}
export class WorkPageDto {
  @ApiProperty({
    type: WorkClaimCountDto,
    isArray: true,
    description: "仅返回本人具备工作资格的职责，零数量仍保留",
  })
  claimCounts!: WorkClaimCountDto[];
  @ApiProperty({
    type: Number,
    minimum: 0,
    description: "本人可处理的正常待发布作品数",
  })
  publishTotal!: number;
  @ApiProperty({ type: Number, minimum: 0 }) todoTotal!: number;
  @ApiProperty({ type: WorkDto, isArray: true }) items!: WorkDto[];
  @ApiProperty({ type: Number, minimum: 0 }) total!: number;
  @ApiProperty({ type: WorkPhaseCountDto, isArray: true })
  phaseCounts!: WorkPhaseCountDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}

export class WorkMutationDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class JoinWorkStageDto extends WorkMutationDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  @IsIn(coordinatedWorkStages)
  stage!: (typeof coordinatedWorkStages)[number];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 100,
    description: "当前用户在本作品对应职责中的临时署名",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  creditName?: string;
}

export class WorkClaimItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  id!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class ClaimWorkStagesDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  @IsIn(coordinatedWorkStages)
  stage!: (typeof coordinatedWorkStages)[number];

  @ApiProperty({ type: WorkClaimItemDto, isArray: true, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((item: WorkClaimItemDto) => item.id)
  @ValidateNested({ each: true })
  @Type(() => WorkClaimItemDto)
  items!: WorkClaimItemDto[];
}

export enum WorkClaimOutcome {
  succeeded = "succeeded",
  conflict = "conflict",
  forbidden = "forbidden",
  not_found = "not_found",
  failed = "failed",
}

export class WorkClaimResultDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: WorkClaimOutcome, enumName: "WorkClaimOutcome" })
  outcome!: WorkClaimOutcome;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
}

export class WorkClaimBatchResultDto {
  @ApiProperty({ type: WorkClaimResultDto, isArray: true })
  results!: WorkClaimResultDto[];
}

export class UpdateStageCreditDto extends WorkMutationDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  @IsIn(coordinatedWorkStages)
  stage!: (typeof coordinatedWorkStages)[number];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 100,
    description: "当前作品对应职责的临时署名；null 表示恢复使用成员昵称",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  creditName?: string | null;
}

export class LeaveWorkStageDto extends WorkMutationDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  @IsIn(coordinatedWorkStages)
  stage!: (typeof coordinatedWorkStages)[number];
}

export class SubmitWorkStageDto extends WorkMutationDto {
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage" })
  @IsEnum(WorkStage)
  stage!: WorkStage;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}

export class CancelWorkStageSubmissionDto extends WorkMutationDto {
  @ApiProperty({
    enum: [WorkStage.translate, WorkStage.proofread, WorkStage.typeset],
  })
  @IsIn([WorkStage.translate, WorkStage.proofread, WorkStage.typeset])
  stage!: WorkStage;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}

export class SkipProofreadingDto extends WorkMutationDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  confirmCancelClaims!: boolean;

  @ApiProperty({ type: String, format: "uuid", isArray: true, maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  proofreadParticipantIds!: string[];
}

export class UpdateWorkDto extends WorkMutationDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 10000,
    description: "作品发布正文；独立于原帖配文，null 或空白表示清空",
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() || null : value,
  )
  @IsString()
  @MaxLength(10000)
  publicationBody?: string | null;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 200 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;
}

export class UpdateWorkCollaborationDto extends WorkMutationDto {
  @ApiProperty({
    enum: WorkCollaborationMode,
    enumName: "WorkCollaborationMode",
  })
  @IsEnum(WorkCollaborationMode)
  collaborationMode!: WorkCollaborationMode;
}

export class UpdateStageAssignmentsDto extends WorkMutationDto {
  @ApiProperty({ enum: coordinatedWorkStages })
  @IsIn(coordinatedWorkStages)
  stage!: (typeof coordinatedWorkStages)[number];

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  participantId?: string;

  @ApiProperty({
    type: String,
    format: "uuid",
    isArray: true,
    minItems: 0,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  imageIds!: string[];
}

export class CompleteStageContributionDto extends WorkMutationDto {
  @ApiProperty({ enum: [WorkStage.translate, WorkStage.proofread] })
  @IsIn([WorkStage.translate, WorkStage.proofread])
  stage!: WorkStage;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}

export class SignedWorkImageUrlDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
}
