import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AuthorizationStatus,
  FirstSyncMode,
  SourceAdapterHealth,
  SourceLanguage,
} from "../generated/prisma/client.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateAuthorDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiProperty({ enum: SourceLanguage, enumName: "SourceLanguage" })
  @IsEnum(SourceLanguage)
  sourceLanguage!: SourceLanguage;

  @ApiProperty({ enum: AuthorizationStatus, enumName: "AuthorizationStatus" })
  @IsEnum(AuthorizationStatus)
  authorizationStatus!: AuthorizationStatus;

  @ApiProperty({ type: String, isArray: true, maxItems: 50 })
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tagNames!: string[];
}

export class AuthorQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 100 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ type: String, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: AuthorizationStatus,
    enumName: "AuthorizationStatus",
  })
  @IsOptional()
  @IsEnum(AuthorizationStatus)
  authorizationStatus?: AuthorizationStatus;

  @ApiPropertyOptional({ type: String, maxLength: 32 })
  @IsOptional()
  @Transform(trimmed)
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/i)
  platform?: string;

  @ApiPropertyOptional({ type: String, maxLength: 64 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(64)
  tag?: string;
}

export class UpdateAuthorDto extends CreateAuthorDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class RevisionDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class CreateExternalAccountDto {
  @ApiProperty({ type: String, pattern: "^[a-z][a-z0-9_-]{0,31}$" })
  @Transform(trimmed)
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/i)
  platform!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalUserId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  handle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  profileUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayNameSnapshot?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  @IsOptional()
  @IsString()
  avatarFileObjectId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  profileSyncAdapter?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: "date-time" })
  @IsOptional()
  @IsString()
  profileSyncedAt?: string | null;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  fetchEnabled!: boolean;

  @ApiProperty({ enum: FirstSyncMode, enumName: "FirstSyncMode" })
  @IsEnum(FirstSyncMode)
  firstSyncMode!: FirstSyncMode;
}

export class UpdateExternalAccountDto {
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 255,
    description: "更换平台身份时归档旧关联并创建新关联，保留历史来源",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalUserId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  @IsOptional()
  @IsString()
  avatarFileObjectId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  profileSyncAdapter?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: "date-time" })
  @IsOptional()
  @IsString()
  profileSyncedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  handle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  profileUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayNameSnapshot?: string | null;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  fetchEnabled!: boolean;

  @ApiProperty({ enum: FirstSyncMode, enumName: "FirstSyncMode" })
  @IsEnum(FirstSyncMode)
  firstSyncMode!: FirstSyncMode;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class TagDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Number }) revision!: number;
}

export class CreateTagDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 64 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;
}

export class UpdateTagDto extends CreateTagDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class ExternalAccountSummaryDto {
  @ApiProperty({ type: String }) externalUserId!: string;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String, nullable: true }) handle!: string | null;
  @ApiProperty({ type: String, nullable: true }) profileUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) displayNameSnapshot!:
    string | null;
  @ApiProperty({ type: Boolean }) avatarAvailable!: boolean;
}

export class SourceAdapterStateDto {
  @ApiProperty({ type: String }) adapterKey!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: Boolean }) available!: boolean;
  @ApiProperty({ enum: SourceAdapterHealth, enumName: "SourceAdapterHealth" })
  health!: SourceAdapterHealth;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastAttemptAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastSuccessAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextAttemptAt!: string | null;
  @ApiProperty({ type: Number }) consecutiveFailures!: number;
  @ApiProperty({ type: String, nullable: true })
  lastErrorMessage!: string | null;
  @ApiProperty({ type: Number }) revision!: number;
}

export class UpdateSourceAdapterStateDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class ExternalAccountDto extends ExternalAccountSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: Boolean }) fetchEnabled!: boolean;
  @ApiProperty({ enum: FirstSyncMode, enumName: "FirstSyncMode" })
  firstSyncMode!: FirstSyncMode;
  @ApiProperty({ type: Boolean }) providerAvailable!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastCheckedAt!: string | null;
  @ApiProperty({ type: SourceAdapterStateDto, isArray: true })
  adapterStates!: SourceAdapterStateDto[];
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  deletedAt!: string | null;
}

