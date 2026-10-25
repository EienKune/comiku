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
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
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
  ConfirmTypesetUploadDto,
  CreateTypesetUploadSessionDto,
  PreviewTypesetUploadGroupsDto,
  TypesetUploadConfirmedDto,
  TypesetUploadPlansDto,
  TypesetUploadSessionDto,
} from "./typeset-upload.dto.js";
import { TypesetUploadsService } from "./typeset-uploads.service.js";

@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("typeset/upload-sessions")
export class TypesetUploadsController {
  constructor(
    @Inject(TypesetUploadsService)
    private readonly uploads: TypesetUploadsService,
  ) {}

  @Post()
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "createTypesetUploadSession" })
  @ApiBody({ type: CreateTypesetUploadSessionDto })
  @ApiCreatedResponse({ type: TypesetUploadSessionDto })
  create(
    @Req() req: AuthRequest,
    @Body(bodyValidation(CreateTypesetUploadSessionDto))
    input: CreateTypesetUploadSessionDto,
  ) {
    return this.uploads.create(req.actor.userId, input);
  }

  @Get(":id")
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "getTypesetUploadSession" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: TypesetUploadSessionDto })
  get(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.uploads.get(req.actor.userId, id);
  }

  @Post(":id/extract")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "extractTypesetUploadSession" })
  @ApiBody({
    required: true,
    schema: { type: "object", additionalProperties: false },
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: TypesetUploadSessionDto })
  extract(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.uploads.queueExtract(req.actor.userId, id);
  }

  @Get(":id/images/:imageId/url")
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "getTypesetUploadPreviewImageUrl" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiQuery({ type: ImageReadQueryDto })
  @ApiOkResponse({ type: ImageUrlDto })
  image(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Query(bodyValidation(ImageReadQueryDto)) query: ImageReadQueryDto,
  ) {
    return this.uploads.imageUrl(req.actor.userId, id, imageId, query.variant);
  }

  @Post(":id/plans")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "previewTypesetUploadPlans" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: PreviewTypesetUploadGroupsDto })
  @ApiOkResponse({ type: TypesetUploadPlansDto })
  plans(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(PreviewTypesetUploadGroupsDto))
    input: PreviewTypesetUploadGroupsDto,
  ) {
    return this.uploads.plans(req.actor.userId, id, input);
  }

  @Post(":id/confirm")
  @HttpCode(200)
  @Access({ permission: "works:typeset" })
  @ApiOperation({ operationId: "confirmTypesetUploadItem" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ConfirmTypesetUploadDto })
  @ApiOkResponse({ type: TypesetUploadConfirmedDto })
  confirm(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ConfirmTypesetUploadDto))
    input: ConfirmTypesetUploadDto,
  ) {
    return this.uploads.confirm(req.actor.userId, id, input.previewId);
  }
}
