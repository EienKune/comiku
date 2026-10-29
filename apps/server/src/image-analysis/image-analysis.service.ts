import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { type BackgroundJob, Prisma } from "../generated/prisma/client.js";
import {
  IMAGE_ANALYSIS_ADAPTER,
  type ActiveImageAnalysisAdapter,
  type ImageAnalysisLabelPresentation,
  validateImageAnalysisResult,
} from "./image-analysis-adapter.js";

@Injectable()
export class ImageAnalysisService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(IMAGE_ANALYSIS_ADAPTER)
    private readonly model: ActiveImageAnalysisAdapter | null,
  ) {}
  get activeModelKey(): string | null {
    return this.model?.modelKey ?? null;
  }
  /** Cache entries contain only per-image winning classes, merged by maximum confidence. */
  promotesReview(predictions: unknown): boolean {
    const policy = this.model?.reviewPolicy;
    return Boolean(
      policy &&
      this.cachedPredictions(predictions).some(
        (entry) =>
          policy.positiveLabels.includes(entry.label) &&
          entry.confidence >= policy.minimumConfidence,
      ),
    );
  }
  classificationTags(predictions: unknown): ImageAnalysisLabelPresentation[] {
    const entries = this.cachedPredictions(predictions);
    // Old summaries need rebuilding from real scores; confidence is not ranking.
    if (entries.some((entry) => entry.score === undefined)) return [];
    const byLabel = new Map(entries.map((entry) => [entry.label, entry.score]));
    let winner: string | undefined;
    let maximum = -1;
    for (const label of this.model?.identity.labels ?? []) {
      const score = byLabel.get(label);
      if (score !== undefined && score > maximum) {
        winner = label;
        maximum = score;
      }
    }
    if (!winner) return [];
    const display = this.model?.labelPresentation?.find(
      (entry) => entry.label === winner,
    );
    return [
      {
        label: winner,
        text: display?.text ?? winner,
        tone: display?.tone ?? "neutral",
      },
    ];
  }
  private cachedPredictions(
    predictions: unknown,
  ): { label: string; confidence: number; score?: number }[] {
    const model = this.model;
    if (
      !model ||
      !Array.isArray(predictions) ||
      predictions.length > model.identity.labels.length
    )
      return [];
    const seen = new Set<string>();
    const entries: { label: string; confidence: number; score?: number }[] = [];
    for (const entry of Array.from(predictions)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.label !== "string" ||
        !model.identity.labels.includes(entry.label) ||
        seen.has(entry.label) ||
        typeof entry.confidence !== "number" ||
        !Number.isFinite(entry.confidence) ||
        entry.confidence < 0 ||
        entry.confidence > 1 ||
        (entry.score !== undefined &&
          (typeof entry.score !== "number" ||
            !Number.isFinite(entry.score) ||
            entry.score < 0 ||
            entry.score > 1))
      )
        return [];
      seen.add(entry.label);
      entries.push({
        label: entry.label,
        confidence: entry.confidence,
        ...(entry.score === undefined ? {} : { score: entry.score }),
      });
    }
    return entries;
  }
  onModuleInit() {
    this.jobs.register("image_analysis", async (job, signal) => {
      const model = this.model;
      const queuedModel = (job.payload as { modelKey?: string }).modelKey;
      if (!model || queuedModel !== model.modelKey) {
        await this.retireJob(
          job,
          model ? "model_configuration_changed" : "adapter_disabled",
        );
        return;
      }
      const row = await this.db.candidateMediaAnalysis.findUnique({
        where: {
          mediaId_modelKey: {
            mediaId: job.resourceId,
            modelKey: model.modelKey,
          },
        },
        include: { media: { include: { fileObject: true } } },
      });
      if (!row || row.status === "succeeded") return;
      try {
        signal.throwIfAborted();
        const { body } = await this.files.read(row.media.fileObjectId);
        if (
          createHash("sha256").update(body).digest("hex") !== row.sourceSha256
        )
          throw Error("Source checksum changed");
        const result = validateImageAnalysisResult(
          await model.analyze(row.mediaId, body, signal),
          model.identity.labels,
        );
        signal.throwIfAborted();
        await this.db.$transaction(async (tx) => {
          await this.lockCandidate(tx, row.media.candidatePostId);
          await this.jobs.assertCurrentLease(tx);
          await tx.candidateMediaAnalysis.update({
            where: { id: row.id },
            data: {
              status: "succeeded",
              score: result.score,
              resultJson: {
                ...result,
                identity: model.identity,
                modelKey: model.modelKey,
              } as unknown as Prisma.InputJsonValue,
              lastError: null,
            },
          });
          await this.aggregate(tx, row.media.candidatePostId, model.modelKey);
        });
      } catch (error) {
        await this.db.$transaction(async (tx) => {
          await this.lockCandidate(tx, row.media.candidatePostId);
          await this.jobs.assertCurrentLease(tx);
          await tx.candidateMediaAnalysis.updateMany({
            where: { id: row.id, status: { not: "succeeded" } },
            data: {
              status: job.attempts >= 3 ? "failed" : "queued",
              lastError: "inference_failed",
            },
          });
          await this.aggregate(tx, row.media.candidatePostId, model.modelKey);
        });
        throw error;
      }
    });
  }
  /** Historical jobs are terminal, never re-labelled with the currently configured identity. */
  private async retireJob(job: BackgroundJob, reason: string) {
    await this.db.$transaction(async (tx) => {
      const media = await tx.candidateMedia.findUnique({
        where: { id: job.resourceId },
        select: { candidatePostId: true },
      });
      if (media) await this.lockCandidate(tx, media.candidatePostId);
      await this.jobs.assertCurrentLease(tx);
      await tx.backgroundJob.updateMany({
        where: { id: job.id, status: "running", leaseId: job.leaseId },
        data: {
          status: "failed",
          leaseId: null,
          leaseUntil: null,
          completedAt: new Date(),
          lastError: reason,
        },
      });
      const key = (job.payload as { modelKey?: string }).modelKey;
      const prefix = `image-analysis:${job.resourceId}:`;
      const storedKey =
        typeof job.idempotencyKey === "string" &&
        job.idempotencyKey.startsWith(prefix)
          ? job.idempotencyKey.slice(prefix.length)
          : undefined;
      const keys = [
        ...new Set(
          [key, storedKey].filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      ];
      if (!keys.length) return;
      await tx.candidateMediaAnalysis.updateMany({
        where: {
          mediaId: job.resourceId,
          modelKey: { in: keys },
          status: "queued",
        },
        data: { status: "failed", lastError: reason },
      });
      if (media) {
        const aggregateKey =
          this.model && keys.includes(this.model.modelKey)
            ? this.model.modelKey
            : !this.model
              ? keys[0]
              : undefined;
        if (aggregateKey)
          await this.aggregate(tx, media.candidatePostId, aggregateKey);
      }
    });
  }

  /** Bounded recovery also runs with no model. Live leases are left to their owner. */
  private async reconcileRetired(candidateId?: string) {
    const rows = await this.db.candidateMediaAnalysis.findMany({
      where: {
        status: "queued",
        ...(this.model ? { modelKey: { not: this.model.modelKey } } : {}),
        ...(candidateId ? { media: { candidatePostId: candidateId } } : {}),
      },
      include: { media: { select: { candidatePostId: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const row of rows) {
      await this.db.$transaction(async (tx) => {
        await this.lockCandidate(tx, row.media.candidatePostId);
        const matching = {
          kind: "image_analysis",
          resourceId: row.mediaId,
          payload: { path: ["modelKey"], equals: row.modelKey },
        };
        if (
          await tx.backgroundJob.count({
            where: {
              ...matching,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          })
        )
          return;
        const reason = this.model
          ? "model_configuration_changed"
          : "adapter_disabled";
        await tx.backgroundJob.updateMany({
          where: {
            ...matching,
            OR: [
              { status: "queued" },
              { status: "running", leaseUntil: { lte: new Date() } },
            ],
          },
          data: {
            status: "failed",
            leaseId: null,
            leaseUntil: null,
            completedAt: new Date(),
            lastError: reason,
          },
        });
        // Claims do not take the candidate lock. A queued job may have acquired a
        // live lease since the first count; never fail its media in that race.
        if (
          await tx.backgroundJob.count({
            where: {
              ...matching,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          })
        )
          return;
        const changed = await tx.candidateMediaAnalysis.updateMany({
          where: { id: row.id, status: "queued" },
          data: { status: "failed", lastError: reason },
        });
        if (changed.count && !this.model)
          await this.aggregate(tx, row.media.candidatePostId, row.modelKey);
      });
    }
  }
  private async lockCandidate(
    tx: Prisma.TransactionClient,
    candidateId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM candidate_posts WHERE id = ${candidateId}::uuid FOR UPDATE`;
  }
  private async aggregate(
    tx: Prisma.TransactionClient,
    candidateId: string,
    modelKey: string,
  ) {
    const media = await tx.candidateMedia.findMany({
      where: { candidatePostId: candidateId },
      select: {
        analyses: {
          where: { modelKey },
          select: { status: true, score: true, resultJson: true },
        },
      },
    });
    const results = media.map((m) => m.analyses[0]);
    const complete =
      results.length > 0 &&
      results.every((r) => r?.status === "succeeded" && r.score !== null);
    let predictions: { label: string; confidence: number; score: number }[] =
      [];
    if (complete && this.model?.modelKey === modelKey) {
      try {
        const confidenceByLabel = new Map<string, number>();
        const scoreByLabel = new Map<string, number>();
        for (const row of results) {
          const result = validateImageAnalysisResult(
            row!.resultJson,
            this.model.identity.labels,
          );
          const confidence = result.classScores.find(
            (score) => score.label === result.predictedClass,
          )!.value;
          const score = row!.score!;
          if (!Number.isFinite(score) || score < 0 || score > 1)
            throw Error("Invalid cached ranking score");
          scoreByLabel.set(
            result.predictedClass,
            Math.max(scoreByLabel.get(result.predictedClass) ?? 0, score),
          );
          confidenceByLabel.set(
            result.predictedClass,
            Math.max(
              confidenceByLabel.get(result.predictedClass) ?? 0,
              confidence,
            ),
          );
        }
        predictions = this.model.identity.labels.flatMap((label) => {
          const confidence = confidenceByLabel.get(label);
          return confidence === undefined
            ? []
            : [{ label, confidence, score: scoreByLabel.get(label)! }];
        });
      } catch {
        // Historical malformed results must never promote a candidate for review.
      }
    }
    await tx.candidatePost.update({
      where: { id: candidateId },
      data: {
        analysisModelKey: modelKey,
        analysisState: complete
          ? "succeeded"
          : results.some((r) => r?.status === "failed")
            ? "failed"
            : "queued",
        analysisScore: complete
          ? Math.max(...results.map((r) => r!.score!))
          : null,
        analysisPredictions: predictions,
      },
    });
  }
  /** Restore cache provenance from actual results, including upgrades and switching back. */
  private async reconcileSummaries(modelKey: string, candidateId?: string) {
    const candidates = await this.db.candidatePost.findMany({
      where: {
        ...(candidateId ? { id: candidateId } : {}),
        author: { deletedAt: null },
        OR: [
          { analysisModelKey: null },
          { analysisModelKey: { not: modelKey } },
          { analysisPredictions: { equals: Prisma.DbNull } },
          {
            analysisState: "succeeded",
            AND: [
              { analysisPredictions: { not: [] } },
              {
                analysisPredictions: {
                  path: ["0", "score"],
                  equals: Prisma.DbNull,
                },
              },
            ],
          },
        ],
        media: { some: { analyses: { some: { modelKey } } } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 20,
    });
    for (const candidate of candidates) {
      await this.db.$transaction(async (tx) => {
        await this.lockCandidate(tx, candidate.id);
        await this.aggregate(tx, candidate.id, modelKey);
      });
    }
  }
  async schedulePending(candidateId?: string) {
    await this.reconcileRetired(candidateId);
    if (!this.model) return;
    const model = this.model;
    await this.reconcileSummaries(model.modelKey, candidateId);
    // A worker can die after its final claim, before the handler records failure.
    const pending = await this.db.candidateMediaAnalysis.findMany({
      where: {
        modelKey: model.modelKey,
        status: "queued",
        ...(candidateId ? { media: { candidatePostId: candidateId } } : {}),
      },
      select: { mediaId: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const exhausted = await this.db.backgroundJob.findMany({
      where: {
        kind: "image_analysis",
        status: "failed",
        resourceId: { in: pending.map((row) => row.mediaId) },
        payload: { path: ["modelKey"], equals: model.modelKey },
      },
      select: { resourceId: true },
      take: 100,
    });
    for (const job of exhausted) {
      await this.db.$transaction(async (tx) => {
        const row = await tx.candidateMediaAnalysis.findFirst({
          where: {
            mediaId: job.resourceId,
            modelKey: model.modelKey,
            status: "queued",
            ...(candidateId ? { media: { candidatePostId: candidateId } } : {}),
          },
          include: { media: { select: { candidatePostId: true } } },
        });
        if (!row) return;
        await this.lockCandidate(tx, row.media.candidatePostId);
        if (
          !(await tx.backgroundJob.count({
            where: {
              kind: "image_analysis",
              resourceId: row.mediaId,
              status: "failed",
              payload: { path: ["modelKey"], equals: model.modelKey },
            },
          }))
        )
          return;
        await tx.candidateMediaAnalysis.updateMany({
          where: { id: row.id, status: "queued" },
          data: { status: "failed", lastError: "worker_attempts_exhausted" },
        });
        await this.aggregate(tx, row.media.candidatePostId, model.modelKey);
      });
    }
    const media = await this.db.candidateMedia.findMany({
      where: {
        ...(candidateId ? { candidatePostId: candidateId } : {}),
        analyses: { none: { modelKey: model.modelKey } },
        fileObject: { lifecycleStatus: "active", deletedAt: null },
        candidatePost: { author: { deletedAt: null } },
      },
      include: { fileObject: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const item of media) {
      await this.db.$transaction(async (tx) => {
        await this.lockCandidate(tx, item.candidatePostId);
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
            lane: "heavy",
            priority: 0,
            payload: {
              modelKey: model.modelKey,
              identity: { ...model.identity },
            },
          },
          tx,
        );
        await this.aggregate(tx, item.candidatePostId, model.modelKey);
      });
    }
  }
  async retryFailed(candidateId: string) {
    if (!this.model) throw new BadRequestException("识别服务尚未配置");
    const model = this.model;
    await this.schedulePending(candidateId);
    return this.db.$transaction(async (tx) => {
      await this.lockCandidate(tx, candidateId);
      if (
        !(await tx.candidatePost.count({
          where: { id: candidateId, author: { deletedAt: null } },
        }))
      )
        throw new NotFoundException("候选不存在");
      const rows = await tx.candidateMediaAnalysis.findMany({
        where: {
          modelKey: model.modelKey,
          status: "failed",
          media: { candidatePostId: candidateId },
        },
      });
      let queued = 0;
      for (const row of rows) {
        const changed = await tx.backgroundJob.updateMany({
          where: {
            idempotencyKey: `image-analysis:${row.mediaId}:${model.modelKey}`,
            status: "failed",
          },
          data: {
            status: "queued",
            attempts: 0,
            availableAt: new Date(),
            completedAt: null,
            lastError: null,
          },
        });
        if (!changed.count) continue;
        await tx.candidateMediaAnalysis.update({
          where: { id: row.id },
          data: { status: "queued", lastError: null },
        });
        queued++;
      }
      await this.aggregate(tx, candidateId, model.modelKey);
      return { queued };
    });
  }
}
