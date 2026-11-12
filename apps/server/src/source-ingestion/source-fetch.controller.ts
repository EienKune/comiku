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
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiQuery,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  SourceFetchRunStatus,
  SourceFetchTrigger,
  SourceAccountTaskStatus,
  SourceFetchItemStatus,
} from "../generated/prisma/client.js";
import {
  RunSourceFetchDto,
  SourceFetchAcceptedDto,
  SourceFetchProgressDto,
  SourcePlatformStateDto,
  SourcePlatformRecheckDto,
} from "./source-fetch.dto.js";
import { SourceFetchService } from "./source-fetch.service.js";
import { SourceHistoryService } from "./source-history.service.js";
import {
  SourceRunPageDto,
  SourceRunQueryDto,
  SourceRunSummaryDto,
  SourceTaskDetailDto,
  SourceTaskPageDto,
  SourceTaskQueryDto,
  SourceEvidenceQueryDto,
  SourceExecutionPageDto,
  SourceGapPageDto,
} from "./source-history.dto.js";

@ApiTags("source-fetch")
@ApiCookieAuth()
@Controller("source-fetch")
export class SourceFetchController {
  constructor(
    @Inject(SourceFetchService) private readonly fetches: SourceFetchService,
    @Inject(SourceHistoryService)
    private readonly history: SourceHistoryService,
  ) {}

  @Get("platforms")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourcePlatforms" })
  @ApiOkResponse({ type: SourcePlatformStateDto, isArray: true })
  async platforms(): Promise<SourcePlatformStateDto[]> {
    return (await this.fetches.platforms.list()).map((state) => ({
      platform: state.platform,
      status: state.status,
      credentialGeneration: state.credentialGeneration,
      errorCode: state.errorCode,
      revision: state.revision,
      cooldownUntil: state.cooldownUntil?.toISOString() ?? null,
      maintenancePaused: state.maintenancePaused,
      maintenanceEpoch: state.maintenanceEpoch,
    }));
  }

  @Post("platforms/:platform/recheck")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "recheckSourcePlatform" })
  @ApiParam({ name: "platform", type: String })
  @ApiOkResponse({ type: SourcePlatformRecheckDto })
  recheck(@Param("platform") platform: string, @Req() request: AuthRequest) {
    return this.fetches.recheckPlatform(platform, request.actor.userId);
  }

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
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "trigger", required: false, enum: SourceFetchTrigger })
  @ApiQuery({ name: "status", required: false, enum: SourceFetchRunStatus })
  @ApiOkResponse({ type: SourceRunPageDto })
  list(@Query(bodyValidation(SourceRunQueryDto)) query: SourceRunQueryDto) {
    return this.history.list(query);
  }

  @Get("runs/:id")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getSourceFetchRun" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: SourceRunSummaryDto })
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.history.get(id);
  }

  @Get("runs/:id/tasks")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourceFetchTasks" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "platform", required: false, type: String })
  @ApiQuery({
    name: "status",
    required: false,
    enum: [
      "all",
      "anomalies",
      "active",
      ...Object.values(SourceAccountTaskStatus),
      SourceFetchItemStatus.skipped,
    ],
  })
  @ApiQuery({ name: "search", required: false, type: String })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: SourceTaskPageDto })
  tasks(
    @Param("id", ParseUUIDPipe) id: string,
    @Query(bodyValidation(SourceTaskQueryDto)) query: SourceTaskQueryDto,
  ) {
    return this.history.tasks(id, query);
  }

  @Get("runs/:id/tasks/:taskId")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getSourceFetchTask" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "taskId", type: String, format: "uuid" })
  @ApiOkResponse({ type: SourceTaskDetailDto })
  task(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
  ) {
    return this.history.task(id, taskId);
  }

  @Get("runs/:id/tasks/:taskId/executions")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourceFetchTaskExecutions" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "taskId", type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: SourceExecutionPageDto })
  executions(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Query(bodyValidation(SourceEvidenceQueryDto))
    query: SourceEvidenceQueryDto,
  ) {
    return this.history.executions(id, taskId, query);
  }

  @Get("runs/:id/tasks/:taskId/gaps")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listSourceFetchTaskGaps" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "taskId", type: String, format: "uuid" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: SourceGapPageDto })
  gaps(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Query(bodyValidation(SourceEvidenceQueryDto))
    query: SourceEvidenceQueryDto,
  ) {
    return this.history.gaps(id, taskId, query);
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
