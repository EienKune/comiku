import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export const notificationReceiptStatuses = [
  "pending",
  "retry_wait",
  "invalid",
  "recorded",
  "skipped",
] as const;
export type NotificationReceiptStatus =
  (typeof notificationReceiptStatuses)[number];

export class NotificationBoundedMetricDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 1000 }) count!: number;
  @ApiProperty({ type: Boolean }) capped!: boolean;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  oldestAt!: string | null;
}

export class NotificationStatusCountsDto {
  @ApiProperty({ type: NotificationBoundedMetricDto, nullable: true })
  uncaptured!: NotificationBoundedMetricDto | null;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  pending!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  retryWait!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  invalid!: NotificationBoundedMetricDto;
}

export class NotificationDeliveryCountsDto {
  @ApiProperty({ type: NotificationBoundedMetricDto })
  pending!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  retryWait!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  sending!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  failedUnresolved!: NotificationBoundedMetricDto;
  @ApiProperty({ type: NotificationBoundedMetricDto })
  unknownUnresolved!: NotificationBoundedMetricDto;
}

export class NotificationStatusDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({
    enum: ["disabled", "not_started", "healthy", "stale", "error"],
    description:
      "Successful worker maintenance evidence; does not indicate bot connectivity.",
  })
  state!: "disabled" | "not_started" | "healthy" | "stale" | "error";
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  sourceSince!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  expandedSourceSince!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastMaintenanceAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastCaptureAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastRegistrationAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastErrorAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: NotificationStatusCountsDto })
  counts!: NotificationStatusCountsDto;
  @ApiProperty({ type: NotificationDeliveryCountsDto })
  deliveries!: NotificationDeliveryCountsDto;
}

export class NotificationReceiptsQueryDto {
  @ApiPropertyOptional({
    enum: notificationReceiptStatuses,
    default: "retry_wait",
  })
  @IsOptional()
  @IsIn(notificationReceiptStatuses)
  status?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ type: String, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class NotificationReceiptItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceEventId!: string;
  @ApiProperty({ type: String, format: "uuid" }) resourceId!: string;
  @ApiProperty({ type: Number, nullable: true }) workNumber!: number | null;
  @ApiProperty({ type: String, nullable: true }) eventType!: string | null;
  @ApiProperty({ type: String, nullable: true }) eventLabel!: string | null;
  @ApiProperty({ enum: notificationReceiptStatuses }) status!: string;
  @ApiProperty({ type: Number }) attempts!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) nextAttemptAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  notificationEventId!: string | null;
}

export class NotificationReceiptPageDto {
  @ApiProperty({ type: NotificationReceiptItemDto, isArray: true })
  items!: NotificationReceiptItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
