import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { NOTIFICATION_EVENT_KEYS } from "./notification-events.js";

export const notificationDeliveryStatuses = [
  "pending",
  "sending",
  "retry_wait",
  "accepted",
  "failed",
  "unknown",
  "cancelled",
] as const;

export class NotificationConnectionDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) adapter!: string;
  @ApiProperty({ type: Boolean }) available!: boolean;
}

export class NotificationEventTypeDto {
  @ApiProperty({ type: String }) type!: string;
  @ApiProperty({ type: String }) label!: string;
}

export class NotificationChannelDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) connectionKey!: string;
  @ApiProperty({ type: String }) groupId!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, isArray: true }) eventTypes!: string[];
  @ApiProperty({ type: Boolean }) includeDetails!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) audienceGeneration!: number;
}

export class NotificationConfigurationDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) configurationError!:
    string | null;
  @ApiProperty({ type: NotificationConnectionDto, isArray: true })
  connections!: NotificationConnectionDto[];
  @ApiProperty({ type: NotificationEventTypeDto, isArray: true })
  eventTypes!: NotificationEventTypeDto[];
  @ApiProperty({ type: NotificationChannelDto, isArray: true })
  channels!: NotificationChannelDto[];
}

export class NotificationChannelInputDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/u)
  name!: string;

  @ApiProperty({
    type: String,
    maxLength: 64,
    pattern: "^[A-Za-z0-9_-]{1,64}$",
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  connectionKey!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]{0,19}$" })
  @IsString()
  @Matches(/^[1-9][0-9]{0,19}$/)
  groupId!: string;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ type: String, isArray: true, enum: NOTIFICATION_EVENT_KEYS })
  @IsArray()
  @ArrayMaxSize(32)
  @ArrayUnique()
  @IsIn(NOTIFICATION_EVENT_KEYS, { each: true })
  eventTypes!: string[];

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  includeDetails!: boolean;
}

export class NotificationChannelUpdateDto extends NotificationChannelInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class NotificationPreviewInputDto {
  @ApiProperty({ type: String, enum: NOTIFICATION_EVENT_KEYS })
  @IsIn(NOTIFICATION_EVENT_KEYS)
  eventType!: string;
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  includeDetails!: boolean;
}

export class NotificationPreviewDto {
  @ApiProperty({ type: String }) text!: string;
}

export class NotificationDeliveryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) channelId!: string;
  @ApiProperty({ type: String }) channelName!: string;
  @ApiProperty({ type: String }) eventType!: string;
  @ApiProperty({ type: Number, nullable: true }) workNumber!: number | null;
  @ApiProperty({ enum: notificationDeliveryStatuses })
  status!: (typeof notificationDeliveryStatuses)[number];
  @ApiProperty({ type: Number }) attempts!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerMessageId!:
    string | null;
  @ApiProperty({ type: String }) preview!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  resolvedAt!: string | null;
}

export class NotificationDeliveryPageDto {
  @ApiProperty({ type: NotificationDeliveryDto, isArray: true })
  items!: NotificationDeliveryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class NotificationDeliveryQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
  @ApiPropertyOptional({ enum: notificationDeliveryStatuses })
  @IsOptional()
  @IsIn(notificationDeliveryStatuses)
  status?: (typeof notificationDeliveryStatuses)[number];
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 25;
}

export class NotificationTestDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}

export class NotificationResolveDto extends NotificationTestDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ enum: ["acknowledge", "retry"] })
  @IsIn(["acknowledge", "retry"])
  action!: "acknowledge" | "retry";
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  confirmPossibleDuplicate?: boolean;
}
