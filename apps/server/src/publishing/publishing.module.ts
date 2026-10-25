import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { PublishingController } from "./publishing.controller.js";
import { PublishingService } from "./publishing.service.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [PublishingController],
  providers: [PublishingService],
})
export class PublishingModule {}
