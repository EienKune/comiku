import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ACCESS,
  type AccessPolicy,
  type AuthRequest,
} from "../common/access.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { UsersService } from "../users/users.service.js";
import { RateLimit } from "./rate-limit.js";

export const SESSION_COOKIE = "comiku_session";
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(RateLimit) private readonly rate: RateLimit,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const policy = this.reflector.getAllAndOverride<AccessPolicy>(ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isWrite) {
      const expectedContentType =
        policy?.contentType === undefined
          ? "application/json"
          : policy.contentType;
      if (
        req.headers.origin !== this.environment.appOrigin ||
        req.headers["x-comiku-request"] !== "1" ||
        (expectedContentType !== null && !req.is(expectedContentType))
      ) {
        throw new ForbiddenException(
          "请求来源或格式无效，请从 Comiku 页面操作",
        );
      }
      this.rate.check(`write-ip:${req.ip}`, 3000);
    }
    if (policy?.public) return true;
    const matches = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${SESSION_COOKIE}=`));
    if (matches.length !== 1) throw new UnauthorizedException("请先登录");
    const { actor, user } = await this.users.authenticate(
      matches[0].slice(SESSION_COOKIE.length + 1),
    );
    req.actor = actor;
    if (isWrite) this.rate.check(`write-user:${actor.userId}`, 600);
    if (!policy?.permission || !user.permissions.includes(policy.permission))
      throw new ForbiddenException("没有执行此操作的权限");
    if (user.mustChangePassword && !policy.allowPasswordChange)
      throw new ForbiddenException("请先修改临时密码");
    return true;
  }
}
