import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Min,
} from "class-validator";

export class BirthdayPersonDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, isArray: true }) aliases!: string[];
  @ApiProperty({ type: Number, nullable: true }) month!: number | null;
  @ApiProperty({ type: Number, nullable: true }) day!: number | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextDate!: string | null;
  @ApiProperty({ type: Number, nullable: true }) daysUntil!: number | null;
}
export class BirthdayCalendarDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String }) today!: string;
  @ApiProperty({ type: String }) windowEnd!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ type: BirthdayPersonDto, isArray: true })
  people!: BirthdayPersonDto[];
}
export class BirthdaySettingsDto {
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Boolean }) displayEnabled!: boolean;
  @ApiProperty({ type: Boolean }) remindersEnabled!: boolean;
  @ApiProperty({ type: String }) sendTime!: string;
  @ApiProperty({ type: Number, isArray: true }) offsetDays!: number[];
}
export class BirthdayManagementDto {
  @ApiProperty({ type: Boolean }) available!: boolean;
  @ApiProperty({ type: BirthdaySettingsDto }) settings!: BirthdaySettingsDto;
  @ApiProperty({ type: Number }) personCount!: number;
  @ApiProperty({ type: String, nullable: true }) lastCheckedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) dataUpdatedAt!: string | null;
}
export class BirthdaySettingsInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: Boolean }) @IsBoolean() displayEnabled!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() remindersEnabled!: boolean;
  @ApiProperty({ type: String })
  @IsString()
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  sendTime!: string;
  @ApiProperty({ type: Number, isArray: true, enum: [0, 1, 7] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn([0, 1, 7], { each: true })
  offsetDays!: number[];
}
export class BirthdayTemplateDto {
  @ApiProperty({ type: String }) note!: string;
  @ApiProperty({ type: Number }) revision!: number;
}
export class BirthdayTemplateInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: String, description: "At most 120 Unicode code points" })
  @IsString()
  note!: string;
}
export class BirthdayChannelDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) groupId!: string;
  @ApiProperty({ type: String }) connectionKey!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Boolean }) birthdayEnabled!: boolean;
  @ApiProperty({ type: Number }) birthdayRevision!: number;
}
export class BirthdaySubscriptionInputDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedChannelRevision!: number;
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedScopeRevision!: number;
  @ApiProperty({ type: Boolean }) @IsBoolean() enabled!: boolean;
}
export class BirthdayPreviewDto {
  @ApiProperty({ type: String }) text!: string;
}
export class BirthdaySyncDto {
  @ApiProperty({ type: Boolean }) queued!: boolean;
}
