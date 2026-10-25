import { Global, Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { JobsService } from "./jobs.service.js";

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
