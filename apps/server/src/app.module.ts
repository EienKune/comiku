import { TransfersModule } from "./transfers/transfers.module.js";
import { ImageAnalysisModule } from "./image-analysis/image-analysis.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { Module, type DynamicModule } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { EnvironmentModule } from "./config/environment.module.js";
import type { Environment } from "./config/environment.js";
import { DatabaseModule } from "./database/database.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { AuthorsModule } from "./authors/authors.module.js";
import { BusinessAuditModule } from "./audit/business-audit.module.js";
import { FilesModule } from "./files/files.module.js";
import { SourceIngestionModule } from "./source-ingestion/source-ingestion.module.js";
import { CandidatesModule } from "./candidates/candidates.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { ReviewsModule } from "./reviews/reviews.module.js";
import { WorksModule } from "./works/works.module.js";
import { TranslationsModule } from "./translations/translations.module.js";
import { TypesettingModule } from "./typesetting/typesetting.module.js";
import { PublishingModule } from "./publishing/publishing.module.js";

@Module({
  imports: [
    DatabaseModule,
    JobsModule,
    ImageAnalysisModule,
    TransfersModule,
    AuthModule,
    FilesModule,
    SourceIngestionModule,
    AuthorsModule,
    BusinessAuditModule,
    CandidatesModule,
    WorksModule,
    TranslationsModule,
    TypesettingModule,
    PublishingModule,
    ReviewsModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {
  static forRoot(environment: Environment): DynamicModule {
    return {
      module: AppModule,
      imports: [EnvironmentModule.forRoot(environment)],
    };
  }
}
