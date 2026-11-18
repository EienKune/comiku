import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { WorkStage, WorkflowStatus } from "../generated/prisma/client.js";

export const contributionMetrics = [
  "translate",
  "proofread",
  "typeset",
  "works",
  "published",
  "tasks",
] as const;
export type ContributionMetric = (typeof contributionMetrics)[number];

export class ContributionQueryDto {
  @ApiPropertyOptional({ enum: ["month", "all"], default: "month" })
  @IsOptional()
  @IsIn(["month", "all"])
  period: "month" | "all" = "month";

  @ApiPropertyOptional({ enum: ["personal", "team"], default: "personal" })
  @IsOptional()
  @IsIn(["personal", "team"])
  scope: "personal" | "team" = "personal";

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class ContributionDetailsQueryDto extends ContributionQueryDto {
  @ApiProperty({ enum: contributionMetrics })
  @IsIn(contributionMetrics)
  metric!: ContributionMetric;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    maximum: 100000,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset = 0;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class ContributionCountsDto {
  @ApiProperty({ type: Number }) translate!: number;
  @ApiProperty({ type: Number }) proofread!: number;
  @ApiProperty({ type: Number }) typeset!: number;
  @ApiProperty({ type: Number }) works!: number;
  @ApiProperty({ type: Number }) published!: number;
  @ApiProperty({ type: Number }) tasks!: number;
}

export class ContributionAchievementDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) condition!: string;
  @ApiProperty({ type: Number }) progress!: number;
  @ApiProperty({ type: Number }) target!: number;
  @ApiProperty({ type: Boolean }) achieved!: boolean;
}

export class ContributionSummaryDto {
  @ApiProperty({ enum: ["month", "all"] }) period!: "month" | "all";
  @ApiProperty({ enum: ["personal", "team"] }) scope!: "personal" | "team";
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) userId!:
    string | null;
  @ApiProperty({ type: String }) month!: string;
  @ApiProperty({ type: String, example: "Asia/Shanghai" }) timezone!: string;
  @ApiProperty({ type: ContributionCountsDto }) counts!: ContributionCountsDto;
  @ApiProperty({ type: ContributionAchievementDto, isArray: true })
  achievements!: ContributionAchievementDto[];
}

export class ContributionCreditDto {
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: WorkStage, enumName: "WorkStage" }) stage!: WorkStage;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}

export class ContributionDetailDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: Number }) workNumber!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  workflowStatus!: WorkflowStatus;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  publishedAt!: string | null;
  @ApiProperty({ type: ContributionCreditDto, isArray: true })
  contributions!: ContributionCreditDto[];
}

export class ContributionDetailsDto {
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) offset!: number;
  @ApiProperty({ type: Number }) limit!: number;
  @ApiProperty({ type: ContributionDetailDto, isArray: true })
  items!: ContributionDetailDto[];
}
