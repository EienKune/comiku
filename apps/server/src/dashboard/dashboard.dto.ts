import { ApiProperty } from "@nestjs/swagger";
import {
  ReviewStatus,
  WorkEventAction,
  WorkflowStatus,
} from "../generated/prisma/client.js";

export class WorkflowCountDto {
  @ApiProperty({ enum: WorkflowStatus, enumName: "WorkflowStatus" })
  status!: WorkflowStatus;
  @ApiProperty({ type: Number }) count!: number;
}

export class ReviewCountDto {
  @ApiProperty({ enum: ReviewStatus, enumName: "ReviewStatus" })
  status!: ReviewStatus;
  @ApiProperty({ type: Number }) count!: number;
}

export class DashboardActivityDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: String }) workTitle!: string;
  @ApiProperty({ enum: WorkEventAction, enumName: "WorkEventAction" })
  action!: WorkEventAction;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class DashboardSummaryDto {
  @ApiProperty({ type: Number }) totalWorks!: number;
  @ApiProperty({ type: WorkflowCountDto, isArray: true })
  workflowCounts!: WorkflowCountDto[];
  @ApiProperty({ type: WorkflowCountDto, isArray: true })
  myWorkflowCounts!: WorkflowCountDto[];
  @ApiProperty({ type: ReviewCountDto, isArray: true })
  reviewCounts!: ReviewCountDto[];
  @ApiProperty({ type: Number, nullable: true }) pendingCandidates!:
    number | null;
  @ApiProperty({ type: Number }) myParticipatingWorks!: number;
  @ApiProperty({ type: DashboardActivityDto, isArray: true })
  recentActivity!: DashboardActivityDto[];
}
