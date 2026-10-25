import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { SourceIngestionModule } from "../source-ingestion/source-ingestion.module.js";
import { AuthorsController } from "./authors.controller.js";
import { AuthorsService } from "./authors.service.js";

@Module({
  imports: [DatabaseModule, FilesModule, SourceIngestionModule],
  controllers: [AuthorsController],
  providers: [AuthorsService],
  exports: [AuthorsService],
})
export class AuthorsModule {}
