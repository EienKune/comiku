import { ReviewRevisionDto } from "../reviews/review-revisions.dto.js";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  MarkerPositionType,
  ReviewResolution,
  ReviewStatus,
  TranslationPresenceMode,
  TranslationVersionKind,
  SourceLanguage,
  WorkCollaborationMode,
  WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";

export class TranslationMutationMetaDto {
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ type: Number, minimum: 0 }) editorEpoch!: number;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ enum: WorkStage, nullable: true })
  submissionStage!: WorkStage | null;
}

export class TranslationEntryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workImageId!: string;
  @ApiProperty({ type: Number, minimum: 0 }) orderIndex!: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 1 }) markerX!: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 1 }) markerY!: number;
  @ApiProperty({ enum: MarkerPositionType, enumName: "MarkerPositionType" })
  markerPositionType!: MarkerPositionType;
  @ApiProperty({ type: String }) translatedText!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: Number, minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, format: "uuid" }) createdById!: string;
  @ApiProperty({ type: String, format: "uuid" }) updatedById!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiPropertyOptional({ type: TranslationMutationMetaDto })
  mutation?: TranslationMutationMetaDto;
}

export class TranslationImageDraftDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number, minimum: 0 }) orderIndex!: number;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: Number, minimum: 0 }) translationRevision!: number;
  @ApiProperty({ type: TranslationEntryDto, isArray: true })
  entries!: TranslationEntryDto[];
  @ApiPropertyOptional({ type: TranslationMutationMetaDto })
  mutation?: TranslationMutationMetaDto;
}

export class TranslationVersionSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number, minimum: 1 }) versionNumber!: number;
  @ApiProperty({
    enum: TranslationVersionKind,
    enumName: "TranslationVersionKind",
  })
  kind!: TranslationVersionKind;
  @ApiProperty({ enum: WorkStage, nullable: true })
  stage!: WorkStage | null;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ type: Number, minimum: 1 }) editorEpoch!: number;
  @ApiProperty({ type: String, format: "uuid" }) createdById!: string;
  @ApiProperty({ type: String }) createdByName!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class TranslationPresenceDto {
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({
    enum: TranslationPresenceMode,
    enumName: "TranslationPresenceMode",
  })
  mode!: TranslationPresenceMode;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage", isArray: true })
  stages!: WorkStage[];
  @ApiProperty({ type: Boolean }) isCurrentSession!: boolean;
  @ApiProperty({ type: String, format: "date-time" }) lastSeenAt!: string;
}

export class TranslationPresenceListDto {
  @ApiProperty({ type: TranslationPresenceDto, isArray: true })
  items!: TranslationPresenceDto[];
  @ApiProperty({ type: Number, minimum: 1 }) expiresInSeconds!: number;
}

export class TranslationOpenReviewCaseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ type: String }) openedByName!: string;
  @ApiProperty({ enum: ReviewResolution, nullable: true })
  resolution!: ReviewResolution | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class LabelPlusWarningDto {
  @ApiProperty({
    enum: [
      "duplicate_image_name",
      "non_sequential_marker_number",
      "unsupported_position_type",
    ],
  })
  code!:
    | "duplicate_image_name"
    | "non_sequential_marker_number"
    | "unsupported_position_type";
  @ApiProperty({ type: Number, minimum: 1 }) line!: number;
  @ApiProperty({ type: String }) message!: string;
}

export class LabelPlusImageMappingDto {
  @ApiProperty({ type: String }) sourceFileName!: string;
  @ApiProperty({ type: String, format: "uuid" }) targetImageId!: string;
  @ApiProperty({ type: String }) targetFileName!: string;
  @ApiProperty({ type: Number, minimum: 0 }) markerCount!: number;
}

export class LabelPlusImportPreviewDto {
  @ApiProperty({ type: String }) formatVersion!: string;
  @ApiProperty({ type: Number, minimum: 1 }) imageCount!: number;
  @ApiProperty({ type: Number, minimum: 0 }) markerCount!: number;
  @ApiProperty({ type: LabelPlusImageMappingDto, isArray: true })
  mappings!: LabelPlusImageMappingDto[];
  @ApiProperty({ type: LabelPlusWarningDto, isArray: true })
  warnings!: LabelPlusWarningDto[];
  @ApiProperty({ type: String, isArray: true }) blockingIssues!: string[];
  @ApiProperty({ type: Boolean }) canImport!: boolean;
}

