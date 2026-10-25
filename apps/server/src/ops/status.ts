import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { loadEnvironment } from "../config/environment.js";

const environment = loadEnvironment();
const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: environment.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  }),
});
try {
  const [jobs, oldestQueued, recentRuns] = await Promise.all([
    db.backgroundJob.groupBy({ by: ["lane", "status"], _count: true }),
    db.backgroundJob.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.sourceFetchRun.groupBy({
      by: ["status"],
      where: { startedAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) } },
      _count: true,
    }),
  ]);
  console.log(
    JSON.stringify(
      {
        jobs,
        oldestQueuedAt: oldestQueued?.createdAt ?? null,
        sourceRuns24h: recentRuns,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("运行状态读取失败，请检查数据库和迁移。");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
