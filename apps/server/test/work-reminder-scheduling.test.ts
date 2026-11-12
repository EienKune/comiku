import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  currentWorkReminderSlot,
  normalizeWorkReminderNote,
  normalizeWorkReminderTimes,
} from "../src/work-reminders/work-reminder-scheduling.js";
import {
  renderWorkReminder,
  workReminderHash,
  type WorkDigestSnapshot,
} from "../src/work-reminders/work-reminder-render.js";
import { notificationMessageSegments } from "../src/notifications/notification-message-segments.js";

test("work digest processes only the current Shanghai slot and expires before midnight", () => {
  const times = ["18:00", "09:00"];
  assert.deepEqual(normalizeWorkReminderTimes(times), ["09:00", "18:00"]);
  assert.equal(
    currentWorkReminderSlot(times, new Date("2026-11-12T00:59:59Z")),
    null,
  );
  assert.deepEqual(
    currentWorkReminderSlot(times, new Date("2026-11-12T01:00:00Z")),
    {
      localDate: "2026-11-12",
      slot: "09:00",
      dueAt: new Date("2026-11-12T01:00:00Z"),
      validBefore: new Date("2026-11-12T10:00:00Z"),
    },
  );
  assert.equal(
    currentWorkReminderSlot(times, new Date("2026-11-12T10:01:00Z"))?.slot,
    "18:00",
  );
  assert.equal(
    currentWorkReminderSlot(
      times,
      new Date("2026-11-12T15:59:59Z"),
    )?.validBefore.toISOString(),
    "2026-11-12T16:00:00.000Z",
  );
  assert.equal(
    currentWorkReminderSlot(times, new Date("2026-11-12T16:00:00Z")),
    null,
  );
  for (const invalid of [
    ["09:00"],
    ["09:00", "09:00"],
    ["24:00", "18:00"],
    ["9:00", "18:00"],
    ["09:00", "12:00", "15:00", "18:00"],
  ])
    assert.throws(() => normalizeWorkReminderTimes(invalid));
  assert.equal(normalizeWorkReminderNote("  提示  "), "提示");
  assert.throws(() => normalizeWorkReminderNote("\n"));
  assert.throws(() => normalizeWorkReminderNote("😀".repeat(121)));
});

const snapshot: WorkDigestSnapshot = {
  kind: "work_digest",
  localDate: "2026-11-12",
  slot: "09:00",
  dueAt: "2026-11-12T01:00:00Z",
  validBefore: "2026-11-12T10:00:00Z",
  observedAt: "2026-11-12T03:15:00Z",
  counts: {
    availableTranslation: 3,
    availableProofreading: 2,
    availableTypesetting: 1,
    availableWorks: 6,
    candidates: 4,
    ready: 3,
    overdue: 4,
  },
  items: Array.from({ length: 5 }, (_, index) => ({
    participantId: `p${index}`,
    round: 1,
    userId: "user",
    workId: "work",
    workNumber: index + 42,
    title: "标题".repeat(120),
    displayName: "名字".repeat(50),
    stage: "typeset",
    kind: index % 2 ? "overdue" : "ready",
    qqNumber: index < 3 ? "123456789" : `12345678${index}`,
    userRevision: 0,
    sourceKey: "a".repeat(64),
  })),
};
test("work digest freezes the actual observation time, five readable details and bounded structured mentions", () => {
  const rendered = renderWorkReminder(
    snapshot,
    "😀".repeat(120),
    true,
    "https://comiku.example",
  );
  assert.match(rendered.text, /截至 2026-11-12 11:15:00/);
  assert.match(rendered.text, /待接作品 6 部/);
  assert.match(rendered.text, /另有 2 项/);
  assert.match(rendered.text, /https:\/\/comiku.example\/works$/);
  assert.ok([...rendered.text].length <= 1000);
  assert.equal(
    rendered.messageSegments.filter((segment) => segment.type === "at").length,
    3,
  );
  assert.ok(notificationMessageSegments(rendered.messageSegments));
  const literal = renderWorkReminder(snapshot, "[CQ:at,qq=all]", false);
  assert.match(literal.text, /\[CQ:at,qq=all\]/);
  assert.equal(literal.messageSegments.length, 1);
  assert.equal(
    workReminderHash("same", snapshot),
    workReminderHash("same", { ...snapshot }),
  );
  assert.notEqual(
    workReminderHash("one", snapshot),
    workReminderHash("two", snapshot),
  );
});
