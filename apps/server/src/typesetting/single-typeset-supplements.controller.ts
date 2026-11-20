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
  AddSingleTypesetSupplementDto,
  TypesetDraftMutationDto,
} from "./typeset-collaboration.dto.js";
import { TypesetVersionListDto } from "./typesetting.dto.js";
import { SingleTypesetSupplementsService } from "./single-typeset-supplements.service.js";
@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("works/:workId/typeset/versions/:versionId/supplements")
export class SingleTypesetSupplementsController {
  constructor(
    @Inject(SingleTypesetSupplementsService)
    private readonly service: SingleTypesetSupplementsService,
  ) {}
  @Post()
  @HttpCode(200)
  @Access({ permission: "works:typeset", contentType: "multipart/form-data" })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiOperation({ operationId: "addSingleTypesetSupplement" })
  @ApiConsumes("multipart/form-data")
  @ApiOkResponse({ type: TypesetVersionListDto })
  @ApiBody({
    schema: {
      type: "object",
      required: ["expectedRevision", "idempotencyKey", "position", "file"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", format: "uuid" },
        position: { type: "string", enum: ["start", "end"] },
        file: { type: "string", format: "binary" },
      },
    },
  })
  add(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @UploadedFile() file: ManualUploadFile | undefined,
    @Body(bodyValidation(AddSingleTypesetSupplementDto))
    input: AddSingleTypesetSupplementDto,
  ) {
    return this.service.add(req.actor.userId, workId, versionId, file, input);
  }
  @Post(":imageId/delete")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "removeSingleTypesetSupplement" })
  @ApiBody({ type: TypesetDraftMutationDto })
  @ApiOkResponse({ type: TypesetVersionListDto })
  remove(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Body(bodyValidation(TypesetDraftMutationDto))
    input: TypesetDraftMutationDto,
  ) {
    return this.service.remove(
      req.actor.userId,
      workId,
      versionId,
      imageId,
      input,
    );
  }
}
