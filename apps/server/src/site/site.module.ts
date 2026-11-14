import { Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { SiteService } from "./site.service.js";
import { SiteIconService } from "./site-icon.service.js";
import { SiteController, SiteUploadPermit } from "./site.controller.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [SiteController],
  providers: [SiteService, SiteIconService, SiteUploadPermit],
  exports: [SiteIconService],
})
export class SiteModule {}
