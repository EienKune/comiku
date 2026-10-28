import { permissionsFor, type Permission } from "../common/access.js";
import { createHash } from "node:crypto";
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
import { JobDeferred, type JobsService } from "../jobs/jobs.service.js";
import { jsonObject, SourceResponseError } from "./source-response.js";

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
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
    private readonly environment: Environment,
  ) {}
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
        kind: { in: ["source_fetch", "source_account_fetch"] },
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
  ): Promise<void | JobDeferred> {
    const task = await tx.sourceFetchAccountTask.findUnique({
      where: { id: job.resourceId },
    });
    if (
      !task ||
      task.jobId !== job.id ||
      job.executionScope !== `source:${task.platform}`
    )
      throw new ConflictException("Invalid source task");
    if (task.completedAt) return;
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
            platform: task.platform,
            credentialGeneration: "actor_unavailable",
          },
        },
      });
      return;
    }

    // Claims already hold platform scope. A global barrier prevents old code claiming concurrently.
    await this.jobs.lockScope(tx, "network", "global");
    let state = await tx.sourcePlatformState.findUnique({
      where: { platform: task.platform },
    });
    const generation = await this.fingerprint(task.platform);
    // A local mismatch must roll back the claim, not postpone work for healthy peers.
    if (!generation || (state && state.credentialGeneration !== generation))
      throw new SourceConfigurationMismatch();
    if (
      !state &&
      generation &&
      (await this.drained(tx, task.platform, now, job.id))
    ) {
      await tx.sourcePlatformState.createMany({
        data: { platform: task.platform, credentialGeneration: generation },
        skipDuplicates: true,
      });
    }
    await this.lock(tx, task.platform);
    state = await tx.sourcePlatformState.findUnique({
      where: { platform: task.platform },
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
      await tx.sourceFetchAccountTask.update({
        where: { id: task.id },
        data: {
          status: "waiting",
          deferredUntil: deferred.retryAt,
          failureCode: deferred.reason,
        },
      });
      return deferred;
    }
    await tx.sourceFetchAccountTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        credentialGeneration: generation,
        startedAt: task.startedAt ?? now,
        deferredUntil: null,
        failureCode: null,
      },
    });
    await tx.backgroundJob.update({
      where: { id: job.id },
      data: {
        payload: { credentialGeneration: generation!, platform: task.platform },
      },
    });
  }
  denial(
    state: SourcePlatformState | null,
    generation: string | null,
    now = new Date(),
  ): JobDeferred | null {
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
    const deferred = this.denial(state, actual === generation ? actual : null);
    if (deferred) throw deferred;
  }
  async outcome(
    tx: Prisma.TransactionClient,
    platform: string,
    generation: string,
    error?: unknown,
  ) {
    const state = await tx.sourcePlatformState.findUnique({
      where: { platform },
    });
    if (!state || state.credentialGeneration !== generation) return;
    const failure =
      error === undefined ? null : platformFailure(error, new Date());
    if (error !== undefined && !failure) return;
    await tx.sourcePlatformState.updateMany({
      where: { platform, credentialGeneration: generation },
      data: failure
        ? {
            ...failure,
            cooldownUntil:
              failure.cooldownUntil &&
              state.cooldownUntil &&
              state.cooldownUntil > failure.cooldownUntil
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
      await tx.backgroundJob.updateMany({
        where: {
          kind: "source_account_fetch",
          executionScope: `source:${platform}`,
          status: "queued",
          attempts: { lt: 3 },
        },
        data: { availableAt: new Date() },
      });
      await this.lock(tx, platform);
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
          cooldownUntil: null,
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
      if (initial?.cooldownUntil && initial.cooldownUntil > new Date()) {
        await this.actor(tx, actorId, "system:manage");
        return { platform, status: initial.status };
      }
      await tx.backgroundJob.updateMany({
        where: {
          kind: "source_account_fetch",
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
