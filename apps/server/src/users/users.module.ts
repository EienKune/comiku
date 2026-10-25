import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { UsersService } from "./users.service.js";
import { UsersController } from "./users.controller.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
