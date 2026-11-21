import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateTypesetHandoffPackageDto } from "./typesetting.dto.js";

export class CreateTypesetMaterialDto extends CreateTypesetHandoffPackageDto {
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  requireCurrentParticipation?: boolean;
}
export class TypesetMaterialImageDto {
  @ApiProperty({ type: String }) workImageId!: string;
  @ApiProperty({ type: String }) fileObjectId!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: Number }) size!: number;
  @ApiProperty({ type: String }) checksum!: string;
  @ApiPropertyOptional({ type: String }) url?: string;
}
export class TypesetMaterialDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: String }) translationVersionId!: string;
  @ApiProperty({ type: Number }) sourceAssetRevision!: number;
  @ApiProperty({ type: Number }) workRevision!: number;
  @ApiProperty({ type: Number }) editorEpoch!: number;
  @ApiProperty({ type: Number }) totalBytes!: number;
  @ApiProperty({ type: String }) translationFileName!: string;
  @ApiProperty({ type: String }) translationBase64!: string;
  @ApiProperty({ type: TypesetMaterialImageDto, isArray: true })
  images!: TypesetMaterialImageDto[];
  @ApiPropertyOptional({ type: Number }) expiresInSeconds?: number;
}
