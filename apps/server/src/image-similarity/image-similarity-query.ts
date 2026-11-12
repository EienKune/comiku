import { Prisma } from "../generated/prisma/client.js";
import {
  FINGERPRINT_RECIPE,
  SIMILARITY_MAX_DISTANCE,
  SIMILARITY_RESULT_LIMIT,
} from "./fingerprint.js";

/** Only scalar distances are scanned globally. Work metadata is joined after TopK.
 * SHA branch uses non-unique file checksum index; identical content remains valid
 * across multiple original files and work pages. No author/workflow-state filter.
 */
export function similarityMatchesQuery(
  checksum: string,
  phashHex: string | null,
) {
  if (
    !/^[0-9a-f]{64}$/.test(checksum) ||
    (phashHex !== null && !/^[0-9a-f]{16}$/.test(phashHex))
  )
    throw new Error("Invalid fingerprint");
  const perceptual =
    phashHex === null
      ? Prisma.sql`SELECT NULL::uuid AS id, 0::int AS distance WHERE false`
      : Prisma.sql`
    SELECT fp.file_object_id AS id,
      bit_count(('x' || fp.phash_hex)::bit(64) # ('x' || ${phashHex})::bit(64))::int AS distance
    FROM image_fingerprints fp JOIN file_objects f ON f.id = fp.file_object_id
    WHERE fp.recipe_version = ${FINGERPRINT_RECIPE} AND fp.status = 'ready'
      AND EXISTS (SELECT 1 FROM work_images adopted WHERE adopted.original_file_object_id = fp.file_object_id)
      AND fp.source_sha256 = f.checksum AND fp.phash_hex ~ '^[0-9a-f]{16}$'
      AND f.lifecycle_status = 'active' AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM exact_files e WHERE e.id = fp.file_object_id)`;
  return Prisma.sql`
    WITH exact_files AS MATERIALIZED (
      SELECT f.id FROM file_objects f
      WHERE f.checksum = ${checksum} AND f.lifecycle_status = 'active' AND f.deleted_at IS NULL
    ), perceptual_files AS MATERIALIZED (${perceptual}), matching_files AS (
      SELECT id, 0 AS distance, 'exact'::text AS kind FROM exact_files
      UNION ALL
      SELECT id, distance, 'perceptual'::text FROM perceptual_files WHERE distance <= ${SIMILARITY_MAX_DISTANCE}
    ), top_images AS MATERIALIZED (
      SELECT wi.id, wi.work_id, wi.order_index, m.distance, m.kind
      FROM matching_files m JOIN work_images wi ON wi.original_file_object_id = m.id
      ORDER BY (m.kind = 'exact') DESC, m.distance, wi.work_id, wi.order_index, wi.id
      LIMIT ${SIMILARITY_RESULT_LIMIT}
    )
    SELECT w.id AS "workId", w.work_number AS "workNumber", w.title AS "workTitle",
      a.id AS "authorId", a.display_name AS "authorName", ti.id AS "imageId",
      ti.order_index AS "index", (SELECT count(*)::int FROM work_images n WHERE n.work_id = w.id) AS "imageCount",
      w.workflow_status AS "workflowStatus", w.review_status AS "reviewStatus",
      (w.workflow_status = 'archived') AS archived, ti.kind AS "matchKind", ti.distance
    FROM top_images ti JOIN works w ON w.id = ti.work_id JOIN authors a ON a.id = w.author_id
    ORDER BY (ti.kind = 'exact') DESC, ti.distance, ti.work_id, ti.order_index, ti.id`;
}

export function similarityCoverageQuery() {
  return Prisma.sql`
    WITH originals AS MATERIALIZED (SELECT DISTINCT original_file_object_id AS id FROM work_images),
    states AS (
      SELECT CASE WHEN f.lifecycle_status <> 'active' OR f.deleted_at IS NOT NULL THEN 'failed'
        WHEN fp.source_sha256 = f.checksum AND fp.status = 'ready' AND fp.phash_hex ~ '^[0-9a-f]{16}$' THEN 'ready'
        WHEN fp.source_sha256 = f.checksum AND fp.status = 'failed' THEN 'failed'
        ELSE 'pending' END AS status
      FROM originals o JOIN file_objects f ON f.id = o.id
      LEFT JOIN image_fingerprints fp ON fp.file_object_id = f.id AND fp.recipe_version = ${FINGERPRINT_RECIPE}
    ) SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ready')::int AS ready,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'failed')::int AS failed FROM states`;
}
