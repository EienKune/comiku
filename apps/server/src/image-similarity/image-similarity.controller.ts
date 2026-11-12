import {
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
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { ImageSimilarityResultDto } from "./image-similarity.dto.js";
import { ImageSimilarityService } from "./image-similarity.service.js";

@ApiTags("image-similarity")
@ApiCookieAuth()
@Controller("image-similarity/candidates/:candidateId/media/:mediaId/search")
export class ImageSimilarityController {
  constructor(
    @Inject(ImageSimilarityService)
    private readonly similarity: ImageSimilarityService,
  ) {}

  @Post()
  @HttpCode(200)
  @Access({ permission: "candidates:read", contentType: null })
  @ApiOperation({ operationId: "prepareCandidateImageSimilarity" })
  @ApiParam({ name: "candidateId", format: "uuid" })
  @ApiParam({ name: "mediaId", format: "uuid" })
  @ApiOkResponse({ type: ImageSimilarityResultDto })
  prepare(
    @Req() request: AuthRequest,
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @Param("mediaId", ParseUUIDPipe) mediaId: string,
  ) {
    return this.similarity.search(
      request.actor.userId,
      candidateId,
      mediaId,
      true,
      request.actor,
    );
  }

  @Get()
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "getCandidateImageSimilarity" })
  @ApiParam({ name: "candidateId", format: "uuid" })
  @ApiParam({ name: "mediaId", format: "uuid" })
  @ApiOkResponse({ type: ImageSimilarityResultDto })
  get(
    @Req() request: AuthRequest,
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @Param("mediaId", ParseUUIDPipe) mediaId: string,
  ) {
    return this.similarity.search(request.actor.userId, candidateId, mediaId);
  }
}
