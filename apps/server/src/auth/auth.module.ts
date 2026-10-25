import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { UsersModule } from "../users/users.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { RateLimit } from "./rate-limit.js";

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [RateLimit, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
