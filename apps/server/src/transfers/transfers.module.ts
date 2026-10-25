import { Global, Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { DirectUploadsService } from "./direct-uploads.service.js";
import { DownloadsService } from "./downloads.service.js";
import { TransfersController } from "./transfers.controller.js";

@Global()
@Module({
  imports: [DatabaseModule, FilesModule],
  providers: [DirectUploadsService, DownloadsService],
  controllers: [TransfersController],
  exports: [DirectUploadsService, DownloadsService],
})
export class TransfersModule {}
