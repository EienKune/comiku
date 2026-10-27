import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
} from "@nestjs/common";
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
import { RunSourceFetchDto, SourceFetchRunDto } from "./source-fetch.dto.js";
import { SourceFetchService } from "./source-fetch.service.js";

@ApiTags("source-fetch")
@ApiCookieAuth()
@Controller("source-fetch")
export class SourceFetchController {
  constructor(
    @Inject(SourceFetchService) private readonly fetches: SourceFetchService,
  ) {}

  @Get("runs")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourceFetchRuns" })
  @ApiOkResponse({ type: SourceFetchRunDto, isArray: true })
  list() {
    return this.fetches.list();
  }

  @Get("runs/:id")
  @Access({ permission: "candidates:read" })
  @ApiOperation({ operationId: "getSourceFetchRun" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: SourceFetchRunDto })
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.fetches.get(id);
  }

  @Post("runs")
  @HttpCode(200)
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "runSourceFetch" })
  @ApiBody({ type: RunSourceFetchDto })
  @ApiOkResponse({ type: SourceFetchRunDto })
  run(
    @Req() request: AuthRequest,
    @Body(bodyValidation(RunSourceFetchDto)) input: RunSourceFetchDto,
  ) {
    return this.fetches.runManual(request.actor.userId, input);
  }
}
