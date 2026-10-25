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
import type { Response } from "express";
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
import { ConfirmPublicationDto, PublishingViewDto } from "./publishing.dto.js";
import { PublishingService } from "./publishing.service.js";

@ApiTags("publishing")
@ApiCookieAuth()
@Controller("works/:workId/publishing")
export class PublishingController {
  constructor(
    @Inject(PublishingService)
    private readonly publishing: PublishingService,
  ) {}

  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getPublishingView" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiOkResponse({ type: PublishingViewDto })
  view(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
  ) {
    return this.publishing.view(request.actor.userId, workId);
  }

  @Get("images")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "downloadPublishingImages" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiOkResponse({
    content: {
      "application/zip": { schema: { type: "string", format: "binary" } },
    },
  })
  async downloadImages(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const archive = await this.publishing.readCurrentImages(
      request.actor.userId,
      workId,
    );
    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="publish-images.zip"; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
    );
    return new StreamableFile(archive.body);
  }

  @Post("confirm")
  @HttpCode(200)
  @Access({ permission: "works:publish" })
  @ApiOperation({ operationId: "confirmPublication" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: ConfirmPublicationDto })
  @ApiOkResponse({ type: PublishingViewDto })
  confirm(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(ConfirmPublicationDto)) input: ConfirmPublicationDto,
  ) {
    return this.publishing.confirm(request.actor.userId, workId, input);
  }
}
