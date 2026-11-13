import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaService } from "../../../database/prisma.service.js";
import type { JobsService } from "../../../jobs/jobs.service.js";
import type {
  BackgroundJob,
  BirthdaySyncState,
  Prisma,
} from "../../../generated/prisma/client.js";
import {
  fetchKivoIndex,
  fetchKivoProfile,
  kivoProfileHash,
  type KivoProfile,
} from "./providers/kivo.js";
import {
  BIRTHDAY_RETRY_MS,
  BIRTHDAY_SCOPE,
} from "../../birthday-scheduling.js";

export const KIVO_SYNC_KIND = "birthday_kivo_sync";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ERROR_CODES = new Set(
  [
    "aborted",
    "duplicate_or_invalid_id",
    "failed",
    "invalid_association",
    "invalid_avatar",
    "invalid_date",
    "invalid_envelope",
    "invalid_id",
    "invalid_json",
    "invalid_name",
    "invalid_object",
    "invalid_pagination",
    "invalid_profile",
    "invalid_redirect",
    "missing_japanese_name",
    "timeout",
    "too_large",
    "too_many_entries",
    "unavailable",
    "unsafe_redirect",
    "index_decline",
  ].map((suffix) => `birthday_kivo_${suffix}`),
);
function errorCode(error: unknown): string {
  return error instanceof Error && ERROR_CODES.has(error.message)
    ? error.message
    : "birthday_kivo_failed";
}
function counts(state: BirthdaySyncState) {
  const value = state.sourceCounts;
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const count =
    typeof record.index === "number" &&
    Number.isSafeInteger(record.index) &&
    record.index >= 0
      ? record.index
      : 0;
  const retry =
    typeof record.indexRetryAt === "string"
      ? Date.parse(record.indexRetryAt)
      : NaN;
  return { count, retry: Number.isFinite(retry) ? retry : 0 };
}
function indexDue(state: BirthdaySyncState): Date {
  return new Date(
    Math.max(
      state.lastCheckedAt ? state.lastCheckedAt.getTime() + DAY : 0,
      counts(state).retry,
    ),
  );
}
const active = (
  settings: { displayEnabled: boolean; remindersEnabled: boolean } | null,
) => !settings || settings.displayEnabled || settings.remindersEnabled;
type Outcome =
  | { entryId: number; checkedAt: Date; profile: KivoProfile; hash: string }
  | { entryId: number; checkedAt: Date; code: string };

