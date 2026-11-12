import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { workReminderMessageValid } from "../src/work-reminders/work-reminder-notification-policy.js";

test("frozen reminder segments cannot mention a different contact or replace the audited text", () => {
  const snapshot = {
    kind: "work_digest",
    dueAt: "2026-11-12T01:00:00Z",
    validBefore: "2026-11-12T10:00:00Z",
    observedAt: "2026-11-12T01:00:01Z",
    items: [
      {
        participantId: randomUUID(),
        workId: randomUUID(),
        userId: randomUUID(),
        round: 1,
        stage: "translate",
        kind: "overdue",
        sourceKey: "a".repeat(64),
        userRevision: 1,
        qqNumber: "10001000",
      },
    ],
  };
  const text = "未交稿 · 合成成员 [CQ:at,qq=all]";
  const segments = [
    { type: "text", data: { text } },
    { type: "at", data: { qq: "10001000" } },
  ];
  assert.equal(workReminderMessageValid(snapshot, segments, text), true);
  assert.equal(
    workReminderMessageValid(
      snapshot,
      [{ type: "text", data: { text } }],
      text,
    ),
    false,
  );
  assert.equal(
    workReminderMessageValid(
      snapshot,
      [segments[0], { type: "at", data: { qq: "10001001" } }],
      text,
    ),
    false,
  );
  assert.equal(
    workReminderMessageValid(snapshot, segments, "different frozen text"),
    false,
  );
  assert.equal(
    workReminderMessageValid({ ...snapshot, items: [] }, segments, text),
    false,
  );
  assert.equal(
    workReminderMessageValid({ ...snapshot, items: [] }, [segments[0]], text),
    true,
  );
});

test("handoff snapshots freeze exactly one ready task while legacy digests retain their historical mixed item contract", () => {
  const item = {
    participantId: randomUUID(),
    workId: randomUUID(),
    userId: randomUUID(),
    round: 1,
    stage: "proofread",
    kind: "ready",
    sourceKey: "b".repeat(64),
    userRevision: 2,
    qqNumber: "10001000",
  };
  const frozen = {
    kind: "work_ready",
    dueAt: "2026-11-12T03:12:00Z",
    validBefore: "2026-11-13T03:12:00Z",
    observedAt: "2026-11-12T03:12:00Z",
    items: [item],
  };
  const text = "【任务交接提醒】\n可以开始校对";
  const segments = [
    { type: "text", data: { text } },
    { type: "at", data: { qq: item.qqNumber } },
  ];
  assert.equal(workReminderMessageValid(frozen, segments, text), true);
  for (const items of [[], [item, item], [{ ...item, kind: "overdue" }]]) {
    assert.equal(
      workReminderMessageValid({ ...frozen, items }, segments, text),
      false,
    );
  }
  assert.equal(
    workReminderMessageValid(frozen, [...segments, segments[1]], text),
    false,
  );
  assert.equal(
    workReminderMessageValid(
      { ...frozen, kind: "work_digest" },
      segments,
      text,
    ),
    true,
  );
  assert.equal(
    workReminderMessageValid(
      { ...frozen, kind: "work_digest", formatVersion: 2 },
      segments,
      text,
    ),
    false,
  );
  assert.equal(
    workReminderMessageValid(
      {
        ...frozen,
        kind: "work_digest",
        formatVersion: 2,
        items: [{ ...item, kind: "overdue" }],
      },
      segments,
      text,
    ),
    true,
  );
});
