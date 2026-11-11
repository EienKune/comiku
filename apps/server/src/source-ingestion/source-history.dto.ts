import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  SourceAccountTaskStatus,
  SourceAdapterHealth,
  SourceFetchItemStatus,
  SourceFetchRunStatus,
  SourceFetchTrigger,
  JobStatus,
} from "../generated/prisma/client.js";

export class SourceRunQueryDto {
  @ApiPropertyOptional({ type: Number, default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ type: String, maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
  @ApiPropertyOptional({
    enum: SourceFetchTrigger,
    enumName: "SourceFetchTrigger",
  })
  @IsOptional()
  @IsEnum(SourceFetchTrigger)
  trigger?: SourceFetchTrigger;
  @ApiPropertyOptional({
    enum: SourceFetchRunStatus,
    enumName: "SourceFetchRunStatus",
  })
  @IsOptional()
  @IsEnum(SourceFetchRunStatus)
  status?: SourceFetchRunStatus;
}
const taskFilters = [
  "all",
  "anomalies",
  "active",
  ...Object.values(SourceAccountTaskStatus),
  SourceFetchItemStatus.skipped,
] as const;
export class SourceTaskQueryDto {
  @ApiPropertyOptional({ type: Number, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ type: String, maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
  @ApiPropertyOptional({ type: String, maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
  @ApiPropertyOptional({ enum: taskFilters, default: "all" })
  @IsOptional()
  @IsIn(taskFilters)
  status?: (typeof taskFilters)[number];
  @ApiPropertyOptional({ type: String, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
export class SourceRunSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: SourceFetchTrigger, enumName: "SourceFetchTrigger" })
  trigger!: SourceFetchTrigger;
  @ApiProperty({ enum: SourceFetchRunStatus, enumName: "SourceFetchRunStatus" })
  status!: SourceFetchRunStatus;
  @ApiProperty({ type: String, format: "date-time" }) startedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
  @ApiProperty({ type: Boolean }) legacy!: boolean;
  @ApiProperty({ type: Number }) targetCount!: number;
  @ApiProperty({ type: Number }) completedTargets!: number;
  @ApiProperty({ type: Number }) succeededTargets!: number;
  @ApiProperty({ type: Number }) failedTargets!: number;
  @ApiProperty({ type: Number }) runningTargets!: number;
  @ApiProperty({ type: Number }) queuedTargets!: number;
  @ApiProperty({ type: Number }) waitingTargets!: number;
  @ApiProperty({ type: Number }) anomalyTargets!: number;
  @ApiProperty({ type: Number }) pagesFetched!: number;
  @ApiProperty({ type: Number }) candidatesCreated!: number;
  @ApiProperty({ type: Number }) mediaStored!: number;
}
export class SourceRunPageDto {
  @ApiProperty({ type: SourceRunSummaryDto, isArray: true })
  items!: SourceRunSummaryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
}
export class SourceTaskRowDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Task ID, or result-item ID for legacy runs",
  })
  id!: string;
  @ApiProperty({ type: String, format: "uuid" }) accountId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String, nullable: true }) handle!: string | null;
  @ApiProperty({ type: String }) externalUserId!: string;
  @ApiProperty({
    enum: [
      ...Object.values(SourceAccountTaskStatus),
      SourceFetchItemStatus.skipped,
    ],
  })
  status!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Controlled reason only; arbitrary upstream text is omitted",
  })
  failureCode!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  startedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  deferredUntil!: string | null;
  @ApiProperty({ type: Boolean }) legacy!: boolean;
  @ApiProperty({ type: Number }) pagesFetched!: number;
  @ApiProperty({ type: Number }) candidatesCreated!: number;
  @ApiProperty({ type: Number }) mediaStored!: number;
}
export class SourceTaskPageDto {
  @ApiProperty({ type: SourceTaskRowDto, isArray: true })
  items!: SourceTaskRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
  @ApiProperty({ type: Boolean }) legacy!: boolean;
}
export class SourceAccountCurrentDto {
  @ApiProperty({ type: Boolean }) fetchEnabled!: boolean;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  deletedAt!: string | null;
  @ApiProperty({
    enum: SourceAdapterHealth,
    enumName: "SourceAdapterHealth",
    nullable: true,
  })
  adapterHealth!: SourceAdapterHealth | null;
  @ApiProperty({
    type: Number,
    description:
      "All current unresolved known posts for this account; not attributed to the selected run",
  })
  unresolvedGapCount!: number;
  @ApiProperty({ type: Number }) excludedGapCount!: number;
}
export class SourceFollowupSuccessDto {
  @ApiProperty({ type: String, format: "uuid" }) taskId!: string;
  @ApiProperty({ type: String, format: "uuid" }) runId!: string;
  @ApiProperty({ type: String, format: "date-time" }) completedAt!: string;
}
export class SourceTaskJobDto {
  @ApiProperty({ enum: JobStatus, enumName: "JobStatus" }) status!: JobStatus;
  @ApiProperty({
    type: Number,
    description: "This task's consumed job budget; never a batch retry count",
  })
  attempts!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description:
      "Earliest queued execution time; not a promise that a source gate will admit it",
  })
  nextAvailableAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextRetryAt!: string | null;
}
export class SourceTaskDetailDto {
  @ApiProperty({ type: SourceTaskRowDto }) original!: SourceTaskRowDto;
  @ApiProperty({ type: SourceAccountCurrentDto, nullable: true })
  current!: SourceAccountCurrentDto | null;
  @ApiProperty({ type: SourceFollowupSuccessDto, nullable: true })
  followupSuccess!: SourceFollowupSuccessDto | null;
  @ApiProperty({ type: SourceTaskJobDto, nullable: true })
  job!: SourceTaskJobDto | null;
  @ApiProperty({
    type: Boolean,
    description: "False for legacy summary-only history",
  })
  executionHistoryAvailable!: boolean;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
}

