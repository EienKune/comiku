import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
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
  ValidateNested,
  ValidateIf,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import {
  AuthorizationStatus,
  FirstSyncMode,
  SourceAdapterHealth,
  SourceLanguage,
} from "../generated/prisma/client.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateAuthorDto {
  @ApiPropertyOptional({
    enum: ["x", "pixiv"],
    description: "使用该平台经验证的账号头像作为作者头像；仅用于创建意图",
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["x", "pixiv"])
  profileSourcePlatform?: "x" | "pixiv";

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

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

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "同一保存意图重试时保留；不同资料复用将返回409。",
  })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;

  @ApiPropertyOptional({
    type: () => CreateAuthorAccountDto,
    isArray: true,
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateAuthorAccountDto)
  accounts?: CreateAuthorAccountDto[];
}

export enum AuthorAccountFilter {
  linked = "linked",
  enabled = "enabled",
  disabled = "disabled",
  unlinked = "unlinked",
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

  @ApiPropertyOptional({
    enum: AuthorAccountFilter,
    enumName: "AuthorAccountFilter",
  })
  @IsOptional()
  @IsEnum(AuthorAccountFilter)
  xState?: AuthorAccountFilter;

  @ApiPropertyOptional({
    enum: AuthorAccountFilter,
    enumName: "AuthorAccountFilter",
  })
  @IsOptional()
  @IsEnum(AuthorAccountFilter)
  pixivState?: AuthorAccountFilter;

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

export class UpdateAuthorDto extends OmitType(CreateAuthorDto, [
  "idempotencyKey",
  "accounts",
  "profileSourcePlatform",
] as const) {
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
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: 4096,
    description: "平台资料解析返回的短时身份凭证，绑定平台与稳定用户 ID",
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  profileProof?: string;
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

export class CreateAuthorAccountDto extends CreateExternalAccountDto {}

export class UpdateExternalAccountDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: 4096,
    description: "平台资料同步凭证；X 身份变更或重新启用采集时必须提供",
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  profileProof?: string;
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 255,
    description:
      "稳定平台用户 ID 不可修改；兼容旧客户端传入相同 ID，不同 ID 返回 409。新账号使用新建入口关联。",
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
  @ApiProperty({ type: Boolean }) fetchEnabled!: boolean;
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
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  notes?: string | null;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
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
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  notes?: string | null;
  @ApiProperty({ type: ExternalAccountDto, isArray: true })
  declare externalAccounts: ExternalAccountDto[];
}

export class AuthorCreationResultDto {
  @ApiProperty({ type: ManagedAuthorDto, nullable: true })
  author!: ManagedAuthorDto | null;
}

export class ResolveXProfileDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "刷新已绑定账号时优先按该账号不可变数字 ID 查询",
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;
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
  @ApiProperty({ type: String }) profileProof!: string;
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

export class ResolvePixivProfileDto {
  @ApiProperty({ type: String, pattern: "^[1-9][0-9]{0,19}$", maxLength: 20 })
  @Transform(trimmed)
  @IsString()
  @Matches(/^[1-9][0-9]{0,19}$/)
  externalUserId!: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  authorId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class ResolvedPixivProfileDto {
  @ApiProperty({ type: String }) profileProof!: string;
  @ApiProperty({ type: String }) externalUserId!: string;
  @ApiProperty({ type: String, nullable: true, enum: [null] }) handle!: null;
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
