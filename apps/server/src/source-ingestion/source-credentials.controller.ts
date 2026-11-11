import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
  SourceCredentialInputDto,
  SourceCredentialOperationDto,
  SourceMaintenanceDto,
  SourceMaintenanceExpectedDto,
} from "./source-credentials.dto.js";
import { SourceCredentialsService } from "./source-credentials.service.js";

@ApiTags("source-maintenance")
@ApiCookieAuth()
@ApiParam({ name: "platform", enum: ["x", "pixiv"] })
@Controller("source-fetch/platforms/:platform")
export class SourceCredentialsController {
  constructor(
    @Inject(SourceCredentialsService)
    private readonly credentials: SourceCredentialsService,
  ) {}
  @Get("maintenance")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getSourceMaintenance" })
  @ApiOkResponse({ type: SourceMaintenanceDto })
  status(@Param("platform") platform: string) {
    return this.credentials.status(platform);
  }
  @Post("maintenance")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "pauseSourceMaintenance" })
  @ApiBody({ type: SourceMaintenanceExpectedDto })
  @ApiOkResponse({ type: SourceMaintenanceDto })
  pause(
    @Param("platform") platform: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceMaintenanceExpectedDto))
    input: SourceMaintenanceExpectedDto,
  ) {
    return this.credentials.pause(platform, request.actor.userId, input);
  }
  @Post("resume")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "resumeSourceMaintenance" })
  @ApiBody({ type: SourceMaintenanceExpectedDto })
  @ApiOkResponse({ type: SourceMaintenanceDto })
  resume(
    @Param("platform") platform: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceMaintenanceExpectedDto))
    input: SourceMaintenanceExpectedDto,
  ) {
    return this.credentials.resume(platform, request.actor.userId, input);
  }
  @Post("credentials")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "saveSourceCredentials" })
  @ApiBody({ type: SourceCredentialInputDto })
  @ApiOkResponse({ type: SourceCredentialOperationDto })
  save(
    @Param("platform") platform: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceCredentialInputDto))
    input: SourceCredentialInputDto,
  ) {
    return this.credentials.save(platform, request.actor.userId, input);
  }
  @Get("credential-updates/:id")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getSourceCredentialOperation" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: SourceCredentialOperationDto })
  receipt(
    @Param("platform") platform: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
  ) {
    return this.credentials.receipt(platform, request.actor.userId, id);
  }
  @Post("credential-updates/:id/reconcile")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "reconcileSourceCredentialOperation" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: SourceMaintenanceExpectedDto })
  @ApiOkResponse({ type: SourceCredentialOperationDto })
  reconcile(
    @Param("platform") platform: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceMaintenanceExpectedDto))
    input: SourceMaintenanceExpectedDto,
  ) {
    return this.credentials.reconcile(
      platform,
      request.actor.userId,
      id,
      input,
    );
  }
  @Post("credential-updates/:id/abort")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "abortUnpreparedSourceCredentialOperation" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: SourceMaintenanceExpectedDto })
  @ApiOkResponse({ type: SourceCredentialOperationDto })
  abort(
    @Param("platform") platform: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceMaintenanceExpectedDto))
    input: SourceMaintenanceExpectedDto,
  ) {
    return this.credentials.abortUnprepared(
      platform,
      request.actor.userId,
      id,
      input,
    );
  }
  @Post("credential-updates/:id/verify")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "verifySourceCredentialOperation" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: SourceMaintenanceExpectedDto })
  @ApiOkResponse({ type: SourceCredentialOperationDto })
  verify(
    @Param("platform") platform: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
    @Body(bodyValidation(SourceMaintenanceExpectedDto))
    input: SourceMaintenanceExpectedDto,
  ) {
    return this.credentials.verify(platform, request.actor.userId, id, input);
  }
}
