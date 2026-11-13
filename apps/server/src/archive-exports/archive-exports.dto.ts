import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export const archiveContents = ["raw", "rendered", "both"] as const;
export type ArchiveContent = (typeof archiveContents)[number];
export const archiveRunStatuses = [
  "queued",
  "preparing",
  "generating",
  "succeeded",
  "partial",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type ArchiveRunStatus = (typeof archiveRunStatuses)[number];
export const archiveFilesStatuses = [
  "available",
  "deleting",
  "deleted",
  "delete_failed",
] as const;
export type ArchiveFilesStatus = (typeof archiveFilesStatuses)[number];

export class ArchiveExportScopeDto {
  @ApiProperty({ type: Number, minimum: 2000, maximum: 9998 })
  @IsInt()
  @Min(2000)
  @Max(9998)
  year!: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number | null;
  @ApiProperty({ enum: archiveContents })
  @IsIn(archiveContents)
  content!: ArchiveContent;
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  includeArchived?: boolean;
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  includeDiscarded?: boolean;
}
export class CreateArchiveExportDto extends ArchiveExportScopeDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}
export class ArchiveExportMutationDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}
export class DeleteArchiveExportFilesDto extends ArchiveExportMutationDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  @IsBoolean()
  @Equals(true)
  confirmedDownloaded!: true;
}
export class ArchiveExportSettingsInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1024,
    description: "0 means unlimited",
  })
  @IsInt()
  @Min(0)
  @Max(1024)
  bandwidthLimitMiB!: number;
}
export class ArchiveExportSettingsDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) bandwidthLimitMiB!: number;
  @ApiProperty({ type: String }) packageTargetBytes!: string;
  @ApiProperty({ type: Number }) retentionDays!: number;
}
export class ArchiveExportPreviewDto {
  @ApiProperty({ type: Number }) workCount!: number;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: Number }) textCount!: number;
  @ApiProperty({ type: Number }) missingRenderedCount!: number;
  @ApiProperty({ type: String }) estimatedBytes!: string;
  @ApiProperty({ type: Number }) warningCount!: number;
  @ApiProperty({ type: Number }) failureCount!: number;
}
export class ArchiveExportRunDto extends ArchiveExportPreviewDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ enum: archiveRunStatuses }) status!: ArchiveRunStatus;
  @ApiProperty({ type: Number }) year!: number;
  @ApiProperty({ type: Number, nullable: true }) month!: number | null;
  @ApiProperty({ enum: archiveContents }) content!: ArchiveContent;
  @ApiProperty({ type: Boolean }) includeArchived!: boolean;
  @ApiProperty({ type: Boolean }) includeDiscarded!: boolean;
  @ApiProperty({ type: String }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) expiresAt!: string | null;
  @ApiProperty({ type: Number }) packageCount!: number;
  @ApiProperty({ type: Number }) completedPackageCount!: number;
  @ApiProperty({ type: Number }) capturedMonthCount!: number;
  @ApiProperty({ type: String }) completedBytes!: string;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ enum: archiveFilesStatuses }) filesStatus!: ArchiveFilesStatus;
  @ApiProperty({ type: String, nullable: true }) filesDeletedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) deletionError!: string | null;
}
export class ArchiveExportPageQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
export class ArchiveExportListDto {
  @ApiProperty({ type: ArchiveExportRunDto, isArray: true })
  items!: ArchiveExportRunDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ArchiveExportPackageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number }) ordinal!: number;
  @ApiProperty({
    type: String,
    enum: [
      "queued",
      "generating",
      "succeeded",
      "failed",
      "cancelled",
      "deleted",
    ],
  })
  status!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: String, nullable: true }) bytes!: string | null;
  @ApiProperty({ type: String, nullable: true }) checksum!: string | null;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: Boolean }) downloadable!: boolean;
}
export class ArchiveExportPackageListDto {
  @ApiProperty({ type: ArchiveExportPackageDto, isArray: true })
  items!: ArchiveExportPackageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ArchiveExportIssueDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, isArray: true }) codes!: string[];
}
export class ArchiveExportIssueListDto {
  @ApiProperty({ type: ArchiveExportIssueDto, isArray: true })
  items!: ArchiveExportIssueDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ArchiveExportDownloadDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
  @ApiProperty({ type: String }) fileName!: string;
}