export class ImportLabelPlusDto {
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage" })
  @IsEnum(WorkStage)
  stage!: WorkStage;

  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class ExportLabelPlusDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class LabelPlusExportDto {
  @ApiProperty({ type: String, format: "uuid" }) fileId!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: String }) downloadUrl!: string;
  @ApiProperty({ type: String }) formatVersion!: string;
  @ApiProperty({ type: Number, minimum: 1 }) imageCount!: number;
  @ApiProperty({ type: Number, minimum: 0 }) markerCount!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class UpdateTranslationPresenceDto {
  @ApiProperty({
    enum: TranslationPresenceMode,
    enumName: "TranslationPresenceMode",
  })
  @IsEnum(TranslationPresenceMode)
  mode!: TranslationPresenceMode;
}

export class TranslationEditorDto {
  @ApiPropertyOptional({ type: ReviewRevisionDto, nullable: true })
  reviewRevision?: ReviewRevisionDto | null;
  @ApiProperty({ type: Boolean }) canSkipProofreading!: boolean;
  @ApiProperty({ type: String, nullable: true })
  skipProofreadingUnavailableReason!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ enum: SourceLanguage, enumName: "SourceLanguage" })
  sourceLanguage!: SourceLanguage;
  @ApiProperty({
    enum: WorkCollaborationMode,
    enumName: "WorkCollaborationMode",
  })
  collaborationMode!: WorkCollaborationMode;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ enum: ReviewStatus, enumName: "ReviewStatus" })
  reviewStatus!: ReviewStatus;
  @ApiProperty({ type: TranslationOpenReviewCaseDto, nullable: true })
  openReviewCase!: TranslationOpenReviewCaseDto | null;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ type: Number, minimum: 0 }) editorEpoch!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  typesetHandoffStartedAt!: string | null;
  @ApiProperty({ type: Boolean }) canEdit!: boolean;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage", isArray: true })
  editStages!: WorkStage[];
  @ApiProperty({ type: Boolean }) canExportLabelPlus!: boolean;
  @ApiProperty({ enum: WorkStage, nullable: true })
  joinableStage!: WorkStage | null;
  @ApiProperty({ enum: WorkStage, nullable: true })
  submissionStage!: WorkStage | null;
  @ApiProperty({ enum: WorkStage, nullable: true })
  cancelableSubmissionStage!: WorkStage | null;
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  assignedImageIds!: string[];
  @ApiProperty({ type: Boolean }) contributionCurrent!: boolean;
  @ApiProperty({ type: Boolean }) multiStageReady!: boolean;
  @ApiProperty({ type: Boolean }) hasUnsubmittedChanges!: boolean;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage", isArray: true })
  revisionStages!: WorkStage[];
  @ApiProperty({ enum: WorkStage, nullable: true })
  translationAttentionStage!: WorkStage | null;
  @ApiProperty({ type: Number, minimum: 1, nullable: true })
  translationAttentionVersionNumber!: number | null;
  @ApiProperty({ type: TranslationImageDraftDto, isArray: true })
  images!: TranslationImageDraftDto[];
  @ApiProperty({ type: TranslationVersionSummaryDto, nullable: true })
  latestVersion!: TranslationVersionSummaryDto | null;
  @ApiProperty({ type: TranslationPresenceDto, isArray: true })
  activeParticipants!: TranslationPresenceDto[];
}

class CoordinateFields {
  @ApiProperty({ type: Number, minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  markerX!: number;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  markerY!: number;
}

export class CreateTranslationEntryDto extends CoordinateFields {
  @ApiProperty({ enum: MarkerPositionType, enumName: "MarkerPositionType" })
  @IsEnum(MarkerPositionType)
  markerPositionType!: MarkerPositionType;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedImageRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}

export class UpdateTranslationEntryDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  markerX?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  markerY?: number;

  @ApiPropertyOptional({
    enum: MarkerPositionType,
    enumName: "MarkerPositionType",
  })
  @IsOptional()
  @IsEnum(MarkerPositionType)
  markerPositionType?: MarkerPositionType;

  @ApiPropertyOptional({ type: String, maxLength: 100_000 })
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  translatedText?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  note?: string | null;
}

export class DeleteTranslationEntryDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedImageRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}

export class ReorderTranslationEntryDto {
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID()
  beforeMarkerId?: string | null;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedImageRevision!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorEpoch!: number;
}
