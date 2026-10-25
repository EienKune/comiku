import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { TranslationsController } from "./translations.controller.js";
import { TranslationsService } from "./translations.service.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [TranslationsController],
  providers: [TranslationsService],
  exports: [TranslationsService],
})
export class TranslationsModule {}
