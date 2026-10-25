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
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import { DirectUploadsService } from "./direct-uploads.service.js";
import { DownloadsService } from "./downloads.service.js";
import {
  CreateDirectUploadDto,
  DirectUploadDto,
  DownloadDeliveryDto,
  DownloadPreparationDto,
  PrepareDownloadDto,
} from "./transfers.dto.js";

@ApiTags("transfers")
@ApiCookieAuth()
@Controller("transfers")
export class TransfersController {
  constructor(
    @Inject(DirectUploadsService)
    private readonly uploads: DirectUploadsService,
    @Inject(DownloadsService) private readonly downloads: DownloadsService,
  ) {}
  @Post("uploads")
  @HttpCode(200)
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "createDirectUpload" })
  @ApiBody({ type: CreateDirectUploadDto })
  @ApiOkResponse({ type: DirectUploadDto })
  create(
    @Req() req: AuthRequest,
    @Body(bodyValidation(CreateDirectUploadDto)) input: CreateDirectUploadDto,
  ) {
    return this.uploads.create(req.actor.userId, input);
  }
  @Get("uploads/:id")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "getDirectUpload" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: DirectUploadDto })
  get(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.uploads.get(req.actor.userId, id);
  }
  @Post("uploads/:id/finalize")
  @HttpCode(200)
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "finalizeDirectUpload" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOkResponse({ type: DirectUploadDto })
  finalize(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.uploads.finalize(req.actor.userId, id);
  }
  @Post("downloads")
  @HttpCode(200)
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "prepareDownload" })
  @ApiBody({ type: PrepareDownloadDto })
  @ApiOkResponse({ type: DownloadPreparationDto })
  prepare(
    @Req() req: AuthRequest,
    @Body(bodyValidation(PrepareDownloadDto)) input: PrepareDownloadDto,
  ) {
    return this.downloads.prepare(req.actor.userId, input);
  }
  @Get("downloads/:id")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "getDownloadPreparation" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: DownloadPreparationDto })
  progress(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.downloads.get(req.actor.userId, id);
  }
  @Post("downloads/:id/deliver")
  @HttpCode(200)
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "deliverDownload" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOkResponse({ type: DownloadDeliveryDto })
  deliver(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.downloads.deliver(req.actor.userId, id);
  }
}
