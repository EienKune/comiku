import { Transform, Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { WorkflowStatus } from "../generated/prisma/client.js";

function trimmedNullable({ value }: { value: unknown }) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || null;
}

export class ConfirmPublicationDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimmedNullable)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class PublicationRecordDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) typesetVersionId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) typesetVersionNumber!: number;
  @ApiProperty({ type: String }) templateName!: string;
  @ApiProperty({ type: Number, minimum: 0 }) templateRevision!: number;
  @ApiProperty({ type: String }) generatedText!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) publishedById!: string;
  @ApiProperty({ type: String }) publishedByName!: string;
  @ApiProperty({ type: String, format: "date-time" }) publishedAt!: string;
}

export class PublishingViewDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number, minimum: 0 }) workRevision!: number;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, nullable: true }) body!: string | null;
  @ApiProperty({ type: String }) authorCredit!: string;
  @ApiProperty({ type: String, nullable: true }) sourcePostUrl!: string | null;
  @ApiProperty({ type: String, isArray: true }) translationCredits!: string[];
  @ApiProperty({ type: String, isArray: true }) proofreadCredits!: string[];
  @ApiProperty({ type: String, isArray: true }) typesetCredits!: string[];
  @ApiProperty({ type: String }) generatedText!: string;
  @ApiProperty({ type: String }) templateName!: string;
  @ApiProperty({ type: Number, minimum: 0 }) templateRevision!: number;
  @ApiProperty({ type: String, format: "uuid" })
  currentTypesetVersionId!: string;
  @ApiProperty({ type: Number, minimum: 1 })
  currentTypesetVersionNumber!: number;
  @ApiProperty({ type: Number, minimum: 1 }) imageCount!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  publishedAt!: string | null;
  @ApiProperty({ type: PublicationRecordDto, isArray: true })
  records!: PublicationRecordDto[];
}
