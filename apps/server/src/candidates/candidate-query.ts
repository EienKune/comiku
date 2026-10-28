import { BadRequestException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { CandidateQueryDto } from "./candidates.dto.js";

export function normalizeCandidateFilter(query: Partial<CandidateQueryDto>) {
  return {
    status: query.status ?? "pending",
    authorId: query.authorId ?? null,
    search: query.search?.trim().replace(/^@/, "").trim().toLowerCase() || null,
    sourceLanguage: query.sourceLanguage ?? null,
    fetchedAfter: query.fetchedAfter
      ? new Date(query.fetchedAfter).toISOString()
      : null,
    fetchedBefore: query.fetchedBefore
      ? new Date(query.fetchedBefore).toISOString()
      : null,
  };
}
export type CandidateFilter = ReturnType<typeof normalizeCandidateFilter>;
export function candidateFilterHash(filter: CandidateFilter) {
  return createHash("sha256").update(JSON.stringify(filter)).digest("hex");
}
export interface CandidateCursorBinding {
  sessionId: string | null;
  filterHash: string;
  modelKey: string | null;
  group: string | null;
}
export interface CandidateCursor extends CandidateCursorBinding {
  ordinal?: number;
  rank?: number;
  score?: number;
  postedAt?: string;
  id?: string;
}
export function encodeCandidateCursor(
  cursor: CandidateCursor,
  secret?: string,
) {
  const body = Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString(
    "base64url",
  );
  return secret
    ? `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`
    : body;
}
export function decodeCandidateCursor(
  token: string,
  binding: CandidateCursorBinding,
  secret?: string,
): CandidateCursor {
  try {
    if (token.length > 2048) throw Error();
    const parts = token.split(".");
    if (secret) {
      if (parts.length !== 2) throw Error();
      const expected = createHmac("sha256", secret).update(parts[0]).digest();
      const supplied = Buffer.from(parts[1], "base64url");
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        throw Error();
    } else if (parts.length !== 1) throw Error();
    if (!/^[A-Za-z0-9_-]+$/.test(parts[0])) throw Error();
    const value = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    if (
      value.v !== 1 ||
      Object.entries(binding).some(([key, expected]) => value[key] !== expected)
    )
      throw Error();
    if (binding.sessionId) {
      if (
        !Number.isSafeInteger(value.ordinal) ||
        value.ordinal < 1 ||
        value.ordinal > 50000
      )
        throw Error();
    } else if (
      !Number.isInteger(value.rank) ||
      value.rank < 0 ||
      value.rank > 3 ||
      !Number.isFinite(value.score) ||
      value.score < -1 ||
      value.score > 1 ||
      typeof value.postedAt !== "string" ||
      !Number.isFinite(Date.parse(value.postedAt)) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.id,
      )
    )
      throw Error();
    return value;
  } catch {
    throw new BadRequestException(
      "候选分页游标无效：需要版本 1 的不透明游标，旧 UUID 游标不再支持",
    );
  }
}

export interface CandidateAnalysisPolicy {
  modelKey: string | null;
  labels: readonly string[];
  positiveLabels: readonly string[];
  minimumConfidence: number;
}

/** Only controlled identifiers are SQL text. Every user/adapter value is a parameter. */
export function candidateBaseWhere(filter: CandidateFilter) {
  const clauses = [
    Prisma.sql`c.status::text = ${filter.status}`,
    Prisma.sql`a.deleted_at IS NULL`,
  ];
  if (filter.authorId)
    clauses.push(Prisma.sql`c.author_id = ${filter.authorId}::uuid`);
  if (filter.sourceLanguage)
    clauses.push(
      Prisma.sql`a.source_language::text = ${filter.sourceLanguage}`,
    );
  if (filter.fetchedAfter)
    clauses.push(Prisma.sql`c.fetched_at >= ${new Date(filter.fetchedAfter)}`);
  if (filter.fetchedBefore)
    clauses.push(Prisma.sql`c.fetched_at <= ${new Date(filter.fetchedBefore)}`);
  if (filter.search) {
    const pattern = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(
      Prisma.sql`(a.display_name ILIKE ${pattern} OR EXISTS (SELECT 1 FROM author_external_accounts aa WHERE aa.author_id = a.id AND aa.deleted_at IS NULL AND aa.handle ILIKE ${pattern}))`,
    );
  }
  return Prisma.join(clauses, " AND ");
}

