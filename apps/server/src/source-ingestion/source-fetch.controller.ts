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
import {
  RunSourceFetchDto,
  SourceFetchAcceptedDto,
  SourceFetchProgressDto,
  SourceFetchRunDto,
} from "./source-fetch.dto.js";
import { SourceFetchService } from "./source-fetch.service.js";

@ApiTags("source-fetch")
@ApiCookieAuth()
@Controller("source-fetch")
export class SourceFetchController {
  constructor(
    @Inject(SourceFetchService) private readonly fetches: SourceFetchService,
  ) {}

  @Get("progress")
  @Access({ permission: "candidates:manage" })
  @ApiOperation({ operationId: "getSourceFetchProgress" })
  @ApiOkResponse({ type: SourceFetchProgressDto })
  progress() {
    return this.fetches.progress();
  }

  @Get("runs")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourceFetchRuns" })
  @ApiOkResponse({ type: SourceFetchRunDto, isArray: true })
  list() {
    return this.fetches.list();
  }

  @Get("runs/:id")
  @Access({ permission: "system:manage" })
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
  @ApiOkResponse({ type: SourceFetchAcceptedDto })
  async run(
    @Req() request: AuthRequest,
    @Body(bodyValidation(RunSourceFetchDto)) input: RunSourceFetchDto,
  ): Promise<SourceFetchAcceptedDto> {
    const run = await this.fetches.runManual(request.actor.userId, input);
    return { id: run.id, status: run.status };
  }
}
