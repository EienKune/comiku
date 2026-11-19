import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  ContributionDetailsDto,
  ContributionDetailsQueryDto,
  ContributionQueryDto,
  ContributionSummaryDto,
} from "./contributions.dto.js";
import { ContributionsService } from "./contributions.service.js";

@ApiTags("contributions")
@ApiCookieAuth()
@Controller("contributions")
export class ContributionsController {
  constructor(
    @Inject(ContributionsService)
    private readonly contributions: ContributionsService,
  ) {}

  @Get("summary")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getContributionSummary" })
  @ApiQuery({ type: ContributionQueryDto })
  @ApiOkResponse({ type: ContributionSummaryDto })
  summary(
    @Req() req: AuthRequest,
    @Query(bodyValidation(ContributionQueryDto)) query: ContributionQueryDto,
  ) {
    return this.contributions.summary(req.actor.userId, query);
  }

  @Get("details")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getContributionDetails" })
  @ApiQuery({ type: ContributionDetailsQueryDto })
  @ApiOkResponse({ type: ContributionDetailsDto })
  details(
    @Req() req: AuthRequest,
    @Query(bodyValidation(ContributionDetailsQueryDto))
    query: ContributionDetailsQueryDto,
  ) {
    return this.contributions.details(req.actor.userId, query);
  }
}
