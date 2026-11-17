import { ApiProperty } from "@nestjs/swagger";

export class ReferenceDictionarySourceDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) version!: string;
  @ApiProperty({ type: String, nullable: true }) sourceUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) attribution!: string | null;
  @ApiProperty({ type: String, nullable: true }) license!: string | null;
}
export class ReferenceDictionaryEntryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) original!: string;
  @ApiProperty({ type: String, nullable: true }) explanationZh!: string | null;
  @ApiProperty({ type: String, nullable: true }) explanationJa!: string | null;
  @ApiProperty({ type: String, nullable: true }) translationZh!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String }) sourceRef!: string;
  @ApiProperty({ type: ReferenceDictionarySourceDto })
  source!: ReferenceDictionarySourceDto;
}
export class ReferenceDictionaryPageDto {
  @ApiProperty({ type: ReferenceDictionaryEntryDto, isArray: true })
  entries!: ReferenceDictionaryEntryDto[];
  @ApiProperty({ type: Number, nullable: true }) nextOffset!: number | null;
}
