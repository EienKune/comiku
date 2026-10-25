import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  OpenReviewCaseDto,
  WithdrawReviewCaseDto,
  ResolveReviewCaseDto,
  ReviewCaseDto,
  ReviewCasePageDto,
  ReviewQueryDto,
} from "./reviews.dto.js";
import { ReviewsService } from "./reviews.service.js";

@ApiTags("reviews")
@ApiCookieAuth()
@Controller("works/:workId/reviews")
export class WorkReviewsController {
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
  ) {}

  @Post()
  @HttpCode(200)
  @Access({ permission: "works:review:raise" })
  @ApiOperation({ operationId: "openWorkReviewCase" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: OpenReviewCaseDto })
  @ApiOkResponse({ type: ReviewCaseDto })
  open(
    @Req() request: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(OpenReviewCaseDto)) input: OpenReviewCaseDto,
  ) {
    return this.reviews.open(request.actor.userId, workId, input);
  }
}

@ApiTags("reviews")
@ApiCookieAuth()
@Controller("reviews")
export class ReviewsController {
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
  ) {}

  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "listReviewCases" })
  @ApiQuery({ type: ReviewQueryDto })
  @ApiOkResponse({ type: ReviewCasePageDto })
  list(@Query(bodyValidation(ReviewQueryDto)) query: ReviewQueryDto) {
    return this.reviews.list(query);
  }

  @Get(":id")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getReviewCase" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: ReviewCaseDto })
  get(@Req() request: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.reviews.get(id, request.actor.userId);
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "withdrawReviewCase" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: WithdrawReviewCaseDto })
  @ApiOkResponse({ type: ReviewCaseDto })
  withdraw(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(WithdrawReviewCaseDto)) input: WithdrawReviewCaseDto,
  ) {
    return this.reviews.withdraw(request.actor.userId, id, input);
  }

  @Post(":id/resolve")
  @HttpCode(200)
  @Access({ permission: "reviews:resolve" })
  @ApiOperation({ operationId: "resolveReviewCase" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ResolveReviewCaseDto })
  @ApiOkResponse({ type: ReviewCaseDto })
  resolve(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ResolveReviewCaseDto)) input: ResolveReviewCaseDto,
  ) {
    return this.reviews.resolve(request.actor.userId, id, input);
  }
}