export class AuthorDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: SourceLanguage, enumName: "SourceLanguage" })
  sourceLanguage!: SourceLanguage;
  @ApiProperty({ enum: AuthorizationStatus, enumName: "AuthorizationStatus" })
  authorizationStatus!: AuthorizationStatus;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Boolean }) avatarAvailable!: boolean;
  @ApiProperty({ type: TagDto, isArray: true }) tags!: TagDto[];
  @ApiProperty({ type: ExternalAccountSummaryDto, isArray: true })
  externalAccounts!: ExternalAccountSummaryDto[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  deletedAt!: string | null;
}

export class AuthorPageDto {
  @ApiProperty({ type: AuthorDto, isArray: true }) items!: AuthorDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ManagedAuthorDto extends AuthorDto {
  @ApiProperty({ type: ExternalAccountDto, isArray: true })
  declare externalAccounts: ExternalAccountDto[];
}

export class ResolveXProfileDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "编辑当前作者时允许同步其已绑定 X 账号",
  })
  @IsOptional()
  @IsUUID()
  authorId?: string;
  @ApiProperty({ type: String, maxLength: 255 })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  handle!: string;
}

export class ResolvedXProfileDto {
  @ApiProperty({ type: String }) externalUserId!: string;
  @ApiProperty({ type: String }) handle!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ type: String }) profileUrl!: string;
  @ApiProperty({ type: String, nullable: true, format: "uuid" })
  avatarFileObjectId!: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ type: String }) adapterKey!: string;
  @ApiProperty({ type: String, format: "date-time" }) syncedAt!: string;
}

export class AuthorEvidenceUploadDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class AuthorEvidenceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) fileObjectId!: string;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: String }) contentType!: string;
  @ApiProperty({ type: Number }) size!: number;
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class ReorderAuthorEvidenceDto extends RevisionDto {
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  evidenceIds!: string[];
}

export class AuthorImportRowDto {
  @ApiProperty({ type: Number, minimum: 1 }) @IsInt() @Min(1) row!: number;
  @ApiProperty({ type: String }) @IsString() displayName!: string;
  @ApiProperty({ type: String }) @IsString() sourceLanguage!: string;
  @ApiProperty({ type: String }) @IsString() authorizationStatus!: string;
  @ApiProperty({ type: String, isArray: true })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tagNames!: string[];
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  xHandle!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  xExternalUserId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  xDisplayName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  xProfileUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "uuid" })
  @IsOptional()
  @IsString()
  xAvatarFileObjectId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  xProfileSyncAdapter!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  @IsOptional()
  @IsString()
  xProfileSyncedAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  pixivUserId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  pixivProfileUrl!: string | null;
}

export class AuthorImportPreviewRowDto extends AuthorImportRowDto {
  @ApiProperty({ type: String, isArray: true }) errors!: string[];
}

export class AuthorImportPreviewDto {
  @ApiProperty({ type: AuthorImportPreviewRowDto, isArray: true })
  rows!: AuthorImportPreviewRowDto[];
  @ApiProperty({ type: Number }) validCount!: number;
  @ApiProperty({ type: Number }) invalidCount!: number;
}

export class ImportAuthorsDto {
  @ApiProperty({ type: AuthorImportRowDto, isArray: true, maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @Type(() => AuthorImportRowDto)
  rows!: AuthorImportRowDto[];
}

export class AuthorImportResultDto {
  @ApiProperty({ type: Number }) createdCount!: number;
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  authorIds!: string[];
}

export class SourceCapabilityDto {
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String }) adapterKey!: string;
  @ApiProperty({ type: Number }) priority!: number;
  @ApiProperty({ type: Boolean }) metered!: boolean;
  @ApiProperty({ type: Boolean }) available!: boolean;
  @ApiProperty({
    enum: FirstSyncMode,
    isArray: true,
    enumName: "FirstSyncMode",
  })
  supportedFirstSyncModes!: FirstSyncMode[];
}
