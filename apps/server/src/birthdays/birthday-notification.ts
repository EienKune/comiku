import type { BirthdayReminderPerson } from "./birthday-data.adapter.js";
import { createHash } from "node:crypto";
import { normalizeBirthdayNote } from "./birthday-policy.js";

export type BirthdayNotificationPerson = BirthdayReminderPerson;
export interface BirthdayNotificationSnapshot {
  kind: "birthday_digest";
  sendLocalDate: string;
  targetLocalDate: string;
  offsetDays: number;
  dueAt: string;
  validBefore: string;
  catalogId: string;
  catalogVersion: string;
  checkedAt: string;
  people: BirthdayNotificationPerson[];
  count: number;
}
export function birthdayNotificationHash(
  occurrenceId: string,
  snapshot: BirthdayNotificationSnapshot,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, occurrenceId, snapshot }))
    .digest("hex");
}
/** Complete names are mandatory; optional copy never displaces the list. */
export function renderBirthdayNotification(
  snapshot: Pick<
    BirthdayNotificationSnapshot,
    "targetLocalDate" | "offsetDays" | "people"
  >,
  note: string,
): string {
  const normalizedNote = normalizeBirthdayNote(note);
  const timing =
    snapshot.offsetDays === 0 ? "今天生日" : `提前 ${snapshot.offsetDays} 天`;
  const text = [
    "【角色生日提醒】",
    `${timing} · ${snapshot.targetLocalDate}`,
    "",
    `生日角色：${snapshot.people.map((person) => person.name).join("、")}`,
    ...(normalizedNote ? ["", normalizedNote] : []),
  ].join("\n");
  // Reserve the same immutable historical replay prefix as ordinary messages.
  if ([...text].length + [..."【历史补发】\n"].length > 1000)
    throw new Error("birthday_message_too_long");
  return text;
}
