import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import {
  ChangePasswordDto,
  LoginDto,
  OkDto,
  AuthUserDto,
} from "../users/users.dto.js";
import { UsersService } from "../users/users.service.js";
import { SESSION_COOKIE } from "./auth.guard.js";
import { RateLimit } from "./rate-limit.js";
import { sessionCookieOptions } from "./cookie.js";

@ApiTags("auth")
@ApiCookieAuth()
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(RateLimit) private readonly rate: RateLimit,
  ) {}
  private cookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions(this.environment),
      maxAge: this.environment.authSessionAbsoluteSeconds * 1000,
    });
  }
  @Post("login")
  @HttpCode(200)
  @Access({ public: true })
  @ApiOperation({ operationId: "login", security: [] })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: AuthUserDto })
  async login(
    @Body(bodyValidation(LoginDto)) input: LoginDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rate.check(`login-ip:${req.ip}`);
    this.rate.check(`login-user:${input.username}`, 10);
    const result = await this.users.login(input.username, input.password);
    this.cookie(res, result.token);
    return result.user;
  }
  @Get("me")
  @Access({ permission: "self", allowPasswordChange: true })
  @ApiOperation({ operationId: "getCurrentUser" })
  @ApiOkResponse({ type: AuthUserDto })
  me(@Req() req: AuthRequest) {
    return this.users.me(req.actor);
  }

  @Post("activity")
  @HttpCode(200)
  @Access({
    permission: "self",
    allowPasswordChange: true,
    rateClass: "session-activity",
  })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOperation({ operationId: "renewSessionActivity" })
  @ApiOkResponse({ type: OkDto })
  activity(@Body() input: unknown, @Req() req: AuthRequest) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length
    )
      throw new BadRequestException("活动请求必须为空对象");
    return this.users.activity(req.actor);
  }

  @Post("logout")
  @HttpCode(200)
  @Access({ permission: "self", allowPasswordChange: true })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOperation({ operationId: "logout" })
  @ApiOkResponse({ type: OkDto })
  async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.users.logout(req.actor);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.environment));
    return result;
  }
  @Post("password")
  @HttpCode(200)
  @Access({ permission: "self", allowPasswordChange: true })
  @ApiOperation({ operationId: "changePassword" })
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({ type: AuthUserDto })
  async password(
    @Body(bodyValidation(ChangePasswordDto)) input: ChangePasswordDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.users.changePassword(
      req.actor,
      input.currentPassword,
      input.newPassword,
    );
    this.cookie(res, result.token);
    return result.user;
  }
  @Post("revoke-others")
  @HttpCode(200)
  @Access({ permission: "self", allowPasswordChange: true })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOperation({ operationId: "revokeOtherSessions" })
  @ApiOkResponse({ type: OkDto })
  revokeOthers(@Req() req: AuthRequest) {
    return this.users.revokeOthers(req.actor);
  }
}
