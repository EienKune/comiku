import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import {
  ApiBody,
  ApiCookieAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  CreateTranslationEntryDto,
  DeleteTranslationEntryDto,
  ExportLabelPlusDto,
  ImportLabelPlusDto,
  LabelPlusExportDto,
  LabelPlusImportPreviewDto,
  ReorderTranslationEntryDto,
  TranslationEditorDto,
  TranslationEntryDto,
  TranslationImageDraftDto,
  TranslationPresenceListDto,
  UpdateTranslationPresenceDto,
  UpdateTranslationEntryDto,
} from "./translations.dto.js";
import {
  TranslationsService,
  type LabelPlusUpload,
} from "./translations.service.js";

const labelPlusUploadOptions = {
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
};

@ApiTags("translations")
@ApiCookieAuth()
@Controller()
export class TranslationsController {
  constructor(
    @Inject(TranslationsService)
    private readonly translations: TranslationsService,
  ) {}

  @Get("works/:workId/translations")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getTranslationEditor" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiOkResponse({ type: TranslationEditorDto })
  getEditor(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
  ) {
    return this.translations.getEditor(
      request.actor.userId,
      workId,
      request.actor.sessionId,
    );
  }

  @Post("works/:workId/labelplus/imports/preview")
  @HttpCode(200)
  @Access({ permission: "works:read", contentType: "multipart/form-data" })
  @UseInterceptors(FileInterceptor("file", labelPlusUploadOptions))
  @ApiOperation({ operationId: "previewLabelPlusImport" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiOkResponse({ type: LabelPlusImportPreviewDto })
  previewLabelPlusImport(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @UploadedFile() file?: LabelPlusUpload,
  ) {
    if (!file) throw new BadRequestException("请选择 LabelPlus 文件");
    return this.translations.previewLabelPlusImport(
      request.actor.userId,
      workId,
      file,
    );
  }

  @Post("works/:workId/labelplus/imports")
  @HttpCode(200)
  @Access({ permission: "works:read", contentType: "multipart/form-data" })
  @UseInterceptors(FileInterceptor("file", labelPlusUploadOptions))
  @ApiOperation({ operationId: "importLabelPlus" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: [
        "file",
        "stage",
        "expectedRevision",
        "expectedEditorEpoch",
        "idempotencyKey",
      ],
      properties: {
        file: { type: "string", format: "binary" },
        stage: { type: "string", enum: ["translate", "proofread"] },
        expectedRevision: { type: "integer", minimum: 0 },
        expectedEditorEpoch: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", format: "uuid" },
      },
    },
  })
  @ApiOkResponse({ type: TranslationEditorDto })
  importLabelPlus(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @UploadedFile() file: LabelPlusUpload | undefined,
    @Body(bodyValidation(ImportLabelPlusDto)) input: ImportLabelPlusDto,
  ) {
    if (!file) throw new BadRequestException("请选择 LabelPlus 文件");
    return this.translations.importLabelPlus(
      request.actor.userId,
      request.actor.sessionId,
      workId,
      file,
      input,
    );
  }

  @Post("works/:workId/labelplus/exports")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "exportLabelPlus" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: ExportLabelPlusDto })
  @ApiOkResponse({ type: LabelPlusExportDto })
  exportLabelPlus(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(ExportLabelPlusDto)) input: ExportLabelPlusDto,
  ) {
    return this.translations.exportLabelPlus(
      request.actor.userId,
      workId,
      input,
    );
  }

  @Get("works/:workId/labelplus/files/:fileId")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "downloadLabelPlusFile" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "fileId", format: "uuid" })
  @ApiOkResponse({
    content: {
      "text/plain": { schema: { type: "string", format: "binary" } },
    },
  })
  async downloadLabelPlusFile(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("fileId", ParseUUIDPipe) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.translations.readLabelPlusFile(
      request.actor.userId,
      workId,
      fileId,
    );
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="labelplus.txt"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    return new StreamableFile(file.body);
  }

  @Post("works/:workId/translations/presence")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "updateTranslationPresence" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: UpdateTranslationPresenceDto })
  @ApiOkResponse({ type: TranslationPresenceListDto })
  updatePresence(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(UpdateTranslationPresenceDto))
    input: UpdateTranslationPresenceDto,
  ) {
    return this.translations.updatePresence(
      request.actor.userId,
      request.actor.sessionId,
      workId,
      input,
    );
  }

  @Delete("works/:workId/translations/presence")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "leaveTranslationPresence" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOkResponse({ type: TranslationPresenceListDto })
  leavePresence(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
  ) {
    return this.translations.leavePresence(
      request.actor.userId,
      request.actor.sessionId,
      workId,
    );
  }

  @Post("work-images/:imageId/markers")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "createTranslationEntry" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiBody({ type: CreateTranslationEntryDto })
  @ApiCreatedResponse({ type: TranslationImageDraftDto })
  create(
    @Req() request: AuthRequest,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Body(bodyValidation(CreateTranslationEntryDto))
    input: CreateTranslationEntryDto,
  ) {
    return this.translations.createEntry(request.actor.userId, imageId, input);
  }

  @Patch("translation-entries/:entryId")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "updateTranslationEntry" })
  @ApiParam({ name: "entryId", format: "uuid" })
  @ApiBody({ type: UpdateTranslationEntryDto })
  @ApiOkResponse({ type: TranslationEntryDto })
  update(
    @Req() request: AuthRequest,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body(bodyValidation(UpdateTranslationEntryDto))
    input: UpdateTranslationEntryDto,
  ) {
    return this.translations.updateEntry(request.actor.userId, entryId, input);
  }

  @Delete("translation-entries/:entryId")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "deleteTranslationEntry" })
  @ApiParam({ name: "entryId", format: "uuid" })
  @ApiBody({ type: DeleteTranslationEntryDto })
  @ApiOkResponse({ type: TranslationImageDraftDto })
  remove(
    @Req() request: AuthRequest,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body(bodyValidation(DeleteTranslationEntryDto))
    input: DeleteTranslationEntryDto,
  ) {
    return this.translations.deleteEntry(request.actor.userId, entryId, input);
  }

  @Post("work-images/:imageId/markers/:entryId/reorder")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "reorderTranslationEntry" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiParam({ name: "entryId", format: "uuid" })
  @ApiBody({ type: ReorderTranslationEntryDto })
  @ApiOkResponse({ type: TranslationImageDraftDto })
  reorder(
    @Req() request: AuthRequest,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body(bodyValidation(ReorderTranslationEntryDto))
    input: ReorderTranslationEntryDto,
  ) {
    return this.translations.reorderEntry(
      request.actor.userId,
      imageId,
      entryId,
      input,
    );
  }
}
