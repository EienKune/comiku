import { BadRequestException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { CandidateTagRule } from "./candidate-review-evidence.js";
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
  const body = Buffer.from(JSON.stringify({ v: 2, ...cursor })).toString(
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
      value.v !== 2 ||
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
      "候选分页游标无效：需要版本 2 的不透明游标，旧 UUID 游标不再支持",
    );
  }
}

export interface CandidateAnalysisPolicy {
  modelKey: string | null;
  labels: readonly string[];
  positiveLabels: readonly string[];
  lowPriorityLabels?: readonly string[];
}

/** Only controlled identifiers are SQL text. Every user/adapter value is a parameter. */
export function candidateBaseWhere(filter: CandidateFilter) {
  const clauses = [
    Prisma.sql`c.status = ${filter.status}::"CandidateStatus"`,
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

/** Current files and bounded class vectors are projected in SQL; evidence never leaves storage. */
export function candidateRankingCte(
  filter: CandidateFilter,
  policy: CandidateAnalysisPolicy,
  rules: readonly CandidateTagRule[] = [],
  candidateIds?: readonly string[],
) {
  const labels = [...policy.labels];
  return Prisma.sql`WITH scope AS MATERIALIZED (
    SELECT c.id,c.posted_at FROM candidate_posts c JOIN authors a ON a.id=c.author_id
    WHERE ${candidateBaseWhere(filter)} ${candidateIds ? Prisma.sql`AND c.id=ANY(${[...candidateIds]}::uuid[])` : Prisma.empty}
  ), rule_snapshot AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(rules)}::jsonb) AS r("normalizedValue" text,"groupId" text,"groupName" text,"groupRevision" int,direction text)
  ), tag_evidence AS (
    SELECT h.candidate_post_id AS id,
      jsonb_agg(h.display_value ORDER BY h.normalized_value) AS hashtags,
      jsonb_agg(jsonb_build_object('normalizedValue',h.normalized_value,'displayValue',h.display_value,'groupId',r."groupId",'groupName',r."groupName",'groupRevision',r."groupRevision",'direction',r.direction) ORDER BY h.normalized_value) FILTER (WHERE r."groupId" IS NOT NULL) AS matches,
      bool_or(r.direction='priority') AS priority,bool_or(r.direction='deprioritize') AS deprioritize
    FROM scope c JOIN candidate_hashtags h ON h.candidate_post_id=c.id
    LEFT JOIN rule_snapshot r ON r."normalizedValue"=h.normalized_value
    GROUP BY h.candidate_post_id
  ), image_rows AS MATERIALIZED (
    SELECT c.id,ma.score,ma.result_json->>'predictedClass' AS winner,
          COALESCE(f.lifecycle_status='active' AND f.deleted_at IS NULL AND ma.status='succeeded'
            AND ma.source_sha256=f.checksum AND ma.score BETWEEN 0 AND 1
            AND CASE WHEN jsonb_typeof(ma.result_json->'score')='number' THEN (ma.result_json->>'score')::numeric BETWEEN 0 AND 1 AND (ma.result_json->>'score')::numeric=ma.score::text::numeric ELSE false END
            AND vector.n=${labels.length} AND vector.n>0 AND vector.valid AND abs(vector.total-1)<=0.00001
            AND jsonb_typeof(ma.result_json->'predictedClass')='string' AND vector.winner=ma.result_json->>'predictedClass',false) AS valid
    FROM scope c JOIN candidate_media m ON m.candidate_post_id=c.id
    JOIN file_objects f ON f.id=m.file_object_id
    LEFT JOIN candidate_media_analyses ma ON ma.media_id=m.id AND ma.model_key=${policy.modelKey}
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n,bool_and(COALESCE(x.shape AND x.label=(${labels}::text[])[x.ordinal] AND x.value BETWEEN 0 AND 1,false)) AS valid,sum(CASE WHEN x.value BETWEEN 0 AND 1 THEN x.value END) AS total,
            (array_agg(x.label ORDER BY x.value DESC NULLS LAST,x.ordinal))[1] AS winner
          FROM (
            SELECT ordinal,jsonb_typeof(v)='object' AND jsonb_typeof(v->'label')='string' AS shape,(v->>'label') AS label,CASE WHEN jsonb_typeof(v->'value')='number' THEN (v->>'value')::numeric END AS value
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ma.result_json->'classScores')='array' THEN CASE WHEN jsonb_array_length(ma.result_json->'classScores')=${labels.length} THEN ma.result_json->'classScores' ELSE '[]'::jsonb END ELSE '[]'::jsonb END) WITH ORDINALITY AS scores(v,ordinal)
          ) x
        ) vector ON true
  ), image_evidence AS (
    SELECT id,max(score) FILTER (WHERE valid) AS score,
      (array_agg(winner ORDER BY score DESC NULLS LAST,array_position(${labels}::text[],winner)) FILTER (WHERE valid))[1] AS representative_class,
      bool_or(valid AND winner=ANY(${[...policy.positiveLabels]}::text[])) AS promotes,
      count(*)>0 AND bool_and(valid AND winner=ANY(${[...(policy.lowPriorityLabels ?? [])]}::text[])) AS all_low
    FROM image_rows GROUP BY id
  ), evidence AS (
    SELECT c.id,c.posted_at,
      COALESCE(t.hashtags,'[]'::jsonb) AS hashtags,
      COALESCE(t.matches,'[]'::jsonb) AS matches,
      COALESCE(t.priority,false) AS tag_positive,COALESCE(t.deprioritize,false) AS tag_negative,
      v.score,v.representative_class,COALESCE(v.promotes,false) AS model_positive,
      COALESCE(v.all_low,false) AS all_low
    FROM scope c LEFT JOIN tag_evidence t ON t.id=c.id LEFT JOIN image_evidence v ON v.id=c.id
  ), grouped AS (
    SELECT *, (tag_positive OR model_positive) AND tag_negative AS conflict,
      CASE WHEN (tag_positive OR model_positive) AND tag_negative THEN 'uncertain'
        WHEN tag_positive OR model_positive THEN 'priority'
        WHEN tag_negative OR all_low THEN 'low_priority' ELSE 'uncertain' END AS triage_group
    FROM evidence
  ), ranked AS (
    SELECT id,posted_at,triage_group,score AS frozen_score,representative_class,
      CASE WHEN ${filter.status}<>'pending' THEN 0 WHEN triage_group='priority' THEN 0 WHEN conflict THEN 1 WHEN triage_group='uncertain' THEN 2 ELSE 3 END AS rank,
      CASE WHEN ${filter.status}='pending' THEN COALESCE(score,-1) ELSE -1 END AS sort_score,
      jsonb_build_object('hashtags',hashtags,'tagRuleMatches',matches,'modelPositive',model_positive,'allLow',all_low,
        'triageReasons',to_jsonb(array_remove(ARRAY[
          CASE WHEN conflict THEN 'rule_conflict' END,
          CASE WHEN tag_positive THEN 'priority_tag' END,
          CASE WHEN model_positive THEN 'priority_model' END,
          CASE WHEN tag_negative THEN 'deprioritize_tag' END,
          CASE WHEN NOT tag_positive AND NOT tag_negative AND NOT model_positive AND all_low THEN 'all_images_low' END,
          CASE WHEN triage_group='uncertain' AND NOT conflict THEN 'insufficient_evidence' END
        ]::text[],NULL))) AS reason_json
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
