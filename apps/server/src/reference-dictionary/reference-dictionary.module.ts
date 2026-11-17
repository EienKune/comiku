import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { ReferenceDictionaryController } from "./reference-dictionary.controller.js";
import { ReferenceDictionaryService } from "./reference-dictionary.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [ReferenceDictionaryController],
  providers: [ReferenceDictionaryService],
})
export class ReferenceDictionaryModule {}
