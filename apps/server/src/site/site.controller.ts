import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Headers,
  Inject,
  Injectable,
  NestInterceptor,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { finalize } from "rxjs";
import type { Response } from "express";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import { SiteService } from "./site.service.js";
import { SiteIconService } from "./site-icon.service.js";
import { SITE_ICON_MAX_BYTES } from "./site-icon-processor.js";
import {
  SiteIconUploadDto,
  SiteSettingsDto,
  UpdateSiteSettingsDto,
} from "./site.dto.js";

@Injectable()
export class SiteUploadPermit implements NestInterceptor {
  constructor(
    @Inject(SiteIconService) private readonly icons: SiteIconService,
  ) {}
  intercept(_context: ExecutionContext, next: CallHandler) {
    const release = this.icons.acquire();
    try {
      return next.handle().pipe(finalize(release));
    } catch (error) {
      release();
      throw error;
    }
  }
}
@ApiTags("site")
@Controller("site")
export class SiteController {
  constructor(
    @Inject(SiteService) private readonly site: SiteService,
    @Inject(SiteIconService) private readonly icons: SiteIconService,
  ) {}
  @Get()
  @Access({ public: true })
  @ApiOperation({ operationId: "getSite" })
  @ApiOkResponse({ type: SiteSettingsDto })
  async publicSettings(
    @Headers("if-none-match") condition: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const settings = await this.site.readPublic();
    const etag = `"site-${settings.revision}"`;
    response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    response.setHeader("ETag", etag);
    if (
      condition
        ?.split(",")
        .some(
          (value) =>
            value.trim().replace(/^W\//, "") === etag || value.trim() === "*",
        )
    ) {
      response.status(304);
      return;
    }
    return settings;
  }
  @Get("settings")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getSiteSettings" })
  @ApiOkResponse({ type: SiteSettingsDto })
  settings(@Req() req: AuthRequest) {
    return this.site.readAdmin(req.actor);
  }
  @Patch("settings")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateSiteSettings" })
  @ApiBody({ type: UpdateSiteSettingsDto })
  @ApiOkResponse({ type: SiteSettingsDto })
  update(
    @Req() req: AuthRequest,
    @Body(bodyValidation(UpdateSiteSettingsDto)) input: UpdateSiteSettingsDto,
  ) {
    return this.site.update(req.actor, input);
  }
  @Post("icon-uploads")
  @Access({ permission: "system:manage", contentType: "multipart/form-data" })
  @UseInterceptors(
    SiteUploadPermit,
    FileInterceptor("file", {
      limits: { fileSize: SITE_ICON_MAX_BYTES, files: 1, fields: 0, parts: 2 },
    }),
  )
  @ApiOperation({ operationId: "uploadSiteIcon" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiCreatedResponse({ type: SiteIconUploadDto })
  upload(
    @Req() req: AuthRequest,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!file) throw new BadRequestException("请选择站点图标");
    return this.icons.prepare(req.actor, file.buffer, file.mimetype);
  }
  @Get("icon/:version/:size")
  @Access({ public: true })
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  @ApiOperation({ operationId: "getSiteIcon" })
  async icon(
    @Param("version", ParseUUIDPipe) version: string,
    @Param("size", ParseIntPipe) size: number,
  ) {
    return new StreamableFile(await this.icons.readPublic(version, size));
  }
}
