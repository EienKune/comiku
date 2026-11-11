import { setTimeout as delay } from "node:timers/promises";
import type { BirthdaysService } from "./birthdays.service.js";
import type { BirthdayReminderService } from "./birthday-reminder.service.js";
import type { JobsService } from "../jobs/jobs.service.js";
import { BIRTHDAY_SCOPE } from "./birthday-scheduling.js";

const MINUTE = 60_000;
type Dependencies = {
  birthdays: Pick<
    BirthdaysService,
    "schedule" | "scheduleSupplement" | "cleanupCatalogs"
  >;
  reminders: Pick<BirthdayReminderService, "maintain">;
  jobs: Pick<JobsService, "runNext">;
  notificationsEnabled: boolean;
};

/** Drain due batches serially; maintenance has its own cadence, retries their own due time. */
export async function runBirthdayWorker(
  { birthdays, reminders, jobs, notificationsEnabled }: Dependencies,
  signal: AbortSignal,
  clock = {
    now: () => Date.now(),
    wait: (ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }).catch(() => {}),
  },
) {
  let nextMaintenance = 0;
  let nextCatalogCleanup = 0;
  while (!signal.aborted) {
    if (clock.now() >= nextMaintenance) {
      nextMaintenance = clock.now() + MINUTE;
      // DB-only reminder maintenance must survive independent source failures.
      if (notificationsEnabled) {
        try {
          await reminders.maintain();
        } catch {
          console.error("生日提醒维护未完成，将在下一轮恢复");
        }
      }
      try {
        await birthdays.schedule();
      } catch {
        console.error("生日主源调度未完成，将在下一轮恢复");
      }
    }
    try {
      // Successful Kivo checkpoints can make the next batch immediately due.
      await birthdays.scheduleSupplement();
    } catch {
      console.error("生日补充来源调度未完成，将在下一轮恢复");
    }
    let processed = false;
    if (!signal.aborted) {
      try {
        processed = await jobs.runNext("network", signal, BIRTHDAY_SCOPE);
      } catch {
        console.error("生日资料处理未完成，将按任务状态恢复");
      }
    }
    if (clock.now() >= nextCatalogCleanup) {
      nextCatalogCleanup = clock.now() + MINUTE;
      try {
        await birthdays.cleanupCatalogs();
        nextCatalogCleanup = clock.now() + 86_400_000;
      } catch {
        console.error("生日后台处理未完成，将在下一轮恢复");
      }
    }
    if (!processed && !signal.aborted) await clock.wait(MINUTE, signal);
  }
}
