import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import {
  ReviewsController,
  WorkReviewsController,
} from "./reviews.controller.js";
import { ReviewsService } from "./reviews.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [ReviewsController, WorkReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
