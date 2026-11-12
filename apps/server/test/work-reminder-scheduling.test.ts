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
  renderWorkReady,
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

test("new digests summarize stage backlog and only overdue details; ready notices stand alone", () => {
  const overdue = snapshot.items.filter((item) => item.kind === "overdue");
  const rendered = renderWorkReminder(
    {
      ...snapshot,
      formatVersion: 2,
      counts: {
        ...snapshot.counts,
        ready: 0,
        translationTotal: 10,
        proofreadingTotal: 8,
        typesettingTotal: 6,
      },
      items: overdue,
    },
    "提示语",
    true,
    "https://comiku.example",
  );
  assert.match(rendered.text, /待入库候选：4 篇/);
  assert.match(rendered.text, /翻译：10 部（待认领 3）/);
  assert.match(rendered.text, /校对：8 部（待认领 2）/);
  assert.match(rendered.text, /嵌字：6 部（待认领 1）/);
  assert.doesNotMatch(rendered.text, /预认领|可以开始|任务交接/);
  assert.match(rendered.text, /超过72小时未交稿：4 项/);
  assert.equal(
    rendered.messageSegments.filter((s) => s.type === "at").length,
    2,
  );
  const ready = renderWorkReady(
    {
      kind: "work_ready",
      dueAt: snapshot.dueAt,
      validBefore: snapshot.validBefore,
      observedAt: snapshot.observedAt,
      items: [snapshot.items[0]!],
    },
    true,
    "https://comiku.example",
  );
  assert.match(ready.text, /^【任务交接提醒】\n#42 /);
  assert.match(ready.text, /可以开始嵌字了/);
  assert.doesNotMatch(ready.text, /工作摘要|72小时|预认领|上海时间/);
  assert.match(ready.text, /https:\/\/comiku.example\/works\/work$/);
  assert.equal(ready.messageSegments.filter((s) => s.type === "at").length, 1);
  assert.throws(() =>
    renderWorkReady(
      {
        kind: "work_ready",
        dueAt: snapshot.dueAt,
        validBefore: snapshot.validBefore,
        observedAt: snapshot.observedAt,
        items: overdue,
      },
      true,
    ),
  );
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
  assert.match(rendered.text, /截至 2026-11-12 11:15:00\n/);
  assert.doesNotMatch(rendered.text, /上海时间|可开工/);
  assert.match(rendered.text, /预认领任务已就绪 3 项/);
  assert.match(rendered.text, /#42 .* · 可以开始嵌字 ·/);
  assert.match(rendered.text, /#43 .* · 嵌字超过72小时未交稿 ·/);
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

test("full digests list every overdue task and mention each person once without the legacy text or item cap", () => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    ...snapshot.items[0]!,
    participantId: `p${index}`,
    workNumber: 100 + index,
    kind: "overdue" as const,
    stage: "translate" as const,
    title: "完整作品标题".repeat(8),
    displayName: `成员${index}`,
    qqNumber: index === 23 ? "10001000" : String(10001000 + index),
  }));
  const full: WorkDigestSnapshot = {
    ...snapshot,
    formatVersion: 3,
    counts: { ...snapshot.counts, ready: 0, overdue: items.length },
    items,
  };
  const rendered = renderWorkReminder(
    full,
    "完整摘要",
    true,
    "https://comiku.example",
  );
  assert.ok([...rendered.text].length > 1000);
  assert.match(rendered.text, /超过72小时未交稿：24 项/);
  assert.doesNotMatch(rendered.text, /另有|预认领|可以开始/);
  for (const item of items)
    assert.ok(rendered.text.includes(`#${item.workNumber} `));
  assert.equal(
    rendered.messageSegments.filter((s) => s.type === "at").length,
    23,
  );
  assert.ok(
    notificationMessageSegments(rendered.messageSegments, "work_digest"),
  );
  assert.equal(notificationMessageSegments(rendered.messageSegments), null);
  assert.throws(
    () =>
      renderWorkReminder(
        { ...full, counts: { ...full.counts, overdue: 25 } },
        "",
        true,
      ),
    /work_digest_incomplete_snapshot/,
  );
  const oversized = Array.from({ length: 2000 }, (_, i) => ({
    ...items[0]!,
    participantId: `large${i}`,
    workNumber: i,
  }));
  assert.throws(
    () =>
      renderWorkReminder(
        {
          ...full,
          counts: { ...full.counts, overdue: oversized.length },
          items: oversized,
        },
        "",
        true,
      ),
    /work_reminder_payload_too_large/,
  );
});
