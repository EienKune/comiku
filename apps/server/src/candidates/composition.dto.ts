import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CandidateCompositionInputDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() id!: string;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
export class CandidateCompositionOutputInputDto {
  @ApiProperty({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(200)
  title!: string | null;
  @ApiProperty({
    type: String,
    format: "uuid",
    isArray: true,
    minItems: 1,
    maxItems: 1000,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  mediaIds!: string[];
}
export class ComposeCandidatesDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
  @ApiProperty({ enum: ["merge", "split"] }) @IsIn(["merge", "split"]) mode!:
    "merge" | "split";
  @ApiProperty({
    type: CandidateCompositionInputDto,
    isArray: true,
    minItems: 1,
    maxItems: 20,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique((item: CandidateCompositionInputDto) => item.id)
  @ValidateNested({ each: true })
  @Type(() => CandidateCompositionInputDto)
  candidates!: CandidateCompositionInputDto[];
  @ApiProperty({
    type: CandidateCompositionOutputInputDto,
    isArray: true,
    minItems: 1,
    maxItems: 20,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CandidateCompositionOutputInputDto)
  works!: CandidateCompositionOutputInputDto[];
}
export class CandidateCompositionWorkDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  sourceCandidateIds!: string[];
}
export class CandidateCompositionCandidateDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ enum: ["imported"] }) status!: "imported";
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  workIds!: string[];
}
export class CandidateCompositionResultDto {
  @ApiProperty({ type: String, format: "uuid" }) idempotencyKey!: string;
  @ApiProperty({ enum: ["merge", "split"] }) mode!: "merge" | "split";
  @ApiProperty({ type: CandidateCompositionWorkDto, isArray: true })
  works!: CandidateCompositionWorkDto[];
  @ApiProperty({ type: CandidateCompositionCandidateDto, isArray: true })
  candidates!: CandidateCompositionCandidateDto[];
  @ApiProperty({ type: String, format: "uuid", isArray: true })
  unadoptedMediaIds!: string[];
}
