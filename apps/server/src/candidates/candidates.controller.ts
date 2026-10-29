import { ImageReadQueryDto, ImageUrlDto } from "../files/image-url.dto.js";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
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
  CandidateBatchActionDto,
  CandidateBatchResultDto,
  CandidateDto,
  CandidatePageDto,
  CandidateQueryDto,
  CreateCandidateReviewSessionDto,
  CandidateReviewSessionDto,
  CandidateUploadSessionDto,
  CandidateTagGroupDto,
  CreateCandidateTagGroupDto,
  CreateCandidateUploadSessionDto,
  ManualCandidateUploadDto,
  ManualUploadResultDto,
  ReorderCandidateMediaDto,
  SetCandidateClassificationDto,
  UpdateManualCandidateDto,
  UpdateCandidateTagGroupDto,
} from "./candidates.dto.js";
import { CandidatesService } from "./candidates.service.js";
import {
  MANUAL_UPLOAD_MAX_FILE_BYTES,
  MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
  type ManualUploadFile,
} from "./manual-candidate-upload.js";

const manualUploadOptions = {
  limits: {
    fileSize: MANUAL_UPLOAD_MAX_FILE_BYTES,
    files: MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
  },
};

@ApiTags("candidates")
@ApiCookieAuth()
@Controller("candidates")
export class CandidatesController {
  constructor(
    @Inject(CandidatesService) private readonly candidates: CandidatesService,
  ) {}

