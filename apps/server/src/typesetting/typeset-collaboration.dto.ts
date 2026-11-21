import { Transform, Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
export class TypesetDraftMutationDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  idempotencyKey!: string;
}
export class AddSingleTypesetSupplementDto extends TypesetDraftMutationDto {
  @ApiProperty({ enum: ["start", "end"] }) @IsIn(["start", "end"]) position!:
    "start" | "end";
}
export class TypesetSessionPreviewDto extends TypesetDraftMutationDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() sessionId!: string;
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  rebind?: boolean;
}
export class AdoptTypesetImageDto extends TypesetSessionPreviewDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  uploadImageId!: string;
}
export class AdoptTypesetSupplementDto extends AdoptTypesetImageDto {
  @ApiProperty({ enum: ["start", "end"] }) @IsIn(["start", "end"]) position!:
    "start" | "end";
}
export class TypesetImportMappingDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() imageId!: string;
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID()
  workImageId?: string | null;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  draftId?: string;
  @ApiProperty({ enum: ["page", "start", "end", "free"] })
  @IsIn(["page", "start", "end", "free"])
  position!: "page" | "start" | "end" | "free";
}
export class ApplyTypesetImportDto extends TypesetDraftMutationDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID() sessionId!: string;
  @ApiProperty({ type: TypesetImportMappingDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TypesetImportMappingDto)
  mappings!: TypesetImportMappingDto[];
}
export class SourceHdReplaceDto extends TypesetDraftMutationDto {
  @ApiProperty({ type: Boolean })
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  sameContentConfirmed!: boolean;
}
export class TypesetCollaborationAssignmentDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  participantId!: string | null;
  @ApiProperty({ type: Number }) generation!: number;
  @ApiProperty({ type: Number }) draftRevision!: number;
  @ApiProperty({ type: Number, nullable: true }) submittedRevision!:
    number | null;
  @ApiProperty({ type: Number, nullable: true }) submittedGeneration!:
    number | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  submittedAt!: string | null;
}
export class TypesetCollaborationPageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: TypesetCollaborationAssignmentDto, nullable: true })
  assignment!: TypesetCollaborationAssignmentDto | null;
}
export class TypesetCollaborationUserDto {
  @ApiProperty({ type: String }) displayName!: string;
}
export class TypesetCollaborationParticipantDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: TypesetCollaborationUserDto })
  user!: TypesetCollaborationUserDto;
}
export class TypesetDraftDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) workImageId!:
    string | null;
  @ApiProperty({ type: String, format: "uuid" }) participantId!: string;
  @ApiProperty({ type: String }) position!: string;
  @ApiProperty({ type: Number }) orderIndex!: number;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number, nullable: true }) submittedRevision!:
    number | null;
}
export class TypesetCollaborationStateDto {
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) editorEpoch!: number;
  @ApiProperty({ type: String }) workflowStatus!: string;
  @ApiProperty({ type: String }) collaborationMode!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  currentTypesetVersionId!: string | null;
  @ApiProperty({ type: Boolean }) handoffReady!: boolean;
  @ApiProperty({ type: TypesetCollaborationPageDto, isArray: true })
  pages!: TypesetCollaborationPageDto[];
  @ApiProperty({ type: TypesetCollaborationParticipantDto, isArray: true })
  participants!: TypesetCollaborationParticipantDto[];
  @ApiProperty({ type: TypesetDraftDto, isArray: true })
  drafts!: TypesetDraftDto[];
}
export class TypesetImportPreviewImageDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) sourceName!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  suggestedWorkImageId!: string | null;
}
export class TypesetImportPreviewDto {
  @ApiProperty({ type: String, format: "uuid" }) sessionId!: string;
  @ApiProperty({ type: Number }) expectedRevision!: number;
  @ApiProperty({ type: TypesetImportPreviewImageDto, isArray: true })
  images!: TypesetImportPreviewImageDto[];
}
export class TypesetDraftSavedDto {
  @ApiProperty({ type: Number }) revision!: number;
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  versionId?: string | null;
}
