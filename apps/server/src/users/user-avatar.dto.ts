import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export const USER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export class CreateUserAvatarUploadDto {
  @ApiProperty({ type: String, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  @Matches(/^[^/\\\p{Cc}]+$/u)
  sourceName!: string;
  @ApiProperty({ enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] })
  @IsIn(["image/png", "image/jpeg", "image/webp", "image/gif"])
  contentType!: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: USER_AVATAR_MAX_BYTES })
  @IsInt()
  @Min(1)
  @Max(USER_AVATAR_MAX_BYTES)
  size!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Matches(/^[a-f0-9]{64}$/)
  checksum!: string;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
export class RemoveUserAvatarDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
export class UserAvatarUploadDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
  @ApiProperty({ type: Object, additionalProperties: { type: "string" } })
  headers!: Record<string, string>;
}
export class UserAvatarUrlDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
}
