import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import {
  DirectUploadPurpose,
  DirectUploadStatus,
  DownloadPurpose,
  JobStatus,
} from "../generated/prisma/client.js";
import { TypesetUploadFileInputDto } from "../typesetting/typeset-upload.dto.js";
import { TypesetVersionUploadMode } from "../typesetting/typesetting.dto.js";
import { SignedUploadTargetDto } from "../candidates/candidates.dto.js";

export class CreateDirectUploadDto {
  @ApiProperty({ enum: DirectUploadPurpose, enumName: "DirectUploadPurpose" })
  @IsEnum(DirectUploadPurpose)
  purpose!: DirectUploadPurpose;
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() resourceId!: string;
  @ApiProperty({ type: Number }) @IsInt() @Min(0) expectedRevision!: number;
  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
  @ApiPropertyOptional({ enum: TypesetVersionUploadMode })
  @IsOptional()
  @IsEnum(TypesetVersionUploadMode)
  mode?: TypesetVersionUploadMode;
  @ApiPropertyOptional({ type: String, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  sourceImageIds?: string;
  @ApiProperty({ type: TypesetUploadFileInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TypesetUploadFileInputDto)
  files!: TypesetUploadFileInputDto[];
}
export class DirectUploadFileDto {
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: SignedUploadTargetDto, nullable: true })
  upload!: SignedUploadTargetDto | null;
}
export class DirectUploadDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: DirectUploadStatus, enumName: "DirectUploadStatus" })
  status!: DirectUploadStatus;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: DirectUploadFileDto, isArray: true })
  files!: DirectUploadFileDto[];
}
export class PrepareDownloadDto {
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  requireCurrentParticipation?: boolean;
  @ApiProperty({ enum: DownloadPurpose, enumName: "DownloadPurpose" })
  @IsEnum(DownloadPurpose)
  purpose!: DownloadPurpose;
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() workId!: string;
  @ApiProperty({ type: Number }) @IsInt() @Min(0) expectedRevision!: number;
  @ApiProperty({ type: Number }) @IsInt() @Min(0) expectedEditorEpoch!: number;
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}
export class DownloadPreparationDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: JobStatus, enumName: "JobStatus" }) status!: JobStatus;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
}
export class DownloadDeliveryDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
  @ApiProperty({ type: String }) fileName!: string;
}
