import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ReviewStatus, WorkflowStatus } from "../generated/prisma/client.js";

export class ImageSimilarityCoverageDto {
  @ApiProperty({
    type: Number,
    description: "Distinct adopted original files in readable works",
  })
  total!: number;
  @ApiProperty({ type: Number }) ready!: number;
  @ApiProperty({ type: Number }) pending!: number;
  @ApiProperty({ type: Number }) failed!: number;
}
export class ImageSimilarityMatchDto {
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) workTitle!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) authorId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: String, format: "uuid" }) imageId!: string;
  @ApiProperty({
    type: Number,
    description: "Zero-based actual WorkImage page order",
  })
  index!: number;
  @ApiProperty({ type: Number }) imageCount!: number;
  @ApiProperty({ type: String, enum: WorkflowStatus })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ type: String, enum: ReviewStatus })
  reviewStatus!: ReviewStatus;
  @ApiProperty({ type: Boolean }) archived!: boolean;
  @ApiProperty({ type: String, enum: ["exact", "perceptual"] }) matchKind!:
    "exact" | "perceptual";
  @ApiProperty({ type: Number, minimum: 0, maximum: 64 }) distance!: number;
}
export class ImageSimilarityResultDto {
  @ApiProperty({
    type: String,
    enum: ["preparing", "ready", "failed", "partial"],
  })
  state!: "preparing" | "ready" | "failed" | "partial";
  @ApiProperty({ type: ImageSimilarityCoverageDto })
  coverage!: ImageSimilarityCoverageDto;
  @ApiProperty({ type: ImageSimilarityMatchDto, isArray: true })
  matches!: ImageSimilarityMatchDto[];
  @ApiPropertyOptional({
    type: String,
    description: "Safe controlled current-image failure code",
  })
  error?: string;
}
