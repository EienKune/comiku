import { Controller, Get, Inject, Req } from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { DashboardSummaryDto } from "./dashboard.dto.js";
import { DashboardService } from "./dashboard.service.js";

@ApiTags("dashboard")
@ApiCookieAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @Get("summary")
  @Access({ permission: "dashboard:read" })
  @ApiOperation({ operationId: "getDashboardSummary" })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@Req() request: AuthRequest) {
    return this.dashboard.summary(request.actor.userId);
  }
}
