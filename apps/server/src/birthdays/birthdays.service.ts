import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { assertNotificationAdministrator } from "../notifications/notification-engine.helpers.js";
import type { BackgroundJob, Prisma } from "../generated/prisma/client.js";
import type {
  BirthdayIdentity,
  BirthdayPerson,
  BirthdaySourceCounts,
} from "./providers/schaledb.js";
import { birthdayCalendar } from "./birthday-calendar.js";
import { isBirthdayIdentityStatus } from "./providers/schaledb.js";

export const BIRTHDAY_SYNC_KIND = "birthday_catalog_sync";
export const BIRTHDAY_SCOPE = "birthdays";
const HOUR = 3_600_000;
const unsafeText = (text: string) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text);

/** Persisted data is still checked before projecting it into an HTTP response. */
export function readBirthdayPeople(value: unknown): BirthdayPerson[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new Error("birthday_invalid_catalog");
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("birthday_invalid_catalog");
    const p = item as Record<string, unknown>;
    if (
      typeof p.key !== "string" ||
      !p.key ||
      p.key.length > 128 ||
      unsafeText(p.key) ||
      keys.has(p.key) ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 128 ||
      unsafeText(p.name) ||
      !Array.isArray(p.aliases) ||
      p.aliases.length > 100 ||
      p.aliases.some(
        (a) => typeof a !== "string" || a.length > 256 || unsafeText(a),
      ) ||
      !Array.isArray(p.entryIds) ||
      p.entryIds.length > 100 ||
      p.entryIds.some((n) => !Number.isSafeInteger(n) || Number(n) < 1) ||
      typeof p.notificationEligible !== "boolean" ||
      !(
        p.originalEntryId === null ||
        (Number.isSafeInteger(p.originalEntryId) &&
          p.entryIds.includes(p.originalEntryId))
      )
    )
      throw new Error("birthday_invalid_catalog");
    const month = p.month as number | null,
      day = p.day as number | null;
    if (
      (month === null) !== (day === null) ||
      (month !== null &&
        (!Number.isInteger(month) ||
          !Number.isInteger(day) ||
          month < 1 ||
          month > 12 ||
          day! < 1 ||
          new Date(Date.UTC(2000, month - 1, day!)).getUTCMonth() !==
            month - 1))
    )
      throw new Error("birthday_invalid_catalog");
    keys.add(p.key);
    return {
      key: p.key,
      name: p.name,
      aliases: p.aliases as string[],
      month,
      day,
      originalEntryId: p.originalEntryId as number | null,
      entryIds: p.entryIds as number[],
      notificationEligible: p.notificationEligible,
    };
  });
}

export function nextBirthdaySync(now: Date): Date {
  const current = birthdayCalendar([], now).today;
  const today = new Date(current + "T06:00:00+08:00");
  return today > now ? today : new Date(today.getTime() + 24 * HOUR);
}

