import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";
import { ContributionsController } from "./contributions.controller.js";
import { ContributionsService } from "./contributions.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [DashboardController, ContributionsController],
  providers: [DashboardService, ContributionsService],
})
export class DashboardModule {}
