import {
  candidateTagRules,
  candidateReviewPolicyKey,
  CANDIDATE_REVIEW_POLICY_VERSION,
} from "./candidate-review-evidence.js";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  Prisma,
  type CandidateReviewSession,
} from "../generated/prisma/client.js";
import type { PrismaService } from "../database/prisma.service.js";
import { permissionsFor } from "../common/access.js";
import {
  candidateBaseWhere,
  candidateFilterHash,
  candidateRankingCte,
  normalizeCandidateFilter,
  type CandidateAnalysisPolicy,
  type CandidateFilter,
} from "./candidate-query.js";
import type {
  CandidateReviewSessionDto,
  CreateCandidateReviewSessionDto,
} from "./candidates.dto.js";

export const REVIEW_IDLE_MS = 30 * 60_000;
export const REVIEW_HARD_MS = 2 * 60 * 60_000;
export const REVIEW_TOUCH_MS = 5 * 60_000;
export const REVIEW_MAX_MEMBERS = 50_000;
export const REVIEW_CLEANUP_ENTRIES = 2_000;

export async function assertCandidateReader(
  tx: Prisma.TransactionClient,
  actorId: string,
  lock = false,
) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR UPDATE`;
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    include: { roles: true },
  });
  if (
    !actor?.isActive ||
    !permissionsFor(
      actor.roles.map((role) => role.role),
      actor.mustChangePassword,
    ).includes("candidates:read")
  )
    throw new ForbiddenException("当前职务不能查看候选");
}

export class CandidateReviewSessions {
  constructor(private readonly db: PrismaService) {}

  async create(
    actorId: string,
    input: CreateCandidateReviewSessionDto,
    policy: CandidateAnalysisPolicy,
  ): Promise<CandidateReviewSessionDto> {
    const filter = normalizeCandidateFilter(input);
    const filterHash = candidateFilterHash(filter);
    return this.db.$transaction(
      async (tx) => {
        // Serialize idempotency, replacement and the three-session quota across tabs.
        await assertCandidateReader(tx, actorId, true);
        const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS now`;
        const previous = await tx.candidateReviewSession.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (previous) {
          this.validate(previous, actorId, filterHash, policy.modelKey, now);
          return this.dto(tx, previous);
        }
        if (input.replaceSessionId) {
          const replaced = await tx.candidateReviewSession.findUnique({
            where: { id: input.replaceSessionId },
          });
          // A collected/expired old ID is harmless; a different owner's ID is never accepted.
          if (replaced && replaced.actorId !== actorId)
            throw new ForbiddenException("审核会话不属于当前用户");
        }
        const ruleSnapshot = await candidateTagRules(tx);
        const session = await tx.candidateReviewSession.create({
          data: {
            id: randomUUID(),
            actorId,
            idempotencyKey: input.idempotencyKey,
            cursorSecret: randomUUID(),
            normalizedFilterJson: filter,
            filterHash,
            modelKey: policy.modelKey,
            policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
            rulesVersion: ruleSnapshot.version,
            reviewPolicyKey: candidateReviewPolicyKey(policy),
            createdAt: now,
            lastUsedAt: now,
            expiresAt: new Date(+now + REVIEW_IDLE_MS),
            hardExpiresAt: new Date(+now + REVIEW_HARD_MS),
          },
        });
        const inserted =
          await tx.$executeRaw`${candidateRankingCte(filter, policy, ruleSnapshot.rules)}
        INSERT INTO candidate_review_session_entries(session_id, candidate_id, ordinal, triage_group, frozen_score, reason_json)
        SELECT ${session.id}::uuid, id, row_number() OVER (ORDER BY rank, sort_score DESC, posted_at DESC, id DESC)::int, triage_group, frozen_score, reason_json
        FROM ranked ORDER BY rank, sort_score DESC, posted_at DESC, id DESC LIMIT ${REVIEW_MAX_MEMBERS + 1}`;
        if (inserted > REVIEW_MAX_MEMBERS)
          throw new BadRequestException(
            "候选超过 50000 项，请缩小筛选范围后刷新列表",
          );
        if (input.replaceSessionId)
          await tx.$executeRaw`UPDATE candidate_review_sessions
            SET expires_at = LEAST(expires_at, date_trunc('milliseconds', clock_timestamp()))
            WHERE id = ${input.replaceSessionId}::uuid AND actor_id = ${actorId}::uuid
            AND idempotency_key <> ${input.idempotencyKey}::uuid`;
        const [{ now: quotaNow }] = await tx.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS now`;
        const active = await tx.candidateReviewSession.findMany({
          where: {
            actorId,
            expiresAt: { gt: quotaNow },
            hardExpiresAt: { gt: quotaNow },
          },
          orderBy: [
            { lastUsedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          select: { id: true },
        });
        const evict = active
          .filter((row) => row.id !== session.id)
          .slice(2)
          .map((row) => row.id);
        if (evict.length)
          await tx.$executeRaw`UPDATE candidate_review_sessions
            SET expires_at = LEAST(expires_at, date_trunc('milliseconds', clock_timestamp()))
            WHERE id = ANY(${evict}::uuid[])`;
        return this.dto(tx, session);
      },
      { timeout: 30_000 },
    );
  }

  validate(
    session: CandidateReviewSession | null,
    actorId: string,
    filterHash: string,
    modelKey: string | null,
    now = new Date(),
  ) {
    if (!session || session.expiresAt <= now || session.hardExpiresAt <= now)
      throw new GoneException("审核会话已过期，请刷新列表");
    if (session.actorId !== actorId)
      throw new ForbiddenException("审核会话不属于当前用户");
    if (session.policyVersion !== CANDIDATE_REVIEW_POLICY_VERSION)
      throw new ConflictException("审核会话格式已更新，请刷新列表");
    if (session.filterHash !== filterHash || session.modelKey !== modelKey)
      throw new ConflictException("审核筛选或模型已改变，请刷新列表");
    return session;
  }

  async read(
    tx: Prisma.TransactionClient,
    id: string,
    actorId: string,
    filter: CandidateFilter,
    modelKey: string | null,
  ) {
    await assertCandidateReader(tx, actorId);
    // Preliminary state is only a renewal CAS input, never authority to admit a
    // page. Invalidation or cleanup may commit after this unlocked read.
    const original = this.validate(
      await tx.candidateReviewSession.findUnique({ where: { id } }),
      actorId,
      candidateFilterHash(filter),
      modelKey,
    );
    const [{ now: renewalNow }] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS now`;
    const renewalDue = +renewalNow - +original.lastUsedAt >= REVIEW_TOUCH_MS;
    // Choose before taking any row lock. A due renewal must acquire its write
    // lock before capturing authoritative time; statement-time CTEs can become
    // stale while UPDATE waits behind a reader's SHARE lock.
    if (renewalDue)
      await tx.$queryRaw`SELECT id FROM candidate_review_sessions
        WHERE id = ${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM candidate_review_sessions
        WHERE id = ${id}::uuid FOR SHARE`;
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS now`;
    const session = this.validate(
      await tx.candidateReviewSession.findUnique({ where: { id } }),
      actorId,
      candidateFilterHash(filter),
      modelKey,
      now,
    );
    // Another renewal may have won before our write lock. Recheck the locked
    // state, and never upgrade a non-due SHARE reader if the threshold crossed
    // during its wait: the next request can renew while this page stays protected.
    if (renewalDue && +now - +session.lastUsedAt >= REVIEW_TOUCH_MS) {
      const changed = await tx.$executeRaw`WITH moment AS MATERIALIZED (
        SELECT clock_timestamp() AS now
      ) UPDATE candidate_review_sessions s
        SET last_used_at = moment.now,
          expires_at = LEAST(moment.now + interval '30 minutes', s.hard_expires_at)
        FROM moment WHERE s.id = ${id}::uuid
          AND s.last_used_at = ${session.lastUsedAt}
          AND s.expires_at = ${session.expiresAt}
          AND s.hard_expires_at = ${session.hardExpiresAt}
          AND s.last_used_at <= moment.now - interval '5 minutes'
          AND s.expires_at > moment.now AND s.hard_expires_at > moment.now`;
      // We already hold the write lock: zero cannot be a competing renewal.
      // Reject a deadline crossed since the locked validation instead of reviving it.
      if (changed !== 1) throw new GoneException("审核会话已过期，请刷新列表");
    }
    return session;
  }

  private async dto(
    tx: Prisma.TransactionClient,
    session: CandidateReviewSession,
  ): Promise<CandidateReviewSessionDto> {
    const rows = await tx.$queryRaw<
      { group: string; count: number }[]
    >`SELECT e.triage_group AS "group", count(*)::int AS count FROM candidate_review_session_entries e JOIN candidate_posts c ON c.id = e.candidate_id JOIN authors a ON a.id = c.author_id WHERE e.session_id = ${session.id}::uuid AND ${candidateBaseWhere(session.normalizedFilterJson as CandidateFilter)} GROUP BY e.triage_group`;
    const counts = {
      priority: 0,
      uncertain: 0,
      low_priority: 0,
    };
    for (const row of rows)
      if (row.group in counts)
        counts[row.group as keyof typeof counts] = row.count;
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      counts,
    };
  }

  /** Snapshot locks serialize cleanup with reads/renewal; never lock candidates. */
  async cleanup(now = new Date()) {
    return this.db.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM candidate_review_sessions
        WHERE expires_at <= LEAST(${now}, clock_timestamp())
        ORDER BY expires_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`;
      if (!expired.length) return { entries: 0, sessions: 0 };
      const ids = expired.map((session) => session.id);
      const entries = await tx.$executeRaw`WITH batch AS (
        SELECT session_id, candidate_id FROM candidate_review_session_entries
        WHERE session_id = ANY(${ids}::uuid[])
        ORDER BY session_id, ordinal LIMIT ${REVIEW_CLEANUP_ENTRIES}
      ) DELETE FROM candidate_review_session_entries e USING batch b
        WHERE e.session_id = b.session_id AND e.candidate_id = b.candidate_id`;
      const sessions =
        await tx.$executeRaw`DELETE FROM candidate_review_sessions s
        WHERE s.id = ANY(${ids}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM candidate_review_session_entries e WHERE e.session_id = s.id)`;
      return { entries, sessions };
    });
  }
}
