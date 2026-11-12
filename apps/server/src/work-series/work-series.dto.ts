import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { ReviewStatus, WorkflowStatus } from "../generated/prisma/client.js";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const boolean = ({ value }: { value: unknown }) =>
  value === "true" ? true : value === "false" ? false : value;

export class WorkSeriesImportIntentDto {
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  seriesId?: string;
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  createTitle?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  requestId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  label?: string | null;
}

export class WorkSeriesQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  authorId?: string;
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  search?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(boolean)
  @IsBoolean()
  includeArchived?: boolean;
}
export class WorkSeriesEntriesQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
  @ApiPropertyOptional({ type: Number, default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(boolean)
  @IsBoolean()
  includeHistory?: boolean;
}
export class WorkSeriesContextQueryDto {
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(boolean)
  @IsBoolean()
  includeHistory?: boolean;
}
export class WorkSeriesWriteDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "同一写入意图重试时保留，变更内容须换用新标识。",
  })
  @IsUUID()
  requestId!: string;
}
export class WorkSeriesRevisionDto extends WorkSeriesWriteDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
export class CreateWorkSeriesDto extends WorkSeriesWriteDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() authorId!: string;
  @ApiProperty({ type: String, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    isArray: true,
    maxItems: 100,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  workIds?: string[];
}
export class UpdateWorkSeriesDto extends WorkSeriesRevisionDto {
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;
  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  archived?: boolean;
}
export class AddWorkSeriesEntriesDto extends WorkSeriesRevisionDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    isArray: true,
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  workIds!: string[];
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "省略为末尾，null为首位，ID为放到该条目之后。",
  })
  @IsOptional()
  @IsUUID()
  afterEntryId?: string | null;
}
export class UpdateWorkSeriesEntryDto extends WorkSeriesRevisionDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  label?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "省略不移动，null为首位。",
  })
  @IsOptional()
  @IsUUID()
  afterEntryId?: string | null;
}
export class WorkSeriesCoverDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: String, format: "uuid" }) imageId!: string;
}
export class WorkSeriesSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) memberCount!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: WorkSeriesCoverDto, isArray: true, maxItems: 3 })
  coverImages!: WorkSeriesCoverDto[];
}
export class WorkSeriesEntryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ enum: ReviewStatus, enumName: "ReviewStatus" })
  reviewStatus!: ReviewStatus;
  @ApiProperty({ type: Boolean }) archived!: boolean;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) coverImageId!:
    string | null;
}
export class WorkSeriesPageDto {
  @ApiProperty({ type: WorkSeriesSummaryDto, isArray: true })
  items!: WorkSeriesSummaryDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class WorkSeriesDetailDto extends WorkSeriesSummaryDto {
  @ApiProperty({ type: Boolean }) archived!: boolean;
  @ApiProperty({ type: Number }) visibleTotal!: number;
  @ApiProperty({ type: WorkSeriesEntryDto, isArray: true })
  entries!: WorkSeriesEntryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class WorkSeriesContextDto {
  @ApiProperty({ type: WorkSeriesSummaryDto, nullable: true })
  series!: WorkSeriesSummaryDto | null;
  @ApiProperty({ type: WorkSeriesEntryDto, nullable: true })
  currentEntry!: WorkSeriesEntryDto | null;
  @ApiProperty({ type: WorkSeriesEntryDto, nullable: true })
  previous!: WorkSeriesEntryDto | null;
  @ApiProperty({ type: WorkSeriesEntryDto, nullable: true })
  next!: WorkSeriesEntryDto | null;
}
