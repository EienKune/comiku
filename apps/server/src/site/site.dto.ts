import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  siteThemePresetIds,
  type SiteThemePresetId,
} from "./site-theme-presets.js";

export class SiteSettingsDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ enum: siteThemePresetIds, enumName: "SiteThemePresetId" })
  themePresetId!: SiteThemePresetId;
  @ApiProperty({ type: String, nullable: true }) iconVersion!: string | null;
  @ApiProperty({ type: Number }) revision!: number;
}
export class UpdateSiteSettingsDto {
  @ApiProperty({ type: String, maxLength: 128 })
  @IsString()
  @MaxLength(128)
  name!: string;
  @ApiProperty({ enum: siteThemePresetIds, enumName: "SiteThemePresetId" })
  @IsIn(siteThemePresetIds)
  themePresetId!: SiteThemePresetId;
  @ApiProperty({ type: Number })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;
  @ApiProperty({ enum: ["keep", "remove", "adopt"] })
  @IsIn(["keep", "remove", "adopt"])
  iconAction!: "keep" | "remove" | "adopt";
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
export class SiteIconUploadDto {
  @ApiProperty({ type: String }) assetId!: string;
  @ApiProperty({ type: String }) expiresAt!: string;
}
