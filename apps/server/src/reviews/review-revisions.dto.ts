// Legacy read-only response shape; revision mutation routes are retired.
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { WorkStage, WorkflowStatus } from "../generated/prisma/client.js";

export class ReviewRevisionParticipantDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) userId!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ enum: WorkStage }) stage!: WorkStage;
  @ApiProperty({ type: String, isArray: true }) imageIds!: string[];
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ type: Boolean }) contributionCurrent!: boolean;
  @ApiProperty({ type: String, nullable: true }) submittedAt!: string | null;
}

export class ReviewRevisionDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) reviewCaseId!: string;
  @ApiProperty({ type: String }) workId!: string;
  @ApiProperty({ enum: WorkStage }) targetStage!: WorkStage;
  @ApiProperty({ enum: WorkStage }) currentStage!: WorkStage;
  @ApiProperty({ enum: WorkflowStatus }) returnWorkflowStatus!: WorkflowStatus;
  @ApiProperty({ type: String, nullable: true }) baselineVersionId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) translationVersionId!:
    string | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  baselineVersionNumber?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  translationVersionNumber?: number | null;
  @ApiProperty({ type: Number }) workRevision!: number;
  @ApiProperty({ type: Number }) editorEpoch!: number;
  @ApiProperty({ type: Boolean }) completed!: boolean;
  @ApiProperty({ type: Boolean }) changed!: boolean;
  @ApiProperty({ type: Boolean }) canJoin!: boolean;
  @ApiProperty({ type: Boolean }) participating!: boolean;
  @ApiProperty({ type: Boolean }) canSubmit!: boolean;
  @ApiProperty({ type: Boolean }) canFinishUnchanged!: boolean;
  @ApiProperty({ type: Boolean }) canSkipProofreading!: boolean;
  @ApiProperty({ type: Boolean })
  requiresProofreadingClaimConfirmation!: boolean;
  @ApiProperty({ type: ReviewRevisionParticipantDto, isArray: true })
  participants!: ReviewRevisionParticipantDto[];
}