/** Internal bounded source acquisition; publication and identity reconciliation are injected. */
export class BirthdaySupplement {
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
    private readonly enabled: boolean,
    private readonly publish: (tx: Prisma.TransactionClient) => Promise<void>,
    private readonly lock: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    jobs.register(
      KIVO_SYNC_KIND,
      (job, signal) => this.synchronize(job, signal),
      { retryDelayMs: BIRTHDAY_RETRY_MS },
    );
  }

  private async nextCheck(
    tx: Prisma.TransactionClient,
    state: BirthdaySyncState,
  ): Promise<Date> {
    const first = await tx.birthdayExternalEntry.findFirst({
      where: { source: "kivo" },
      orderBy: [{ nextCheckAt: "asc" }, { entryId: "asc" }],
      select: { nextCheckAt: true },
    });
    return new Date(
      Math.min(
        indexDue(state).getTime(),
        first?.nextCheckAt.getTime() ?? Infinity,
      ),
    );
  }

  async schedule(now = new Date()): Promise<{ queued: boolean }> {
    if (!this.enabled) return { queued: false };
    return this.db.$transaction(async (tx) => {
      if (
        !active(
          await tx.birthdaySettings.findUnique({ where: { id: "global" } }),
        )
      )
        return { queued: false };
      await this.jobs.lockScope(tx, "network", BIRTHDAY_SCOPE);
      await tx.birthdaySyncState.upsert({
        where: { id: "kivo" },
        create: { id: "kivo", nextCheckAt: now },
        update: {},
      });
      await tx.$queryRaw`SELECT id FROM birthday_sync_states WHERE id = 'kivo' FOR UPDATE`;
      const state = await tx.birthdaySyncState.findUniqueOrThrow({
        where: { id: "kivo" },
      });
      if (state.jobId) {
        const job = await tx.backgroundJob.findUnique({
          where: { id: state.jobId },
        });
        if (job && ["queued", "running"].includes(job.status))
          return { queued: false };
        if (job?.status === "failed" && job.availableAt > now)
          return { queued: false };
      }
      if (state.nextCheckAt > now) return { queued: false };
      const nextCheckAt = await this.nextCheck(tx, state);
      if (nextCheckAt > now) {
        await tx.birthdaySyncState.update({
          where: { id: state.id },
          data: { nextCheckAt },
        });
        return { queued: false };
      }
      const phase = indexDue(state) <= now ? "index" : "profiles";
      const job = await this.jobs.enqueue(
        {
          kind: KIVO_SYNC_KIND,
          resourceId: randomUUID(),
          lane: "network",
          executionScope: BIRTHDAY_SCOPE,
          idempotencyKey: `birthday-kivo:${phase}:${now.toISOString()}`,
          payload: { phase },
        },
        tx,
      );
      await tx.birthdaySyncState.update({
        where: { id: state.id },
        data: {
          jobId: job.id,
          nextCheckAt: new Date(now.getTime() + BIRTHDAY_RETRY_MS),
        },
      });
      return { queued: true };
    });
  }

  private async owned(
    tx: Prisma.TransactionClient,
    job: BackgroundJob,
    signal: AbortSignal,
    leaseHeld = false,
  ) {
    signal.throwIfAborted();
    if (!leaseHeld) await this.jobs.assertLease(tx, job);
    await tx.$queryRaw`SELECT id FROM birthday_sync_states WHERE id = 'kivo' FOR UPDATE`;
    const state = await tx.birthdaySyncState.findUniqueOrThrow({
      where: { id: "kivo" },
    });
    if (state.jobId !== job.id) throw new Error("birthday_kivo_aborted");
    return state;
  }

  async synchronize(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    if (!this.enabled) return;
    signal.throwIfAborted();
    if (
      !active(
        await this.db.birthdaySettings.findUnique({ where: { id: "global" } }),
      )
    )
      return;
    const state = await this.db.birthdaySyncState.findUnique({
      where: { id: "kivo" },
    });
    if (!state || state.jobId !== job.id) return;
    const payload = job.payload;
    const phase =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.phase
        : undefined;
    if (phase !== "index" && phase !== "profiles")
      throw new Error("birthday_kivo_invalid_profile");
    const deadline = AbortSignal.timeout(45_000);
    const network = AbortSignal.any([signal, deadline]);
    if (phase === "index") {
      let entries: Awaited<ReturnType<typeof fetchKivoIndex>> | undefined;
      let code: string | null = null;
      try {
        entries = await fetchKivoIndex({ signal: network });
        if (entries.length < counts(state).count * 0.9)
          throw new Error("birthday_kivo_index_decline");
      } catch (error) {
        signal.throwIfAborted();
        code = deadline.aborted ? "birthday_kivo_timeout" : errorCode(error);
      }
      signal.throwIfAborted();
      await this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, job);
        await this.lock(tx);
        const current = await this.owned(tx, job, signal, true);
        if (
          !active(
            await tx.birthdaySettings.findUnique({ where: { id: "global" } }),
          )
        )
          return;
        const now = new Date();
        if (code || !entries) {
          const metadata = {
            index: counts(current).count,
            indexRetryAt: new Date(
              now.getTime() + BIRTHDAY_RETRY_MS,
            ).toISOString(),
          };
          const failed = { ...current, sourceCounts: metadata };
          await tx.birthdaySyncState.update({
            where: { id: state.id },
            data: {
              lastAttemptAt: now,
              lastErrorCode: code ?? "birthday_kivo_failed",
              sourceCounts: metadata,
              nextCheckAt: await this.nextCheck(tx, failed),
            },
          });
          signal.throwIfAborted();
          return;
        }
        const existing = await tx.birthdayExternalEntry.findMany({
          where: { source: "kivo" },
          select: { entryId: true },
          take: 2001,
        });
        const known = new Set(existing.map((entry) => entry.entryId));
        const added = entries.filter((entry) => !known.has(entry.id));
        if (existing.length + added.length > 2000)
          throw new Error("birthday_kivo_too_many_entries");
        if (added.length)
          await tx.birthdayExternalEntry.createMany({
            data: added.map((entry) => ({
              source: "kivo",
              entryId: entry.id,
              listedAt: now,
              nextCheckAt: now,
            })),
            skipDuplicates: true,
          });
        await tx.birthdayExternalEntry.updateMany({
          where: {
            source: "kivo",
            entryId: { in: entries.map((entry) => entry.id) },
          },
          data: { listedAt: now },
        });
        const updated = {
          ...current,
          lastCheckedAt: now,
          sourceCounts: { index: entries.length },
        };
        await tx.birthdaySyncState.update({
          where: { id: state.id },
          data: {
            lastAttemptAt: now,
            lastCheckedAt: now,
            lastErrorCode: null,
            sourceCounts: updated.sourceCounts,
            nextCheckAt: await this.nextCheck(tx, updated),
          },
        });
        signal.throwIfAborted();
      });
      if (code)
        console.error(
          JSON.stringify({ event: "birthday_kivo_sync_failed", phase, code }),
        );
      return;
    }

    const due = await this.db.birthdayExternalEntry.findMany({
      where: { source: "kivo", nextCheckAt: { lte: new Date() } },
      orderBy: [{ nextCheckAt: "asc" }, { entryId: "asc" }],
      take: 20,
      select: { entryId: true },
    });
    const outcomes: Outcome[] = [];
    for (const entry of due) {
      signal.throwIfAborted();
      if (deadline.aborted) break;
      try {
        const profile = await fetchKivoProfile(entry.entryId, {
          signal: network,
        });
        outcomes.push({
          entryId: entry.entryId,
          profile,
          hash: kivoProfileHash(profile),
          checkedAt: new Date(),
        });
      } catch (error) {
        signal.throwIfAborted();
        outcomes.push({
          entryId: entry.entryId,
          code: deadline.aborted ? "birthday_kivo_timeout" : errorCode(error),
          checkedAt: new Date(),
        });
      }
      if (deadline.aborted) break;
      // Include the last request: another due batch may now start immediately.
      try {
        await delay(250, undefined, { signal: network });
      } catch {
        signal.throwIfAborted();
        break;
      }
    }
    signal.throwIfAborted();
    await this.db.$transaction(async (tx) => {
      await this.jobs.assertLease(tx, job);
      await this.lock(tx);
      const current = await this.owned(tx, job, signal, true);
      if (
        !active(
          await tx.birthdaySettings.findUnique({ where: { id: "global" } }),
        )
      )
        return;
      for (const outcome of outcomes) {
        const data =
          "profile" in outcome
            ? {
                profile: outcome.profile as unknown as Prisma.InputJsonValue,
                profileHash: outcome.hash,
                lastCheckedAt: outcome.checkedAt,
                nextCheckAt: new Date(outcome.checkedAt.getTime() + DAY),
                lastErrorCode: null,
              }
            : {
                lastErrorCode: outcome.code,
                nextCheckAt: new Date(
                  outcome.checkedAt.getTime() + BIRTHDAY_RETRY_MS,
                ),
              };
        await tx.birthdayExternalEntry.update({
          where: {
            source_entryId: { source: "kivo", entryId: outcome.entryId },
          },
          data,
        });
      }
      await this.publish(tx);
      await tx.birthdaySyncState.update({
        where: { id: state.id },
        data: {
          lastAttemptAt: new Date(),
          nextCheckAt: await this.nextCheck(tx, current),
        },
      });
      signal.throwIfAborted();
    });
    for (const outcome of outcomes)
      if ("code" in outcome)
        console.error(
          JSON.stringify({
            event: "birthday_kivo_profile_failed",
            entryId: outcome.entryId,
            code: outcome.code,
          }),
        );
  }
}
