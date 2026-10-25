import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateTypesetHandoffPackageDto {
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

export class TypesetHandoffPackageDto {
  @ApiProperty({ type: String, format: "uuid" }) packageId!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: String }) downloadUrl!: string;
  @ApiProperty({ type: Number, minimum: 1 }) imageCount!: number;
  @ApiProperty({ type: Number, minimum: 0 }) markerCount!: number;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ type: Number, minimum: 0 }) editorEpoch!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export enum TypesetVersionUploadMode {
  new_version = "new_version",
  replace_current = "replace_current",
}

function trimmedNullable({ value }: { value: unknown }) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || null;
}

export class CreateTypesetVersionDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;

  @ApiProperty({
    enum: TypesetVersionUploadMode,
    enumName: "TypesetVersionUploadMode",
  })
  @IsEnum(TypesetVersionUploadMode)
  mode!: TypesetVersionUploadMode;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimmedNullable)
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      "JSON array aligned with uploaded files; each item is a source work image UUID or null.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  sourceImageIds?: string;
}

export class ManageTypesetVersionDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class DeleteTypesetVersionDto extends ManageTypesetVersionDto {
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  clearCurrent?: boolean;
}

export class TypesetVersionImageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  workImageId!: string | null;
  @ApiProperty({ type: Number, minimum: 0 }) orderIndex!: number;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: Number, minimum: 1 }) width!: number;
  @ApiProperty({ type: Number, minimum: 1 }) height!: number;
}

export class TypesetVersionDto {
  @ApiProperty({ type: Boolean }) needsTextReview!: boolean;
  @ApiProperty({ type: String, nullable: true }) sourceTranslationVersionId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) reviewedTranslationVersionId!:
    string | null;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number, minimum: 1 }) versionNumber!: number;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: Boolean }) automaticallySorted!: boolean;
  @ApiProperty({ type: Boolean }) isCurrent!: boolean;
  @ApiProperty({ type: String, format: "uuid" }) uploadedById!: string;
  @ApiProperty({ type: String }) uploadedByName!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  deletedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  purgeAfter!: string | null;
  @ApiProperty({ type: TypesetVersionImageDto, isArray: true })
  images!: TypesetVersionImageDto[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class TypesetVersionListDto {
  @ApiProperty({ type: TypesetVersionDto, isArray: true })
  items!: TypesetVersionDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  currentVersionId!: string | null;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
}
