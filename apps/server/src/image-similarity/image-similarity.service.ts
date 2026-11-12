import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { permissionsFor, type Actor } from "../common/access.js";
import { JobsService, JobDeferred } from "../jobs/jobs.service.js";
import {
  Prisma,
  type BackgroundJob,
  type FileObject,
} from "../generated/prisma/client.js";
import {
  FINGERPRINT_BYTE_LIMIT,
  FINGERPRINT_RECIPE,
  FingerprintInputError,
  fingerprintImage,
  readFingerprintInput,
} from "./fingerprint.js";
import {
  similarityCoverageQuery,
  similarityMatchesQuery,
} from "./image-similarity-query.js";
import type {
  ImageSimilarityCoverageDto,
  ImageSimilarityMatchDto,
  ImageSimilarityResultDto,
} from "./image-similarity.dto.js";

export const IMAGE_FINGERPRINT_JOB = "image_fingerprint";
export const FINGERPRINT_BACKFILL_BATCH = 2;

@Injectable()
export class ImageSimilarityService {
  private nextEmptyBackfillScan = 0;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  onModuleInit() {
    this.jobs.register(IMAGE_FINGERPRINT_JOB, (job, signal) =>
      this.process(job, signal),
    );
    // Historical work yields to every eligible business heavy job, including old
    // exports chosen by Jobs' age fairness rule. No new worker/scope/concurrency.
    this.jobs.registerClaimGate(IMAGE_FINGERPRINT_JOB, async (job, tx, now) => {
      if ((job.payload as { historical?: boolean }).historical !== true) return;
      const other = await tx.backgroundJob.findFirst({
        where: {
          lane: "heavy",
          executionScope: "global",
          status: "queued",
          kind: { not: IMAGE_FINGERPRINT_JOB },
          attempts: { lt: 3 },
          availableAt: { lte: now },
        },
        select: { id: true },
      });
      if (other)
        return new JobDeferred(new Date(now.getTime() + 30_000), "capacity");
    });
  }

