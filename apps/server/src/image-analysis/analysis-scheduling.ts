import {
  type BackgroundJob,
  type Prisma,
  type ImageAnalysisActivation,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { JobsService, JobDeferred } from "../jobs/jobs.service.js";
import type { ActiveImageAnalysisAdapter } from "./image-analysis-adapter.js";

/** JSONB NOT NULL still permits JSON null, primitives and arrays. */
export function analysisJobModelKey(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const key = (payload as { modelKey?: unknown }).modelKey;
  return typeof key === "string" ? key : undefined;
}

export class AnalysisConfigurationMismatch extends Error {
  constructor() {
    super("Image analysis activation differs from local configuration");
  }
}
export class AnalysisScheduling {
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  async status() {
    return this.db.imageAnalysisActivation.findUnique({
      where: { id: "global" },
    });
  }
  private async barrier(tx: Prisma.TransactionClient) {
    await this.jobs.lockScope(tx, "analysis", "global");
    await this.jobs.lockScope(tx, "heavy", "global");
  }
  private async drained(tx: Prisma.TransactionClient) {
    // Even an expired executor must be explicitly drained before maintenance.
    if (
      await tx.backgroundJob.count({
        where: { kind: "image_analysis", status: "running" },
      })
    )
      throw new Error(
        "Drain and stop all image analysis workers before activation",
      );
  }
  async ensure(modelKey: string | null) {
    return this.db.$transaction(async (tx) => {
      await this.barrier(tx);
      let row = await tx.imageAnalysisActivation.findUnique({
        where: { id: "global" },
      });
      if (!row) {
        await this.drained(tx);
        row = await tx.imageAnalysisActivation.create({
          data: { id: "global", activeModelKey: modelKey },
        });
      }
      if (row.activeModelKey !== modelKey)
        throw new AnalysisConfigurationMismatch();
      return row;
    });
  }
  async activate(
    modelKey: string | null,
    expectedGeneration: number,
    historicalPaused = false,
  ) {
    if (modelKey !== null && !/^[a-f0-9]{64}$/.test(modelKey))
      throw new Error("Invalid model key");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
      throw new Error("Invalid generation");
    return this.db.$transaction(async (tx) => {
      await this.barrier(tx);
      await this.drained(tx);
      const old = await tx.imageAnalysisActivation.findUnique({
        where: { id: "global" },
      });
      if ((old?.generation ?? 0) !== expectedGeneration)
        throw new Error("Activation generation changed");
      if (!old)
        return tx.imageAnalysisActivation.create({
          data: { id: "global", activeModelKey: modelKey, historicalPaused },
        });
      return tx.imageAnalysisActivation.update({
        where: { id: "global" },
        data: {
          activeModelKey: modelKey,
          generation: { increment: 1 },
          activatedAt:
            old.activeModelKey === modelKey ? old.activatedAt : new Date(),
          historicalPaused,
        },
      });
    });
  }
  async assert(tx: Prisma.TransactionClient, modelKey: string | null) {
    const row = await tx.imageAnalysisActivation.findUnique({
      where: { id: "global" },
    });
    if (!row || row.activeModelKey !== modelKey)
      throw new AnalysisConfigurationMismatch();
    return row;
  }
  async gate(
    job: BackgroundJob,
    tx: Prisma.TransactionClient,
    now: Date,
    modelKey: string | null,
  ) {
    // Never acquire analysis scope while holding the legacy heavy claim barrier.
    if (job.lane !== "analysis" || job.executionScope !== "global")
      return new JobDeferred(new Date(now.getTime() + 60000), "scope_paused");
    const row = await this.assert(tx, modelKey);
    if (
      await tx.backgroundJob.count({
        where: {
          kind: "image_analysis",
          status: "running",
          id: { not: job.id },
          lane: { not: "analysis" },
        },
      })
    )
      return new JobDeferred(new Date(now.getTime() + 60000), "capacity");
    if (row.historicalPaused && job.queueName === "historical")
      return new JobDeferred(new Date(now.getTime() + 60000), "scope_paused");
  }
  async intent(
    tx: Prisma.TransactionClient,
    media: { id: string; createdAt: Date },
    modelKey: string,
    activation: ImageAnalysisActivation,
  ) {
    return tx.imageAnalysisWorkIntent.upsert({
      where: { mediaId_modelKey: { mediaId: media.id, modelKey } },
      update: {},
      create: {
        mediaId: media.id,
        modelKey,
        purpose:
          media.createdAt >= activation.activatedAt
            ? "incremental"
            : "historical",
        activationGeneration: activation.generation,
      },
    });
  }
  /** Bounded upgrade under both claim barriers. Running rows are never relocated. */
  async migrateQueued(modelKey: string | null) {
    await this.db.$transaction(async (tx) => {
      await this.barrier(tx);
      const rows = await tx.backgroundJob.findMany({
        where: {
          kind: "image_analysis",
          status: "queued",
          OR: [
            { lane: { not: "analysis" } },
            { executionScope: { not: "global" } },
            { queueName: { notIn: ["incremental", "historical"] } },
          ],
        },
        orderBy: { id: "asc" },
        take: 20,
      });
      if (!rows.length) return;
      if (
        await tx.backgroundJob.count({
          where: {
            kind: "image_analysis",
            status: "running",
            lane: { not: "analysis" },
          },
        })
      )
        throw new Error("Drain legacy analysis workers before migration");
      const ids = rows.map((job) => job.id);
      await tx.$queryRaw`SELECT id FROM background_jobs WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const activation = await this.assert(tx, modelKey);
      for (const job of rows) {
        const current = await tx.backgroundJob.findUnique({
          where: { id: job.id },
        });
        if (!current || current.status !== "queued") continue;
        const key = analysisJobModelKey(current.payload);
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
          await tx.backgroundJob.update({
            where: { id: current.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              lastError: "invalid_legacy_analysis",
              leaseId: null,
              leaseUntil: null,
            },
          });
          continue;
        }
        const media = await tx.candidateMedia.findUnique({
          where: { id: current.resourceId },
        });
        if (!media) {
          await tx.backgroundJob.update({
            where: { id: current.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              lastError: "orphaned_legacy_analysis",
              leaseId: null,
              leaseUntil: null,
            },
          });
          continue;
        }
        const intent = await this.intent(tx, media, key, activation);
        await tx.backgroundJob.update({
          where: { id: current.id },
          data: {
            lane: "analysis",
            executionScope: "global",
            queueName: intent.purpose,
          },
        });
      }
    });
  }
  async discover(
    model: ActiveImageAnalysisAdapter,
    activation: ImageAnalysisActivation,
    aggregate: (
      tx: Prisma.TransactionClient,
      id: string,
      key: string,
    ) => Promise<void>,
    candidateId?: string,
  ) {
    for (const purpose of ["incremental", "historical"] as const) {
      if (purpose === "historical" && activation.historicalPaused) continue;
      const media = await this.db.candidateMedia.findMany({
        where: {
          ...(candidateId ? { candidatePostId: candidateId } : {}),
          AND: [
            {
              OR: [
                {
                  analysisWorkIntents: {
                    some: { modelKey: model.modelKey, purpose },
                  },
                },
                {
                  analysisWorkIntents: { none: { modelKey: model.modelKey } },
                  createdAt:
                    purpose === "incremental"
                      ? { gte: activation.activatedAt }
                      : { lt: activation.activatedAt },
                },
              ],
            },
          ],
          OR: [
            { analyses: { none: { modelKey: model.modelKey } } },
            {
              analyses: {
                some: { modelKey: model.modelKey, status: "queued" },
              },
              analysisWorkIntents: { none: { modelKey: model.modelKey } },
            },
          ],
          fileObject: { lifecycleStatus: "active", deletedAt: null },
          candidatePost: { author: { deletedAt: null } },
        },
        include: { fileObject: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 20,
      });
      for (const item of media)
        await this.db.$transaction(async (tx) => {
          await this.jobs.lockScope(tx, "analysis", "global");
          const current = await this.assert(tx, model.modelKey);
          if (current.generation !== activation.generation)
            throw new AnalysisConfigurationMismatch();
          const jobKey = `image-analysis:${item.id}:${model.modelKey}`;
          await tx.$queryRaw`SELECT id FROM background_jobs WHERE idempotency_key=${jobKey} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM candidate_posts WHERE id=${item.candidatePostId}::uuid FOR UPDATE`;
          const intent = await this.intent(tx, item, model.modelKey, current);
          await tx.candidateMediaAnalysis.createMany({
            data: {
              mediaId: item.id,
              modelKey: model.modelKey,
              modelRevision: model.identity.modelRevision,
              decisionVersion: model.identity.decisionVersion,
              sourceSha256: item.fileObject.checksum,
            },
            skipDuplicates: true,
          });
          await this.jobs.enqueue(
            {
              kind: "image_analysis",
              resourceId: item.id,
              idempotencyKey: `image-analysis:${item.id}:${model.modelKey}`,
              lane: "analysis",
              executionScope: "global",
              queueName: intent.purpose,
              priority: 0,
              payload: {
                modelKey: model.modelKey,
                identity: { ...model.identity },
              },
            },
            tx,
          );
          await aggregate(tx, item.candidatePostId, model.modelKey);
        });
    }
  }
}