export class SourceEvidenceQueryDto {
  @ApiPropertyOptional({ type: Number, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ type: String, maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}
export class SourceDiagnosticSampleDto {
  @ApiProperty({ type: String }) stage!: string;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ type: String }) scope!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  occurredAt!: string | null;
  @ApiPropertyOptional({ type: Number }) httpStatus?: number;
  @ApiPropertyOptional({ type: Number }) limitBytes?: number;
  @ApiPropertyOptional({ type: Number }) declaredBytes?: number;
  @ApiPropertyOptional({ type: Number }) observedBytes?: number;
  @ApiPropertyOptional({ type: Number }) durationMs?: number;
  @ApiPropertyOptional({ type: Boolean }) timeout?: boolean;
}
export class SourceExecutionDiagnosticsDto {
  @ApiProperty({ type: SourceDiagnosticSampleDto, isArray: true, maxItems: 8 })
  samples!: SourceDiagnosticSampleDto[];
  @ApiProperty({ type: Number }) omitted!: number;
}
export class SourceExecutionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: ["scan"] }) kind!: "scan";
  @ApiProperty({ type: Number }) budgetAttempt!: number;
  @ApiProperty({ type: Boolean }) budgetRefunded!: boolean;
  @ApiProperty({ type: String, format: "date-time" }) admittedAt!: string;
  @ApiProperty({
    enum: ["succeeded", "partial_failed", "failed", "deferred"],
    nullable: true,
  })
  businessOutcome!:
    "succeeded" | "partial_failed" | "failed" | "deferred" | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  businessFinishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  settledAt!: string | null;
  @ApiProperty({ type: SourceExecutionDiagnosticsDto })
  diagnostics!: SourceExecutionDiagnosticsDto;
}
export class SourceExecutionPageDto {
  @ApiProperty({ type: SourceExecutionDto, isArray: true })
  items!: SourceExecutionDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
  @ApiProperty({
    enum: ["scan"],
    description:
      "Only directly linked scan executions; recovery is not inferred from account identity",
  })
  scope!: "scan";
  @ApiProperty({ type: Boolean }) legacy!: boolean;
}
export class SourceGapCampaignDto {
  @ApiProperty({ type: Number }) number!: number;
  @ApiProperty({ type: String }) state!: string;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) startedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}
export class SourceGapDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({
    type: String,
    description: "Public source post identity, not a download URL",
  })
  postId!: string;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String }) state!: string;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({
    type: Number,
    description:
      "Completed failed recovery campaigns recorded on this known post",
  })
  attempts!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextRetryAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: SourceGapCampaignDto, nullable: true })
  campaign!: SourceGapCampaignDto | null;
}
export class SourceGapPageDto {
  @ApiProperty({ type: SourceGapDto, isArray: true }) items!: SourceGapDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
  @ApiProperty({
    enum: ["current_account"],
    description:
      "Current unresolved known posts for the account across all runs; no selected-run attribution",
  })
  scope!: "current_account";
  @ApiProperty({ type: Boolean }) legacy!: boolean;
}
