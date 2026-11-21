import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { ImageReadQueryDto, ImageUrlDto } from "../files/image-url.dto.js";
import { FilesInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import { TypesetCollaborationService } from "./typeset-collaboration.service.js";
import {
  ApplyTypesetImportDto,
  TypesetDraftMutationDto,
  TypesetCollaborationStateDto,
  TypesetImportPreviewDto,
  TypesetDraftSavedDto,
  TypesetSessionPreviewDto,
} from "./typeset-collaboration.dto.js";
@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("works/:workId/typeset/collaboration")
export class TypesetCollaborationController {
  constructor(
    @Inject(TypesetCollaborationService)
    private readonly service: TypesetCollaborationService,
  ) {}
  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getTypesetCollaboration" })
  @ApiParam({ name: "workId", format: "uuid", type: String })
  @ApiOkResponse({ type: TypesetCollaborationStateDto })
  state(@Param("workId", ParseUUIDPipe) workId: string) {
    return this.service.state(workId);
  }
  @Get("drafts/:draftId/url")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getTypesetDraftImageUrl" })
  @ApiOkResponse({ type: ImageUrlDto })
  image(
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
    @Query(bodyValidation(ImageReadQueryDto)) query: ImageReadQueryDto,
  ) {
    return this.service.imageUrl(workId, draftId, query.variant);
  }
  @Post("preview")
  @HttpCode(200)
  @Access({ permission: "works:typeset", contentType: "multipart/form-data" })
  @UseInterceptors(
    FilesInterceptor("files", 100, {
      limits: { files: 100, fileSize: 25 * 1024 * 1024 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ operationId: "previewTypesetCollaborationImport" })
  @ApiOkResponse({ type: TypesetImportPreviewDto })
  @ApiBody({
    schema: {
      type: "object",
      required: ["expectedRevision", "idempotencyKey", "files"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", format: "uuid" },
        files: { type: "array", items: { type: "string", format: "binary" } },
      },
    },
  })
  preview(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @UploadedFiles() files: ManualUploadFile[],
    @Body(bodyValidation(TypesetDraftMutationDto))
    input: TypesetDraftMutationDto,
  ) {
    return this.service.preview(req.actor.userId, workId, files ?? [], input);
  }
  @Post("apply")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "applyTypesetCollaborationImport" })
  @ApiBody({ type: ApplyTypesetImportDto })
  @ApiOkResponse({ type: TypesetDraftSavedDto })
  apply(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(ApplyTypesetImportDto)) input: ApplyTypesetImportDto,
  ) {
    return this.service.apply(req.actor.userId, workId, input);
  }
  @Post("preview-session")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "previewTypesetCollaborationSession" })
  @ApiParam({ name: "workId", format: "uuid", type: String })
  @ApiBody({ type: TypesetSessionPreviewDto })
  @ApiOkResponse({ type: TypesetImportPreviewDto })
  previewSession(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(TypesetSessionPreviewDto))
    input: TypesetSessionPreviewDto,
  ) {
    return this.service.previewSession(req.actor.userId, workId, input);
  }
  @Post("drafts/:draftId/delete")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "deleteTypesetSupplement" })
  @ApiBody({ type: TypesetDraftMutationDto })
  remove(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
    @Body(bodyValidation(TypesetDraftMutationDto))
    input: TypesetDraftMutationDto,
  ) {
    return this.service.remove(req.actor.userId, workId, draftId, input);
  }
}
