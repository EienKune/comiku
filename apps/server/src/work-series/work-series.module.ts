import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { WorkSeriesController } from "./work-series.controller.js";
import { WorkSeriesService } from "./work-series.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkSeriesController],
  providers: [WorkSeriesService],
  exports: [WorkSeriesService],
})
export class WorkSeriesModule {}
