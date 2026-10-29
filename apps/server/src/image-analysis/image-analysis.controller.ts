import { CandidateClassificationScoresDto } from "./classification-scores.dto.js";
import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  HttpCode,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { Access } from "../common/access.js";
import { ImageAnalysisService } from "./image-analysis.service.js";
class RetryAnalysisDto {
  @ApiProperty({ type: Number }) queued!: number;
}
@ApiTags("candidates")
@ApiCookieAuth()
@Controller("candidates")
export class ImageAnalysisController {
  constructor(
    @Inject(ImageAnalysisService)
    private readonly analysis: ImageAnalysisService,
  ) {}
  @Get(":id/classification-scores")
  @Access({ permission: "candidates:read" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ operationId: "getCandidateClassificationScores" })
  @ApiOkResponse({ type: CandidateClassificationScoresDto })
  scores(@Param("id", ParseUUIDPipe) id: string) {
    return this.analysis.classificationScores(id);
  }
  @Post(":id/analysis-retry")
  @HttpCode(200)
  @Access({ permission: "candidates:manage" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ operationId: "retryCandidateAnalysis" })
  @ApiOkResponse({ type: RetryAnalysisDto })
  retry(@Param("id", ParseUUIDPipe) id: string) {
    return this.analysis.retryFailed(id);
  }
}
