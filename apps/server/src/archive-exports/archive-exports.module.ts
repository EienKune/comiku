import { Inject, Module } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import {
  ARCHIVE_STORAGE,
  createArchiveStorage,
  type ArchiveStorage,
} from "./archive-storage.js";
import { ArchiveExportsController } from "./archive-exports.controller.js";
import { ArchiveExportsService } from "./archive-exports.service.js";
import { ArchiveRuntimeService } from "./archive-runtime.service.js";

@Module({
  imports: [DatabaseModule, JobsModule],
  controllers: [ArchiveExportsController],
  providers: [
    {
      provide: ARCHIVE_STORAGE,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) =>
        createArchiveStorage(environment),
    },
    ArchiveExportsService,
    ArchiveRuntimeService,
  ],
  exports: [ArchiveExportsService, ArchiveRuntimeService],
})
export class ArchiveExportsModule {
  constructor(
    @Inject(ARCHIVE_STORAGE) private readonly storage: ArchiveStorage | null,
  ) {}
  onModuleDestroy() {
    this.storage?.close?.();
  }
}
