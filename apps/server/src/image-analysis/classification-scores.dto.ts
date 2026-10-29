import { ApiProperty } from "@nestjs/swagger";
import { CandidateClassificationTagDto } from "../candidates/candidates.dto.js";

export class CandidateClassificationImageDto {
  @ApiProperty({ type: String, format: "uuid" }) mediaId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) index!: number;
  @ApiProperty({ enum: ["succeeded", "pending", "failed", "unavailable"] })
  state!: "succeeded" | "pending" | "failed" | "unavailable";
  @ApiProperty({
    type: Number,
    isArray: true,
    nullable: true,
    description: "Probabilities aligned with columns; null when unusable.",
  })
  scores!: number[] | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Zero-based winning column; null when unusable.",
  })
  winner!: number | null;
}
export class CandidateClassificationScoresDto {
  @ApiProperty({ type: String, nullable: true }) modelKey!: string | null;
  @ApiProperty({ type: CandidateClassificationTagDto, isArray: true })
  columns!: CandidateClassificationTagDto[];
  @ApiProperty({ type: CandidateClassificationImageDto, isArray: true })
  images!: CandidateClassificationImageDto[];
}
