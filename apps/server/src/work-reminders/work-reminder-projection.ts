import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../database/prisma.service.js";
import { currentStageStatuses } from "../works/personal-work-policy.js";
import {
  canUserWorkStage,
  claimableWorkStatuses,
} from "../workflow/workflow-policy.js";
import {
  observeReminder,
  advanceReminderClock,
  MAX_OBSERVATION_GAP_MILLISECONDS,
  OVERDUE_MILLISECONDS,
  reminderKey,
  type ReminderEvidence,
  type ReminderState,
} from "./work-reminder-policy.js";

export type { ReminderEvidence } from "./work-reminder-policy.js";
type Tx = Prisma.TransactionClient;
export const WORK_REMINDER_PROJECTION_LOCK = "comiku:work-reminder-projection";

// The caller holds these only while freezing/rechecking delivery intent, never
// across an external send. NOWAIT prevents conflict with business lock orders.
export async function lockReminderEvidence(
  tx: Tx,
  workIds: string[],
  userIds: string[],
): Promise<void> {
  if (workIds.length)
    await tx.$queryRaw(Prisma.sql`
    SELECT id FROM works
    WHERE id IN (${Prisma.join([...new Set(workIds)].sort().map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id FOR SHARE NOWAIT
  `);
  if (userIds.length)
    await tx.$queryRaw(Prisma.sql`
    SELECT id FROM users
    WHERE id IN (${Prisma.join([...new Set(userIds)].sort().map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id FOR SHARE NOWAIT
  `);
}

export async function readReminderEvidence(
  tx: Tx,
  participantIds: string[],
): Promise<ReminderEvidence[]> {
  if (!participantIds.length) return [];
  const participants = await tx.workStageParticipant.findMany({
    where: { id: { in: participantIds } },
    select: {
      id: true,
      workId: true,
      userId: true,
      stage: true,
      joinedAt: true,
      leftAt: true,
      submittedAt: true,
      user: {
        select: {
          displayName: true,
          qqNumber: true,
          revision: true,
          isActive: true,
          roles: { select: { role: true } },
          languageCapabilities: { select: { language: true } },
        },
      },
      work: {
        select: {
          workNumber: true,
          title: true,
          sourceLanguage: true,
          collaborationMode: true,
          workflowStatus: true,
          reviewStatus: true,
          revision: true,
          editorEpoch: true,
          proofreadSkippedVersionId: true,
        },
      },
      assignments: {
        orderBy: { workImageId: "asc" },
        select: {
          id: true,
          workImageId: true,
          assignedAt: true,
          workImage: { select: { translationRevision: true } },
        },
      },
      contributionSubmissions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          pages: { select: { workImageId: true, imageRevision: true } },
        },
      },
    },
  });
  const cancellations = await tx.$queryRaw<
    { participantId: string; cancelKey: string }[]
  >(Prisma.sql`
    SELECT p.id AS "participantId", cancelled.token AS "cancelKey"
    FROM work_stage_participants p
    LEFT JOIN LATERAL (
      SELECT count(*)::text || ':' || coalesce(max(e.id::text), '') AS token FROM work_events e
      WHERE e.work_id = p.work_id AND e.action = 'stage_submission_cancelled'
        AND e.detail->>'stage' = p.stage::text
        AND e.detail->'restoredParticipantIds' @> jsonb_build_array(p.id::text)
    ) cancelled ON true
    WHERE p.id IN (${Prisma.join(participantIds.map((id) => Prisma.sql`${id}::uuid`))})
  `);
  const cancelByParticipant = new Map(
    cancellations.map((item) => [item.participantId, item.cancelKey]),
  );
  return participants.map((participant) => {
    const { work, user, stage } = participant;
    const submission = participant.contributionSubmissions[0];
    const contributionCurrent =
      work.collaborationMode === "multi" &&
      (stage === "translate" || stage === "proofread") &&
      Boolean(
        submission &&
        participant.assignments.length &&
        participant.assignments.every((assignment) =>
          submission.pages.some(
            (page) =>
              page.workImageId === assignment.workImageId &&
              page.imageRevision === assignment.workImage.translationRevision,
          ),
        ),
      );
    let state: ReminderState;
    if (
      participant.leftAt ||
      participant.submittedAt ||
      stage === "publish" ||
      (stage === "proofread" && work.proofreadSkippedVersionId)
    )
      state = "ended";
    else if (work.workflowStatus === "archived") state = "paused";
    else if (!claimableWorkStatuses(stage).includes(work.workflowStatus))
      state = "ended";
    else if (
      work.reviewStatus !== "normal" ||
      !user.isActive ||
      !canUserWorkStage(
        user.roles.map(({ role }) => role),
        user.languageCapabilities.map(({ language }) => language),
        stage,
        work.sourceLanguage,
      )
    )
      state = "paused";
    else if (!currentStageStatuses(stage).includes(work.workflowStatus))
      state = "waiting";
    else state = contributionCurrent ? "completed" : "ready";
    const sourceKey = reminderKey({
      participantId: participant.id,
      joinedAt: participant.joinedAt,
      cancel: cancelByParticipant.get(participant.id) ?? "0:",
      contribution: submission?.id ?? null,
      assignments: participant.assignments.map(
        ({ id, workImageId, assignedAt }) => ({ id, workImageId, assignedAt }),
      ),
    });
    const evidenceKey = reminderKey({
      sourceKey,
      workRevision: work.revision,
      editorEpoch: work.editorEpoch,
      userRevision: user.revision,
      active: user.isActive,
      roles: user.roles.map(({ role }) => role).sort(),
      languages: user.languageCapabilities
        .map(({ language }) => language)
        .sort(),
      state,
      submittedAt: participant.submittedAt,
      leftAt: participant.leftAt,
      pages: participant.assignments.map(({ workImageId, workImage }) => [
        workImageId,
        workImage.translationRevision,
      ]),
    });
    return {
      participantId: participant.id,
      workId: participant.workId,
      userId: participant.userId,
      workNumber: work.workNumber,
      title: work.title,
      displayName: user.displayName,
      stage,
      qqNumber: user.qqNumber,
      userRevision: user.revision,
      sourceKey,
      evidenceKey,
      state,
      eligible: state === "ready",
      waiting: state === "waiting",
      completed: state === "completed",
      ended: state === "ended",
    };
  });
}

