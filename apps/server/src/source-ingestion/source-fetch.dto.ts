import {
  IsArray,
  IsOptional,
  IsUUID,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  SourceFetchItemStatus,
  SourceFetchRunStatus,
  SourceFetchTrigger,
  SourceAdapterHealth,
  JobStatus,
} from "../generated/prisma/client.js";

export class RunSourceFetchDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    isArray: true,
    maxItems: 100,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  accountIds?: string[];
}

export class SourceFetchRunItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) externalAccountId!: string;
  @ApiProperty({ type: String }) authorName!: string;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String }) adapterKey!: string;
  @ApiProperty({ enum: SourceAdapterHealth, enumName: "SourceAdapterHealth" })
  adapterHealth!: SourceAdapterHealth;
  @ApiProperty({
    enum: SourceFetchItemStatus,
    enumName: "SourceFetchItemStatus",
  })
  status!: SourceFetchItemStatus;
  @ApiProperty({ type: Number }) pagesFetched!: number;
  @ApiProperty({ type: Number }) itemsSeen!: number;
  @ApiProperty({ type: Number }) candidatesCreated!: number;
  @ApiProperty({ type: Number }) candidatesExisting!: number;
  @ApiProperty({ type: Number }) mediaStored!: number;
  @ApiProperty({ type: Number }) apiRequests!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) startedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}

export class SourceFetchRunDto {
  @ApiProperty({ type: Number }) attempts!: number;
  @ApiProperty({ enum: JobStatus, enumName: "JobStatus", nullable: true })
  jobStatus!: JobStatus | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextRetryAt!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: SourceFetchTrigger, enumName: "SourceFetchTrigger" })
  trigger!: SourceFetchTrigger;
  @ApiProperty({ enum: SourceFetchRunStatus, enumName: "SourceFetchRunStatus" })
  status!: SourceFetchRunStatus;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  requestedById!: string | null;
  @ApiProperty({ type: SourceFetchRunItemDto, isArray: true })
  items!: SourceFetchRunItemDto[];
  @ApiProperty({ type: String, format: "date-time" }) startedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}
