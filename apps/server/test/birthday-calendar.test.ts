import assert from "node:assert/strict";
import test from "node:test";
import { birthdayCalendar } from "../src/birthdays/birthday-calendar.js";
import type { BirthdayPerson } from "../src/birthdays/birthday-data.adapter.js";

const person = (
  key: string,
  month: number | null,
  day: number | null,
): BirthdayPerson => ({
  key,
  name: key,
  aliases: [],
  month,
  day,
  avatarUrl: "https://schaledb.com/images/student/icon/10000.webp",
});

test("Shanghai midnight defines today independently of local host time; window includes days zero through six", () => {
  const result = birthdayCalendar(
    [
      person("today", 11, 12),
      person("last", 11, 18),
      person("beyond", 11, 19),
      person("unknown", null, null),
    ],
    new Date("2026-11-11T16:00:00Z"),
  );
  assert.equal(result.today, "2026-11-12");
  assert.equal(result.windowEnd, "2026-11-18");
  assert.deepEqual(
    result.summary.map((p) => p.key),
    ["today", "last"],
  );
  assert.equal(result.people.at(-1)?.key, "unknown");
  assert.equal(result.people.at(-1)?.nextDate, null);
  assert.equal(result.people.at(-1)?.daysUntil, null);
  assert.equal(
    birthdayCalendar([], new Date("2026-11-11T15:59:59Z")).today,
    "2026-11-11",
  );
});

test("no birthdays in window shows every person on nearest date, including across year boundaries", () => {
  const result = birthdayCalendar(
    [person("next-b", 1, 2), person("later", 1, 3), person("next-a", 1, 2)],
    new Date("2026-12-25T12:00:00Z"),
  );
  assert.equal(result.windowEnd, "2026-12-31");
  assert.deepEqual(
    result.summary.map((p) => [p.key, p.daysUntil, p.nextDate]),
    [
      ["next-a", 8, "2027-01-02"],
      ["next-b", 8, "2027-01-02"],
    ],
  );
});

test("leap day finds the next real February 29 rather than normalizing to March", () => {
  const p = person("leap", 2, 29);
  assert.equal(
    birthdayCalendar([p], new Date("2026-02-28T00:00:00Z")).people[0].nextDate,
    "2028-02-29",
  );
  assert.equal(
    birthdayCalendar([p], new Date("2028-02-28T16:00:00Z")).people[0].daysUntil,
    0,
  );
  assert.equal(
    birthdayCalendar([p], new Date("2096-03-01T00:00:00Z")).people[0].nextDate,
    "2104-02-29",
  );
});

test("unknown and malformed dates cannot enter summary; avatars come from the adapter", () => {
  const unknown = person("unknown", null, null);
  const invalid = person("invalid", 2, 30);
  const alternate = { ...person("alternate", null, null), avatarUrl: null };
  const result = birthdayCalendar(
    [unknown, invalid, alternate],
    new Date("2026-11-11T00:00:00Z"),
  );
  assert.deepEqual(result.summary, []);
  assert.equal(
    result.people.find((p) => p.key === "alternate")?.avatarUrl,
    null,
  );
  assert.equal(
    result.people.find((p) => p.key === "unknown")?.avatarUrl,
    "https://schaledb.com/images/student/icon/10000.webp",
  );
  assert.throws(() => birthdayCalendar([], new Date(NaN)), /invalid_clock/);
});

test("calendar projection does not mutate its persisted snapshot", () => {
  const source = [person("source", 11, 11)];
  const before = structuredClone(source);
  const result = birthdayCalendar(source, new Date("2026-11-11T00:00:00Z"));
  result.people[0].aliases.push("temporary");
  assert.deepEqual(source, before);
});

test("calendar keeps adapter-provided avatars and never invents a source fallback", () => {
  const avatarUrl = "https://static.kivo.wiki/images/students/example.png";
  const result = birthdayCalendar(
    [
      {
        ...person("kivo:123", 11, 11),
        avatarUrl,
      },
      { ...person("legacy", 11, 11), avatarUrl: null },
    ],
    new Date("2026-11-11T00:00:00Z"),
  );
  assert.equal(
    result.people.find((p) => p.key === "kivo:123")?.avatarUrl,
    avatarUrl,
  );
  assert.equal(result.people.find((p) => p.key === "legacy")?.avatarUrl, null);
});
