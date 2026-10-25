import { DownloadsService } from "./transfers/downloads.service.js";
import "reflect-metadata";
import { setTimeout as delay } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";
import { JobsService } from "./jobs/jobs.service.js";
import { SourceFetchService } from "./source-ingestion/source-fetch.service.js";
import { PrismaService } from "./database/prisma.service.js";
import { writeWorkerHealth } from "./ops/worker-health.js";

const environment = loadEnvironment();
const app = await NestFactory.createApplicationContext(
  AppModule.forRoot(environment),
);
const stopping = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stopping.abort());
const jobs = app.get(JobsService);
const sources = app.get(SourceFetchService);
const transfers = app.get(DownloadsService);
let healthWriting = false;
const heartbeat = async () => {
  if (!process.env.WORKER_HEALTH_FILE || healthWriting) return;
  healthWriting = true;
  try {
    await app.get(PrismaService).$queryRaw`SELECT 1`;
    await writeWorkerHealth(process.env.WORKER_HEALTH_FILE);
  } catch {
    console.error("后台健康检查未更新，请检查数据库或临时磁盘。");
  } finally {
    healthWriting = false;
  }
};
await heartbeat();
const healthTimer = setInterval(() => {
  void heartbeat();
}, 10_000);
async function loop(lane: "heavy" | "network") {
  while (!stopping.signal.aborted) {
    try {
      if (lane === "network") await sources.scheduleDue();
      else await transfers.scheduleCleanup();
      if (await jobs.runNext(lane, stopping.signal)) continue;
    } catch {
      console.error("后台任务轮询失败，稍后重试");
    }
    await delay(1_000, undefined, { signal: stopping.signal }).catch(() => {});
  }
}
try {
  await Promise.all([loop("heavy"), loop("network")]);
} finally {
  clearInterval(healthTimer);
  await app.close();
}
