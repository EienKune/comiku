import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from "class-validator";

export class WorkReminderSettingsDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, isArray: true }) sendTimes!: string[];
  @ApiProperty({ type: String }) note!: string;
  @ApiProperty({ type: Number }) revision!: number;
}
export class WorkReminderSubscriptionDto {
  @ApiProperty({ type: Boolean }) digestEnabled!: boolean;
  @ApiProperty({ type: Boolean }) readyEnabled!: boolean;
  @ApiProperty({ type: Boolean }) overdueEnabled!: boolean;
  @ApiProperty({ type: Boolean }) mentionsEnabled!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
}
export class WorkReminderChannelDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) groupId!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String }) connectionKey!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: WorkReminderSubscriptionDto })
  subscription!: WorkReminderSubscriptionDto;
}
export class WorkReminderManagementDto {
  @ApiProperty({ type: WorkReminderSettingsDto })
  settings!: WorkReminderSettingsDto;
  @ApiProperty({ type: WorkReminderChannelDto, isArray: true })
  channels!: WorkReminderChannelDto[];
}
export class WorkReminderSettingsInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: Boolean }) @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: String, isArray: true, minItems: 2, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { each: true })
  sendTimes!: string[];
  @ApiProperty({ type: String, description: "At most 120 Unicode code points" })
  @IsString()
  note!: string;
}
export class WorkReminderSubscriptionInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedChannelRevision!: number;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: Boolean }) @IsBoolean() digestEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() readyEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() overdueEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() mentionsEnabled!: boolean;
}
export class WorkReminderPreviewInputDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  note?: string;
}
export class WorkReminderPreviewDto {
  @ApiProperty({ type: String }) text!: string;
}
