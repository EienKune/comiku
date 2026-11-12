import type { Prisma } from "../generated/prisma/client.js";

/** Source-independent facts consumed by the calendar and HTTP projection. */
export interface BirthdayPerson {
  key: string;
  name: string;
  aliases: string[];
  month: number | null;
  day: number | null;
  avatarUrl: string | null;
}

export interface BirthdayDataCatalog {
  people: BirthdayPerson[];
  lastCheckedAt: Date | null;
  updatedAt: Date;
}

/** Additional adapter-owned audit fields survive freezing, without core interpretation. */
export interface BirthdayReminderPerson {
  key: string;
  name: string;
  month: number;
  day: number;
  [auditField: string]: unknown;
}

export interface BirthdayReminderPublication {
  /** Existing BirthdayCatalog row, retained by the occurrence's audit foreign key. */
  catalogId: string;
  catalogVersion: string;
  checkedAt: Date;
  validBefore: Date;
  people: BirthdayReminderPerson[];
}

/** Code-level replacement boundary; all methods stay local when disabled.
 * Reminder reads run in the caller's transaction and perform no network I/O.
 * Implementations own validation, source locks, persistence, freshness and jobs.
 */
export abstract class BirthdayDataAdapter {
  abstract readonly enabled: boolean;
  /** Stable occurrence namespace; changing it is an explicit data migration. */
  abstract readonly namespace: string;
  abstract catalog(): Promise<BirthdayDataCatalog | null>;
  abstract schedule(actorId?: string, now?: Date): Promise<{ queued: boolean }>;
  abstract scheduleSupplement(now?: Date): Promise<unknown>;
  abstract cleanupCatalogs(now?: Date): Promise<unknown>;
  abstract reminderPublication(
    tx: Prisma.TransactionClient,
    targetDate: string,
    now: Date,
  ): Promise<BirthdayReminderPublication | null>;
}