  @Get()
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "listCandidates" })
  @ApiQuery({ type: CandidateQueryDto })
  @ApiOkResponse({ type: CandidatePageDto })
  list(
    @Req() request: AuthRequest,
    @Query(bodyValidation(CandidateQueryDto)) query: CandidateQueryDto,
  ) {
    return this.candidates.list(query, request.actor.userId);
  }

  @Post("review-sessions")
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "createCandidateReviewSession" })
  @ApiBody({ type: CreateCandidateReviewSessionDto })
  @ApiCreatedResponse({ type: CandidateReviewSessionDto })
  createReviewSession(
    @Req() request: AuthRequest,
    @Body(bodyValidation(CreateCandidateReviewSessionDto))
    input: CreateCandidateReviewSessionDto,
  ) {
    return this.candidates.createReviewSession(request.actor.userId, input);
  }

  @Get("tag-groups")
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "listCandidateTagGroups" })
  @ApiOkResponse({ type: CandidateTagGroupDto, isArray: true })
  listTagGroups() {
    return this.candidates.listTagGroups();
  }

  @Post("tag-groups")
  @Access({ permission: "authors:admin" })
  @ApiOperation({ operationId: "createCandidateTagGroup" })
  @ApiBody({ type: CreateCandidateTagGroupDto })
  @ApiCreatedResponse({ type: CandidateTagGroupDto })
  createTagGroup(
    @Body(bodyValidation(CreateCandidateTagGroupDto))
    input: CreateCandidateTagGroupDto,
  ) {
    return this.candidates.createTagGroup(input);
  }

  @Patch("tag-groups/:id")
  @Access({ permission: "authors:admin" })
  @ApiOperation({ operationId: "updateCandidateTagGroup" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateCandidateTagGroupDto })
  @ApiOkResponse({ type: CandidateTagGroupDto })
  updateTagGroup(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateCandidateTagGroupDto))
    input: UpdateCandidateTagGroupDto,
  ) {
    return this.candidates.updateTagGroup(id, input);
  }

  @Patch(":id/classification")
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "setCandidateClassification" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: SetCandidateClassificationDto })
  @ApiOkResponse({ type: CandidateDto })
  setClassification(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(SetCandidateClassificationDto))
    input: SetCandidateClassificationDto,
  ) {
    return this.candidates.setClassification(request.actor.userId, id, input);
  }

  @Patch(":id/manual-metadata")
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "updateManualCandidateMetadata" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateManualCandidateDto })
  @ApiOkResponse({ type: CandidateDto })
  updateManualMetadata(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateManualCandidateDto))
    input: UpdateManualCandidateDto,
  ) {
    return this.candidates.updateManualMetadata(id, input);
  }

  @Post("actions")
  @HttpCode(200)
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "applyCandidateBatchAction" })
  @ApiBody({ type: CandidateBatchActionDto })
  @ApiOkResponse({ type: CandidateBatchResultDto })
  action(
    @Req() request: AuthRequest,
    @Body(bodyValidation(CandidateBatchActionDto))
    input: CandidateBatchActionDto,
  ) {
    return this.candidates.batch(request.actor.userId, input);
  }

  @Post("uploads")
  @Access({
    permission: "candidates:manage",
    contentType: "multipart/form-data",
  })
  @UseInterceptors(
    FilesInterceptor(
      "files",
      MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
      manualUploadOptions,
    ),
  )
  @ApiOperation({ operationId: "uploadManualCandidates" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["authorId", "files"],
      properties: {
        authorId: { type: "string", format: "uuid" },
        text: { type: "string", maxLength: 4000 },
        sourceUrl: { type: "string", format: "uri" },
        files: {
          type: "array",
          maxItems: MANUAL_UPLOAD_MAX_TOP_LEVEL_FILES,
          items: { type: "string", format: "binary" },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ManualUploadResultDto })
  upload(
    @Req() request: AuthRequest,
    @UploadedFiles() files: ManualUploadFile[] | undefined,
    @Body(bodyValidation(ManualCandidateUploadDto))
    input: ManualCandidateUploadDto,
  ) {
    if (!files?.length) throw new BadRequestException("请选择图片或 ZIP 文件");
    return this.candidates.uploadManual(request.actor.userId, input, files);
  }

  @Post("upload-sessions")
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "createCandidateUploadSession" })
  @ApiBody({ type: CreateCandidateUploadSessionDto })
  @ApiCreatedResponse({ type: CandidateUploadSessionDto })
  createUploadSession(
    @Req() request: AuthRequest,
    @Body(bodyValidation(CreateCandidateUploadSessionDto))
    input: CreateCandidateUploadSessionDto,
  ) {
    return this.candidates.createUploadSession(request.actor.userId, input);
  }

  @Get("upload-sessions/:id")
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "getCandidateUploadSession" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: CandidateUploadSessionDto })
  getUploadSession(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.candidates.getUploadSession(request.actor.userId, id);
  }

  @Post("upload-sessions/:id/finalize")
  @HttpCode(200)
  @Access({ permission: "candidates:manage", contentType: null })
  @ApiOperation({ operationId: "finalizeCandidateUploadSession" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: CandidateUploadSessionDto })
  finalizeUploadSession(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.candidates.queueFinalize(request.actor.userId, id);
  }

  @Post(":id/media-order")
  @HttpCode(200)
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "reorderCandidateMedia" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ReorderCandidateMediaDto })
  @ApiOkResponse({ type: CandidateDto })
  reorderMedia(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ReorderCandidateMediaDto))
    input: ReorderCandidateMediaDto,
  ) {
    return this.candidates.reorderMedia(id, input);
  }

  @Get(":id")
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "getCandidate" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: CandidateDto })
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.candidates.get(id);
  }

  @Get(":candidateId/media/:mediaId/url")
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "getCandidateMediaUrl" })
  @ApiParam({ name: "candidateId", format: "uuid" })
  @ApiParam({ name: "mediaId", format: "uuid" })
  @ApiQuery({ type: ImageReadQueryDto })
  @ApiOkResponse({ type: ImageUrlDto })
  mediaUrl(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @Param("mediaId", ParseUUIDPipe) mediaId: string,
    @Query(bodyValidation(ImageReadQueryDto)) query: ImageReadQueryDto,
  ) {
    return this.candidates.mediaUrl(candidateId, mediaId, query.variant);
  }
}
