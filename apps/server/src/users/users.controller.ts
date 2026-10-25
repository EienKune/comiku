import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, roleLabels, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import { Role } from "../generated/prisma/client.js";
import {
  AuditDto,
  ConfirmPasswordDto,
  CreateUserDto,
  CredentialDto,
  ManageUserDto,
  MemberDto,
  OkDto,
  ProfileDto,
  RoleOptionDto,
  UserDto,
} from "./users.dto.js";
import {
  CreateUserAvatarUploadDto,
  RemoveUserAvatarDto,
  UserAvatarUploadDto,
  UserAvatarUrlDto,
} from "./user-avatar.dto.js";
import { UsersService } from "./users.service.js";

@ApiTags("accounts")
@ApiCookieAuth()
@Controller("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}
  @Patch("me")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "updateProfile" })
  @ApiBody({ type: ProfileDto })
  @ApiOkResponse({ type: UserDto })
  profile(
    @Req() req: AuthRequest,
    @Body(bodyValidation(ProfileDto)) input: ProfileDto,
  ) {
    return this.users.updateProfile(req.actor, input);
  }
  @Post("me/avatar/upload-sessions")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "createUserAvatarUpload" })
  @ApiBody({ type: CreateUserAvatarUploadDto })
  @ApiCreatedResponse({ type: UserAvatarUploadDto })
  createAvatarUpload(
    @Req() req: AuthRequest,
    @Body(bodyValidation(CreateUserAvatarUploadDto))
    input: CreateUserAvatarUploadDto,
  ) {
    return this.users.createAvatarUpload(req.actor, input);
  }
  @Post("me/avatar/upload-sessions/:id/complete")
  @HttpCode(200)
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "completeUserAvatarUpload" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: UserDto })
  completeAvatarUpload(
    @Req() req: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.users.completeAvatarUpload(req.actor, id);
  }
  @Delete("me/avatar")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "removeUserAvatar" })
  @ApiBody({ type: RemoveUserAvatarDto })
  @ApiOkResponse({ type: UserDto })
  removeAvatar(
    @Req() req: AuthRequest,
    @Body(bodyValidation(RemoveUserAvatarDto)) input: RemoveUserAvatarDto,
  ) {
    return this.users.removeAvatar(req.actor, input.expectedRevision);
  }
  @Get(":id/avatar/url")
  @Access({ permission: "self" })
  @ApiOperation({ operationId: "getUserAvatarUrl" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: UserAvatarUrlDto })
  avatarUrl(
    @Req() req: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.users.avatarUrl(req.actor, id);
  }
  @Get("members")
  @Access({ permission: "members:read" })
  @ApiOperation({ operationId: "listMembers" })
  @ApiOkResponse({ type: MemberDto, isArray: true })
  members() {
    return this.users.members();
  }
  @Get("roles")
  @Access({ permission: "members:read" })
  @ApiOperation({ operationId: "listRoles" })
  @ApiOkResponse({ type: RoleOptionDto, isArray: true })
  roles() {
    return Object.values(Role).map((value) => ({
      value,
      label: roleLabels[value],
    }));
  }
  @Get()
  @Access({ permission: "accounts:manage" })
  @ApiOperation({ operationId: "listUsers" })
  @ApiOkResponse({ type: UserDto, isArray: true })
  list() {
    return this.users.list();
  }
  @Get("audit")
  @Access({ permission: "audit:read" })
  @ApiOperation({ operationId: "listAccountAudit" })
  @ApiOkResponse({ type: AuditDto, isArray: true })
  audit() {
    return this.users.audits();
  }
  @Post()
  @Access({ permission: "accounts:manage" })
  @ApiOperation({ operationId: "createUser" })
  @ApiBody({ type: CreateUserDto })
  @ApiCreatedResponse({ type: CredentialDto })
  create(
    @Req() req: AuthRequest,
    @Body(bodyValidation(CreateUserDto)) input: CreateUserDto,
  ) {
    return this.users.create(req.actor, input);
  }
  @Patch(":id")
  @Access({ permission: "accounts:manage" })
  @ApiOperation({ operationId: "manageUser" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: ManageUserDto })
  @ApiOkResponse({ type: UserDto })
  manage(
    @Req() req: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(bodyValidation(ManageUserDto)) input: ManageUserDto,
  ) {
    return this.users.manage(req.actor, id, input);
  }
  @Post(":id/reset-password")
  @HttpCode(200)
  @Access({ permission: "accounts:manage" })
  @ApiOperation({ operationId: "resetUserPassword" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: ConfirmPasswordDto })
  @ApiOkResponse({ type: CredentialDto })
  reset(
    @Req() req: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(bodyValidation(ConfirmPasswordDto)) input: ConfirmPasswordDto,
  ) {
    return this.users.resetPassword(req.actor, id, input.currentPassword);
  }
  @Post(":id/revoke-sessions")
  @HttpCode(200)
  @Access({ permission: "accounts:manage" })
  @ApiOperation({ operationId: "revokeUserSessions" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: ConfirmPasswordDto })
  @ApiOkResponse({ type: OkDto })
  revoke(
    @Req() req: AuthRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(bodyValidation(ConfirmPasswordDto)) input: ConfirmPasswordDto,
  ) {
    return this.users.revokeUserSessions(req.actor, id, input.currentPassword);
  }
}
