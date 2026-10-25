import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { LanguageCapability, Role } from "../generated/prisma/client.js";
import { normalizeUsername } from "./password.js";

export class LoginDto {
  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 64,
    pattern: "^[a-z0-9][a-z0-9_-]{2,63}$",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? normalizeUsername(value) : value,
  )
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{2,63}$/)
  username!: string;
  @ApiProperty({ type: String, format: "password", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
export class ProfileDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;
}
export class ChangePasswordDto {
  @ApiProperty({ type: String, format: "password", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
  @ApiProperty({
    type: String,
    format: "password",
    minLength: 12,
    maxLength: 128,
  })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
export class ConfirmPasswordDto {
  @ApiProperty({ type: String, format: "password", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}
export class CreateUserDto extends ProfileDto {
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  canSkipProofreading?: boolean;
  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 64,
    pattern: "^[a-z0-9]{3,64}$",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? normalizeUsername(value) : value,
  )
  @IsString()
  @Matches(/^[a-z0-9]{3,64}$/)
  username!: string;
  @ApiProperty({ enum: Role, enumName: "Role", isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsEnum(Role, { each: true })
  roles!: Role[];
  @ApiPropertyOptional({
    enum: LanguageCapability,
    enumName: "LanguageCapability",
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsEnum(LanguageCapability, { each: true })
  languageCapabilities?: LanguageCapability[];
  @ApiProperty({ type: String, format: "password", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}
// Account changes intentionally cannot change username or password via a generic PATCH.
export class ManageUserDto extends ProfileDto {
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  canSkipProofreading?: boolean;
  @ApiProperty({ enum: Role, enumName: "Role", isArray: true })
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsEnum(Role, { each: true })
  roles!: Role[];
  @ApiPropertyOptional({
    enum: LanguageCapability,
    enumName: "LanguageCapability",
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsEnum(LanguageCapability, { each: true })
  languageCapabilities?: LanguageCapability[];
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  isActive!: boolean;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: String, format: "password", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}
export class UserDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "头像文件标识，仅用于读取与缓存更新，不可由资料 PATCH 写入",
  })
  avatarVersion?: string | null;
  @ApiProperty({ type: Boolean }) canSkipProofreading!: boolean;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) username!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: Role, enumName: "Role", isArray: true }) roles!: Role[];
  @ApiProperty({
    enum: LanguageCapability,
    enumName: "LanguageCapability",
    isArray: true,
  })
  languageCapabilities!: LanguageCapability[];
  @ApiProperty({ type: Boolean }) isActive!: boolean;
  @ApiProperty({ type: Boolean }) mustChangePassword!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String, isArray: true }) permissions!: string[];
}
export class MemberDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "头像文件标识，仅用于读取与缓存更新，不可由资料 PATCH 写入",
  })
  avatarVersion?: string | null;
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) username!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: Role, enumName: "Role", isArray: true }) roles!: Role[];
  @ApiProperty({
    enum: LanguageCapability,
    enumName: "LanguageCapability",
    isArray: true,
  })
  languageCapabilities!: LanguageCapability[];
}
export class RoleOptionDto {
  @ApiProperty({ enum: Role, enumName: "Role" }) value!: Role;
  @ApiProperty({ type: String }) label!: string;
}
export class CredentialDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
  @ApiProperty({
    type: String,
    description: "仅在本次响应显示，请安全交付；无法再次查询",
  })
  temporaryPassword!: string;
}
export class OkDto {
  @ApiProperty({ type: Boolean }) ok = true;
}
export class AuditDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: Object, additionalProperties: true }) detail!: object;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}
