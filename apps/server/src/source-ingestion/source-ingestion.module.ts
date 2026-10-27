import { Module } from "@nestjs/common";
import { GalleryDlContentSource } from "./adapters/gallery-dl/gallery-dl-content-source.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { FilesModule } from "../files/files.module.js";
import { UnavailableContentSourceClient } from "./content-source.js";
import {
  CANDIDATE_MEDIA_CLASSIFIER,
  DisabledCandidateMediaClassifier,
} from "./candidate-classifier.js";
import { HttpMediaDownloader, MEDIA_DOWNLOADER } from "./media-downloader.js";
import { SourceFetchController } from "./source-fetch.controller.js";
import { SourceFetchService } from "./source-fetch.service.js";
import { ContentSourceRegistry } from "./source-registry.js";
import { XContentSourceClient } from "./adapters/x-official/x-content-source.js";
import { XWebSessionContentSourceClient } from "./adapters/x-web-session/x-web-session-content-source.js";

@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [SourceFetchController],
  providers: [
    {
      provide: ContentSourceRegistry,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) => {
        const registry = new ContentSourceRegistry().register(
          environment.xWebSession
            ? new XWebSessionContentSourceClient(environment.xWebSession)
            : new UnavailableContentSourceClient("x", "x_web_session", 10, [
                "none",
                "last_24_hours",
              ]),
        );
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
        return registry.register(
          environment.xBearerToken
            ? new XContentSourceClient(environment.xBearerToken)
            : new UnavailableContentSourceClient(
                "x",
                "x_official_v2",
                20,
                ["none", "last_24_hours"],
                true,
              ),
        );
      },
    },
    {
      provide: CANDIDATE_MEDIA_CLASSIFIER,
      useFactory: () => new DisabledCandidateMediaClassifier(),
    },
    { provide: MEDIA_DOWNLOADER, useFactory: () => new HttpMediaDownloader() },
    SourceFetchService,
  ],
  exports: [ContentSourceRegistry, MEDIA_DOWNLOADER, SourceFetchService],
})
export class SourceIngestionModule {}
