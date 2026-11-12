import type { BirthdayPerson } from "./birthday-data.adapter.js";

export interface BirthdayCalendarPerson extends BirthdayPerson {
  nextDate: string | null;
  daysUntil: number | null;
  avatarUrl: string | null;
}

const DAY = 86_400_000;
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export function birthdayCalendar(people: readonly BirthdayPerson[], now: Date) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("birthday_invalid_clock");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const value = (part: string) =>
    Number(parts.find((p) => p.type === part)!.value);
  const year = value("year");
  // UTC is used only as date arithmetic after extracting the Shanghai calendar date.
  const today = Date.UTC(year, value("month") - 1, value("day"));
  const projected: BirthdayCalendarPerson[] = people
    .map((person) => {
      const p: BirthdayCalendarPerson = {
        ...person,
        aliases: [...person.aliases],
        nextDate: null,
        daysUntil: null,
        avatarUrl: person.avatarUrl,
      };
      if (person.month === null || person.day === null) return p;
      for (
        let candidateYear = year;
        candidateYear <= year + 8;
        candidateYear++
      ) {
        const candidate: number = Date.UTC(
          candidateYear,
          person.month - 1,
          person.day,
        );
        const date: Date = new Date(candidate);
        if (
          date.getUTCMonth() !== person.month - 1 ||
          date.getUTCDate() !== person.day ||
          candidate < today
        )
          continue;
        p.nextDate = isoDate(candidate);
        p.daysUntil = (candidate - today) / DAY;
        break;
      }
      return p;
    })
    .sort(
      (a, b) =>
        (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity) ||
        a.key.localeCompare(b.key),
    );
  const upcoming = projected.filter((p) => p.daysUntil !== null);
  let summary = upcoming.filter((p) => p.daysUntil! <= 6);
  if (!summary.length && upcoming.length)
    summary = upcoming.filter((p) => p.nextDate === upcoming[0].nextDate);
  return {
    today: isoDate(today),
    windowEnd: isoDate(today + 6 * DAY),
    people: projected,
    summary,
  };
}
