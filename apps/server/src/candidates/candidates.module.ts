import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { CandidatesController } from "./candidates.controller.js";
import { CandidatesService } from "./candidates.service.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [CandidatesController],
  providers: [CandidatesService],
  exports: [CandidatesService],
})
export class CandidatesModule {}
