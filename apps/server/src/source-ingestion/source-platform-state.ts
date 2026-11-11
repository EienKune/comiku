import { permissionsFor, type Permission } from "../common/access.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ConflictException } from "@nestjs/common";
import type { Environment } from "../config/environment.js";
import type { PrismaService } from "../database/prisma.service.js";
import type {
  BackgroundJob,
  Prisma,
  SourcePlatformState,
} from "../generated/prisma/client.js";
import {
  JOB_LEASE_MS,
  JobDeferred,
  type JobAdmissionContext,
  type JobsService,
} from "../jobs/jobs.service.js";
import { jsonObject, SourceResponseError } from "./source-response.js";
import { SourceExecutions } from "./source-executions.js";

export interface MaintenanceExpectation {
  expectedEpoch: number;
  expectedGeneration: string;
}
const unresolvedPhases = ["preparing", "prepared", "promoted", "blocked"];
export const SOURCE_PROFILE_HEARTBEAT_MS = 15_000;
export const SOURCE_PROFILE_MAX_EXECUTION_MS = 120_000;

/** Hash bounded local material on every claim/network boundary; never expose material. */
export async function credentialFingerprint(
  platform: string,
  config: Environment["galleryDl"],
): Promise<string | null> {
  const path =
    platform === "x"
      ? config?.xConfigPath
      : platform === "pixiv"
        ? config?.pixivConfigPath
        : undefined;
  if (!config || !path) return null;
  try {
    const hash = createHash("sha256").update(
      JSON.stringify(["gallery-dl", platform, config.python, resolve(path)]),
    );
    let totalBytes = 0;
    const read = async (file: string) => {
      if ((await stat(file)).size > 1024 * 1024)
        throw new Error("Configuration too large");
      const bytes = await readFile(file);
      if (bytes.length > 1024 * 1024)
        throw new Error("Configuration too large");
      totalBytes += bytes.length;
      if (totalBytes > 4 * 1024 * 1024)
        throw new Error("Credential material exceeds aggregate limit");
      return bytes;
    };
    const bytes = await read(path);
    hash.update(bytes);
    let count = 0;
    const visit = async (value: unknown, depth = 0): Promise<void> => {
      if (depth > 12) throw new Error("Configuration nesting exceeds limit");
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (++count > 10000) throw new Error("Configuration exceeds limit");
        if (key === "cookies" && typeof entry === "string") {
          if (!isAbsolute(entry) || /[$%]/.test(entry))
            throw new Error("Cookie paths must be absolute literal paths");
          const file = resolve(entry);
          hash.update(file).update(await read(file));
        } else if (key === "cookies-from-browser" && entry) {
          // Browser profiles are mutable external stores without a reproducible material snapshot.
          throw new Error(
            "Export browser cookies to a controlled file before activation",
          );
        } else await visit(entry, depth + 1);
      }
    };
    await visit(JSON.parse(bytes.toString("utf8")));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export function platformFailure(
  error: unknown,
  now: Date,
): Pick<SourcePlatformState, "status" | "errorCode" | "cooldownUntil"> | null {
  if (
    !(error instanceof SourceResponseError) ||
    error.details?.scope !== "credential"
  )
    return null;
  const { reason, diagnostic } = error.details;
  if (
    ["auth_failed", "challenge_required", "request_http_401"].includes(reason)
  )
    return { status: "auth_paused", errorCode: reason, cooldownUntil: null };
  if (!["rate_limited", "request_http_429"].includes(reason)) return null;
  const rawHeaders = jsonObject(diagnostic)?.http_response_headers;
  let headers = jsonObject(rawHeaders);
  if (typeof rawHeaders === "string") {
    try {
      headers = jsonObject(JSON.parse(rawHeaders));
    } catch {
      /* Ignore malformed diagnostic header JSON. */
    }
  }
  const retry = headers?.["retry-after"];
  let delay = 15 * 60_000;
  if (typeof retry === "string" && /^\d+$/.test(retry))
    delay = Number(retry) * 1000;
  else if (typeof retry === "string" && Number.isFinite(Date.parse(retry)))
    delay = Date.parse(retry) - now.getTime();
  if (!Number.isFinite(delay) || delay < 0) delay = 15 * 60_000;
  return {
    status: "cooling_down",
    errorCode: "rate_limited",
    cooldownUntil: new Date(
      now.getTime() + Math.min(86400000, Math.max(5000, delay)),
    ),
  };
}

export class SourceConfigurationMismatch extends Error {
  constructor() {
    super("Local source configuration does not match the active generation");
  }
}

export class SourcePlatformStates {
  readonly executions: SourceExecutions;
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
    private readonly environment: Environment,
  ) {
    this.executions = new SourceExecutions(db, jobs?.ownerId ?? randomUUID());
  }
  async fingerprint(platform: string) {
    return credentialFingerprint(platform, this.environment.galleryDl);
  }
  async lock(tx: Prisma.TransactionClient, platform: string) {
    await tx.$queryRaw`SELECT platform FROM source_platform_states WHERE platform = ${platform} FOR UPDATE`;
  }
  async actor(
    tx: Prisma.TransactionClient,
    actorId: string | null,
    permission: Permission = "candidates:manage",
  ) {
    if (!actorId) return;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`;
    const user = await tx.user.findUnique({
      where: { id: actorId },
      include: { roles: { select: { role: true } } },
    });
    if (
      !user?.isActive ||
      !permissionsFor(
        user.roles.map((entry) => entry.role),
        user.mustChangePassword,
      ).includes(permission)
    )
      throw new ConflictException("Source actor unavailable");
  }
  async drained(
    tx: Prisma.TransactionClient,
    platform: string,
    now: Date,
    excludeJobId?: string,
  ) {
    // Scope barrier precedes any platform row locks; do not lock jobs under platform.
    const live = await tx.backgroundJob.count({
      where: {
        id: excludeJobId ? { not: excludeJobId } : undefined,
        kind: {
          in: [
            "source_fetch",
            "source_account_fetch",
            "source_post_recover",
            "source_profile_resolve",
          ],
        },
        status: "running",
        leaseUntil: { gt: now },
        OR: [
          { executionScope: "global" },
          { executionScope: `source:${platform}` },
        ],
      },
    });
    const accounts = await tx.sourceAccountScanState.count({
      where: { leaseUntil: { gt: now }, account: { platform } },
    });
    const adapters = await tx.sourceAdapterState.count({
      where: { fetchLeaseUntil: { gt: now }, externalAccount: { platform } },
    });
    return live === 0 && accounts === 0 && adapters === 0;
  }
  async claim(
    job: BackgroundJob,
    tx: Prisma.TransactionClient,
    now: Date,
    binding?: {
      platform: string;
      completedAt: Date | null;
      waiting: (deferred: JobDeferred) => Promise<unknown>;
      running: (generation: string) => Promise<unknown>;
    },
    admission?: JobAdmissionContext,
  ): Promise<void | JobDeferred> {
    const task = binding
      ? null
      : await tx.sourceFetchAccountTask.findUnique({
          where: { id: job.resourceId },
        });
    if (
      (!binding && (!task || task.jobId !== job.id)) ||
      job.executionScope !== `source:${binding?.platform ?? task?.platform}`
    )
      throw new ConflictException("Invalid source task");
    const platform = binding?.platform ?? task!.platform;
    if (binding?.completedAt || task?.completedAt) return;
    if (job.actorId)
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${job.actorId}::uuid FOR SHARE`;
    if (
      job.actorId &&
      !(await tx.user.count({
        where: {
          id: job.actorId,
          isActive: true,
          mustChangePassword: false,
          roles: { some: { role: { in: ["admin", "source"] } } },
        },
      }))
    ) {
      // Revocation is terminal business failure, not a credential wait. The handler
      // checks it first and settles this target without network work.
      await tx.backgroundJob.update({
        where: { id: job.id },
        data: {
          payload: {
            platform: platform,
            credentialGeneration: "actor_unavailable",
          },
        },
      });
      return;
    }

    // Claims already hold platform scope. A global barrier prevents old code claiming concurrently.
    await this.jobs.lockScope(tx, "network", "global");
    let state = await tx.sourcePlatformState.findUnique({
      where: { platform: platform },
    });
    // A closed maintenance gate never needs to reread material that an explicit
    // credential operation may currently be promoting under that same gate.
    const generation = state?.maintenancePaused
      ? state.credentialGeneration
      : await this.fingerprint(platform);
    // A local mismatch must roll back the claim, not postpone work for healthy peers.
    if (!generation || (state && state.credentialGeneration !== generation))
      throw new SourceConfigurationMismatch();
    if (
      !state &&
      generation &&
      (await this.drained(tx, platform, now, job.id))
    ) {
      await tx.sourcePlatformState.createMany({
        data: { platform: platform, credentialGeneration: generation },
        skipDuplicates: true,
      });
    }
    await this.lock(tx, platform);
    state = await tx.sourcePlatformState.findUnique({
      where: { platform: platform },
    });
    const legacy = await tx.backgroundJob.count({
      where: {
        kind: "source_fetch",
        status: "running",
        leaseUntil: { gt: now },
      },
    });
    const deferred =
      legacy || !state
        ? new JobDeferred(new Date(now.getTime() + 60000), "capacity")
        : this.denial(state, generation, now);
    if (deferred) {
      if (binding) await binding.waiting(deferred);
      else
        await tx.sourceFetchAccountTask.update({
          where: { id: task!.id },
          data: {
            status: "waiting",
            deferredUntil: deferred.retryAt,
            failureCode: deferred.reason,
          },
        });
      return deferred;
    }
    if (binding) await binding.running(generation!);
    else
      await tx.sourceFetchAccountTask.update({
        where: { id: task!.id },
        data: {
          status: "running",
          credentialGeneration: generation,
          startedAt: task!.startedAt ?? now,
          deferredUntil: null,
          failureCode: null,
        },
      });
    await tx.backgroundJob.update({
      where: { id: job.id },
      data: {
        payload: { credentialGeneration: generation!, platform: platform },
      },
    });
    if (!admission)
      throw new Error("Source claim requires atomic lease admission");
    await this.executions.admit(tx, {
      platform,
      kind: binding ? "recovery" : "scan",
      jobId: job.id,
      leaseId: admission.leaseId,
      budgetAttempt: admission.budgetAttempt,
      credentialGeneration: generation!,
      ...(binding ? { campaignId: job.resourceId } : { taskId: task!.id }),
    });
  }
  denial(
    state: SourcePlatformState | null,
    generation: string | null,
    now = new Date(),
    maintenanceAdmission = true,
  ): JobDeferred | null {
    if (maintenanceAdmission && state?.maintenancePaused)
      return new JobDeferred(
        new Date(now.getTime() + 60000),
        "platform_maintenance",
      );
    if (!generation || !state || state.credentialGeneration !== generation)
      return new JobDeferred(
        new Date(now.getTime() + 300000),
        "credential_unavailable",
      );
    if (state.status === "auth_paused")
      return new JobDeferred(new Date(now.getTime() + 900000), "scope_paused");
    if (state.cooldownUntil && state.cooldownUntil > now)
      return new JobDeferred(state.cooldownUntil, "platform_cooldown");
    return null;
  }
  async beforeNetwork(platform: string, generation: string) {
    const actual = await this.fingerprint(platform);
    const state = await this.db.sourcePlatformState.findUnique({
      where: { platform },
    });
    const deferred = this.denial(
      state,
      actual === generation ? actual : null,
      new Date(),
      false,
    );
    if (deferred) throw deferred;
  }
  /** One interactive metadata call may overlap the platform's one collection job. */
  async profileNetwork<T>(
    actorId: string,
    run: () => Promise<T>,
    platform: "x" | "pixiv" = "x",
    maintenance?: MaintenanceExpectation & { operationId?: string },
  ): Promise<T> {
    const label = platform === "x" ? "X" : "Pixiv",
      leaseId = randomUUID(),
      id = randomUUID();
    const generation = await this.fingerprint(platform);
    if (!generation) throw new ConflictException(`${label} 资料同步配置不可用`);
    let renewalDeadline = 0;
    await this.db.$transaction(async (tx) => {
      await this.jobs.lockScope(tx, "network", `source:${platform}`);
      await this.jobs.lockScope(tx, "network", "global");
      await this.actor(tx, actorId, "authors:manage");
      if (maintenance)
        await this.assertMaintenance(
          tx,
          platform,
          maintenance,
          actorId,
          maintenance.operationId,
        );
      const now = new Date();
      renewalDeadline = now.getTime() + SOURCE_PROFILE_MAX_EXECUTION_MS;
      if (
        await tx.backgroundJob.count({
          where: {
            lane: "network",
            status: "running",
            leaseUntil: { gt: now },
            OR: [
              { executionScope: "global" },
              {
                executionScope: `source:${platform}`,
                kind: "source_profile_resolve",
              },
            ],
          },
        })
      )
        throw new ConflictException(`${label} 资料同步正在运行，请稍后再试`);
      let state = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      if (!state) {
        if (!(await this.drained(tx, platform, now)))
          throw new ConflictException(`${label} 同步状态尚未就绪，请稍后再试`);
        await tx.sourcePlatformState.createMany({
          data: { platform, credentialGeneration: generation },
          skipDuplicates: true,
        });
        state = await tx.sourcePlatformState.findUnique({
          where: { platform },
        });
      }
      if (this.denial(state, generation, now, !maintenance))
        throw new ConflictException(
          `${label} 资料同步已暂停或处于冷却，请等待管理员恢复`,
        );
      await tx.backgroundJob.create({
        data: {
          id,
          resourceId: id,
          kind: "source_profile_resolve",
          actorId,
          idempotencyKey: `source-profile:${id}`,
          lane: "network",
          executionScope: `source:${platform}`,
          status: "running",
          leaseId,
          leaseUntil: new Date(now.getTime() + JOB_LEASE_MS),
          startedAt: now,
          attempts: 1,
          payload: { platform, credentialGeneration: generation },
        },
      });
      await this.executions.admit(tx, {
        platform,
        kind: maintenance ? "credential_validation" : "profile",
        jobId: id,
        leaseId,
        budgetAttempt: 1,
        credentialGeneration: generation,
      });
    });
    return this.executions.run({ id, leaseId }, async () => {
      let heartbeatPending: Promise<void> | null = null;
      let heartbeatStopped = false;
      const stopHeartbeat = () => {
        heartbeatStopped = true;
        clearInterval(heartbeat);
      };
      const heartbeat = setInterval(() => {
        if (heartbeatStopped || heartbeatPending) return;
        heartbeatPending = this.db
          .$transaction(async (tx) => {
            // Sample time after the row lock: an update blocked behind another
            // writer must not resurrect a lease that expired during that wait.
            await tx.$queryRaw`SELECT id FROM background_jobs WHERE id=${id}::uuid FOR UPDATE`;
            const now = new Date();
            if (now.getTime() >= renewalDeadline) return true;
            const until = new Date(
              Math.min(now.getTime() + JOB_LEASE_MS, renewalDeadline),
            );
            const { count } = await tx.backgroundJob.updateMany({
              where: {
                id,
                status: "running",
                leaseId,
                leaseUntil: { gt: now },
              },
              data: { leaseUntil: until },
            });
            return !count || until.getTime() === renewalDeadline;
          })
          .then((stop) => {
            if (stop) stopHeartbeat();
          })
          .catch(() => stopHeartbeat())
          .finally(() => {
            heartbeatPending = null;
          });
      }, SOURCE_PROFILE_HEARTBEAT_MS);
      let failure: unknown,
        failed = false,
        result: T | undefined;
      try {
        await this.beforeNetwork(platform, generation);
        result = await run();
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        stopHeartbeat();
        await heartbeatPending;
      }
      const finished = await this.db.$transaction(async (tx) => {
        await this.jobs.lockScope(tx, "network", `source:${platform}`);
        const changed = await tx.backgroundJob.updateMany({
          where: {
            id,
            status: "running",
            leaseId,
            leaseUntil: { gt: new Date() },
          },
          data: {
            status: failed ? "failed" : "succeeded",
            completedAt: new Date(),
            leaseId: null,
            leaseUntil: null,
          },
        });
        if (
          changed.count &&
          ((!failed && !maintenance) || failure instanceof SourceResponseError)
        )
          await this.outcome(tx, platform, generation, failure);
        if (changed.count)
          await this.executions.business(
            tx,
            { id, leaseId },
            failed ? "failed" : "succeeded",
            failure,
          );
        return changed.count;
      });
      await this.executions.settle({ id, leaseId });
      if (failed) {
        if (failure instanceof JobDeferred)
          throw new ConflictException(
            `${label} 资料同步配置已变化或不可用，请稍后重试`,
          );
        throw failure;
      }
      if (!finished)
        throw new ConflictException(`${label} 资料同步已过期，请重试`);
      return result as T;
    });
  }
  async runMaintenanceValidation<T>(
    platform: "x" | "pixiv",
    actorId: string,
    expected: MaintenanceExpectation & { operationId?: string },
    run: () => Promise<T>,
  ) {
    return this.profileNetwork(actorId, run, platform, expected);
  }

  async lockMaintenance(tx: Prisma.TransactionClient, platform: string) {
    await this.jobs.lockScope(tx, "network", `source:${platform}`);
    await this.jobs.lockScope(tx, "network", "global");
  }
  /** Only call this inside a short write transaction; never hold it over file/network work. */
  async assertMaintenance(
    tx: Prisma.TransactionClient,
    platform: string,
    expected: MaintenanceExpectation,
    actorId: string,
    operationId?: string,
  ) {
    await this.lockMaintenance(tx, platform);
    await this.actor(tx, actorId, "system:manage");
    await this.lock(tx, platform);
    const state = await tx.sourcePlatformState.findUnique({
      where: { platform },
    });
    if (
      !state?.maintenancePaused ||
      state.maintenanceEpoch !== expected.expectedEpoch ||
      state.credentialGeneration !== expected.expectedGeneration
    )
      throw new ConflictException("Platform maintenance state changed");
    if (
      (await tx.sourcePlatformExecution.count({
        where: { platform, settledAt: null },
      })) ||
      !(await this.drained(tx, platform, new Date()))
    )
      throw new ConflictException(
        "Platform execution has not confirmed completion",
      );
    if (
      await tx.sourceCredentialChangeOperation.count({
        where: {
          platform,
          phase: { in: unresolvedPhases },
          ...(operationId ? { id: { not: operationId } } : {}),
        },
      })
    )
      throw new ConflictException("A credential update is unresolved");
    return state;
  }
  async maintenanceStatus(platform: string) {
    return this.db.$transaction(async (tx) => {
      const state = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      const unsettledExecutions = await tx.sourcePlatformExecution.count({
        where: { platform, settledAt: null },
      });
      return {
        platform,
        maintenancePaused: state?.maintenancePaused ?? false,
        maintenanceEpoch: state?.maintenanceEpoch ?? 0,
        credentialGeneration:
          state?.credentialGeneration ?? (await this.fingerprint(platform)),
        unsettledExecutions,
        observedAt: new Date().toISOString(),
      };
    });
  }
  async pauseMaintenance(
    platform: string,
    actorId: string,
    expected: MaintenanceExpectation,
  ) {
    await this.db.$transaction(async (tx) => {
      await this.lockMaintenance(tx, platform);
      await this.actor(tx, actorId, "system:manage");
      await this.lock(tx, platform);
      let state = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      if (!state) {
        const actual = await this.fingerprint(platform);
        if (
          expected.expectedEpoch !== 0 ||
          !actual ||
          actual !== expected.expectedGeneration
        )
          throw new ConflictException("Platform maintenance state changed");
        if (
          (await tx.sourcePlatformExecution.count({
            where: { platform, settledAt: null },
          })) ||
          !(await this.drained(tx, platform, new Date()))
        )
          throw new ConflictException(
            "Platform execution has not confirmed completion",
          );
        if (
          await tx.sourceCredentialChangeOperation.count({
            where: { platform, phase: { in: unresolvedPhases } },
          })
        )
          throw new ConflictException("A credential update is unresolved");
        await tx.sourcePlatformState.createMany({
          data: {
            platform,
            credentialGeneration: actual,
            maintenancePaused: true,
            maintenanceEpoch: 1,
            revision: 1,
          },
          skipDuplicates: true,
        });
        await this.lock(tx, platform);
        state = await tx.sourcePlatformState.findUnique({
          where: { platform },
        });
        if (
          !state?.maintenancePaused ||
          state.maintenanceEpoch !== 1 ||
          state.credentialGeneration !== actual
        )
          throw new ConflictException("Platform maintenance state changed");
        return;
      }
      if (
        state.maintenanceEpoch !== expected.expectedEpoch ||
        state.credentialGeneration !== expected.expectedGeneration
      )
        throw new ConflictException("Platform maintenance state changed");
      if (state.maintenancePaused) return;
      await tx.sourcePlatformState.update({
        where: { platform },
        data: {
          maintenancePaused: true,
          maintenanceEpoch: { increment: 1 },
          revision: { increment: 1 },
        },
      });
    });
    return this.maintenanceStatus(platform);
  }
  async resumeMaintenance(
    platform: string,
    actorId: string,
    expected: MaintenanceExpectation,
  ) {
    await this.db.$transaction(async (tx) => {
      // Lock queued job rows before actor/platform rows. The scope barrier makes
      // this fixed set stable against new source claims and maintenance writers.
      await this.lockMaintenance(tx, platform);
      const waiting = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM background_jobs WHERE execution_scope = ${`source:${platform}`}
        AND kind IN ('source_account_fetch','source_post_recover')
        AND status='queued' AND last_error='platform_maintenance' ORDER BY id FOR UPDATE`;
      await this.assertMaintenance(tx, platform, expected, actorId);
      if ((await this.fingerprint(platform)) !== expected.expectedGeneration)
        throw new ConflictException(
          "Local credential configuration changed or unavailable",
        );
      await tx.sourcePlatformState.update({
        where: { platform },
        data: {
          maintenancePaused: false,
          revision: { increment: 1 },
        },
      });
      await tx.backgroundJob.updateMany({
        where: {
          id: { in: waiting.map(({ id }) => id) },
          executionScope: `source:${platform}`,
          status: "queued",
          lastError: "platform_maintenance",
          kind: { in: ["source_account_fetch", "source_post_recover"] },
        },
        data: { availableAt: new Date() },
      });
      await tx.sourceFetchAccountTask.updateMany({
        where: {
          jobId: { in: waiting.map(({ id }) => id) },
          platform,
          status: "waiting",
          failureCode: "platform_maintenance",
          completedAt: null,
        },
        data: { status: "queued", deferredUntil: null, failureCode: null },
      });
    });
    return this.maintenanceStatus(platform);
  }
  async activateMaintenance(
    tx: Prisma.TransactionClient,
    platform: string,
    actorId: string,
    expected: MaintenanceExpectation,
    generation: string,
    operationId: string,
  ) {
    const state = await this.assertMaintenance(
      tx,
      platform,
      expected,
      actorId,
      operationId,
    );
    if (generation === state.credentialGeneration) return;
    const changed = await tx.sourcePlatformState.updateMany({
      where: {
        platform,
        maintenancePaused: true,
        maintenanceEpoch: expected.expectedEpoch,
        credentialGeneration: expected.expectedGeneration,
      },
      data: {
        credentialGeneration: generation,
        status: "unverified",
        errorCode: null,
        cooldownUntil: state.cooldownUntil,
        revision: { increment: 1 },
      },
    });
    if (!changed.count)
      throw new ConflictException("Credential generation changed");
  }
  /**
   * Ops-only declaration after a maintainer has independently verified every old
   * API/worker process and its child processes stopped. Lease expiry is only a
   * refusal check here; it never supplies that external completion evidence.
   */
  async confirmStoppedOwner(
    platform: string,
    ownerId: string,
    expectedGeneration: string,
    processesStopped: boolean,
  ) {
    if (processesStopped !== true)
      throw new ConflictException(
        "Explicit confirmation that source processes stopped is required",
      );
    if (
      !["x", "pixiv"].includes(platform) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ownerId,
      ) ||
      !/^[0-9a-f]{64}$/.test(expectedGeneration)
    )
      throw new ConflictException(
        "A fixed platform, owner UUID and expected generation are required",
      );
    return this.db.$transaction(async (tx) => {
      await this.lockMaintenance(tx, platform);
      if (!(await this.drained(tx, platform, new Date())))
        throw new ConflictException(
          "Live source or account leases still exist",
        );
      await this.lock(tx, platform);
      const state = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      if (!state?.maintenancePaused)
        throw new ConflictException("Platform maintenance must remain paused");
      if (state.credentialGeneration !== expectedGeneration)
        throw new ConflictException("Credential generation changed");
      const now = new Date();
      const settledCount =
        await tx.$executeRaw`UPDATE source_platform_executions
        SET settled_at=${now}, diagnostic_json=diagnostic_json || jsonb_build_object(
          'settlementCode','operator_confirmed_stopped','settlementConfirmedAt',${now.toISOString()}::text)
        WHERE id IN (SELECT id FROM source_platform_executions
          WHERE platform=${platform} AND owner_id=${ownerId}::uuid
          AND credential_generation=${expectedGeneration} AND settled_at IS NULL
          AND admitted_at<=${now} ORDER BY admitted_at,id LIMIT 100 FOR UPDATE)
      `;
      const remainingUnsettled = await tx.sourcePlatformExecution.count({
        where: {
          platform,
          ownerId,
          credentialGeneration: expectedGeneration,
          settledAt: null,
        },
      });
      return {
        platform,
        ownerId,
        settledCount,
        remainingUnsettled,
        code: "operator_confirmed_stopped" as const,
      };
    });
  }
  async outcome(
    tx: Prisma.TransactionClient,
    platform: string,
    generation: string,
    error?: unknown,
  ) {
    const now = new Date();
    const failure = error === undefined ? null : platformFailure(error, now);
    if (error !== undefined && !failure) return;
    // Collection and interactive requests can complete in either order. Merge
    // their evidence under the platform row lock, never under a new scope lock.
    await this.lock(tx, platform);
    const state = await tx.sourcePlatformState.findUnique({
      where: { platform },
    });
    if (!state || state.credentialGeneration !== generation) return;
    if (
      !failure &&
      (state.status === "auth_paused" ||
        (state.cooldownUntil && state.cooldownUntil > now))
    )
      return;
    await tx.sourcePlatformState.updateMany({
      where: { platform, credentialGeneration: generation },
      data: failure
        ? {
            ...failure,
            ...(state.status === "auth_paused"
              ? { status: state.status, errorCode: state.errorCode }
              : {}),
            cooldownUntil:
              state.cooldownUntil &&
              (!failure.cooldownUntil ||
                state.cooldownUntil > failure.cooldownUntil)
                ? state.cooldownUntil
                : failure.cooldownUntil,
            revision: { increment: 1 },
          }
        : {
            status: "healthy",
            cooldownUntil: null,
            errorCode: null,
            revision: { increment: 1 },
          },
    });
  }
  list() {
    return this.db.sourcePlatformState.findMany({
      orderBy: { platform: "asc" },
    });
  }
  async activate(platform: string, expectedGeneration: string) {
    const generation = await this.fingerprint(platform);
    if (!generation)
      throw new ConflictException("Local credential configuration unavailable");
    if (generation === expectedGeneration)
      throw new ConflictException(
        "Credential generation is unchanged; use controlled recheck",
      );
    return this.db.$transaction(async (tx) => {
      await this.jobs.lockScope(tx, "network", `source:${platform}`);
      await this.jobs.lockScope(tx, "network", "global");
      if (!(await this.drained(tx, platform, new Date())))
        throw new ConflictException(
          "Drain old source and account leases before activation",
        );
      if (
        await tx.sourcePlatformExecution.count({
          where: { platform, settledAt: null },
        })
      )
        throw new ConflictException(
          "Source execution completion is unconfirmed",
        );
      await tx.backgroundJob.updateMany({
        where: {
          kind: { in: ["source_account_fetch", "source_post_recover"] },
          executionScope: `source:${platform}`,
          status: "queued",
          attempts: { lt: 3 },
        },
        data: { availableAt: new Date() },
      });
      await this.lock(tx, platform);
      if (
        await tx.sourcePlatformState.count({
          where: { platform, maintenancePaused: true },
        })
      )
        throw new ConflictException("Use the active maintenance operation");
      if (
        !(await tx.sourcePlatformState.count({
          where: { platform, credentialGeneration: expectedGeneration },
        }))
      )
        throw new ConflictException("Credential generation changed");
      if ((await this.fingerprint(platform)) !== generation)
        throw new ConflictException("Local credential configuration changed");
      const changed = await tx.sourcePlatformState.updateMany({
        where: { platform, credentialGeneration: expectedGeneration },
        data: {
          credentialGeneration: generation,
          status: "unverified",
          // A credential rotation cannot shorten a trusted platform cooldown.
          errorCode: null,
          revision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new ConflictException("Credential generation changed");
      // Waiting tasks will pin the new generation on claim; account failures are never globally erased.

      return { platform, status: "unverified" as const };
    });
  }
  async recheck(platform: string, actorId: string) {
    // Recheck schedules a real scan by releasing the pause, without editing generation.
    return this.db.$transaction(async (tx) => {
      await this.jobs.lockScope(tx, "network", `source:${platform}`);
      await this.jobs.lockScope(tx, "network", "global");
      if (!(await this.drained(tx, platform, new Date())))
        throw new ConflictException("Platform scan still running");
      const initial = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      if (initial?.maintenancePaused)
        throw new ConflictException("Platform maintenance is active");
      if (initial?.cooldownUntil && initial.cooldownUntil > new Date()) {
        await this.actor(tx, actorId, "system:manage");
        return { platform, status: initial.status };
      }
      await tx.backgroundJob.updateMany({
        where: {
          kind: { in: ["source_account_fetch", "source_post_recover"] },
          executionScope: `source:${platform}`,
          status: "queued",
          attempts: { lt: 3 },
        },
        data: { availableAt: new Date() },
      });
      await this.actor(tx, actorId, "system:manage");
      await this.lock(tx, platform);
      const generation = await this.fingerprint(platform);
      const state = await tx.sourcePlatformState.findUnique({
        where: { platform },
      });
      if (!generation || !state || state.credentialGeneration !== generation)
        throw new ConflictException("Activate current local credentials first");
      // Do not shorten a trustworthy rate-limit cooldown.
      if (state.cooldownUntil && state.cooldownUntil > new Date())
        return { platform, status: state.status };
      await tx.sourcePlatformState.update({
        where: { platform },
        data: {
          status: "unverified",
          errorCode: null,
          revision: { increment: 1 },
        },
      });

      return { platform, status: "unverified" as const };
    });
  }
}
