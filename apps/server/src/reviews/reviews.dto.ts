import { ReviewRevisionDto } from "./review-revisions.dto.js";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  Equals,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ReviewPurpose,
  ReviewCaseStatus,
  ReviewResolution,
  ReviewStatus,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { WorkMutationDto } from "../works/works.dto.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class OpenReviewCaseDto extends WorkMutationDto {
  @ApiPropertyOptional({
    enum: [ReviewPurpose.production_decision],
    description: "旧客户端兼容字段；新请求可省略，仅允许内容制作判断。",
  })
  @IsOptional()
  @Equals(ReviewPurpose.production_decision, { message: "内容修订审核已停用" })
  purpose?: ReviewPurpose;
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditorEpoch?: number;
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class WithdrawReviewCaseDto extends WorkMutationDto {
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditorEpoch?: number;
}

export class ResolveReviewCaseDto extends WithdrawReviewCaseDto {
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  confirmDiscard?: boolean;
  @ApiProperty({
    enum: [
      ReviewResolution.continue_production,
      ReviewResolution.discard,
      ReviewResolution.restore_production,
    ],
  })
  @IsEnum({
    continue_production: ReviewResolution.continue_production,
    discard: ReviewResolution.discard,
    restore_production: ReviewResolution.restore_production,
  })
  resolution!: ReviewResolution;

  @ApiPropertyOptional({
    enum: WorkflowStatus,
    enumName: "WorkflowStatus",
    description: "停用字段；传入任何目标阶段都会被拒绝。",
  })
  @IsOptional()
  @IsEnum(WorkflowStatus)
  targetWorkflowStatus?: WorkflowStatus;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string;
}

export class ReviewQueryDto {
  @ApiPropertyOptional({ enum: ["true", "false"] })
  @IsOptional()
  @IsEnum({ true: "true", false: "false" })
  discardedOnly?: string;
  @ApiPropertyOptional({
    enum: ReviewCaseStatus,
    enumName: "ReviewCaseStatus",
    default: ReviewCaseStatus.open,
  })
  @IsOptional()
  @IsEnum(ReviewCaseStatus)
  status: ReviewCaseStatus = ReviewCaseStatus.open;

  @ApiPropertyOptional({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  @IsOptional()
  @IsEnum(WorkflowStatus)
  openedFromWorkflowStatus?: WorkflowStatus;

  @ApiPropertyOptional({ enum: ReviewStatus, enumName: "ReviewStatus" })
  @IsOptional()
  @IsEnum(ReviewStatus)
  reviewStatus?: ReviewStatus;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  authorId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  openedById?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}

export class ReviewCaseDto {
  @ApiProperty({ type: ReviewRevisionDto, nullable: true })
  contentRevision!: ReviewRevisionDto | null;
  @ApiProperty({ enum: ReviewPurpose, enumName: "ReviewPurpose" })
  purpose!: ReviewPurpose;
  @ApiProperty({ type: Number }) editorEpoch!: number;
  @ApiProperty({ type: Boolean }) canWithdraw!: boolean;
  @ApiProperty({ type: Boolean }) canRestore!: boolean;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  restoredAt!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: String }) workTitle!: string;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ enum: WorkflowStatus }) workflowStatus!: WorkflowStatus;
  @ApiProperty({ enum: ReviewStatus }) reviewStatus!: ReviewStatus;
  @ApiProperty({ enum: WorkflowStatus })
  openedFromWorkflowStatus!: WorkflowStatus;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  openedTypesetVersionId!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  openedTypesetVersionNumber!: number | null;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ enum: ReviewCaseStatus }) status!: ReviewCaseStatus;
  @ApiProperty({ type: String, format: "uuid" }) openedById!: string;
  @ApiProperty({ type: String }) openedByName!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) resolvedById!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedByName!: string | null;
  @ApiProperty({
    enum: ReviewResolution,
    enumName: "ReviewResolution",
    nullable: true,
  })
  resolution!: ReviewResolution | null;
  @ApiProperty({ enum: WorkflowStatus, nullable: true })
  targetWorkflowStatus!: WorkflowStatus | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote!: string | null;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  resolvedAt!: string | null;
}

export class ReviewCasePageDto {
  @ApiProperty({ type: ReviewCaseDto, isArray: true }) items!: ReviewCaseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}
