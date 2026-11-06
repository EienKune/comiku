import type { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { AnalysisScheduling } from "../../src/image-analysis/analysis-scheduling.js";
/** Serial isolated-PG fixture: owns only its activation generation and restores it exactly. */
export async function analysisActivationFixture(
  db: PrismaService,
  key: string | null,
) {
  const jobs = new JobsService(db),
    scheduling = new AnalysisScheduling(db, jobs);
  const before = await scheduling.status();
  const queueBefore = await db.jobQueueState.findUnique({
    where: { lane_scope: { lane: "analysis", scope: "global" } },
  });
  let owned = await scheduling.activate(key, before?.generation ?? 0);
  await db.jobQueueState.deleteMany({
    where: { lane: "analysis", scope: "global" },
  });
  return {
    async activate(next: string | null, paused = false) {
      owned = await scheduling.activate(next, owned.generation, paused);
      return owned;
    },
    async restore() {
      await db.$transaction(async (tx) => {
        await jobs.lockScope(tx, "analysis", "global");
        await jobs.lockScope(tx, "heavy", "global");
        const current = await tx.imageAnalysisActivation.findUnique({
          where: { id: "global" },
        });
        if (current?.generation !== owned.generation)
          throw new Error("Fixture no longer owns activation");
        if (queueBefore)
          await tx.jobQueueState.upsert({
            where: { lane_scope: { lane: "analysis", scope: "global" } },
            create: queueBefore,
            update: queueBefore,
          });
        else
          await tx.jobQueueState.deleteMany({
            where: { lane: "analysis", scope: "global" },
          });
        if (before)
          await tx.imageAnalysisActivation.update({
            where: { id: "global" },
            data: before,
          });
        else
          await tx.imageAnalysisActivation.delete({ where: { id: "global" } });
      });
    },
  };
}
