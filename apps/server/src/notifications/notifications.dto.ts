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
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { NOTIFICATION_EVENT_KEYS } from "./notification-events.js";
import { WorkStage } from "../generated/prisma/enums.js";

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
  @ApiProperty({ type: Boolean }) supportsStages!: boolean;
  @ApiProperty({ enum: WorkStage, isArray: true }) allowedStages!: WorkStage[];
}

export class NotificationSubscriptionRuleDto {
  @ApiProperty({ type: String, enum: NOTIFICATION_EVENT_KEYS })
  @IsIn(NOTIFICATION_EVENT_KEYS)
  eventType!: string;
  @ApiProperty({ enum: WorkStage, isArray: true, nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(Object.values(WorkStage), { each: true })
  stages!: WorkStage[] | null;
}

export class NotificationTemplateSettingsDto {
  @ApiProperty({ type: Boolean }) @IsBoolean() titleEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() authorEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() actorEnabled!: boolean;
  @ApiProperty({ type: String, description: "At most 120 Unicode code points" })
  @IsString()
  note!: string;
}
export class NotificationTemplateDto extends NotificationTemplateSettingsDto {
  @ApiProperty({ type: String }) eventType!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) contentRevision!: number;
  @ApiProperty({ type: Number }) referencedGroupCount!: number;
}
export class NotificationTemplateUpdateDto extends NotificationTemplateSettingsDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class NotificationChannelDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) connectionKey!: string;
  @ApiProperty({ type: String }) groupId!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, isArray: true }) eventTypes!: string[];
  @ApiProperty({ type: Boolean }) includeDetails!: boolean;
  @ApiProperty({ enum: ["legacy", "templates"] }) receiverMode!:
    "legacy" | "templates";
  @ApiProperty({ type: NotificationSubscriptionRuleDto, isArray: true })
  subscriptionRules!: NotificationSubscriptionRuleDto[];
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
  @ApiProperty({ type: NotificationTemplateDto, isArray: true })
  templates!: NotificationTemplateDto[];
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

  @ApiPropertyOptional({ enum: ["legacy", "templates"] })
  @IsOptional()
  @IsIn(["legacy", "templates"])
  receiverMode?: "legacy" | "templates";
  @ApiPropertyOptional({ type: NotificationSubscriptionRuleDto, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_EVENT_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationSubscriptionRuleDto)
  subscriptionRules?: NotificationSubscriptionRuleDto[];
}

export class NotificationTemplateRevisionDto {
  @ApiProperty({ type: String, enum: NOTIFICATION_EVENT_KEYS })
  @IsIn(NOTIFICATION_EVENT_KEYS)
  eventType!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  revision!: number;
}

export class NotificationChannelUpdateDto extends NotificationChannelInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiPropertyOptional({ type: NotificationTemplateRevisionDto, isArray: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_EVENT_KEYS.length)
  @ArrayUnique((entry: NotificationTemplateRevisionDto) => entry?.eventType)
  @ValidateNested({ each: true })
  @Type(() => NotificationTemplateRevisionDto)
  expectedTemplateRevisions?: NotificationTemplateRevisionDto[];
}

export class NotificationPreviewInputDto {
  @ApiProperty({ type: String, enum: NOTIFICATION_EVENT_KEYS })
  @IsIn(NOTIFICATION_EVENT_KEYS)
  eventType!: string;
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  includeDetails!: boolean;
  @ApiPropertyOptional({ type: NotificationTemplateSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationTemplateSettingsDto)
  template?: NotificationTemplateSettingsDto;
  @ApiPropertyOptional({ enum: WorkStage })
  @IsOptional()
  @IsIn(Object.values(WorkStage))
  stage?: WorkStage;
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  missingMetadata?: boolean;
}

export class NotificationPreviewDto {
  @ApiProperty({ type: String }) text!: string;
}

export class NotificationDeliveryDto {
  @ApiProperty({ enum: ["capture_current"], nullable: true })
  metadataOrigin!: "capture_current" | null;
  @ApiProperty({ type: Number, nullable: true }) contentRevision!:
    number | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  metadataObservedAt!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) channelId!: string;
  @ApiProperty({ type: String }) channelName!: string;
  @ApiProperty({ type: String }) groupId!: string;
  @ApiProperty({ type: String }) connectionKey!: string;
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
  @ApiPropertyOptional({ type: String, enum: NOTIFICATION_EVENT_KEYS })
  @IsOptional()
  @IsIn(NOTIFICATION_EVENT_KEYS)
  eventType?: string;
  @ApiPropertyOptional({ enum: WorkStage })
  @IsOptional()
  @IsIn(Object.values(WorkStage))
  stage?: WorkStage;
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTemplateRevision?: number;
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
