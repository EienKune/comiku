import { ApiProperty } from "@nestjs/swagger";
import { CreateTypesetHandoffPackageDto } from "./typesetting.dto.js";

export class TypesetHandoffManifestItemDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: Number }) workRevision!: number;
  @ApiProperty({ type: Number }) editorEpoch!: number;
  @ApiProperty({ type: Boolean }) canDownload!: boolean;
  @ApiProperty({ type: String, nullable: true }) unavailableReason!:
    string | null;
}

export class TypesetHandoffManifestDto {
  @ApiProperty({ type: TypesetHandoffManifestItemDto, isArray: true })
  items!: TypesetHandoffManifestItemDto[];
}

// Download is an explicit confirmation, with the same frozen baseline as preparation.
export class DownloadTypesetBatchItemDto extends CreateTypesetHandoffPackageDto {}