export interface ReminderItem extends ReminderEvidence {
  kind: "ready" | "overdue";
  round: number;
  eligibleMilliseconds: number;
}

export interface ReminderItemsOptions {
  channelId: string;
  scopeGeneration: number;
  readyEnabled: boolean;
  overdueEnabled: boolean;
  limit?: number;
}

export class WorkReminderProjection {
  constructor(private readonly db: PrismaService) {}

  async maintain(
    now = new Date(),
    take = 500,
  ): Promise<{ processed: number; acquired: boolean }> {
    const limit = Math.max(2, Math.min(500, Math.trunc(take)));
    return this.db.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${WORK_REMINDER_PROJECTION_LOCK}, 0)) AS acquired
      `);
      if (!lock?.acquired) return { processed: 0, acquired: false };
      const previousClock = await tx.workReminderClock.findUnique({
        where: { id: "global" },
      });
      if (
        previousClock &&
        now.getTime() < previousClock.lastObservedAt.getTime()
      )
        return { processed: 0, acquired: true };
      const clock = advanceReminderClock(previousClock, now);
      await tx.workReminderClock.upsert({
        where: { id: "global" },
        create: { id: "global", ...clock },
        update: clock,
      });
      // Reserve capacity for both discovery and the oldest observations. An
      // endless stream of new claims cannot prevent existing clocks advancing.
      const fresh = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM work_stage_participants p
        WHERE p.left_at IS NULL AND p.submitted_at IS NULL AND p.stage <> 'publish'
          AND NOT EXISTS (SELECT 1 FROM work_reminder_episodes e WHERE e.participant_id = p.id)
        ORDER BY p.joined_at, p.id LIMIT ${Math.ceil(limit / 2)}
      `);
      // Ended rows do not age through the regular queue. Re-entry starts from
      // the indexed active-participant set, so historical ended rows cannot
      // become an ever-growing prefix scanned before every live observation.
      const revived = await tx.$queryRaw<
        { participantId: string }[]
      >(Prisma.sql`
        SELECT e.participant_id AS "participantId"
        FROM work_stage_participants p JOIN works w ON w.id = p.work_id
        CROSS JOIN LATERAL (
          SELECT e.participant_id FROM work_reminder_episodes e
          WHERE e.participant_id = p.id AND e.state = 'ended'
          FOR UPDATE OF e SKIP LOCKED
        ) e
        WHERE p.left_at IS NULL AND p.submitted_at IS NULL AND p.stage <> 'publish'
          AND ((p.stage = 'translate' AND w.workflow_status IN ('pending_translate', 'translating'))
            OR (p.stage = 'proofread' AND w.proofread_skipped_version_id IS NULL
              AND w.workflow_status IN ('pending_translate', 'translating', 'pending_proofread', 'proofreading'))
            OR (p.stage = 'typeset' AND w.workflow_status IN ('pending_translate', 'translating',
              'pending_proofread', 'proofreading', 'pending_typeset', 'typesetting')))
        ORDER BY p.joined_at, p.id LIMIT ${Math.min(Math.floor(limit / 4), limit - fresh.length)}
      `);
      const observed = await tx.$queryRaw<
        { participantId: string }[]
      >(Prisma.sql`
        SELECT e.participant_id AS "participantId" FROM work_reminder_episodes e
        WHERE e.state <> 'ended'
        ORDER BY e.last_observed_at, e.participant_id
        LIMIT ${limit - fresh.length - revived.length} FOR UPDATE OF e SKIP LOCKED
      `);
      const ids = [
        ...fresh.map(({ id }) => id),
        ...revived.map(({ participantId }) => participantId),
        ...observed.map(({ participantId }) => participantId),
      ];
      const previous = await tx.workReminderEpisode.findMany({
        where: { participantId: { in: ids } },
      });
      const byId = new Map(previous.map((item) => [item.participantId, item]));
      const evidence = await readReminderEvidence(tx, ids);
      const rows = evidence.map((item) => {
        const data = observeReminder(
          byId.get(item.participantId) ?? null,
          item,
          now,
          clock.elapsedMilliseconds,
        );
        return Prisma.sql`(${item.participantId}::uuid, ${item.workId}::uuid, ${item.userId}::uuid,
          ${item.stage}::"WorkStage", ${data.round}, ${data.state}, ${data.sourceKey}, ${data.evidenceKey},
          ${data.eligibleMilliseconds}, ${data.clockMilliseconds}, ${data.lastObservedAt},
          ${data.readyObservedAt}, ${data.preclaimed}, ${now}, ${now})`;
      });
      if (rows.length)
        await tx.$executeRaw(Prisma.sql`
        INSERT INTO work_reminder_episodes (participant_id, work_id, user_id, stage, round, state,
          source_key, evidence_key, eligible_milliseconds, clock_milliseconds, last_observed_at,
          ready_observed_at, preclaimed, created_at, updated_at)
        VALUES ${Prisma.join(rows)}
        ON CONFLICT (participant_id) DO UPDATE SET
          round = EXCLUDED.round, state = EXCLUDED.state, source_key = EXCLUDED.source_key,
          evidence_key = EXCLUDED.evidence_key, eligible_milliseconds = EXCLUDED.eligible_milliseconds,
          clock_milliseconds = EXCLUDED.clock_milliseconds, last_observed_at = EXCLUDED.last_observed_at,
          ready_observed_at = EXCLUDED.ready_observed_at, preclaimed = EXCLUDED.preclaimed,
          updated_at = EXCLUDED.updated_at
      `);
      // A deleted participant must not retain a deliverable projection.
      const existing = new Set(
        evidence.map(({ participantId }) => participantId),
      );
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length)
        await tx.workReminderEpisode.deleteMany({
          where: { participantId: { in: missing } },
        });
      return { processed: ids.length, acquired: true };
    });
  }

  async readItems(
    tx: Tx,
    now: Date,
    options: ReminderItemsOptions,
  ): Promise<{
    items: ReminderItem[];
    readyCount: number;
    overdueCount: number;
  }> {
    const limit = Math.max(1, Math.min(5, options.limit ?? 5));
    const clock = await tx.workReminderClock.findUnique({
      where: { id: "global" },
    });
    if (
      !clock ||
      clock.lastObservedAt.getTime() > now.getTime() ||
      now.getTime() - clock.lastObservedAt.getTime() >
        MAX_OBSERVATION_GAP_MILLISECONDS
    ) {
      return { items: [], readyCount: 0, overdueCount: 0 };
    }
    // Rehydrate the exact current source/evidence before accepting this clock
    // continuation. A healthy shared clock may advance while this participant
    // waits for its bounded maintenance turn.
    const eligibleMilliseconds = Prisma.sql`(e.eligible_milliseconds +
      GREATEST(0::bigint, ${clock.elapsedMilliseconds}::bigint - e.clock_milliseconds))`;
    const predicate = Prisma.sql`
      e.state = 'ready' AND e.last_observed_at <= ${now}
      AND ((k.kind = 'ready' AND ${options.readyEnabled} AND e.preclaimed AND e.ready_observed_at IS NOT NULL
          AND (NOT ${options.overdueEnabled} OR ${eligibleMilliseconds} < ${BigInt(OVERDUE_MILLISECONDS)}))
        OR (k.kind = 'overdue' AND ${options.overdueEnabled} AND ${eligibleMilliseconds} >= ${BigInt(OVERDUE_MILLISECONDS)}))
      AND NOT EXISTS (SELECT 1 FROM work_reminder_notices n
        WHERE n.participant_id = e.participant_id AND n.round = e.round AND n.kind = k.kind
          AND n.channel_id = ${options.channelId}::uuid)
    `;
    const counts = await tx.$queryRaw<
      { kind: string; count: bigint }[]
    >(Prisma.sql`
      SELECT k.kind, count(*) AS count FROM work_reminder_episodes e
      CROSS JOIN (VALUES ('ready'), ('overdue')) k(kind)
      WHERE ${predicate} GROUP BY k.kind
    `);
    const candidates = await tx.$queryRaw<
      {
        participantId: string;
        workId: string;
        userId: string;
        round: number;
        kind: "ready" | "overdue";
        sourceKey: string;
        evidenceKey: string;
        eligibleMilliseconds: bigint;
      }[]
    >(Prisma.sql`
      SELECT e.participant_id AS "participantId", e.work_id AS "workId", e.user_id AS "userId", e.round, k.kind,
        e.source_key AS "sourceKey", e.evidence_key AS "evidenceKey",
        ${eligibleMilliseconds} AS "eligibleMilliseconds"
      FROM work_reminder_episodes e CROSS JOIN (VALUES ('ready'), ('overdue')) k(kind)
      WHERE ${predicate}
      ORDER BY k.kind, e.ready_observed_at, e.participant_id LIMIT ${limit}
    `);
    await lockReminderEvidence(
      tx,
      candidates.map(({ workId }) => workId),
      candidates.map(({ userId }) => userId),
    );
    const evidence = await readReminderEvidence(
      tx,
      candidates.map(({ participantId }) => participantId),
    );
    const byId = new Map(evidence.map((item) => [item.participantId, item]));
    const result = {
      items: [] as ReminderItem[],
      readyCount: 0,
      overdueCount: 0,
    };
    for (const row of counts)
      result[row.kind === "ready" ? "readyCount" : "overdueCount"] = Number(
        row.count,
      );
    for (const candidate of candidates) {
      const item = byId.get(candidate.participantId);
      if (
        item?.eligible &&
        item.sourceKey === candidate.sourceKey &&
        item.evidenceKey === candidate.evidenceKey
      ) {
        result.items.push({
          ...item,
          kind: candidate.kind,
          round: candidate.round,
          eligibleMilliseconds: Number(candidate.eligibleMilliseconds),
        });
      } else {
        result[candidate.kind === "ready" ? "readyCount" : "overdueCount"]--;
      }
    }
    return result;
  }
}