@Injectable()
export class BirthdaysService {
  readonly enabled: boolean;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ENVIRONMENT) environment: Environment,
  ) {
    this.enabled = environment.birthdays?.enabled ?? false;
    this.jobs.register(BIRTHDAY_SYNC_KIND, (job, signal) =>
      this.synchronize(job, signal),
    );
  }

  async calendar(now = new Date(), summary = false) {
    const empty = birthdayCalendar([], now);
    if (!this.enabled)
      return {
        enabled: false,
        today: empty.today,
        windowEnd: empty.windowEnd,
        timezone: "Asia/Shanghai",
        people: [],
      };
    const [settings, state] = await Promise.all([
      this.db.birthdaySettings.findUnique({ where: { id: "global" } }),
      this.db.birthdaySyncState.findUnique({
        where: { id: "schaledb" },
        include: { catalog: true },
      }),
    ]);
    if (settings?.displayEnabled === false || !state?.catalog)
      return {
        enabled: false,
        today: empty.today,
        windowEnd: empty.windowEnd,
        timezone: "Asia/Shanghai",
        people: [],
      };
    const data = birthdayCalendar(
      readBirthdayPeople(state.catalog.people),
      now,
    );
    const people = (summary ? data.summary : data.people).map(
      ({ key, name, aliases, month, day, avatarUrl, nextDate, daysUntil }) => ({
        key,
        name,
        aliases,
        month,
        day,
        avatarUrl,
        nextDate,
        daysUntil,
      }),
    );
    return {
      enabled: true,
      today: data.today,
      windowEnd: data.windowEnd,
      timezone: "Asia/Shanghai",
      people,
    };
  }

  async catalogStatus() {
    if (!this.enabled)
      return {
        available: false,
        personCount: 0,
        lastCheckedAt: null,
        dataUpdatedAt: null,
      };
    const state = await this.db.birthdaySyncState.findUnique({
      where: { id: "schaledb" },
      include: { catalog: true },
    });
    return {
      available: true,
      personCount: state?.catalog
        ? readBirthdayPeople(state.catalog.people).length
        : 0,
      lastCheckedAt: state?.lastCheckedAt?.toISOString() ?? null,
      dataUpdatedAt: state?.catalog?.createdAt.toISOString() ?? null,
    };
  }

  async schedule(manualActorId?: string, now = new Date()) {
    if (!this.enabled) {
      if (manualActorId) throw new ConflictException("生日数据接入尚未启用");
      return { queued: false };
    }
    return this.db.$transaction(async (tx) => {
      if (manualActorId)
        await assertNotificationAdministrator(tx, manualActorId);
      await this.jobs.lockScope(tx, "network", BIRTHDAY_SCOPE);
      const settings = await tx.birthdaySettings.findUnique({
        where: { id: "global" },
      });
      if (
        !manualActorId &&
        settings &&
        !settings.displayEnabled &&
        !settings.remindersEnabled
      )
        return { queued: false };
      await tx.birthdaySyncState.upsert({
        where: { id: "schaledb" },
        create: { id: "schaledb", nextCheckAt: now },
        update: {},
      });
      await tx.$queryRaw`SELECT id FROM birthday_sync_states WHERE id = 'schaledb' FOR UPDATE`;
      const state = await tx.birthdaySyncState.findUniqueOrThrow({
        where: { id: "schaledb" },
      });
      if (state.jobId) {
        const job = await tx.backgroundJob.findUnique({
          where: { id: state.jobId },
        });
        if (job && ["queued", "running"].includes(job.status))
          return { queued: false };
      }
      if (
        manualActorId &&
        state.lastAttemptAt &&
        now.getTime() - state.lastAttemptAt.getTime() < 60_000
      )
        throw new ConflictException("刚刚已检查生日资料，请稍后再试");
      if (!manualActorId && state.nextCheckAt > now) return { queued: false };
      const job = await this.jobs.enqueue(
        {
          kind: BIRTHDAY_SYNC_KIND,
          resourceId: randomUUID(),
          lane: "network",
          executionScope: BIRTHDAY_SCOPE,
          idempotencyKey: `birthday-sync:${state.id}:${now.toISOString()}`,
          payload: { manual: Boolean(manualActorId) },
        },
        tx,
      );
      await tx.birthdaySyncState.update({
        where: { id: state.id },
        data: { jobId: job.id, nextCheckAt: new Date(now.getTime() + HOUR) },
      });
      return { queued: true };
    });
  }

  /** Delete only unreferenced old catalogs; delivery audit references retain their catalog. */
  async cleanupCatalogs(now = new Date()) {
    if (!this.enabled) return;
    const cutoff = new Date(now.getTime() - 90 * 24 * HOUR);
    await this.db.$executeRaw`
      DELETE FROM birthday_catalogs c WHERE c.id IN (
        SELECT candidate.id FROM birthday_catalogs candidate
        WHERE candidate.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM birthday_sync_states s WHERE s.catalog_id = candidate.id)
          AND NOT EXISTS (SELECT 1 FROM birthday_reminder_occurrences o WHERE o.catalog_id = candidate.id)
        ORDER BY candidate.created_at, candidate.id LIMIT 20
        FOR UPDATE OF candidate SKIP LOCKED
      )`;
  }

  async synchronize(job: BackgroundJob, signal: AbortSignal) {
    if (!this.enabled) return;
    const settings = await this.db.birthdaySettings.findUnique({
      where: { id: "global" },
    });
    const manual = Boolean(
      job.payload &&
      typeof job.payload === "object" &&
      !Array.isArray(job.payload) &&
      job.payload.manual === true,
    );
    if (
      settings &&
      !settings.displayEnabled &&
      !settings.remindersEnabled &&
      !manual
    )
      return;
    const state = await this.db.birthdaySyncState.findUniqueOrThrow({
      where: { id: "schaledb" },
      include: { catalog: true },
    });
    if (state.jobId !== job.id) return;
    await this.db.$transaction(async (tx) => {
      await this.jobs.assertLease(tx, job);
      await tx.birthdaySyncState.update({
        where: { id: state.id },
        data: { lastAttemptAt: new Date() },
      });
    });
    try {
      const previous = state.catalog
        ? readBirthdayPeople(state.catalog.people)
        : [];
      const saved = await this.db.birthdayIdentity.findMany({
        orderBy: { entryId: "asc" },
      });
      const identities = saved.map((row) => {
        if (!isBirthdayIdentityStatus(row.status))
          throw new Error("birthday_invalid_persisted_identity");
        return {
          entryId: row.entryId,
          personKey: row.personKey,
          originalEntryId: row.originalEntryId,
          status: row.status,
        } satisfies BirthdayIdentity;
      });
      const { fetchBirthdayCatalog } = await import("./providers/schaledb.js");
      const result = await fetchBirthdayCatalog({
        signal,
        previousPeople: previous,
        identities,
        previousCounts: state.lastCheckedAt
          ? (state.sourceCounts as unknown as BirthdaySourceCounts)
          : undefined,
      });
      signal.throwIfAborted();
      await this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, job);
        await tx.$queryRaw`SELECT id FROM birthday_sync_states WHERE id = 'schaledb' FOR UPDATE`;
        const current = await tx.birthdaySyncState.findUniqueOrThrow({
          where: { id: state.id },
        });
        if (current.jobId !== job.id)
          throw new ConflictException("生日同步任务已变化");
        const overrides = await tx.birthdayNameOverride.findMany();
        const byKey = new Map(overrides.map((row) => [row.personKey, row]));
        const people = readBirthdayPeople(
          result.people.map((person) => {
            const override = byKey.get(person.key);
            return override
              ? {
                  ...person,
                  name: override.name,
                  aliases: [
                    ...new Set([
                      ...person.aliases,
                      person.name,
                      ...override.aliases,
                    ]),
                  ]
                    .filter((alias) => alias !== override.name)
                    .sort(),
                }
              : person;
          }),
        );
        const contentHash = createHash("sha256")
          .update(JSON.stringify(people))
          .digest("hex");
        const catalog = await tx.birthdayCatalog.upsert({
          where: { contentHash },
          update: {},
          create: {
            contentHash,
            people: people as unknown as Prisma.InputJsonValue,
            sourceCounts:
              result.sourceCounts as unknown as Prisma.InputJsonValue,
          },
        });
        const oldById = new Map(saved.map((row) => [row.entryId, row]));
        const added = result.identities.filter(
          (row) => !oldById.has(row.entryId),
        );
        if (added.length)
          await tx.birthdayIdentity.createMany({
            data: added,
            skipDuplicates: true,
          });
        for (const row of result.identities) {
          const old = oldById.get(row.entryId);
          if (
            old &&
            (old.personKey !== row.personKey ||
              old.originalEntryId !== row.originalEntryId ||
              old.status !== row.status)
          )
            await tx.birthdayIdentity.update({
              where: { entryId: row.entryId },
              data: row,
            });
        }
        const now = new Date();
        await tx.birthdaySyncState.update({
          where: { id: state.id },
          data: {
            catalogId: catalog.id,
            lastCheckedAt: now,
            nextCheckAt: nextBirthdaySync(now),
            lastErrorCode: null,
            sourceCounts:
              result.sourceCounts as unknown as Prisma.InputJsonValue,
          },
        });
      });
    } catch (error) {
      const code =
        error instanceof Error && /^birthday_[a-z_]+$/.test(error.message)
          ? error.message
          : "birthday_sync_failed";
      await this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, job);
        await tx.birthdaySyncState.updateMany({
          where: { id: state.id, jobId: job.id },
          data: {
            lastErrorCode: code,
            nextCheckAt: new Date(Date.now() + HOUR),
          },
        });
      });
      console.error(
        JSON.stringify({ event: "birthday_sync_failed", code, jobId: job.id }),
      );
      throw new Error(code, { cause: error });
    }
  }
}
