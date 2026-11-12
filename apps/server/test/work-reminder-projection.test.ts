import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../src/generated/prisma/client.js";
import { readReminderEvidence } from "../src/work-reminders/work-reminder-projection.js";
import {
  advanceReminderClock,
  observeReminder,
  OVERDUE_MILLISECONDS,
} from "../src/work-reminders/work-reminder-policy.js";

const start = new Date("2026-11-12T00:00:00.000Z");
const at = (milliseconds: number) => new Date(start.getTime() + milliseconds);
const ready = {
  state: "ready" as const,
  sourceKey: "round-a",
  evidenceKey: "evidence-a",
};

test("the overdue clock accumulates only matching observations within two minutes", () => {
  const first = observeReminder(null, ready, start);
  assert.equal(first.eligibleMilliseconds, 0n);
  const observed = observeReminder(first, ready, at(60_000));
  assert.equal(observed.eligibleMilliseconds, 60_000n);
  const gap = observeReminder(observed, ready, at(600_000));
  assert.equal(gap.eligibleMilliseconds, 60_000n);
  const resumed = observeReminder(gap, ready, at(660_000));
  assert.equal(resumed.eligibleMilliseconds, 120_000n);
});

test("ordinary revisions and eligibility pauses retain accumulated time without crediting uncertain intervals", () => {
  const previous = {
    ...observeReminder(null, ready, start),
    eligibleMilliseconds: BigInt(OVERDUE_MILLISECONDS - 60_000),
  };
  const revision = observeReminder(
    previous,
    { ...ready, evidenceKey: "edited" },
    at(60_000),
  );
  assert.equal(revision.round, previous.round);
  assert.equal(revision.eligibleMilliseconds, previous.eligibleMilliseconds);
  const paused = observeReminder(
    revision,
    { ...ready, state: "paused", evidenceKey: "paused" },
    at(120_000),
  );
  const restored = observeReminder(paused, ready, at(180_000));
  assert.equal(restored.round, previous.round);
  assert.equal(restored.eligibleMilliseconds, previous.eligibleMilliseconds);
  const due = observeReminder(restored, ready, at(240_000));
  assert.equal(due.eligibleMilliseconds, BigInt(OVERDUE_MILLISECONDS));
});

test("cancellation, assignment changes and invalidated personal completion start a new clock", () => {
  const previous = {
    ...observeReminder(null, ready, start),
    eligibleMilliseconds: BigInt(OVERDUE_MILLISECONDS),
  };
  const changed = observeReminder(
    previous,
    { ...ready, sourceKey: "new-assignment-or-cancel" },
    at(60_000),
  );
  assert.equal(changed.round, 2);
  assert.equal(changed.eligibleMilliseconds, 0n);
  const completed = observeReminder(
    previous,
    { ...ready, state: "completed" },
    at(60_000),
  );
  const reopened = observeReminder(completed, ready, at(120_000));
  assert.equal(reopened.round, 2);
  assert.equal(reopened.eligibleMilliseconds, 0n);
});

test("only a previously waiting claim qualifies for the one-per-round ready notice", () => {
  const preclaimed = observeReminder(
    null,
    { ...ready, state: "waiting" },
    start,
  );
  assert.equal(preclaimed.preclaimed, true);
  assert.equal(preclaimed.readyObservedAt, null);
  const available = observeReminder(preclaimed, ready, at(60_000));
  assert.equal(available.preclaimed, true);
  assert.deepEqual(available.readyObservedAt, at(60_000));
  const immediate = observeReminder(null, ready, start);
  assert.equal(immediate.preclaimed, false);
});

test("an older worker timestamp cannot roll back projection evidence or its observation clock", () => {
  const previous = observeReminder(null, ready, at(60_000));
  assert.deepEqual(
    observeReminder(previous, { ...ready, sourceKey: "stale-source" }, start),
    previous,
  );
  assert.deepEqual(
    observeReminder(
      previous,
      { ...ready, evidenceKey: "stale-evidence" },
      at(60_000),
    ),
    previous,
  );
});

test("1501 participants keep accumulating across long rotations while the shared worker heartbeat remains healthy", () => {
  let clock = advanceReminderClock(null, start);
  const observations = Array.from({ length: 1501 }, () =>
    observeReminder(null, ready, start, 0n),
  );
  for (let tick = 1; tick <= 12; tick++) {
    clock = advanceReminderClock(clock, at(tick * 60_000));
    const oldest = observations
      .map((observation, index) => ({ observation, index }))
      .sort(
        (a, b) =>
          a.observation.lastObservedAt.getTime() -
            b.observation.lastObservedAt.getTime() || a.index - b.index,
      )
      .slice(0, 500);
    for (const { index } of oldest) {
      observations[index] = observeReminder(
        observations[index]!,
        ready,
        at(tick * 60_000),
        clock.elapsedMilliseconds,
      );
    }
  }
  assert.equal(clock.elapsedMilliseconds, 720_000n);
  assert.ok(
    observations.every(
      (observation) => observation.eligibleMilliseconds >= 540_000n,
    ),
  );
});

