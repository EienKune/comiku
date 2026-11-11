import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsString, Matches, Min, ValidateIf } from "class-validator";

export class UpdateQqBindingDto {
  @ApiProperty({
    type: String,
    nullable: true,
    minLength: 5,
    maxLength: 20,
    pattern: "^[1-9][0-9]{4,19}$",
    description:
      "群内工作提醒使用的 QQ 号；null 解绑，不作为登录或身份认证依据",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @Matches(/^[1-9][0-9]{4,19}$/)
  qqNumber!: string | null;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class QqBindingDto {
  @ApiProperty({ type: String, nullable: true })
  qqNumber!: string | null;

  @ApiProperty({ type: Number, minimum: 0 })
  revision!: number;
}
