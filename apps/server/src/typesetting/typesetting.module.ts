import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { TranslationsModule } from "../translations/translations.module.js";
import { WorksModule } from "../works/works.module.js";
import { TypesettingController } from "./typesetting.controller.js";
import { TypesettingService } from "./typesetting.service.js";
import { TypesetBatchController } from "./typeset-batch.controller.js";
import { TypesetUploadsController } from "./typeset-uploads.controller.js";
import { TypesetUploadsService } from "./typeset-uploads.service.js";

@Module({
  imports: [DatabaseModule, FilesModule, TranslationsModule, WorksModule],
  controllers: [
    TypesettingController,
    TypesetBatchController,
    TypesetUploadsController,
  ],
  providers: [TypesettingService, TypesetUploadsService],
})
export class TypesettingModule {}
