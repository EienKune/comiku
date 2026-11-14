import { randomUUID } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  Prisma,
  type ArchiveExportAttempt,
  type ArchiveExportRun,
  type BackgroundJob,
} from "../generated/prisma/client.js";
import { JobDeferred, JobsService } from "../jobs/jobs.service.js";
import {
  ARCHIVE_DELETE,
  ARCHIVE_PACKAGE,
  ARCHIVE_PREPARE,
  ARCHIVE_SCOPE,
  archiveHash,
  assertArchiveAdministrator,
  terminalArchiveStatuses,
} from "./archive-common.js";
import type { ArchiveExportScopeDto } from "./archive-exports.dto.js";
import { planArchivePackages } from "./archive-format.js";
import { visitArchiveMonth } from "./archive-selection.js";
import {
  ARCHIVE_STORAGE,
  archiveObjectKey,
  type ArchivePart,
  type ArchiveStorage,
} from "./archive-storage.js";
import { ArchiveWriter, type ArchiveResult } from "./archive-writer.js";

type Payload = { runId: string; generation: number; packageId?: string };
function payload(job: BackgroundJob): Payload {
  const value = job.payload;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.generation)
  )
    throw new Error("archive_payload_invalid");
  return value as unknown as Payload;
}
function failureCode(error: unknown) {
  if (
    error instanceof Error &&
    /^(archive_[a-z_]+|source_[a-z_]+)$/.test(error.message)
  )
    return error.message.slice(0, 100);
  if (error instanceof ConflictException) return "archive_state_changed";
  return "archive_generation_failed";
}

