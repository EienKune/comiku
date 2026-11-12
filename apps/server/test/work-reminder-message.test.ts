import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  workReminderMessageValid,
  workReminderMessagePolicy,
} from "../src/work-reminders/work-reminder-notification-policy.js";

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

test("only a valid full-digest resource can carry all overdue contacts and extended text", () => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    participantId: randomUUID(),
    workId: randomUUID(),
    userId: randomUUID(),
    round: 1,
    stage: "translate",
    kind: "overdue",
    sourceKey: "a".repeat(64),
    userRevision: 0,
    qqNumber: String(10001000 + index),
  }));
  const frozen = {
    kind: "work_digest",
    formatVersion: 3,
    dueAt: "2026-11-12T01:00:00Z",
    validBefore: "2026-11-12T10:00:00Z",
    observedAt: "2026-11-12T01:00:01Z",
    counts: { ready: 0, overdue: items.length },
    items,
  };
  const text = "超时任务明细".repeat(250);
  const message = [
    { type: "text", data: { text } },
    ...items.map((item) => ({ type: "at", data: { qq: item.qqNumber } })),
  ];
  assert.equal(workReminderMessagePolicy(frozen, "work_digest"), "work_digest");
  assert.equal(
    workReminderMessageValid(frozen, message, text, "work_digest"),
    true,
  );
  assert.equal(
    workReminderMessageValid(frozen, message, text, "work_ready"),
    false,
  );
  assert.equal(workReminderMessagePolicy(frozen, "work_ready"), "standard");
  for (const modified of [
    { ...frozen, formatVersion: 2 },
    { ...frozen, kind: "work_ready" },
    { ...frozen, counts: { ready: 0, overdue: items.length + 1 } },
    { ...frozen, items: [items[0], ...items.slice(1, -1), items[0]] },
    { ...frozen, items: [{ ...items[0], kind: "ready" }, ...items.slice(1)] },
  ])
    assert.equal(
      workReminderMessageValid(modified, message, text, "work_digest"),
      false,
    );
  assert.equal(
    workReminderMessageValid(
      frozen,
      [...message, message[1]],
      text,
      "work_digest",
    ),
    false,
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
