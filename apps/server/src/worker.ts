import { CandidatesService } from "./candidates/candidates.service.js";
import { AnalysisConfigurationMismatch } from "./image-analysis/analysis-scheduling.js";
import { SourceConfigurationMismatch } from "./source-ingestion/source-platform-state.js";
import { DownloadsService } from "./transfers/downloads.service.js";
import { ImageAnalysisService } from "./image-analysis/image-analysis.service.js";
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
const analysis = app.get(ImageAnalysisService);
let nextAnalysisScan = 0;
let nextReviewCleanup = 0;
let nextSourceRecoveryScan = 0;
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
async function maintenanceLoop() {
  while (!stopping.signal.aborted) {
    try {
      if (Date.now() >= nextSourceRecoveryScan) {
        await sources.reconcileExhausted();
        await sources.recovery.schedule();
        await sources.scheduleDue();
        nextSourceRecoveryScan = Date.now() + 60_000;
      }
      await transfers.scheduleCleanup();
      if (Date.now() >= nextReviewCleanup) {
        await app.get(CandidatesService).cleanupReviewSessions();
        nextReviewCleanup = Date.now() + 60_000;
      }
      if (Date.now() >= nextAnalysisScan) {
        await analysis.schedulePending();
        nextAnalysisScan = Date.now() + 60_000;
      }
    } catch {
      console.error("后台调度未完成，稍后重试");
    }
    await delay(5_000, undefined, { signal: stopping.signal }).catch(() => {});
  }
}
async function loop(lane: "heavy" | "network" | "analysis", scope = "global") {
  while (!stopping.signal.aborted) {
    try {
      if (await jobs.runNext(lane, stopping.signal, scope)) continue;
    } catch (error) {
      if (
        error instanceof SourceConfigurationMismatch ||
        error instanceof AnalysisConfigurationMismatch
      ) {
        console.error("当前工作进程的图源配置尚未激活，该平台暂停领取");
        await delay(30_000, undefined, { signal: stopping.signal }).catch(
          () => {},
        );
      } else console.error("后台任务轮询失败，稍后重试");
    }
    await delay(1_000, undefined, { signal: stopping.signal }).catch(() => {});
  }
}
try {
  await Promise.all([
    maintenanceLoop(),
    loop("heavy"),
    loop("analysis"),
    loop("network"),
    loop("network", "source:x"),
    loop("network", "source:pixiv"),
  ]);
} finally {
  clearInterval(healthTimer);
  await app.close();
}
