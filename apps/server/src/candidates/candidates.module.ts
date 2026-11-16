import { CandidateCompositionsService } from "./composition.service.js";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { ImageAnalysisModule } from "../image-analysis/image-analysis.module.js";
import { CandidatesController } from "./candidates.controller.js";
import { CandidatesService } from "./candidates.service.js";
import { WorkSeriesModule } from "../work-series/work-series.module.js";

@Module({
  imports: [DatabaseModule, FilesModule, ImageAnalysisModule, WorkSeriesModule],
  controllers: [CandidatesController],
  providers: [CandidatesService, CandidateCompositionsService],
  exports: [CandidatesService],
})
export class CandidatesModule {}
