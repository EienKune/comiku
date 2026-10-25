import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ReviewStatus,
  WorkEventAction,
  WorkflowStatus,
} from "../generated/prisma/client.js";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class BusinessAuditQueryDto {
  @ApiPropertyOptional({ enum: WorkEventAction, enumName: "WorkEventAction" })
  @IsOptional()
  @IsEnum(WorkEventAction)
  action?: WorkEventAction;

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ type: Number, enum: [7, 30, 90] })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 30, 90])
  days?: 7 | 30 | 90;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}

export class BusinessAuditEventDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) workId!: string;
  @ApiProperty({ type: String }) workTitle!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ enum: WorkEventAction, enumName: "WorkEventAction" })
  action!: WorkEventAction;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) actorId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ enum: WorkflowStatus, nullable: true })
  fromWorkflowStatus!: WorkflowStatus | null;
  @ApiProperty({ enum: WorkflowStatus, nullable: true })
  toWorkflowStatus!: WorkflowStatus | null;
  @ApiProperty({ enum: ReviewStatus, nullable: true })
  fromReviewStatus!: ReviewStatus | null;
  @ApiProperty({ enum: ReviewStatus, nullable: true })
  toReviewStatus!: ReviewStatus | null;
  @ApiProperty({ type: Object }) detail!: object;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class BusinessAuditPageDto {
  @ApiProperty({ enum: ["global", "related"] })
  scope!: "global" | "related";
  @ApiProperty({ type: Number, minimum: 0 }) total!: number;
  @ApiProperty({ type: BusinessAuditEventDto, isArray: true })
  items!: BusinessAuditEventDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}
