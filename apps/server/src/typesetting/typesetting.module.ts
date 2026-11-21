import { TypesetMaterialsController } from "./typeset-materials.controller.js";
import { TypesetMaterialsService } from "./typeset-materials.service.js";
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
import { TypesetCollaborationController } from "./typeset-collaboration.controller.js";
import { TypesetCollaborationService } from "./typeset-collaboration.service.js";
import { SourceHdController } from "./source-hd.controller.js";
import { SourceHdService } from "./source-hd.service.js";
import { SingleTypesetSupplementsService } from "./single-typeset-supplements.service.js";
import { SingleTypesetSupplementsController } from "./single-typeset-supplements.controller.js";

@Module({
  imports: [DatabaseModule, FilesModule, TranslationsModule, WorksModule],
  controllers: [
    TypesetMaterialsController,
    TypesettingController,
    TypesetBatchController,
    TypesetUploadsController,
    TypesetCollaborationController,
    SourceHdController,
    SingleTypesetSupplementsController,
  ],
  providers: [
    TypesetMaterialsService,
    TypesettingService,
    TypesetUploadsService,
    TypesetCollaborationService,
    SourceHdService,
    SingleTypesetSupplementsService,
  ],
})
export class TypesettingModule {}
