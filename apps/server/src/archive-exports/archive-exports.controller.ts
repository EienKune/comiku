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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  ArchiveExportDownloadDto,
  ArchiveExportIssueListDto,
  ArchiveExportListDto,
  ArchiveExportMutationDto,
  ArchiveExportPackageListDto,
  ArchiveExportPageQueryDto,
  ArchiveExportPreviewDto,
  ArchiveExportRunDto,
  ArchiveExportScopeDto,
  ArchiveExportSettingsDto,
  ArchiveExportSettingsInputDto,
  CreateArchiveExportDto,
  DeleteArchiveExportFilesDto,
} from "./archive-exports.dto.js";
import { ArchiveExportsService } from "./archive-exports.service.js";

@ApiTags("archive-exports")
@ApiCookieAuth()
@Access({ permission: "system:manage" })
@Controller("archive-exports")
export class ArchiveExportsController {
  constructor(
    @Inject(ArchiveExportsService)
    private readonly exports: ArchiveExportsService,
  ) {}
  @Get("settings")
  @ApiOperation({ operationId: "getArchiveExportSettings" })
  @ApiOkResponse({ type: ArchiveExportSettingsDto })
  settings(@Req() req: AuthRequest): Promise<ArchiveExportSettingsDto> {
    return this.exports.settings(req.actor);
  }
  @Patch("settings")
  @ApiOperation({ operationId: "updateArchiveExportSettings" })
  @ApiBody({ type: ArchiveExportSettingsInputDto })
  @ApiOkResponse({ type: ArchiveExportSettingsDto })
  updateSettings(
    @Req() req: AuthRequest,
    @Body(bodyValidation(ArchiveExportSettingsInputDto))
    input: ArchiveExportSettingsInputDto,
  ): Promise<ArchiveExportSettingsDto> {
    return this.exports.updateSettings(req.actor, input);
  }
  @Post("preview")
  @HttpCode(200)
  @ApiOperation({ operationId: "previewArchiveExport" })
  @ApiBody({ type: ArchiveExportScopeDto })
  @ApiOkResponse({ type: ArchiveExportPreviewDto })
  preview(
    @Req() req: AuthRequest,
    @Body(bodyValidation(ArchiveExportScopeDto)) input: ArchiveExportScopeDto,
  ): Promise<ArchiveExportPreviewDto> {
    return this.exports.preview(req.actor, input);
  }
  @Post()
  @HttpCode(200)
  @ApiOperation({ operationId: "createArchiveExport" })
  @ApiBody({ type: CreateArchiveExportDto })
  @ApiOkResponse({ type: ArchiveExportRunDto })
  create(
    @Req() req: AuthRequest,
    @Body(bodyValidation(CreateArchiveExportDto)) input: CreateArchiveExportDto,
  ): Promise<ArchiveExportRunDto> {
    return this.exports.create(req.actor, input);
  }
  @Get()
  @ApiOperation({ operationId: "listArchiveExports" })
  @ApiQuery({ name: "limit", required: false, type: Number, maximum: 50 })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: ArchiveExportListDto })
  list(
    @Req() req: AuthRequest,
    @Query(bodyValidation(ArchiveExportPageQueryDto))
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportListDto> {
    return this.exports.list(req.actor, query);
  }
  @Get(":id")
  @ApiOperation({ operationId: "getArchiveExport" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ArchiveExportRunDto })
  get(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ArchiveExportRunDto> {
    return this.exports.get(req.actor, id);
  }
  @Get(":id/packages")
  @ApiOperation({ operationId: "listArchiveExportPackages" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiQuery({ name: "limit", required: false, type: Number, maximum: 50 })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: ArchiveExportPackageListDto })
  packages(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(bodyValidation(ArchiveExportPageQueryDto))
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportPackageListDto> {
    return this.exports.packages(req.actor, id, query);
  }
  @Get(":id/issues")
  @ApiOperation({ operationId: "listArchiveExportIssues" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiQuery({ name: "limit", required: false, type: Number, maximum: 50 })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: ArchiveExportIssueListDto })
  issues(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(bodyValidation(ArchiveExportPageQueryDto))
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportIssueListDto> {
    return this.exports.issues(req.actor, id, query);
  }
  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ operationId: "cancelArchiveExport" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: ArchiveExportMutationDto })
  @ApiOkResponse({ type: ArchiveExportRunDto })
  cancel(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ArchiveExportMutationDto))
    input: ArchiveExportMutationDto,
  ): Promise<ArchiveExportRunDto> {
    return this.exports.mutate(req.actor, id, "cancel", input);
  }
  @Post(":id/retry")
  @HttpCode(200)
  @ApiOperation({ operationId: "retryArchiveExport" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: ArchiveExportMutationDto })
  @ApiOkResponse({ type: ArchiveExportRunDto })
  retry(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ArchiveExportMutationDto))
    input: ArchiveExportMutationDto,
  ): Promise<ArchiveExportRunDto> {
    return this.exports.mutate(req.actor, id, "retry", input);
  }
  @Post(":id/delete-files")
  @HttpCode(200)
  @ApiOperation({ operationId: "deleteArchiveExportFiles" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: DeleteArchiveExportFilesDto })
  @ApiOkResponse({ type: ArchiveExportRunDto })
  deleteFiles(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(DeleteArchiveExportFilesDto))
    input: DeleteArchiveExportFilesDto,
  ): Promise<ArchiveExportRunDto> {
    return this.exports.mutate(req.actor, id, "delete-files", input);
  }
  @Get(":id/packages/:packageId/download")
  @ApiOperation({ operationId: "downloadArchiveExportPackage" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "packageId", type: String, format: "uuid" })
  @ApiOkResponse({ type: ArchiveExportDownloadDto })
  download(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("packageId", ParseUUIDPipe) packageId: string,
  ): Promise<ArchiveExportDownloadDto> {
    return this.exports.download(req.actor, id, packageId);
  }
}