  private async authorize(tx: Prisma.TransactionClient, actorId: string) {
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      include: { roles: true },
    });
    const permissions = actor?.isActive
      ? permissionsFor(
          actor.roles.map((r) => r.role),
          actor.mustChangePassword,
        )
      : [];
    if (
      !permissions.includes("candidates:read") ||
      !permissions.includes("works:read")
    )
      throw new ForbiddenException("当前职务不能检索候选与作品图片");
  }

  private async currentMedia(
    tx: Prisma.TransactionClient,
    actorId: string,
    candidateId: string,
    mediaId: string,
  ) {
    await this.authorize(tx, actorId);
    const media = await tx.candidateMedia.findFirst({
      where: {
        id: mediaId,
        candidatePostId: candidateId,
        candidatePost: { author: { deletedAt: null } },
        fileObject: { lifecycleStatus: "active", deletedAt: null },
      },
      include: { fileObject: true },
    });
    if (!media) throw new NotFoundException("候选图片不存在或不可用");
    return media;
  }

  private async authorizePreparation(
    tx: Prisma.TransactionClient,
    actorId: string,
    actor?: Actor,
  ) {
    if (!actor || actor.userId !== actorId)
      throw new UnauthorizedException("图片检索需要有效登录会话");
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(20260905, 2)`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR UPDATE`;
    const now = new Date();
    const session = await tx.authSession.findFirst({
      where: {
        id: actor.sessionId,
        userId: actorId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: {
          gt: new Date(
            now.getTime() - this.environment.authSessionIdleSeconds * 1000,
          ),
        },
        user: { isActive: true },
      },
    });
    if (!session) throw new UnauthorizedException("登录已失效，请重新登录");
  }

  /** POST registers at most this image. GET never creates or repairs any job. */
  async search(
    actorId: string,
    candidateId: string,
    mediaId: string,
    prepare = false,
    actor?: Actor,
  ): Promise<ImageSimilarityResultDto> {
    return this.db.$transaction(async (tx) => {
      if (prepare) await this.authorizePreparation(tx, actorId, actor);
      const media = await this.currentMedia(tx, actorId, candidateId, mediaId);
      if (prepare) await this.register(tx, media.fileObject, false);
      const row = await tx.imageFingerprint.findUnique({
        where: {
          fileObjectId_recipeVersion: {
            fileObjectId: media.fileObjectId,
            recipeVersion: FINGERPRINT_RECIPE,
          },
        },
      });
      const [coverage] = await tx.$queryRaw<ImageSimilarityCoverageDto[]>(
        similarityCoverageQuery(),
      );
      const available =
        row?.sourceSha256 === media.fileObject.checksum &&
        row.status === "ready" &&
        row.phashHex &&
        /^[0-9a-f]{16}$/.test(row.phashHex);
      // SHA matching remains available when decoding is unsupported/too large,
      // and while the current perceptual fingerprint is preparing.
      const matches = await tx.$queryRaw<ImageSimilarityMatchDto[]>(
        similarityMatchesQuery(
          media.fileObject.checksum,
          available ? row.phashHex! : null,
        ),
      );
      if (
        row?.sourceSha256 === media.fileObject.checksum &&
        row.status === "failed"
      )
        return {
          state: "failed",
          coverage: coverage!,
          matches,
          error: row.lastError ?? "fingerprint_failed",
        };
      if (row?.jobId && ["queued", "running"].includes(row.status)) {
        const job = await tx.backgroundJob.findUnique({
          where: { id: row.jobId },
          select: { status: true },
        });
        if (!job || job.status === "failed" || job.status === "succeeded")
          return {
            state: "failed",
            coverage: coverage!,
            matches,
            error: "fingerprint_interrupted",
          };
      }
      if (!available)
        return { state: "preparing", coverage: coverage!, matches };
      return {
        state: coverage!.pending || coverage!.failed ? "partial" : "ready",
        coverage: coverage!,
        matches,
      };
    });
  }

  private async register(
    tx: Prisma.TransactionClient,
    file: FileObject,
    historical: boolean,
  ) {
    await tx.imageFingerprint.createMany({
      data: {
        fileObjectId: file.id,
        recipeVersion: FINGERPRINT_RECIPE,
        sourceSha256: file.checksum,
      },
      skipDuplicates: true,
    });
    const row = await tx.imageFingerprint.findUniqueOrThrow({
      where: {
        fileObjectId_recipeVersion: {
          fileObjectId: file.id,
          recipeVersion: FINGERPRINT_RECIPE,
        },
      },
    });
    // Immutable originals mean checksum drift is exceptional. Invalidate the old
    // recipe result and give changed content a fresh job identity.
    if (row.sourceSha256 !== file.checksum) {
      await tx.imageFingerprint.update({
        where: { id: row.id },
        data: {
          sourceSha256: file.checksum,
          status: "queued",
          phashHex: null,
          jobId: null,
          lastError: null,
        },
      });
    } else if (row.status === "ready" || row.status === "failed") return;
    const job = await this.jobs.enqueue(
      {
        kind: IMAGE_FINGERPRINT_JOB,
        resourceId: row.id,
        idempotencyKey: `fingerprint:${row.id}:${file.checksum}`,
        lane: "heavy",
        executionScope: "global",
        priority: historical ? -20 : 2,
        payload: {
          historical,
          recipeVersion: FINGERPRINT_RECIPE,
          sourceSha256: file.checksum,
        },
      },
      tx,
    );
    await tx.imageFingerprint.updateMany({
      where: {
        id: row.id,
        sourceSha256: file.checksum,
        status: { in: ["queued", "running"] },
      },
      data: { jobId: job.id },
    });
    // Exhausted/crashed jobs never enter their handler again. A POST still reports
    // this terminal condition accurately; it does not silently re-download.
    if (job.status === "failed" || job.status === "succeeded")
      await tx.imageFingerprint.updateMany({
        where: {
          id: row.id,
          status: { in: ["queued", "running"] },
          jobId: job.id,
        },
        data: { status: "failed", lastError: "fingerprint_interrupted" },
      });
  }

  /** Called by worker maintenance (e.g. every five seconds). Persistent barrier,
   * <=2 outstanding jobs across workers; refill without sleeps while gaps exist.
   * Once covered, check for newly adopted originals at most once per minute.
   */
  async schedulePending(limit = FINGERPRINT_BACKFILL_BATCH): Promise<number> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:fingerprint-backfill'))`;
      await tx.$executeRaw`
        WITH terminal AS (SELECT fp.id FROM image_fingerprints fp JOIN background_jobs j ON j.id = fp.job_id
          WHERE fp.recipe_version = ${FINGERPRINT_RECIPE} AND fp.status IN ('queued', 'running') AND j.status IN ('failed', 'succeeded')
          ORDER BY fp.created_at, fp.id LIMIT 20 FOR UPDATE OF fp SKIP LOCKED)
        UPDATE image_fingerprints fp SET status = 'failed', last_error = 'fingerprint_interrupted', updated_at = CURRENT_TIMESTAMP
        FROM terminal t WHERE fp.id = t.id`;
      const outstanding = await tx.backgroundJob.count({
        where: {
          kind: IMAGE_FINGERPRINT_JOB,
          lane: "heavy",
          executionScope: "global",
          status: { in: ["queued", "running"] },
        },
      });
      const take = Math.max(
        0,
        Math.min(
          Math.trunc(limit) || 0,
          FINGERPRINT_BACKFILL_BATCH - outstanding,
        ),
      );
      if (!take) return 0;
      if (Date.now() < this.nextEmptyBackfillScan) return 0;
      const files = await tx.fileObject.findMany({
        where: {
          lifecycleStatus: "active",
          deletedAt: null,
          workImages: { some: {} },
          imageFingerprints: { none: { recipeVersion: FINGERPRINT_RECIPE } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      });
      for (const file of files) await this.register(tx, file, true);
      if (!files.length) this.nextEmptyBackfillScan = Date.now() + 60_000;
      return files.length;
    });
  }

  private async process(job: BackgroundJob, signal: AbortSignal) {
    const row = await this.db.imageFingerprint.findUnique({
      where: { id: job.resourceId },
      include: { fileObject: true },
    });
    if (
      !row ||
      row.recipeVersion !== FINGERPRINT_RECIPE ||
      ["ready", "failed"].includes(row.status) ||
      row.jobId !== job.id
    )
      return;
    const payload = job.payload as { sourceSha256?: string };
    if (
      payload.sourceSha256 !== row.sourceSha256 ||
      row.fileObject.checksum !== row.sourceSha256
    )
      return;
    const persist = async (
      data: Prisma.ImageFingerprintUpdateManyMutationInput,
    ) =>
      this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, job);
        await tx.$queryRaw`SELECT id FROM file_objects WHERE id = ${row.fileObjectId}::uuid FOR SHARE`;
        return tx.imageFingerprint.updateMany({
          where: {
            id: row.id,
            jobId: job.id,
            sourceSha256: row.sourceSha256,
            status: { in: ["queued", "running"] },
          },
          data,
        });
      });
    if (
      row.fileObject.lifecycleStatus !== "active" ||
      row.fileObject.deletedAt
    ) {
      await persist({ status: "failed", lastError: "file_unavailable" });
      return;
    }
    await persist({ status: "running", lastError: null });
    try {
      const boundedSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(20_000),
      ]);
      boundedSignal.throwIfAborted();
      if (row.fileObject.size > BigInt(FINGERPRINT_BYTE_LIMIT))
        throw new FingerprintInputError("byte_limit");
      // Storage adapters do not accept an AbortSignal. Bound admission wait as
      // well as stream consumption, and close a response arriving after timeout.
      const opened = this.files.readStream(row.fileObjectId);
      const { body } = await new Promise<Awaited<typeof opened>>(
        (resolve, reject) => {
          const abort = () => reject(new Error("Fingerprint read timed out"));
          boundedSignal.addEventListener("abort", abort, { once: true });
          opened.then(
            (result) => {
              boundedSignal.removeEventListener("abort", abort);
              if (boundedSignal.aborted) {
                result.body.destroy();
                reject(new Error("Fingerprint read timed out"));
              } else resolve(result);
            },
            (error: unknown) => {
              boundedSignal.removeEventListener("abort", abort);
              reject(error);
            },
          );
          if (boundedSignal.aborted) abort();
        },
      );
      const input = await readFingerprintInput(body, boundedSignal);
      const fingerprint = await fingerprintImage(input);
      boundedSignal.throwIfAborted();
      if (fingerprint.sourceSha256 !== row.sourceSha256)
        throw new FingerprintInputError("checksum_mismatch");
      await this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, job);
        await tx.$queryRaw`SELECT id FROM file_objects WHERE id = ${row.fileObjectId}::uuid FOR SHARE`;
        await tx.imageFingerprint.updateMany({
          where: {
            id: row.id,
            jobId: job.id,
            sourceSha256: row.sourceSha256,
            status: "running",
            fileObject: {
              lifecycleStatus: "active",
              deletedAt: null,
              checksum: row.sourceSha256,
            },
          },
          data: { ...fingerprint, status: "ready", lastError: null },
        });
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const deterministic =
        error instanceof FingerprintInputError && error.code !== "read_aborted";
      await persist({
        status: deterministic || job.attempts >= 3 ? "failed" : "queued",
        lastError: deterministic ? error.code : "fingerprint_read_failed",
      });
      if (!deterministic)
        throw new Error("Fingerprint original read failed", { cause: error });
    }
  }
}
