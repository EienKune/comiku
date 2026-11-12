import type { Prisma } from "../generated/prisma/client.js";
import { notificationMessageSegments } from "../notifications/notification-message-segments.js";
import {
  lockReminderEvidence,
  readReminderEvidence,
  WORK_REMINDER_PROJECTION_LOCK,
} from "./work-reminder-projection.js";
import {
  MAX_OBSERVATION_GAP_MILLISECONDS,
  OVERDUE_MILLISECONDS,
} from "./work-reminder-policy.js";
import type { WorkDigestSnapshot } from "./work-reminder-render.js";

export async function lockWorkReminderSettings(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM work_reminder_settings WHERE id = 'global' FOR SHARE`;
  return tx.workReminderSettings.findUnique({ where: { id: "global" } });
}
export async function lockWorkReminderSubscription(
  tx: Prisma.TransactionClient,
  channelId: string,
) {
  await tx.$queryRaw`SELECT channel_id FROM work_reminder_subscriptions WHERE channel_id = ${channelId}::uuid FOR SHARE`;
  return tx.workReminderSubscription.findUnique({ where: { channelId } });
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function snapshot(value: unknown): WorkDigestSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as WorkDigestSnapshot;
  if (
    row.kind !== "work_digest" ||
    !Array.isArray(row.items) ||
    row.items.length > 5 ||
    !Number.isFinite(Date.parse(row.dueAt)) ||
    !Number.isFinite(Date.parse(row.validBefore)) ||
    !Number.isFinite(Date.parse(row.observedAt)) ||
    Date.parse(row.dueAt) >= Date.parse(row.validBefore)
  )
    return null;
  for (const item of row.items) {
    if (
      !item ||
      ![item.participantId, item.workId, item.userId].every(
        (id) => typeof id === "string" && uuid.test(id),
      ) ||
      !Number.isSafeInteger(item.round) ||
      item.round < 1 ||
      !Number.isSafeInteger(item.userRevision) ||
      item.userRevision < 0 ||
      !["ready", "overdue"].includes(item.kind) ||
      !["translate", "proofread", "typeset"].includes(item.stage) ||
      typeof item.sourceKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sourceKey) ||
      (item.qqNumber !== null &&
        (typeof item.qqNumber !== "string" ||
          !/^[1-9][0-9]{4,19}$/.test(item.qqNumber)))
    )
      return null;
  }
  return row;
}

/** The transport payload must represent exactly the frozen text and contacts. */
export function workReminderMessageValid(
  snapshotValue: unknown,
  message: unknown,
  text: string,
): boolean {
  const frozen = snapshot(snapshotValue),
    segments = notificationMessageSegments(message);
  if (
    !frozen ||
    !segments ||
    segments
      .filter((s) => s.type === "text")
      .map((s) => s.data.text)
      .join("") !== text
  )
    return false;
  const expected = [
    ...new Set(
      frozen.items.map((item) => item.qqNumber).filter((qq) => qq !== null),
    ),
  ].sort();
  const actual = segments
    .filter((s) => s.type === "at")
    .map((s) => s.data.qq)
    .sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export async function workReminderDeliveryInvalidReason(
  snapshotValue: unknown,
  generations: {
    reminderGeneration?: number | null;
    reminderScopeGeneration?: number | null;
  },
  settings: Awaited<ReturnType<typeof lockWorkReminderSettings>>,
  scope: Awaited<ReturnType<typeof lockWorkReminderSubscription>>,
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<string | null> {
  const frozen = snapshot(snapshotValue);
  if (!frozen) return "work_reminder_snapshot_invalid";
  const dueAt = new Date(frozen.dueAt);
  if (now < dueAt || now.getTime() >= Date.parse(frozen.validBefore))
    return "work_reminder_expired";
  if (
    !settings?.enabled ||
    settings.generation !== generations.reminderGeneration ||
    settings.acceptAfter > dueAt ||
    !settings.sendTimes.includes(frozen.slot)
  )
    return "work_reminder_settings_changed";
  if (
    !scope ||
    scope.generation !== generations.reminderScopeGeneration ||
    scope.acceptAfter > dueAt ||
    !(scope.digestEnabled || scope.readyEnabled || scope.overdueEnabled)
  )
    return "work_reminder_subscription_changed";
  if (!frozen.items.length) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${WORK_REMINDER_PROJECTION_LOCK}, 0))`;
  const clock = await tx.workReminderClock.findUnique({
    where: { id: "global" },
  });
  if (
    !clock ||
    now.getTime() - clock.lastObservedAt.getTime() >
      MAX_OBSERVATION_GAP_MILLISECONDS
  )
    return "work_reminder_observation_stale";
  // NOWAIT avoids introducing a wait cycle with business transactions. A busy
  // reservation rolls back before creating an attempt and uses safe job retry.
  await lockReminderEvidence(
    tx,
    frozen.items.map((item) => item.workId),
    frozen.items.map((item) => item.userId),
  );
  const evidence = await readReminderEvidence(
    tx,
    frozen.items.map((item) => item.participantId),
  );
  const episodes = await tx.workReminderEpisode.findMany({
    where: {
      participantId: { in: frozen.items.map((item) => item.participantId) },
    },
  });
  for (const item of frozen.items) {
    const current = evidence.find(
        (row) => row.participantId === item.participantId,
      ),
      episode = episodes.find(
        (row) => row.participantId === item.participantId,
      );
    if (
      !current?.eligible ||
      !episode ||
      episode.round !== item.round ||
      episode.state !== "ready" ||
      episode.sourceKey !== item.sourceKey ||
      current.sourceKey !== item.sourceKey ||
      current.evidenceKey !== episode.evidenceKey ||
      current.userId !== item.userId ||
      current.workId !== item.workId ||
      current.stage !== item.stage ||
      current.userRevision !== item.userRevision ||
      (scope.mentionsEnabled && current.qqNumber !== item.qqNumber)
    )
      return "work_reminder_task_changed";
    const elapsed =
      clock.elapsedMilliseconds > episode.clockMilliseconds
        ? clock.elapsedMilliseconds - episode.clockMilliseconds
        : 0n;
    if (
      item.kind === "ready" &&
      (!scope.readyEnabled || !episode.preclaimed || !episode.readyObservedAt)
    )
      return "work_reminder_task_changed";
    if (
      item.kind === "overdue" &&
      (!scope.overdueEnabled ||
        episode.eligibleMilliseconds + elapsed < BigInt(OVERDUE_MILLISECONDS))
    )
      return "work_reminder_task_changed";
  }
  return null;
}
