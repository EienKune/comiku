import { Module } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { OBJECT_STORAGE } from "./object-storage.js";
import { FileObjectsService } from "./file-objects.service.js";
import { LocalFilesController } from "./local-files.controller.js";
import { LocalObjectStorage } from "./local-object-storage.js";
import { MemoryObjectStorage } from "./memory-object-storage.js";
import {
  R2ObjectStorage,
  UnavailableObjectStorage,
} from "./r2-object-storage.js";

@Module({
  imports: [DatabaseModule],
  controllers: [LocalFilesController],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) => {
        if (environment.objectStorageDriver === "memory") {
          return new MemoryObjectStorage();
        }
        if (environment.objectStorageDriver === "local") {
          return new LocalObjectStorage(environment.localStoragePath!);
        }
        return environment.r2
          ? new R2ObjectStorage(environment.r2)
          : new UnavailableObjectStorage();
      },
    },
    FileObjectsService,
  ],
  exports: [OBJECT_STORAGE, FileObjectsService],
})
export class FilesModule {}
