import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import {
  SourceHdReplaceDto,
  TypesetDraftSavedDto,
} from "./typeset-collaboration.dto.js";
import { SourceHdService } from "./source-hd.service.js";
@ApiTags("works")
@ApiCookieAuth()
@Controller("works/:workId/images/:imageId/hd-replacement")
export class SourceHdController {
  constructor(
    @Inject(SourceHdService) private readonly service: SourceHdService,
  ) {}
  @Post()
  @HttpCode(200)
  @Access({ permission: "works:read", contentType: "multipart/form-data" })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiOperation({ operationId: "replaceSourceImageHd" })
  @ApiConsumes("multipart/form-data")
  @ApiOkResponse({ type: TypesetDraftSavedDto })
  @ApiBody({
    schema: {
      type: "object",
      required: [
        "expectedRevision",
        "idempotencyKey",
        "sameContentConfirmed",
        "file",
      ],
      properties: {
        expectedRevision: { type: "integer" },
        idempotencyKey: { type: "string", format: "uuid" },
        sameContentConfirmed: { type: "boolean" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  replace(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @UploadedFile() file: ManualUploadFile | undefined,
    @Body(bodyValidation(SourceHdReplaceDto)) input: SourceHdReplaceDto,
  ) {
    return this.service.replace(req.actor.userId, workId, imageId, file, input);
  }
}