@Injectable()
export class ArchiveRuntimeService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly writer = new ArchiveWriter();
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(ARCHIVE_STORAGE) private readonly storage: ArchiveStorage | null,
  ) {}
  get enabled() {
    return this.environment.archiveExports.enabled && this.storage !== null;
  }
  onModuleInit() {
    if (!this.enabled) return;
    this.jobs.register(ARCHIVE_PREPARE, (job, signal) =>
      this.prepare(job, signal),
    );
    this.jobs.register(ARCHIVE_PACKAGE, (job, signal) =>
      this.generate(job, signal),
    );
    this.jobs.register(ARCHIVE_DELETE, (job, signal) =>
      this.deleteFiles(job, signal),
    );
    this.jobs.registerClaimGate(
      ARCHIVE_PACKAGE,
      async (job, tx, now, admission) => {
        const input = payload(job);
        const run = await tx.archiveExportRun.findUnique({
          where: { id: input.runId },
        });
        const pkg = await tx.archiveExportPackage.findUnique({
          where: { id: job.resourceId },
        });
        if (
          !run ||
          !pkg ||
          pkg.runId !== run.id ||
          run.generation !== input.generation ||
          run.status !== "generating" ||
          pkg.status === "succeeded"
        )
          return;
        // Physical settlement is independent of a job lease's expiry. A crashed
        // owner blocks admission until a recorded stopped-owner attestation.
        if (
          await tx.archiveExportAttempt.count({ where: { settledAt: null } })
        ) {
          await tx.archiveExportRun.update({
            where: { id: run.id },
            data: { error: "archive_owner_unsettled" },
          });
          return new JobDeferred(new Date(now.getTime() + 30_000), "capacity");
        }
        const id = randomUUID();
        await tx.archiveExportAttempt.create({
          data: {
            id,
            packageId: pkg.id,
            jobId: job.id,
            leaseId: admission.leaseId,
            ownerId: admission.ownerId,
            generation: input.generation,
            objectKey: archiveObjectKey({
              runId: run.id,
              packageId: pkg.id,
              attemptId: id,
            }),
            manifestHash: pkg.manifestHash,
          },
        });
      },
    );
    for (const kind of [ARCHIVE_PREPARE, ARCHIVE_PACKAGE, ARCHIVE_DELETE])
      this.jobs.registerExecutionLifecycle(kind, {
        run: (_job, action) => action(),
        business: async (tx, job, outcome, error) => {
          if (outcome !== "failed") return;
          if (kind === ARCHIVE_PREPARE)
            await tx.archiveExportRun.updateMany({
              where: {
                id: job.resourceId,
                generation: payload(job).generation,
                status: "preparing",
              },
              data: { error: failureCode(error) },
            });
          const current = await tx.backgroundJob.findUnique({
            where: { id: job.id },
          });
          if (current?.status !== "failed") return;
          if (kind === ARCHIVE_PACKAGE)
            await tx.archiveExportPackage.updateMany({
              where: {
                id: job.resourceId,
                status: { notIn: ["succeeded", "deleted", "cancelled"] },
              },
              data: { status: "failed", error: "archive_attempts_exhausted" },
            });
          if (kind === ARCHIVE_DELETE)
            await tx.archiveExportRun.updateMany({
              where: { id: job.resourceId, filesStatus: { not: "deleted" } },
              data: {
                filesStatus: "delete_failed",
                deletionError: "archive_cleanup_failed",
                revision: { increment: 1 },
              },
            });
        },
        settled: async (job) => {
          await this.db.$transaction(async (tx) => {
            await tx.archiveExportAttempt.updateMany({
              where: { jobId: job.id, leaseId: job.leaseId!, settledAt: null },
              data: { settledAt: new Date() },
            });
            await this.aggregate(tx, payload(job).runId);
          });
        },
      });
  }
  private async owned<T>(
    job: BackgroundJob,
    action: (tx: Prisma.TransactionClient, run: ArchiveExportRun) => Promise<T>,
    allowTerminal = false,
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await this.jobs.assertLease(tx, job);
        const input = payload(job);
        const run = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: input.runId },
        });
        if (!allowTerminal)
          await assertArchiveAdministrator(
            tx,
            job.actorId ?? run.actorId,
            this.environment,
          );
        await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${run.id}::uuid FOR UPDATE`;
        const current = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        if (
          current.generation !== input.generation ||
          (!allowTerminal &&
            (terminalArchiveStatuses.includes(current.status) ||
              current.status === "cancelling" ||
              current.deadlineAt <= new Date()))
        )
          throw new ConflictException("归档任务状态已变化");
        return action(tx, current);
      },
      { timeout: 30_000 },
    );
  }
  private async prepare(job: BackgroundJob, signal: AbortSignal) {
    const input = payload(job);
    await this.owned(job, async (tx, run) => {
      await tx.archiveExportRun.update({
        where: { id: run.id },
        data: { status: "preparing", error: null, revision: { increment: 1 } },
      });
    });
    const initial = await this.db.archiveExportRun.findUniqueOrThrow({
      where: { id: input.runId },
    });
    const scope: ArchiveExportScopeDto = {
      year: initial.year,
      month: initial.month,
      content: initial.content as ArchiveExportScopeDto["content"],
      includeArchived: initial.includeArchived,
      includeDiscarded: initial.includeDiscarded,
    };
    const months = initial.month
      ? [initial.month]
      : Array.from({ length: 12 }, (_, i) => i + 1);
    for (const [monthIndex, month] of months.entries()) {
      signal.throwIfAborted();
      if (
        !(await this.db.archiveExportMonth.count({
          where: { runId: initial.id, month },
        }))
      )
        await this.db.$transaction(
          async (tx) => {
            if (
              !(await tx.backgroundJob.count({
                where: {
                  id: job.id,
                  leaseId: job.leaseId,
                  status: "running",
                  leaseUntil: { gt: new Date() },
                },
              }))
            )
              throw new ConflictException("后台任务租约已变化");
            const run = await tx.archiveExportRun.findUniqueOrThrow({
              where: { id: initial.id },
            });
            if (
              run.generation !== input.generation ||
              run.status !== "preparing" ||
              run.deadlineAt <= new Date()
            )
              throw new ConflictException("归档任务状态已变化");
            if (
              await tx.archiveExportMonth.count({
                where: { runId: run.id, month },
              })
            )
              return;
            const monthId = randomUUID();
            await tx.archiveExportMonth.create({
              data: {
                id: monthId,
                runId: run.id,
                month,
                capturedAt: new Date(),
                manifestHash: archiveHash(""),
              },
            });
            const lastEntry = await tx.archiveExportEntry.aggregate({
              where: { runId: run.id },
              _max: { ordinal: true },
            });
            let ordinal = lastEntry._max.ordinal ?? 0;
            const previousBytes = await tx.$queryRaw<
              { bytes: bigint }[]
            >`SELECT COALESCE(sum(size+256+2*octet_length(path)),0)::bigint AS bytes FROM archive_export_entries WHERE run_id=${run.id}::uuid`;
            let capturedBytes = previousBytes[0].bytes;
            const hashes: string[] = [];
            await visitArchiveMonth(tx, scope, month, async (work) => {
              signal.throwIfAborted();
              if (Date.now() >= run.deadlineAt.getTime())
                throw new Error("archive_deadline_exceeded");
              const fileIds = [
                ...new Set(
                  work.entries.flatMap((e) =>
                    e.fileObjectId ? [e.fileObjectId] : [],
                  ),
                ),
              ].sort();
              if (fileIds.length) {
                await tx.$queryRaw(
                  Prisma.sql`SELECT id FROM file_objects WHERE id IN (${Prisma.join(fileIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
                );
                const live = await tx.fileObject.count({
                  where: {
                    id: { in: fileIds },
                    lifecycleStatus: "active",
                    deletedAt: null,
                  },
                });
                if (live !== fileIds.length)
                  throw new Error("archive_source_unavailable");
              }
              capturedBytes += work.entries.reduce(
                (sum, e) =>
                  sum + e.size + BigInt(256 + 2 * Buffer.byteLength(e.path)),
                0n,
              );
              if (
                capturedBytes >
                BigInt(this.environment.archiveExports.maxRunBytes)
              )
                throw new Error("archive_run_budget_exceeded");
              const snapshotId = randomUUID();
              const {
                entries,
                missingRendered: _missingRendered,
                failedText: _failedText,
                ...snapshot
              } = work;
              void _missingRendered;
              void _failedText;
              await tx.archiveExportWorkSnapshot.create({
                data: { id: snapshotId, runId: run.id, monthId, ...snapshot },
              });
              await tx.archiveExportEntry.createMany({
                data: entries.map((e) => ({
                  ...e,
                  sourceFileObjectId: e.fileObjectId,
                  ordinal: ++ordinal,
                  runId: run.id,
                  snapshotId,
                })),
              });
              hashes.push(
                archiveHash(
                  JSON.stringify(
                    entries.map((e) => [e.path, String(e.size), e.checksum]),
                  ),
                ),
              );
            });
            const otherCache = await tx.archiveExportRun.aggregate({
              where: { id: { not: run.id }, filesStatus: { not: "deleted" } },
              _sum: { estimatedBytes: true },
            });
            if (
              (otherCache._sum.estimatedBytes ?? 0n) + capturedBytes >
              BigInt(this.environment.archiveExports.maxCacheBytes)
            )
              throw new Error("archive_cache_budget_exceeded");
            // Staging an immutable month does not publish progress or external
            // objects. Do not lock the heartbeat row inside the MVCC snapshot:
            // heartbeats would otherwise force serialization failures. A short
            // separate owned transaction adopts the staged month below.
            await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${run.id}::uuid FOR UPDATE`;
            const current = await tx.archiveExportRun.findUniqueOrThrow({
              where: { id: run.id },
            });
            if (
              current.generation !== input.generation ||
              current.status !== "preparing" ||
              current.deadlineAt <= new Date()
            )
              throw new ConflictException("归档任务状态已变化");
            await tx.archiveExportMonth.update({
              where: { id: monthId },
              data: { manifestHash: archiveHash(hashes.join("\n")) },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            timeout: 120_000,
          },
        );
      await this.owned(job, async (tx, run) => {
        if (run.capturedMonthCount > monthIndex) return;
        if (run.capturedMonthCount !== monthIndex)
          throw new Error("archive_month_order_invalid");
        const captured = await tx.archiveExportMonth.findUniqueOrThrow({
          where: { runId_month: { runId: run.id, month } },
        });
        const stats = await tx.$queryRaw<
          {
            work_count: number;
            warning_count: number;
            failure_count: number;
            missing_count: number;
          }[]
        >`SELECT count(*)::int AS work_count,COALESCE(sum(jsonb_array_length(issues)),0)::int AS warning_count,count(*) FILTER (WHERE issues ? 'text_encoding_failed')::int AS failure_count,count(*) FILTER (WHERE issues ? 'missing_rendered')::int AS missing_count FROM archive_export_work_snapshots WHERE month_id=${captured.id}::uuid`;
        const entryStats = await tx.archiveExportEntry.groupBy({
          by: ["kind"],
          where: { snapshot: { monthId: captured.id } },
          _count: { _all: true },
        });
        const bytes = await tx.$queryRaw<
          { bytes: bigint }[]
        >`SELECT COALESCE(sum(size+256+2*octet_length(path)),0)::bigint AS bytes FROM archive_export_entries WHERE run_id=${run.id}::uuid`;
        const s = stats[0];
        await tx.archiveExportRun.update({
          where: { id: run.id },
          data: {
            workCount: { increment: s.work_count },
            imageCount: {
              increment: entryStats
                .filter((e) => e.kind === "raw" || e.kind === "rendered")
                .reduce((sum, e) => sum + e._count._all, 0),
            },
            textCount: {
              increment:
                entryStats.find((e) => e.kind === "text")?._count._all ?? 0,
            },
            warningCount: { increment: s.warning_count },
            failureCount: { increment: s.failure_count },
            missingRenderedCount: { increment: s.missing_count },
            capturedMonthCount: { increment: 1 },
            estimatedBytes: bytes[0].bytes,
            revision: { increment: 1 },
          },
        });
      });
    }
    signal.throwIfAborted();
    await this.plan(job);
  }
  private async plan(job: BackgroundJob) {
    const input = payload(job);
    await this.db.$transaction(
      async (tx) => {
        const run = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: input.runId },
        });
        if (run.generation !== input.generation || run.status !== "preparing")
          throw new ConflictException("归档任务状态已变化");
        if (run.packageCount) throw new Error("archive_plan_already_exists");
        type LightEntry = {
          id: string;
          path: string;
          size: bigint;
          checksum: string;
        };
        let current: LightEntry[] = [],
          ordinal = 0,
          cursor = 0;
        const flush = async (entries: LightEntry[]) => {
          if (!entries.length) return;
          const manifestHash = archiveHash(
            JSON.stringify(
              entries.map((e) => [e.path, String(e.size), e.checksum]),
            ),
          );
          const pkg = await tx.archiveExportPackage.create({
            data: {
              runId: run.id,
              ordinal: ++ordinal,
              fileName: `Comiku_${run.year}${run.month ? `-${String(run.month).padStart(2, "0")}` : ""}_${String(ordinal).padStart(3, "0")}.zip`,
              manifestHash,
              estimatedBytes: entries.reduce((sum, e) => sum + e.size, 0n),
            },
          });
          for (let i = 0; i < entries.length; i += 1000)
            await tx.archiveExportEntry.updateMany({
              where: {
                id: { in: entries.slice(i, i + 1000).map((e) => e.id) },
              },
              data: { packageId: pkg.id },
            });
          const queued = await this.jobs.enqueue(
            {
              kind: ARCHIVE_PACKAGE,
              resourceId: pkg.id,
              actorId: job.actorId ?? run.actorId,
              executionScope: ARCHIVE_SCOPE,
              idempotencyKey: `archive:package:${pkg.id}:${run.generation}`,
              payload: {
                runId: run.id,
                packageId: pkg.id,
                generation: run.generation,
              },
            },
            tx,
          );
          await tx.archiveExportPackage.update({
            where: { id: pkg.id },
            data: { jobId: queued.id },
          });
        };
        // Fetch one work group at a time; only the current <=20k-entry package is
        // retained. Annual text bodies are never loaded during package planning.
        for (;;) {
          const group = await tx.archiveExportEntry.findMany({
            where: { runId: run.id, ordinal: { gt: cursor } },
            orderBy: { ordinal: "asc" },
            take: 1,
            select: { snapshotId: true },
          });
          if (!group.length) break;
          const entries = await tx.archiveExportEntry.findMany({
            where: { runId: run.id, snapshotId: group[0].snapshotId },
            orderBy: { ordinal: "asc" },
            select: {
              id: true,
              path: true,
              size: true,
              checksum: true,
              ordinal: true,
            },
          });
          cursor = entries.at(-1)!.ordinal;
          const packages = planArchivePackages(
            [...current, ...entries].map((e) => ({ ...e, sha256: e.checksum })),
            BigInt(this.environment.archiveExports.packageTargetBytes),
            this.environment.archiveExports.maxEntriesPerPackage,
          );
          current = packages.pop() ?? [];
          for (const parts of packages) await flush(parts);
        }
        await flush(current);
        await this.jobs.assertLease(tx, job);
        await assertArchiveAdministrator(
          tx,
          job.actorId ?? run.actorId,
          this.environment,
        );
        await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${run.id}::uuid FOR UPDATE`;
        const latest = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        if (
          latest.generation !== input.generation ||
          latest.status !== "preparing" ||
          latest.deadlineAt <= new Date()
        )
          throw new ConflictException("归档任务状态已变化");
        await tx.archiveExportRun.update({
          where: { id: run.id },
          data: {
            status: "generating",
            packageCount: ordinal,
            error: null,
            revision: { increment: 1 },
          },
        });
      },
      { timeout: 120_000 },
    );
  }
  private async generate(job: BackgroundJob, signal: AbortSignal) {
    const input = payload(job);
    const attempt = await this.db.archiveExportAttempt.findUnique({
      where: { jobId_leaseId: { jobId: job.id, leaseId: job.leaseId! } },
    });
    if (!attempt) return;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.controllers.set(input.runId, controller);
    let bandwidth = 0,
      polling = false;
    const check = async () => {
      if (polling) return;
      polling = true;
      try {
        await this.owned(job, async (tx, run) => {
          bandwidth =
            (
              await tx.archiveExportSettings.findUnique({
                where: { id: "global" },
              })
            )?.bandwidthLimitMiB ?? 0;
          if (run.status !== "generating") throw new Error("archive_cancelled");
        });
      } catch (error) {
        controller.abort(error);
      } finally {
        polling = false;
      }
    };
    await check();
    const timer = setInterval(() => {
      void check();
    }, 1000);
    const parts: ArchivePart[] = [];
    try {
      combined.throwIfAborted();
      const previous = await this.db.archiveExportAttempt.findMany({
        where: {
          packageId: attempt.packageId,
          id: { not: attempt.id },
          settledAt: { not: null },
        },
        orderBy: { startedAt: "asc" },
      });
      for (const old of previous) {
        if (old.completeIntent && (await this.reconcileAndAdopt(job, old))) {
          await this.markUnusedAttempt(attempt.id);
          return;
        }
        if (old.cleanupStatus !== "deleted") await this.cleanupAttempt(old);
      }
      const entries = await this.db.archiveExportEntry.findMany({
        where: { packageId: attempt.packageId },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          path: true,
          size: true,
          checksum: true,
          sourceKey: true,
          fileObjectId: true,
        },
      });
      const manifestHash = archiveHash(
        JSON.stringify(
          entries.map((e) => [e.path, String(e.size), e.checksum]),
        ),
      );
      if (
        manifestHash !== attempt.manifestHash ||
        entries.some((e) => e.sourceKey && !e.fileObjectId)
      )
        throw new Error("archive_snapshot_invalid");
      await this.owned(job, async (tx) => {
        await tx.archiveExportPackage.update({
          where: { id: attempt.packageId },
          data: { status: "generating", error: null },
        });
      });
      const result = await this.writer.write({
        entries: entries.map((e) => ({
          path: e.path,
          size: e.size,
          sha256: e.checksum,
          ...(e.sourceKey
            ? { sourceKey: e.sourceKey }
            : {
                openContent: async (contentSignal: AbortSignal) => {
                  contentSignal.throwIfAborted();
                  const stored =
                    await this.db.archiveExportEntry.findUniqueOrThrow({
                      where: { id: e.id },
                      select: { contentText: true },
                    });
                  contentSignal.throwIfAborted();
                  if (stored.contentText === null)
                    throw new Error("archive_snapshot_invalid");
                  return addAbortSignal(
                    contentSignal,
                    Readable.from([Buffer.from(stored.contentText)]),
                  );
                },
              }),
        })),
        storage: this.storage!,
        key: attempt.objectKey,
        identity: {
          runId: input.runId,
          packageId: attempt.packageId,
          attemptId: attempt.id,
        },
        signal: combined,
        getRateMiB: () => bandwidth,
        partSizeBytes: this.environment.archiveExports.partSizeBytes,
        uploadConcurrency: this.environment.archiveExports.uploadConcurrency,
        maxBytes: BigInt(this.environment.archiveExports.maxRunBytes),
        onUploadCreated: async (uploadId) => {
          await this.owned(job, async (tx) => {
            await tx.archiveExportAttempt.update({
              where: { id: attempt.id },
              data: { uploadId },
            });
          });
        },
        onPartUploaded: async (part) => {
          parts.push(part);
          await this.owned(job, async (tx) => {
            await tx.archiveExportAttempt.update({
              where: { id: attempt.id },
              data: { parts: parts as unknown as Prisma.InputJsonValue },
            });
          });
        },
        onCompleteIntent: async (result) => {
          await this.owned(job, async (tx) => {
            await tx.archiveExportAttempt.update({
              where: { id: attempt.id },
              data: {
                completeIntent: true,
                uploadId: result.uploadId,
                expectedBytes: result.bytes,
                expectedChecksum: result.sha256,
                parts: result.parts as unknown as Prisma.InputJsonValue,
              },
            });
          });
        },
      });
      await this.adopt(job, attempt, result);
    } catch (error) {
      const latest = await this.db.archiveExportAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      // A database commit reply can be lost after adoption. Current authority or
      // lease may already have changed, so an adoption retry is not a reliable
      // test for whether the object is retained. Check the durable package link.
      if (await this.isAdopted(latest)) return;
      if (latest.completeIntent) {
        try {
          if (await this.reconcileAndAdopt(job, latest)) return;
        } catch {
          /* Preserve durable intent for a later owned recovery. */
        }
      }
      let cleanupError = false;
      try {
        await this.cleanupAttempt(latest);
      } catch {
        cleanupError = true;
      }
      await this.db.archiveExportAttempt.updateMany({
        where: { id: attempt.id, status: { not: "succeeded" } },
        data: {
          status: "failed",
          error: failureCode(error),
          ...(cleanupError
            ? {
                cleanupStatus: "delete_failed",
                cleanupError: "archive_cleanup_failed",
              }
            : {}),
        },
      });
      try {
        await this.owned(job, async (tx) => {
          await tx.archiveExportPackage.updateMany({
            where: { id: attempt.packageId, status: { not: "succeeded" } },
            data: { status: "failed", error: failureCode(error) },
          });
        });
      } catch {
        /* A replacement owner owns business state. */
      }
      throw error;
    } finally {
      clearInterval(timer);
      this.controllers.delete(input.runId);
      // Await an already-running control/permission read before lifecycle settlement.
      while (polling) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  private async markUnusedAttempt(id: string) {
    await this.db.archiveExportAttempt.update({
      where: { id },
      data: { status: "unused", cleanupStatus: "deleted" },
    });
  }
  private async reconcileAndAdopt(
    job: BackgroundJob,
    attempt: ArchiveExportAttempt,
  ) {
    if (
      !attempt.completeIntent ||
      attempt.expectedBytes === null ||
      !attempt.expectedChecksum
    )
      return false;
    const head = await this.storage!.head(attempt.objectKey);
    if (!head) return false;
    const input = payload(job);
    if (
      head.identity.runId !== input.runId ||
      head.identity.packageId !== attempt.packageId ||
      head.identity.attemptId !== attempt.id ||
      head.bytes !== attempt.expectedBytes
    )
      throw new Error("archive_receipt_mismatch");
    await this.adopt(job, attempt, {
      bytes: attempt.expectedBytes,
      sha256: attempt.expectedChecksum,
      uploadId: attempt.uploadId ?? "",
      parts: [],
    });
    return true;
  }
  private async adopt(
    job: BackgroundJob,
    attempt: ArchiveExportAttempt,
    result: ArchiveResult,
  ) {
    await this.owned(job, async (tx, run) => {
      const pkg = await tx.archiveExportPackage.findUniqueOrThrow({
        where: { id: attempt.packageId },
      });
      if (pkg.status === "succeeded") return;
      if (pkg.manifestHash !== attempt.manifestHash)
        throw new Error("archive_snapshot_invalid");
      const persisted = await tx.archiveExportAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      if (
        !persisted.completeIntent ||
        persisted.expectedBytes !== result.bytes ||
        persisted.expectedChecksum !== result.sha256
      )
        throw new Error("archive_receipt_mismatch");
      const file = await tx.fileObject.create({
        data: {
          objectKey: attempt.objectKey,
          bucketScope: "archive",
          kind: "archive-export",
          contentType: "application/zip",
          size: result.bytes,
          checksum: result.sha256,
          createdById: run.actorId,
        },
      });
      await tx.archiveExportPackage.update({
        where: { id: pkg.id },
        data: {
          status: "succeeded",
          bytes: result.bytes,
          checksum: result.sha256,
          fileObjectId: file.id,
          adoptedAttemptId: attempt.id,
          error: null,
          completedAt: new Date(),
        },
      });
      await tx.archiveExportAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "succeeded",
          cleanupStatus: "retained",
          completedAt: new Date(),
          error: null,
        },
      });
      await tx.archiveExportRun.update({
        where: { id: run.id },
        data: {
          completedPackageCount: { increment: 1 },
          completedBytes: { increment: result.bytes },
          error: null,
          revision: { increment: 1 },
        },
      });
    });
  }
  private async isAdopted(attempt: ArchiveExportAttempt) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM archive_export_packages WHERE id=${attempt.packageId}::uuid FOR UPDATE`;
      const pkg = await tx.archiveExportPackage.findUnique({
        where: { id: attempt.packageId },
        select: { adoptedAttemptId: true, fileObjectId: true },
      });
      return pkg?.adoptedAttemptId === attempt.id && pkg.fileObjectId !== null;
    });
  }
  private async cleanupAttempt(
    attempt: ArchiveExportAttempt,
    deleteAdopted = false,
  ) {
    // The unsuccessful execution path may clean only an unadopted attempt.
    // Physical settlement gates prevent a new owner from adopting this attempt
    // after this short lock is released. Explicit run deletion is separate.
    if (!deleteAdopted && (await this.isAdopted(attempt))) return;
    try {
      // Exact per-attempt keys also cover CreateMultipart's lost DB receipt.
      const uploads = await this.storage!.listMultipart(attempt.objectKey);
      for (const upload of uploads)
        await this.storage!.abortMultipart(attempt.objectKey, upload.uploadId);
      await this.storage!.delete(attempt.objectKey);
      await this.db.archiveExportAttempt.update({
        where: { id: attempt.id },
        data: { cleanupStatus: "deleted", cleanupError: null },
      });
    } catch (error) {
      await this.db.archiveExportAttempt.update({
        where: { id: attempt.id },
        data: {
          cleanupStatus: "delete_failed",
          cleanupError: "archive_cleanup_failed",
        },
      });
      throw error;
    }
  }
  private async deleteFiles(job: BackgroundJob, signal: AbortSignal) {
    const run = await this.owned(
      job,
      async (tx, row) => {
        if (!terminalArchiveStatuses.includes(row.status))
          throw new ConflictException("归档任务尚未结束");
        if (
          await tx.archiveExportAttempt.count({
            where: { package: { runId: row.id }, settledAt: null },
          })
        )
          throw new ConflictException("旧执行尚未确认停止");
        if (row.filesStatus !== "deleted")
          await tx.archiveExportRun.update({
            where: { id: row.id },
            data: { filesStatus: "deleting", deletionError: null },
          });
        return row;
      },
      true,
    );
    if (run.filesStatus === "deleted") return;
    try {
      let cursor: string | undefined;
      for (;;) {
        const attempts = await this.db.archiveExportAttempt.findMany({
          where: {
            package: { runId: run.id },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: "asc" },
          take: 20,
        });
        if (!attempts.length) break;
        for (const attempt of attempts) {
          signal.throwIfAborted();
          if (attempt.cleanupStatus !== "deleted")
            await this.cleanupAttempt(attempt, true);
        }
        cursor = attempts.at(-1)!.id;
      }
      await this.owned(
        job,
        async (tx) => {
          const packages = await tx.archiveExportPackage.findMany({
            where: { runId: run.id, fileObjectId: { not: null } },
            select: { fileObjectId: true },
          });
          await tx.archiveExportPackage.updateMany({
            where: { runId: run.id },
            data: { fileObjectId: null, status: "deleted" },
          });
          await tx.fileObject.updateMany({
            where: {
              id: {
                in: packages.flatMap((p) =>
                  p.fileObjectId ? [p.fileObjectId] : [],
                ),
              },
            },
            data: { lifecycleStatus: "deleted", deletedAt: new Date() },
          });
          await tx.archiveExportEntry.updateMany({
            where: { runId: run.id, fileObjectId: { not: null } },
            data: { fileObjectId: null },
          });
          await tx.archiveExportRun.update({
            where: { id: run.id },
            data: {
              filesStatus: "deleted",
              filesDeletedAt: new Date(),
              deletionError: null,
              revision: { increment: 1 },
            },
          });
        },
        true,
      );
    } catch (error) {
      try {
        await this.owned(
          job,
          async (tx) => {
            await tx.archiveExportRun.updateMany({
              where: { id: run.id, filesStatus: { not: "deleted" } },
              data: {
                filesStatus: "delete_failed",
                deletionError: "archive_cleanup_failed",
                revision: { increment: 1 },
              },
            });
          },
          true,
        );
      } catch {
        /* Keep whichever owner's durable state won. */
      }
      throw error;
    }
  }
  private async aggregate(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${id}::uuid FOR UPDATE`;
    const run = await tx.archiveExportRun.findUnique({ where: { id } });
    if (!run || terminalArchiveStatuses.includes(run.status)) return;
    if (
      await tx.archiveExportAttempt.count({
        where: { package: { runId: id }, settledAt: null },
      })
    )
      return;
    const jobs = await tx.backgroundJob.count({
      where: {
        executionScope: ARCHIVE_SCOPE,
        status: { in: ["queued", "running"] },
        OR: [
          { resourceId: id },
          {
            resourceId: {
              in: (
                await tx.archiveExportPackage.findMany({
                  where: { runId: id },
                  select: { id: true },
                })
              ).map((p) => p.id),
            },
          },
        ],
      },
    });
    if (jobs) return;
    const now = new Date();
    const status =
      run.status === "cancelling"
        ? "cancelled"
        : run.capturedMonthCount !== (run.month ? 1 : 12)
          ? "failed"
          : run.completedPackageCount === run.packageCount && !run.failureCount
            ? "succeeded"
            : run.completedPackageCount || run.failureCount
              ? "partial"
              : "failed";
    await tx.archiveExportRun.update({
      where: { id },
      data: {
        status,
        completedAt: now,
        expiresAt: new Date(
          now.getTime() +
            this.environment.archiveExports.retentionDays * 86_400_000,
        ),
        ...(status === "failed"
          ? { error: run.error ?? "archive_generation_failed" }
          : {}),
        revision: { increment: 1 },
      },
    });
    if (status === "cancelled")
      await tx.archiveExportPackage.updateMany({
        where: { runId: id, status: { not: "succeeded" } },
        data: { status: "cancelled" },
      });
  }
  async maintain() {
    if (!this.enabled) return;
    const active = await this.db.archiveExportRun.findMany({
      where: { status: { notIn: terminalArchiveStatuses } },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const run of active) {
      await this.db.$transaction(async (tx) => {
        await this.jobs.lockScope(tx, "heavy", ARCHIVE_SCOPE);
        await tx.$queryRaw`SELECT j.id FROM background_jobs j WHERE j.execution_scope=${ARCHIVE_SCOPE} AND (j.resource_id=${run.id}::uuid OR j.resource_id IN (SELECT id FROM archive_export_packages WHERE run_id=${run.id}::uuid)) ORDER BY j.id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${run.id}::uuid FOR UPDATE`;
        const current = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        if (terminalArchiveStatuses.includes(current.status)) return;
        if (
          current.status === "cancelling" ||
          current.deadlineAt <= new Date()
        ) {
          this.controllers.get(run.id)?.abort(new Error("archive_cancelled"));
          const packageIds = (
            await tx.archiveExportPackage.findMany({
              where: { runId: run.id },
              select: { id: true },
            })
          ).map((p) => p.id);
          await tx.backgroundJob.updateMany({
            where: {
              executionScope: ARCHIVE_SCOPE,
              status: "queued",
              OR: [{ resourceId: run.id }, { resourceId: { in: packageIds } }],
            },
            data: {
              status: "failed",
              completedAt: new Date(),
              lastError: "archive_cancelled",
            },
          });
          await tx.archiveExportRun.updateMany({
            where: { id: run.id, status: { notIn: terminalArchiveStatuses } },
            data: {
              status: "cancelling",
              ...(current.deadlineAt <= new Date()
                ? { error: "archive_deadline_exceeded" }
                : {}),
            },
          });
        }
        const unknown = await tx.archiveExportAttempt.findFirst({
          where: { package: { runId: run.id }, settledAt: null },
          select: { jobId: true, leaseId: true },
        });
        if (
          unknown &&
          !(await tx.backgroundJob.count({
            where: {
              id: unknown.jobId,
              leaseId: unknown.leaseId,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          }))
        )
          await tx.archiveExportRun.updateMany({
            where: { id: run.id, status: { notIn: terminalArchiveStatuses } },
            data: { error: "archive_owner_unsettled" },
          });
        await this.aggregate(tx, run.id);
      });
    }
    const expired = await this.db.archiveExportRun.findMany({
      where: {
        status: { in: terminalArchiveStatuses },
        filesStatus: { in: ["available", "delete_failed"] },
        expiresAt: { lte: new Date() },
      },
      orderBy: { expiresAt: "asc" },
      take: 20,
    });
    for (const run of expired)
      await this.db.$transaction(async (tx) => {
        await this.jobs.lockScope(tx, "heavy", ARCHIVE_SCOPE);
        await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${run.id}::uuid FOR UPDATE`;
        const current = await tx.archiveExportRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        if (
          !terminalArchiveStatuses.includes(current.status) ||
          !current.expiresAt ||
          current.expiresAt > new Date()
        )
          return;
        if (
          current.filesStatus === "deleting" ||
          current.filesStatus === "deleted"
        )
          return;
        if (
          await tx.backgroundJob.count({
            where: {
              kind: ARCHIVE_DELETE,
              resourceId: run.id,
              status: { in: ["queued", "running"] },
            },
          })
        )
          return;
        if (
          await tx.archiveExportAttempt.count({
            where: { package: { runId: run.id }, settledAt: null },
          })
        )
          return;
        await this.jobs.enqueue(
          {
            kind: ARCHIVE_DELETE,
            resourceId: run.id,
            executionScope: ARCHIVE_SCOPE,
            idempotencyKey: `archive:expiry:${run.id}:${current.revision}`,
            payload: { runId: run.id, generation: current.generation },
          },
          tx,
        );
        await tx.archiveExportRun.update({
          where: { id: run.id },
          data: { filesStatus: "deleting", revision: { increment: 1 } },
        });
      });
  }
  /** Called only after an operator has independently stopped this physical owner.
   * A lease timestamp or missing heartbeat is never sufficient evidence. */
  async attestStoppedOwner(
    ownerId: string,
    actorId: string,
    confirmation: "owner_process_stopped",
  ) {
    if (confirmation !== "owner_process_stopped")
      throw new Error("Explicit stopped-owner confirmation required");
    await this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actorId, this.environment);
      await this.jobs.lockScope(tx, "heavy", ARCHIVE_SCOPE);
      const attempts = await tx.archiveExportAttempt.findMany({
        where: { ownerId, settledAt: null },
        select: { id: true, jobId: true },
      });
      const ids = attempts.map((a) => a.jobId).sort();
      if (ids.length)
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM background_jobs WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
        );
      if (
        ids.length &&
        (await tx.backgroundJob.count({
          where: {
            id: { in: ids },
            status: "running",
            leaseUntil: { gt: new Date() },
          },
        }))
      )
        throw new ConflictException(
          "仍存在有效执行租约，请停止进程后等待租约到期",
        );
      await tx.archiveExportAttempt.updateMany({
        where: { ownerId, settledAt: null },
        data: {
          settledAt: new Date(),
          error: "archive_operator_confirmed_stopped",
        },
      });
      await tx.accountAudit.create({
        data: {
          actorId,
          action: "archive.owner-stopped",
          detail: { ownerId, attemptCount: attempts.length, confirmation },
        },
      });
    });
  }
}
