import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ImageSimilarityController } from "./image-similarity.controller.js";
import { ImageSimilarityService } from "./image-similarity.service.js";

@Module({
  imports: [DatabaseModule, FilesModule, JobsModule],
  controllers: [ImageSimilarityController],
  providers: [ImageSimilarityService],
  exports: [ImageSimilarityService],
})
export class ImageSimilarityModule {}
