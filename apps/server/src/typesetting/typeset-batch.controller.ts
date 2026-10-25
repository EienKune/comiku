import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  CreateTypesetHandoffPackageDto,
  TypesetHandoffPackageDto,
} from "./typesetting.dto.js";
import {
  DownloadTypesetBatchItemDto,
  TypesetHandoffManifestDto,
} from "./typeset-batch.dto.js";
import { TypesettingService } from "./typesetting.service.js";

@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("typeset")
export class TypesetBatchController {
  constructor(
    @Inject(TypesettingService)
    private readonly typesetting: TypesettingService,
  ) {}

  @Get("handoff-manifest")
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "getTypesetHandoffManifest" })
  @ApiOkResponse({ type: TypesetHandoffManifestDto })
  manifest(@Req() request: AuthRequest) {
    return this.typesetting.handoffManifest(request.actor.userId);
  }

  @Post("handoff-items/:workId")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "prepareTypesetBatchHandoff" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: CreateTypesetHandoffPackageDto })
  @ApiOkResponse({ type: TypesetHandoffPackageDto })
  prepare(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(CreateTypesetHandoffPackageDto))
    input: CreateTypesetHandoffPackageDto,
  ) {
    return this.typesetting.prepareBatchHandoff(
      request.actor.userId,
      workId,
      input,
    );
  }

  @Post("handoff-items/:workId/:packageId/download")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "downloadTypesetBatchHandoff" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "packageId", format: "uuid" })
  @ApiBody({ type: DownloadTypesetBatchItemDto })
  @ApiOkResponse({
    content: {
      "application/zip": { schema: { type: "string", format: "binary" } },
    },
  })
  async download(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("packageId", ParseUUIDPipe) packageId: string,
    @Body(bodyValidation(DownloadTypesetBatchItemDto))
    input: DownloadTypesetBatchItemDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.typesetting.readHandoffPackage(
      request.actor.userId,
      workId,
      packageId,
      input,
    );
    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="typeset-handoff.zip"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    response.setHeader("Cache-Control", "no-store");
    return new StreamableFile(file.body);
  }
}