/** Equivalent to hasEvidence + promotesReview, including malformed and partial summaries. */
export function candidateRankingCte(
  filter: CandidateFilter,
  policy: CandidateAnalysisPolicy,
) {
  const labels = [...policy.labels];
  const positive = [...policy.positiveLabels];
  return Prisma.sql`WITH evidence AS (
    SELECT c.id, c.posted_at, c.tag_disposition,
      COALESCE(d.label::text, s.label::text, 'manga') AS visual,
      CASE WHEN c.analysis_model_key = ${policy.modelKey} AND c.analysis_score BETWEEN 0 AND 1
        AND p.n > 0 AND p.n <= ${labels.length} AND p.valid AND p.n = p.distinct_labels
        THEN c.analysis_score ELSE NULL END AS score,
      COALESCE(p.promotes, false) AS promotes
    FROM candidate_posts c JOIN authors a ON a.id = c.author_id
    LEFT JOIN candidate_classification_decisions d ON d.candidate_post_id = c.id
    LEFT JOIN LATERAL (SELECT label FROM candidate_classification_suggestions WHERE candidate_post_id = c.id ORDER BY created_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, count(DISTINCT e->>'label')::int AS distinct_labels,
        bool_and(COALESCE(jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'label') = 'string'
          AND (e->>'label') = ANY(${labels}::text[])
          AND CASE WHEN jsonb_typeof(e->'confidence') = 'number' THEN (e->>'confidence')::numeric BETWEEN 0 AND 1 ELSE false END
          AND CASE WHEN jsonb_typeof(e->'score') = 'number' THEN (e->>'score')::numeric BETWEEN 0 AND 1 ELSE false END, false)) AS valid,
        bool_or((e->>'label') = ANY(${positive}::text[]) AND CASE WHEN jsonb_typeof(e->'confidence') = 'number' THEN (e->>'confidence')::numeric >= ${policy.minimumConfidence} ELSE false END) AS promotes
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.analysis_predictions) = 'array' THEN c.analysis_predictions ELSE '[]'::jsonb END) e
    ) p ON true
    WHERE ${candidateBaseWhere(filter)}
  ), grouped AS (
    SELECT *, CASE WHEN visual = 'photo' THEN 'photo'
      WHEN tag_disposition = 'blocked' THEN 'blocked_manga'
      WHEN tag_disposition = 'valid' OR (score IS NOT NULL AND promotes) THEN 'valid_manga'
      ELSE 'neutral_manga' END AS triage_group FROM evidence
  ), ranked AS (
    SELECT id, posted_at, triage_group, score AS frozen_score,
      CASE WHEN ${filter.status} <> 'pending' THEN 0 WHEN triage_group = 'valid_manga' THEN 0 WHEN triage_group = 'neutral_manga' THEN 1 WHEN triage_group = 'blocked_manga' THEN 2 ELSE 3 END AS rank,
      CASE WHEN ${filter.status} = 'pending' THEN COALESCE(score, -1) ELSE -1 END AS sort_score
    FROM grouped
  )`;
}

export function candidatePendingSql(
  filter: CandidateFilter,
  modelKey: string | null,
  sessionId?: string,
) {
  if (!modelKey) return Prisma.sql`SELECT false AS pending`;
  return Prisma.sql`SELECT EXISTS (
    SELECT 1 FROM candidate_posts c JOIN authors a ON a.id = c.author_id
    JOIN candidate_media m ON m.candidate_post_id = c.id
    JOIN file_objects f ON f.id = m.file_object_id
    LEFT JOIN candidate_media_analyses ma ON ma.media_id = m.id AND ma.model_key = ${modelKey}
    WHERE ${candidateBaseWhere(filter)} AND f.lifecycle_status = 'active' AND f.deleted_at IS NULL
    ${sessionId ? Prisma.sql`AND EXISTS (SELECT 1 FROM candidate_review_session_entries e WHERE e.session_id = ${sessionId}::uuid AND e.candidate_id = c.id)` : Prisma.empty}
    AND (ma.id IS NULL OR ma.status = 'queued' OR c.analysis_model_key IS DISTINCT FROM ${modelKey} OR c.analysis_summary_version < 1)
  ) AS pending`;
}