test("the shared clock excludes a long shutdown and resumes without backfilling downtime", () => {
  let clock = advanceReminderClock(null, start);
  let observation = observeReminder(
    null,
    ready,
    start,
    clock.elapsedMilliseconds,
  );
  clock = advanceReminderClock(clock, at(60_000));
  clock = advanceReminderClock(clock, at(120_000));
  clock = advanceReminderClock(clock, at(180_000));
  observation = observeReminder(
    observation,
    ready,
    at(180_000),
    clock.elapsedMilliseconds,
  );
  assert.equal(observation.eligibleMilliseconds, 180_000n);
  clock = advanceReminderClock(clock, at(900_000));
  observation = observeReminder(
    observation,
    ready,
    at(900_000),
    clock.elapsedMilliseconds,
  );
  assert.equal(observation.eligibleMilliseconds, 180_000n);
  clock = advanceReminderClock(clock, at(960_000));
  observation = observeReminder(
    observation,
    ready,
    at(960_000),
    clock.elapsedMilliseconds,
  );
  assert.equal(observation.eligibleMilliseconds, 240_000n);
  assert.deepEqual(advanceReminderClock(clock, at(930_000)), clock);
});

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant",
    workId: "work",
    userId: "user",
    stage: "translate",
    joinedAt: start,
    leftAt: null,
    submittedAt: null,
    user: {
      displayName: "Synthetic Member",
      qqNumber: "12345678",
      revision: 1,
      isActive: true,
      roles: [{ role: "translator" }],
      languageCapabilities: [{ language: "ja" }],
    },
    work: {
      workNumber: 12,
      title: "Synthetic Work",
      sourceLanguage: "ja",
      collaborationMode: "multi",
      workflowStatus: "translating",
      reviewStatus: "normal",
      revision: 4,
      editorEpoch: 0,
      proofreadSkippedVersionId: null,
    },
    assignments: [
      {
        id: "assignment",
        workImageId: "page",
        assignedAt: start,
        workImage: { translationRevision: 2 },
      },
    ],
    contributionSubmissions: [
      { id: "submission", pages: [{ workImageId: "page", imageRevision: 2 }] },
    ],
    ...overrides,
  };
}

async function evidenceFor(row: ReturnType<typeof participant>) {
  const tx = {
    workStageParticipant: { findMany: async () => [row] },
    $queryRaw: async () => [{ participantId: "participant", cancelKey: "0:" }],
  } as unknown as Prisma.TransactionClient;
  return (await readReminderEvidence(tx, ["participant"]))[0]!;
}

test("personal completion requires every currently assigned page at the current revision", async () => {
  const completed = await evidenceFor(participant());
  assert.equal(completed.state, "completed");
  const stale = await evidenceFor(
    participant({
      assignments: [
        {
          id: "assignment",
          workImageId: "page",
          assignedAt: start,
          workImage: { translationRevision: 3 },
        },
      ],
    }),
  );
  assert.equal(stale.state, "ready");
  assert.equal(stale.sourceKey, completed.sourceKey);
  assert.notEqual(stale.evidenceKey, completed.evidenceKey);
  assert.equal(
    (await evidenceFor(participant({ assignments: [] }))).state,
    "ready",
  );
  assert.equal(
    (await evidenceFor(participant({ submittedAt: start }))).state,
    "ended",
  );
  assert.equal(
    (await evidenceFor(participant({ leftAt: start }))).state,
    "ended",
  );
});

test("review, archive, inactivity and missing language qualification pause reminders", async () => {
  const row = participant({ contributionSubmissions: [] });
  assert.equal(
    (
      await evidenceFor({
        ...row,
        work: { ...row.work, reviewStatus: "needs_review" },
      })
    ).state,
    "paused",
  );
  assert.equal(
    (
      await evidenceFor({
        ...row,
        work: { ...row.work, workflowStatus: "archived" },
      })
    ).state,
    "paused",
  );
  assert.equal(
    (await evidenceFor({ ...row, user: { ...row.user, isActive: false } }))
      .state,
    "paused",
  );
  assert.equal(
    (
      await evidenceFor({
        ...row,
        user: { ...row.user, languageCapabilities: [] },
      })
    ).state,
    "paused",
  );
  const beforeStage = {
    ...row,
    stage: "proofread",
    user: { ...row.user, roles: [{ role: "proofreader" }] },
  };
  assert.equal((await evidenceFor(beforeStage)).state, "waiting");
  assert.equal(
    (
      await evidenceFor({
        ...row,
        work: { ...row.work, workflowStatus: "pending_proofread" },
      })
    ).state,
    "ended",
  );
});
