import { Transform, Type } from "class-transformer";
import {
  IMAGE_ANALYSIS_LABEL_TONES,
  type ImageAnalysisLabelPresentation,
} from "../image-analysis/image-analysis-adapter.js";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  CandidateStatus,
  CandidateUploadItemStatus,
  CandidateUploadSessionStatus,
  ReferencedPostType,
  SourceLanguage,
  CandidateVisualClass,
  CandidateTagDisposition,
  CandidateTagGroupKind,
} from "../generated/prisma/client.js";
import {
  MANUAL_UPLOAD_MAX_FILE_BYTES,
  MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
} from "./manual-candidate-upload.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CandidateQueryDto {
  @ApiPropertyOptional({ enum: CandidateStatus, enumName: "CandidateStatus" })
  @IsOptional()
  @IsEnum(CandidateStatus)
  status?: CandidateStatus;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  authorId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: SourceLanguage, enumName: "SourceLanguage" })
  @IsOptional()
  @IsEnum(SourceLanguage)
  sourceLanguage?: SourceLanguage;

  @ApiPropertyOptional({
    enum: ["valid_manga", "neutral_manga", "blocked_manga", "photo"],
  })
  @IsOptional()
  @IsIn(["valid_manga", "neutral_manga", "blocked_manga", "photo"])
  triageGroup?: "valid_manga" | "neutral_manga" | "blocked_manga" | "photo";

  @ApiPropertyOptional({ type: String, format: "date-time" })
  @IsOptional()
  @IsDateString()
  fetchedAfter?: string;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  @IsOptional()
  @IsDateString()
  fetchedBefore?: string;

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

export class CandidateMediaDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) externalMediaId!: string;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: String }) mediaType!: string;
}

export class CandidateClassificationTagDto implements ImageAnalysisLabelPresentation {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ enum: IMAGE_ANALYSIS_LABEL_TONES })
  tone!: ImageAnalysisLabelPresentation["tone"];
}

export class CandidateDto {
  @ApiPropertyOptional({ type: Boolean }) canRetryAnalysis?: boolean;
  @ApiPropertyOptional({ type: CandidateClassificationTagDto, isArray: true })
  classificationTags?: CandidateClassificationTagDto[];
  @ApiPropertyOptional({
    enum: ["high", "medium", "low", "unprocessed", "queued", "failed"],
  })
  reviewPriority?:
    "high" | "medium" | "low" | "unprocessed" | "queued" | "failed";
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: String, nullable: true }) authorHandle!: string | null;
  @ApiProperty({ type: Boolean }) authorAvatarAvailable!: boolean;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ enum: SourceLanguage, enumName: "SourceLanguage" })
  sourceLanguage!: SourceLanguage;
  @ApiProperty({ type: String, isArray: true }) sourceAdapters!: string[];
  @ApiProperty({ type: String, isArray: true }) hashtags!: string[];
  @ApiProperty({
    enum: CandidateTagDisposition,
    enumName: "CandidateTagDisposition",
  })
  tagDisposition!: CandidateTagDisposition;
  @ApiProperty({ enum: CandidateVisualClass, enumName: "CandidateVisualClass" })
  visualClass!: CandidateVisualClass;
  @ApiProperty({ enum: ["human", "model", "default"] })
  visualClassSource!: "human" | "model" | "default";
  @ApiProperty({ type: Number, nullable: true })
  classificationRevision!: number | null;
  @ApiProperty({ type: String }) externalPostId!: string;
  @ApiProperty({ type: String, nullable: true }) externalPostUrl!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) text!: string | null;
  @ApiProperty({
    enum: ReferencedPostType,
    nullable: true,
    enumName: "ReferencedPostType",
  })
  referencedPostType!: ReferencedPostType | null;
  @ApiProperty({ type: String, nullable: true }) referencedPostId!:
    string | null;
  @ApiProperty({ enum: CandidateStatus, enumName: "CandidateStatus" })
  status!: CandidateStatus;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: CandidateMediaDto, isArray: true })
  media!: CandidateMediaDto[];
  @ApiProperty({ type: String, format: "date-time" }) postedAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) fetchedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  reviewedAt!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) workId!:
    string | null;
}

export class CandidatePageDto {
  @ApiPropertyOptional({ type: Boolean }) analysisPending?: boolean;
  @ApiProperty({ type: CandidateDto, isArray: true }) items!: CandidateDto[];
  @ApiProperty({ type: Number, minimum: 0 }) total!: number;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}

export class UpdateManualCandidateDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  authorId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(4000)
  text?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @Transform(trimmed)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string | null;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class CandidateTagGroupDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({
    enum: CandidateTagGroupKind,
    enumName: "CandidateTagGroupKind",
  })
  kind!: CandidateTagGroupKind;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, isArray: true }) aliases!: string[];
  @ApiProperty({ type: Number }) revision!: number;
}

export class CreateCandidateTagGroupDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    enum: CandidateTagGroupKind,
    enumName: "CandidateTagGroupKind",
  })
  @IsEnum(CandidateTagGroupKind)
  kind!: CandidateTagGroupKind;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ type: String, isArray: true, minItems: 1, maxItems: 30 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  aliases!: string[];
}

export class UpdateCandidateTagGroupDto extends CreateCandidateTagGroupDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class SetCandidateClassificationDto {
  @ApiProperty({ enum: CandidateVisualClass, enumName: "CandidateVisualClass" })
  @IsEnum(CandidateVisualClass)
  label!: CandidateVisualClass;

  @ApiProperty({ type: Number, minimum: 0, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  expectedRevision!: number | null;
}

export enum CandidateAction {
  import = "import",
  discard = "discard",
  restore = "restore",
}

export class CandidateActionItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  id!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class CandidateBatchActionDto {
  @ApiProperty({ enum: CandidateAction, enumName: "CandidateAction" })
  @IsEnum(CandidateAction)
  action!: CandidateAction;

  @ApiProperty({ type: CandidateActionItemDto, isArray: true, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((item: CandidateActionItemDto) => item.id)
  @ValidateNested({ each: true })
  @Type(() => CandidateActionItemDto)
  items!: CandidateActionItemDto[];
}

export enum CandidateActionOutcome {
  succeeded = "succeeded",
  unchanged = "unchanged",
  conflict = "conflict",
  not_found = "not_found",
  failed = "failed",
}

export class CandidateActionResultDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({
    enum: CandidateActionOutcome,
    enumName: "CandidateActionOutcome",
  })
  outcome!: CandidateActionOutcome;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) workId!:
    string | null;
}

export class CandidateBatchResultDto {
  @ApiProperty({ type: CandidateActionResultDto, isArray: true })
  results!: CandidateActionResultDto[];
}

export class SignedFileUrlDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
}

export class ManualCandidateUploadDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  authorId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(4000)
  text?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @Transform(trimmed)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string | null;
}

export enum ManualUploadOutcome {
  created = "created",
  failed = "failed",
}

export class ManualUploadItemResultDto {
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ enum: ManualUploadOutcome, enumName: "ManualUploadOutcome" })
  outcome!: ManualUploadOutcome;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
  @ApiProperty({ type: String, isArray: true }) warnings!: string[];
  @ApiProperty({ type: CandidateDto, nullable: true })
  candidate!: CandidateDto | null;
}

export class ManualUploadResultDto {
  @ApiProperty({ type: ManualUploadItemResultDto, isArray: true })
  results!: ManualUploadItemResultDto[];
}

export class CandidateUploadFileDto {
  @ApiProperty({ type: String, maxLength: 255 })
  @Transform(trimmed)
  @IsString()
  @MaxLength(255)
  @Matches(/^[^\p{Cc}]+$/u)
  sourceName!: string;

  @ApiProperty({
    enum: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/zip",
    ],
  })
  @IsIn([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/zip",
  ])
  contentType!: string;

  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: MANUAL_UPLOAD_MAX_FILE_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(MANUAL_UPLOAD_MAX_FILE_BYTES)
  size!: number;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @Matches(/^[a-f0-9]{64}$/)
  checksum!: string;
}

export class CreateCandidateUploadSessionDto extends ManualCandidateUploadDto {
  @ApiProperty({
    type: CandidateUploadFileDto,
    isArray: true,
    minItems: 1,
    maxItems: MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES)
  @ValidateNested({ each: true })
  @Type(() => CandidateUploadFileDto)
  files!: CandidateUploadFileDto[];
}

export class SignedUploadTargetDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: String, enum: ["PUT"] }) method!: "PUT";
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
  })
  headers!: Record<string, string>;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
}

export class CandidateUploadSessionItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({
    enum: CandidateUploadItemStatus,
    enumName: "CandidateUploadItemStatus",
  })
  status!: CandidateUploadItemStatus;
  @ApiProperty({ type: SignedUploadTargetDto, nullable: true })
  upload!: SignedUploadTargetDto | null;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
  @ApiProperty({ type: String, isArray: true }) warnings!: string[];
  @ApiProperty({ type: CandidateDto, nullable: true })
  candidate!: CandidateDto | null;
}

export class CandidateUploadSessionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({
    enum: CandidateUploadSessionStatus,
    enumName: "CandidateUploadSessionStatus",
  })
  status!: CandidateUploadSessionStatus;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: CandidateUploadSessionItemDto, isArray: true })
  items!: CandidateUploadSessionItemDto[];
}

export class ReorderCandidateMediaDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

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
  mediaIds!: string[];
}
