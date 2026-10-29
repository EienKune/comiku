import { Module } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { ImageAnalysisService } from "./image-analysis.service.js";
import { IMAGE_ANALYSIS_ADAPTER } from "./image-analysis-adapter.js";
import { loadImageAnalysisAdapter } from "./adapter-loader.js";
import { ImageAnalysisController } from "./image-analysis.controller.js";
@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [ImageAnalysisController],
  providers: [
    {
      provide: IMAGE_ANALYSIS_ADAPTER,
      inject: [ENVIRONMENT],
      useFactory: (env: Environment) =>
        loadImageAnalysisAdapter(env.imageAnalysis),
    },
    ImageAnalysisService,
  ],
  exports: [ImageAnalysisService],
})
export class ImageAnalysisModule {}
