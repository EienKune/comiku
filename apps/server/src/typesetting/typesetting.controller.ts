import { ImageReadQueryDto, ImageUrlDto } from "../files/image-url.dto.js";
import {
  Body,
  Controller,
  Query,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import {
  ApiBody,
  ApiCookieAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  CreateTypesetHandoffPackageDto,
  CreateTypesetVersionDto,
  DeleteTypesetVersionDto,
  ManageTypesetVersionDto,
  TypesetHandoffPackageDto,
  TypesetVersionListDto,
  TypesetVersionUploadMode,
} from "./typesetting.dto.js";
import { TypesettingService } from "./typesetting.service.js";
import {
  TYPESET_IMAGE_MAX_FILES,
  TYPESET_IMAGE_MAX_FILE_BYTES,
} from "./typeset-image-upload.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";

@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("works/:workId/typeset")
export class TypesettingController {
  constructor(
    @Inject(TypesettingService)
    private readonly typesetting: TypesettingService,
  ) {}

  @Get("versions")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "listTypesetVersions" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiOkResponse({ type: TypesetVersionListDto })
  listVersions(@Param("workId", ParseUUIDPipe) workId: string) {
    return this.typesetting.listVersions(workId);
  }

  @Post("versions")
  @Access({ permission: "works:typeset", contentType: "multipart/form-data" })
  @UseInterceptors(
    FilesInterceptor("files", TYPESET_IMAGE_MAX_FILES, {
      limits: {
        files: TYPESET_IMAGE_MAX_FILES,
        fileSize: TYPESET_IMAGE_MAX_FILE_BYTES,
      },
    }),
  )
  @ApiOperation({ operationId: "createTypesetVersion" })
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["expectedRevision", "idempotencyKey", "mode", "files"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", format: "uuid" },
        mode: { type: "string", enum: Object.values(TypesetVersionUploadMode) },
        note: { type: "string", maxLength: 1000, nullable: true },
        sourceImageIds: {
          type: "string",
          description:
            "JSON array aligned with files; values are source work image UUIDs or null.",
        },
        files: {
          type: "array",
          minItems: 1,
          maxItems: TYPESET_IMAGE_MAX_FILES,
          items: { type: "string", format: "binary" },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: TypesetVersionListDto })
  createVersion(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @UploadedFiles() files: ManualUploadFile[] | undefined,
    @Body(bodyValidation(CreateTypesetVersionDto))
    input: CreateTypesetVersionDto,
  ) {
    return this.typesetting.createVersion(
      request.actor.userId,
      workId,
      files ?? [],
      input,
    );
  }

  @Post("versions/:versionId/select")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "selectTypesetVersion" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "versionId", format: "uuid" })
  @ApiBody({ type: ManageTypesetVersionDto })
  @ApiOkResponse({ type: TypesetVersionListDto })
  selectVersion(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Body(bodyValidation(ManageTypesetVersionDto))
    input: ManageTypesetVersionDto,
  ) {
    return this.typesetting.selectVersion(
      request.actor.userId,
      workId,
      versionId,
      input,
    );
  }

  @Post("versions/:versionId/delete")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "deleteTypesetVersion" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "versionId", format: "uuid" })
  @ApiBody({ type: DeleteTypesetVersionDto })
  @ApiOkResponse({ type: TypesetVersionListDto })
  deleteVersion(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Body(bodyValidation(DeleteTypesetVersionDto))
    input: DeleteTypesetVersionDto,
  ) {
    return this.typesetting.deleteVersion(
      request.actor.userId,
      workId,
      versionId,
      input,
    );
  }

  @Post("versions/:versionId/restore")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "restoreTypesetVersion" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "versionId", format: "uuid" })
  @ApiBody({ type: ManageTypesetVersionDto })
  @ApiOkResponse({ type: TypesetVersionListDto })
  restoreVersion(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Body(bodyValidation(ManageTypesetVersionDto))
    input: ManageTypesetVersionDto,
  ) {
    return this.typesetting.restoreVersion(
      request.actor.userId,
      workId,
      versionId,
      input,
    );
  }

  @Get("versions/:versionId/images/:imageId/url")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getTypesetVersionImageUrl" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "versionId", format: "uuid" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiQuery({ type: ImageReadQueryDto })
  @ApiOkResponse({ type: ImageUrlDto })
  imageUrl(
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Query(bodyValidation(ImageReadQueryDto)) query: ImageReadQueryDto,
  ) {
    return this.typesetting.imageUrl(workId, versionId, imageId, query.variant);
  }

  @Post("handoff-packages")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "createTypesetHandoffPackage" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: CreateTypesetHandoffPackageDto })
  @ApiOkResponse({ type: TypesetHandoffPackageDto })
  createHandoffPackage(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(CreateTypesetHandoffPackageDto))
    input: CreateTypesetHandoffPackageDto,
  ) {
    return this.typesetting.createHandoffPackage(
      request.actor.userId,
      workId,
      input,
    );
  }

  @Get("handoff-packages/:packageId")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "downloadTypesetHandoffPackage" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "packageId", format: "uuid" })
  @ApiOkResponse({
    content: {
      "application/zip": { schema: { type: "string", format: "binary" } },
    },
  })
  async downloadHandoffPackage(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("packageId", ParseUUIDPipe) packageId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.typesetting.readHandoffPackage(
      request.actor.userId,
      workId,
      packageId,
    );
    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="typeset-handoff.zip"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    return new StreamableFile(file.body);
  }
}
