import { createHash } from "node:crypto";
import type { WorkStage } from "../generated/prisma/client.js";

export const OVERDUE_MILLISECONDS = 72 * 60 * 60 * 1000;
export const MAX_OBSERVATION_GAP_MILLISECONDS = 120_000;

export type ReminderState =
  "waiting" | "ready" | "paused" | "completed" | "ended";

export interface ReminderEvidence {
  participantId: string;
  userId: string;
  workId: string;
  workNumber: number;
  title: string | null;
  displayName: string;
  stage: WorkStage;
  qqNumber: string | null;
  userRevision: number;
  sourceKey: string;
  evidenceKey: string;
  state: ReminderState;
  eligible: boolean;
  waiting: boolean;
  completed: boolean;
  ended: boolean;
  /** Proven initial reservation, never an inference from current readiness. */
  preclaimed?: boolean;
}

export interface ReminderObservation {
  round: number;
  state: string;
  sourceKey: string;
  evidenceKey: string;
  eligibleMilliseconds: bigint;
  clockMilliseconds: bigint;
  lastObservedAt: Date;
  readyObservedAt: Date | null;
  preclaimed: boolean;
}

export function reminderKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface ReminderClock {
  elapsedMilliseconds: bigint;
  lastObservedAt: Date;
}

export function advanceReminderClock(
  previous: ReminderClock | null,
  now: Date,
): ReminderClock {
  if (!previous) return { elapsedMilliseconds: 0n, lastObservedAt: now };
  const elapsed = now.getTime() - previous.lastObservedAt.getTime();
  if (elapsed <= 0) return previous;
  return {
    elapsedMilliseconds:
      previous.elapsedMilliseconds +
      (elapsed <= MAX_OBSERVATION_GAP_MILLISECONDS ? BigInt(elapsed) : 0n),
    lastObservedAt: now,
  };
}

// Observation evidence deliberately cannot reconstruct unobserved business history.
// An uncertain interval is lost, but an ordinary revision never resets prior time.
export function observeReminder(
  previous: ReminderObservation | null,
  evidence: Pick<
    ReminderEvidence,
    "state" | "sourceKey" | "evidenceKey" | "preclaimed"
  >,
  now: Date,
  clockMilliseconds?: bigint,
): ReminderObservation {
  if (previous && now.getTime() <= previous.lastObservedAt.getTime())
    return previous;
  const newRound = Boolean(
    previous &&
    (previous.sourceKey !== evidence.sourceKey ||
      ((previous.state === "completed" || previous.state === "ended") &&
        evidence.state === "ready")),
  );
  const elapsed = previous
    ? now.getTime() - previous.lastObservedAt.getTime()
    : 0;
  const clock =
    clockMilliseconds ??
    (previous?.clockMilliseconds ?? 0n) +
      (elapsed > 0 && elapsed <= MAX_OBSERVATION_GAP_MILLISECONDS
        ? BigInt(elapsed)
        : 0n);
  const clockDelta = previous ? clock - previous.clockMilliseconds : 0n;
  const trusted = Boolean(
    previous &&
    !newRound &&
    previous.state === "ready" &&
    evidence.state === "ready" &&
    previous.evidenceKey === evidence.evidenceKey &&
    elapsed > 0 &&
    clockDelta >= 0n,
  );
  return {
    round: previous ? previous.round + Number(newRound) : 1,
    state: evidence.state,
    sourceKey: evidence.sourceKey,
    evidenceKey: evidence.evidenceKey,
    eligibleMilliseconds:
      (newRound ? 0n : (previous?.eligibleMilliseconds ?? 0n)) +
      (trusted ? clockDelta : 0n),
    clockMilliseconds: clock,
    lastObservedAt: now,
    readyObservedAt:
      evidence.state === "ready"
        ? (!newRound && previous?.readyObservedAt) || now
        : newRound
          ? null
          : (previous?.readyObservedAt ?? null),
    preclaimed:
      evidence.state === "waiting" ||
      (!newRound && (previous?.preclaimed ?? false)) ||
      (evidence.preclaimed === true &&
        (!previous || (!newRound && previous.round === 1))),
  };
}
