import { Module } from "@nestjs/common";
import { GalleryDlContentSource } from "./adapters/gallery-dl/gallery-dl-content-source.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { HttpMediaDownloader, MEDIA_DOWNLOADER } from "./media-downloader.js";
import { SourceFetchController } from "./source-fetch.controller.js";
import { SourceFetchService } from "./source-fetch.service.js";
import { SourceHistoryService } from "./source-history.service.js";
import { ContentSourceRegistry } from "./source-registry.js";
import { SourceCredentialsController } from "./source-credentials.controller.js";
import { SourceCredentialsService } from "./source-credentials.service.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [SourceFetchController, SourceCredentialsController],
  providers: [
    {
      provide: ContentSourceRegistry,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) => {
        const registry = new ContentSourceRegistry();
        if (environment.galleryDl) {
          const { python, xConfigPath, pixivConfigPath } =
            environment.galleryDl;
          if (xConfigPath)
            registry.register(
              new GalleryDlContentSource("x", {
                python,
                configPath: xConfigPath,
              }),
            );
          if (pixivConfigPath)
            registry.register(
              new GalleryDlContentSource("pixiv", {
                python,
                configPath: pixivConfigPath,
              }),
            );
        }
        return registry.assertSingleActiveAdapters();
      },
    },
    {
      provide: MEDIA_DOWNLOADER,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) =>
        new HttpMediaDownloader(fetch, environment.sourceMediaMaxBytes),
    },
    SourceFetchService,
    SourceCredentialsService,
    SourceHistoryService,
  ],
  exports: [ContentSourceRegistry, MEDIA_DOWNLOADER, SourceFetchService],
})
export class SourceIngestionModule {}
