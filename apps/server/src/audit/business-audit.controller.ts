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
  BusinessAuditPageDto,
  BusinessAuditQueryDto,
} from "./business-audit.dto.js";
import { BusinessAuditService } from "./business-audit.service.js";

@ApiTags("business-audit")
@ApiCookieAuth()
@Controller("audit/events")
export class BusinessAuditController {
  constructor(
    @Inject(BusinessAuditService)
    private readonly audit: BusinessAuditService,
  ) {}

  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "listBusinessAuditEvents" })
  @ApiQuery({ type: BusinessAuditQueryDto })
  @ApiOkResponse({ type: BusinessAuditPageDto })
  list(
    @Req() request: AuthRequest,
    @Query(bodyValidation(BusinessAuditQueryDto)) query: BusinessAuditQueryDto,
  ) {
    return this.audit.list(request.actor.userId, query);
  }
}
