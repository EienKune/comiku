import { BadRequestException } from "@nestjs/common";

export const WORK_DIGEST_EVENT = "work.digest";
export const WORK_DIGEST_RESOURCE = "work_digest";
export function normalizeWorkReminderNote(note: string): string {
  if (
    typeof note !== "string" ||
    [...note].length > 120 ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(note)
  )
    throw new BadRequestException("提示语最多120个字符，不能包含控制字符");
  return note.trim();
}
export function normalizeWorkReminderTimes(times: string[]): string[] {
  if (
    !Array.isArray(times) ||
    times.length < 2 ||
    times.length > 3 ||
    times.some(
      (time) =>
        typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) ||
    new Set(times).size !== times.length
  )
    throw new BadRequestException("请选择2至3个不同的提醒时间");
  return [...times].sort();
}
export function workReminderLocalDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function workReminderDueAt(date: string, slot: string): Date {
  return new Date(`${date}T${slot}:00.000+08:00`);
}
/** A restart may process only the currently open Shanghai slot. */
export function currentWorkReminderSlot(
  times: string[],
  now: Date,
): {
  localDate: string;
  slot: string;
  dueAt: Date;
  validBefore: Date;
} | null {
  const ordered = normalizeWorkReminderTimes(times);
  const localDate = workReminderLocalDate(now);
  const current = ordered.findLastIndex(
    (time) => workReminderDueAt(localDate, time) <= now,
  );
  if (current < 0) return null;
  const slot = ordered[current]!;
  const tomorrow = new Date(Date.parse(`${localDate}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    localDate,
    slot,
    dueAt: workReminderDueAt(localDate, slot),
    validBefore:
      current + 1 < ordered.length
        ? workReminderDueAt(localDate, ordered[current + 1]!)
        : workReminderDueAt(tomorrow, "00:00"),
  };
}
