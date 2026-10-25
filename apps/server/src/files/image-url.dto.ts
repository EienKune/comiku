import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";
import { ImageDerivativeStatus } from "../generated/prisma/client.js";

export class ImageReadQueryDto {
  @ApiPropertyOptional({
    type: String,
    enum: ["original", "thumbnail"],
    default: "original",
  })
  @IsOptional()
  @IsIn(["original", "thumbnail"])
  variant: "original" | "thumbnail" = "original";
}

export class ImageUrlDto {
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: Number }) expiresInSeconds!: number;
  @ApiProperty({
    enum: ImageDerivativeStatus,
    enumName: "ImageDerivativeStatus",
  })
  status!: ImageDerivativeStatus;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: String, format: "uuid" }) fileId!: string;
}
