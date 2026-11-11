import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class SourceMaintenanceExpectedDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedEpoch!: number;
  @ApiProperty({ type: String })
  @Matches(/^[a-f0-9]{64}$/)
  expectedGeneration!: string;
}
export class SourceCredentialInputDto extends SourceMaintenanceExpectedDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() requestId!: string;
  @ApiPropertyOptional({ type: String, writeOnly: true, maxLength: 8192 })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  authToken?: string;
  @ApiPropertyOptional({ type: String, writeOnly: true, maxLength: 8192 })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  ct0?: string;
  @ApiPropertyOptional({ type: String, writeOnly: true, maxLength: 8192 })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  refreshToken?: string;
}
export class SourceCredentialOperationDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: String, format: "uuid" }) requestId!: string;
  @ApiProperty({ type: String }) phase!: string;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: Number }) expectedEpoch!: number;
  @ApiProperty({ type: String }) expectedGeneration!: string;
  @ApiProperty({ type: String, nullable: true }) targetGeneration!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) verificationOutcome!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) verificationCode!:
    string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  verifiedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  completedAt!: string | null;
}
export class SourceMaintenanceDto {
  @ApiProperty({ type: String }) platform!: string;
  @ApiProperty({ type: Boolean }) supported!: boolean;
  @ApiProperty({ type: String, nullable: true }) readonlyReason!: string | null;
  @ApiProperty({ type: Boolean }) maintenancePaused!: boolean;
  @ApiProperty({ type: Number }) maintenanceEpoch!: number;
  @ApiProperty({ type: String, nullable: true }) credentialGeneration!:
    string | null;
  @ApiProperty({ type: Number }) unsettledExecutions!: number;
  @ApiProperty({ type: Boolean }) canSave!: boolean;
  @ApiProperty({ type: String }) authStatus!: string;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  cooldownUntil!: string | null;
  @ApiProperty({ type: SourceCredentialOperationDto, nullable: true })
  activeOperation!: SourceCredentialOperationDto | null;
  @ApiProperty({ type: SourceCredentialOperationDto, nullable: true })
  lastOperation!: SourceCredentialOperationDto | null;
  @ApiProperty({ type: String, format: "date-time" }) observedAt!: string;
}
