import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { LanguageCapability, Role } from "../generated/prisma/client.js";
import { ConfirmPasswordDto, ProfileDto, RoleOptionDto } from "./users.dto.js";
import { normalizeUsername } from "./password.js";

export const registrationRoles = Object.values(Role).filter(
  (role) => role !== Role.admin,
);

export class RegistrationSettingsDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: Boolean }) allowRoleSelection!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
}
export class UpdateRegistrationSettingsDto extends ConfirmPasswordDto {
  @ApiProperty({ type: Boolean }) @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() allowRoleSelection!: boolean;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
export class LanguageCapabilityOptionDto {
  @ApiProperty({ enum: LanguageCapability, enumName: "LanguageCapability" })
  value!: LanguageCapability;
  @ApiProperty({ type: String }) label!: string;
}
export class RegistrationOptionsDto extends RegistrationSettingsDto {
  @ApiProperty({ type: RoleOptionDto, isArray: true }) roles!: RoleOptionDto[];
  @ApiProperty({ type: LanguageCapabilityOptionDto, isArray: true })
  languageCapabilities!: LanguageCapabilityOptionDto[];
}
export class RegisterDto extends ProfileDto {
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
  @ApiProperty({
    type: String,
    format: "password",
    minLength: 12,
    maxLength: 128,
  })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
  @ApiProperty({
    enum: registrationRoles,
    enumName: "RegistrationRole",
    isArray: true,
  })
  @IsArray()
  @ArrayMaxSize(registrationRoles.length)
  @ArrayUnique()
  @IsIn(registrationRoles, { each: true })
  roles!: Role[];
  @ApiProperty({
    enum: LanguageCapability,
    enumName: "LanguageCapability",
    isArray: true,
  })
  @IsArray()
  @ArrayMaxSize(Object.values(LanguageCapability).length)
  @ArrayUnique()
  @IsEnum(LanguageCapability, { each: true })
  languageCapabilities!: LanguageCapability[];
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedSettingsRevision!: number;
}
