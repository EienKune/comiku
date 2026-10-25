import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { TranslationsModule } from "../translations/translations.module.js";
import { WorksController } from "./works.controller.js";
import { WorksService } from "./works.service.js";

@Module({
  imports: [DatabaseModule, FilesModule, TranslationsModule],
  controllers: [WorksController],
  providers: [WorksService],
  exports: [WorksService],
})
export class WorksModule {}
