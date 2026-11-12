import {
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
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
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
  AddWorkSeriesEntriesDto,
  CreateWorkSeriesDto,
  UpdateWorkSeriesDto,
  UpdateWorkSeriesEntryDto,
  WorkSeriesContextDto,
  WorkSeriesContextQueryDto,
  WorkSeriesDetailDto,
  WorkSeriesEntriesQueryDto,
  WorkSeriesPageDto,
  WorkSeriesQueryDto,
  WorkSeriesRevisionDto,
  WorkSeriesSummaryDto,
} from "./work-series.dto.js";
import { WorkSeriesService } from "./work-series.service.js";

@ApiTags("work-series")
@ApiCookieAuth()
@Controller("work-series")
export class WorkSeriesController {
  constructor(
    @Inject(WorkSeriesService) private readonly series: WorkSeriesService,
  ) {}

  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "listWorkSeries" })
  @ApiQuery({ type: WorkSeriesQueryDto })
  @ApiOkResponse({ type: WorkSeriesPageDto })
  list(@Query(bodyValidation(WorkSeriesQueryDto)) query: WorkSeriesQueryDto) {
    return this.series.list(query);
  }

  @Get("work/:workId/context")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getWorkSeriesContext" })
  @ApiParam({ name: "workId", type: String, format: "uuid" })
  @ApiQuery({ type: WorkSeriesContextQueryDto })
  @ApiOkResponse({ type: WorkSeriesContextDto })
  context(
    @Param("workId", new ParseUUIDPipe()) workId: string,
    @Query(bodyValidation(WorkSeriesContextQueryDto))
    query: WorkSeriesContextQueryDto,
  ) {
    return this.series.context(workId, query.includeHistory);
  }

  @Get(":id")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getWorkSeries" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiQuery({ type: WorkSeriesEntriesQueryDto })
  @ApiOkResponse({ type: WorkSeriesDetailDto })
  detail(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query(bodyValidation(WorkSeriesEntriesQueryDto))
    query: WorkSeriesEntriesQueryDto,
  ) {
    return this.series.detail(id, query);
  }

  @Post()
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "createWorkSeries" })
  @ApiBody({ type: CreateWorkSeriesDto })
  @ApiCreatedResponse({ type: WorkSeriesSummaryDto })
  create(
    @Req() request: AuthRequest,
    @Body(bodyValidation(CreateWorkSeriesDto)) input: CreateWorkSeriesDto,
  ) {
    return this.series.create(request.actor, input);
  }

  @Patch(":id")
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "updateWorkSeries" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: UpdateWorkSeriesDto })
  @ApiOkResponse({ type: WorkSeriesSummaryDto })
  update(
    @Req() request: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(bodyValidation(UpdateWorkSeriesDto)) input: UpdateWorkSeriesDto,
  ) {
    return this.series.update(request.actor, id, input);
  }

  @Post(":id/entries")
  @HttpCode(200)
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "addWorkSeriesEntries" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: AddWorkSeriesEntriesDto })
  @ApiOkResponse({ type: WorkSeriesSummaryDto })
  add(
    @Req() request: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(bodyValidation(AddWorkSeriesEntriesDto))
    input: AddWorkSeriesEntriesDto,
  ) {
    return this.series.add(request.actor, id, input);
  }

  @Patch(":id/entries/:entryId")
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "updateWorkSeriesEntry" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "entryId", type: String, format: "uuid" })
  @ApiBody({ type: UpdateWorkSeriesEntryDto })
  @ApiOkResponse({ type: WorkSeriesSummaryDto })
  updateEntry(
    @Req() request: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("entryId", new ParseUUIDPipe()) entryId: string,
    @Body(bodyValidation(UpdateWorkSeriesEntryDto))
    input: UpdateWorkSeriesEntryDto,
  ) {
    return this.series.updateEntry(request.actor, id, entryId, input);
  }

  @Post(":id/entries/:entryId/remove")
  @HttpCode(200)
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "removeWorkSeriesEntry" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "entryId", type: String, format: "uuid" })
  @ApiBody({ type: WorkSeriesRevisionDto })
  @ApiOkResponse({ type: WorkSeriesSummaryDto })
  remove(
    @Req() request: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("entryId", new ParseUUIDPipe()) entryId: string,
    @Body(bodyValidation(WorkSeriesRevisionDto)) input: WorkSeriesRevisionDto,
  ) {
    return this.series.remove(request.actor, id, entryId, input);
  }
}
