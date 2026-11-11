import { BadRequestException } from "@nestjs/common";

export const BIRTHDAY_NOTIFICATION_EVENT = "birthday.reminder";
export const BIRTHDAY_RESOURCE_KIND = "birthday_digest";
export const BIRTHDAY_OFFSETS = [0, 1, 7] as const;
export const BIRTHDAY_SOURCE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export interface BirthdayOffsetState {
  generation: number;
  acceptAfter: string;
}
export type BirthdayOffsetStates = Record<string, BirthdayOffsetState>;
export function birthdayLocalDate(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
export function birthdayAddDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
export function birthdayDueAt(date: string, time: string): Date {
  return new Date(`${date}T${time}:00.000+08:00`);
}
export function birthdayOffsetStates(value: unknown): BirthdayOffsetStates {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: BirthdayOffsetStates = {};
  for (const offset of BIRTHDAY_OFFSETS) {
    const entry = (value as Record<string, unknown>)[String(offset)];
    if (!entry || typeof entry !== "object") continue;
    const state = entry as BirthdayOffsetState;
    if (
      Number.isInteger(state.generation) &&
      state.generation > 0 &&
      typeof state.acceptAfter === "string" &&
      Number.isFinite(Date.parse(state.acceptAfter))
    )
      result[String(offset)] = { ...state };
  }
  return result;
}
export function birthdayCutoffEligible(
  cutoff: Date | string | null | undefined,
  dueAt: Date,
): boolean {
  return cutoff != null && new Date(cutoff).getTime() <= dueAt.getTime();
}
export function normalizeBirthdayNote(note: string): string {
  if (
    typeof note !== "string" ||
    [...note].length > 120 ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(note)
  )
    throw new BadRequestException("生日提示语最多120个字符，不能包含控制字符");
  return note.trim();
}
export function validateBirthdaySchedule(input: {
  displayEnabled: boolean;
  remindersEnabled: boolean;
  sendTime: string;
  offsetDays: number[];
}) {
  if (
    typeof input.displayEnabled !== "boolean" ||
    typeof input.remindersEnabled !== "boolean" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.sendTime) ||
    !Array.isArray(input.offsetDays) ||
    input.offsetDays.some(
      (offset) => !BIRTHDAY_OFFSETS.includes(offset as never),
    ) ||
    new Set(input.offsetDays).size !== input.offsetDays.length ||
    (input.remindersEnabled && input.offsetDays.length === 0)
  )
    throw new BadRequestException("生日提醒日程无效");
}
