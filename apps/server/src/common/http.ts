import {
  Catch,
  HttpException,
  ValidationPipe,
  type ArgumentsHost,
  type ExceptionFilter,
  type Type,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiProperty } from "@nestjs/swagger";

export class ErrorDto {
  @ApiProperty({ type: Number }) statusCode!: number;
  @ApiProperty({
    type: Object,
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  })
  message!: string | string[];
}

export const bodyValidation = (type: Type) =>
  new ValidationPipe({
    expectedType: type,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const result =
      error instanceof HttpException
        ? error.getResponse()
        : "服务器暂时无法完成请求";
    response
      .status(status)
      .json(
        typeof result === "string"
          ? { statusCode: status, message: result }
          : result,
      );
  }
}
