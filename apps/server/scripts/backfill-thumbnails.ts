import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { loadEnvironment } from "../src/config/environment.js";
import { FileObjectsService } from "../src/files/file-objects.service.js";

const app = await NestFactory.createApplicationContext(
  AppModule.forRoot(loadEnvironment()),
);
try {
  const queued = await app
    .get(FileObjectsService)
    .backfillThumbnails(100, process.argv.includes("--retry-failed"));
  console.log(
    `已登记 ${queued} 个历史缩略图任务（单次上限 100），请保持 worker 运行；可重复执行直到 0。`,
  );
} finally {
  await app.close();
}
