import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { SignedUploadTargetDto } from "../candidates/candidates.dto.js";
import {
  TYPESET_BATCH_MAX_FILES,
  TYPESET_BATCH_MAX_WORKS,
  TYPESET_BATCH_MAX_ZIP_BYTES,
} from "./typeset-batch-upload.js";

export class TypesetUploadFileInputDto {
  @ApiProperty({ type: String, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  @Matches(/^[^/\\\p{Cc}]+$/u)
  sourceName!: string;
  @ApiProperty({
    enum: ["image/png", "image/jpeg", "image/webp", "application/zip"],
  })
  @IsIn(["image/png", "image/jpeg", "image/webp", "application/zip"])
  contentType!: string;
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: TYPESET_BATCH_MAX_ZIP_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(TYPESET_BATCH_MAX_ZIP_BYTES)
  size!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Matches(/^[a-f0-9]{64}$/)
  checksum!: string;
}
export class CreateTypesetUploadSessionDto {
  @ApiProperty({
    type: TypesetUploadFileInputDto,
    isArray: true,
    minItems: 1,
    maxItems: TYPESET_BATCH_MAX_FILES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TYPESET_BATCH_MAX_FILES)
  @ValidateNested({ each: true })
  @Type(() => TypesetUploadFileInputDto)
  files!: TypesetUploadFileInputDto[];
}
export class TypesetUploadImageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) uploadFileId!: string;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: Number }) width!: number;
  @ApiProperty({ type: Number }) height!: number;
  @ApiProperty({ type: Number }) size!: number;
  @ApiProperty({ type: Number, nullable: true }) workNumber!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pageNumber!: number | null;
  @ApiProperty({ type: String, isArray: true }) warnings!: string[];
}
export class TypesetUploadFileDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: Boolean }) archive!: boolean;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: SignedUploadTargetDto, nullable: true })
  upload!: SignedUploadTargetDto | null;
  @ApiProperty({ type: TypesetUploadImageDto, isArray: true })
  images!: TypesetUploadImageDto[];
}
export class TypesetUploadSessionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: Number }) maxWorks!: number;
  @ApiProperty({ type: Number }) maxTotalBytes!: number;
  @ApiProperty({ type: TypesetUploadFileDto, isArray: true })
  files!: TypesetUploadFileDto[];
}
export class TypesetUploadGroupInputDto {
  @ApiProperty({ type: Number, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  workNumber!: number;
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
  imageIds!: string[];
  @ApiProperty({ type: Boolean }) @IsBoolean() mergeConfirmed!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() manualTargetConfirmed!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() contentConfirmed!: boolean;
}
export class PreviewTypesetUploadGroupsDto {
  @ApiProperty({
    type: TypesetUploadGroupInputDto,
    isArray: true,
    minItems: 1,
    maxItems: TYPESET_BATCH_MAX_WORKS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TYPESET_BATCH_MAX_WORKS)
  @ValidateNested({ each: true })
  @Type(() => TypesetUploadGroupInputDto)
  groups!: TypesetUploadGroupInputDto[];
}
export class TypesetUploadPlanDto {
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) workId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) previewId!:
    string | null;
  @ApiProperty({ type: Number, nullable: true }) workRevision!: number | null;
  @ApiProperty({ type: Number, nullable: true }) editorEpoch!: number | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  handoffStartedAt!: string | null;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
}
export class TypesetUploadPlansDto {
  @ApiProperty({ type: TypesetUploadPlanDto, isArray: true })
  items!: TypesetUploadPlanDto[];
}
export class ConfirmTypesetUploadDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() previewId!: string;
}
export class TypesetUploadConfirmedDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: String, format: "uuid" }) versionId!: string;
  @ApiProperty({
    type: Boolean,
    description: "本次确认是否同时提交嵌字；旧会话只返回原有保存结果",
  })
  stageSubmitted!: boolean;
}
