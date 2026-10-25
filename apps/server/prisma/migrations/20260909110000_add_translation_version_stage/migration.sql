ALTER TABLE "translation_versions"
  ADD COLUMN "stage" "WorkStage";

UPDATE "translation_versions"
SET "stage" = CASE
  WHEN "kind" = 'translate_submission' THEN 'translate'::"WorkStage"
  WHEN "kind" = 'proofread_submission' THEN 'proofread'::"WorkStage"
  ELSE NULL
END;

UPDATE "translation_versions" AS version
SET "stage" = (event."detail" ->> 'stage')::"WorkStage"
FROM "work_events" AS event
WHERE event."detail" ->> 'translationVersionId' = version."id"::text
  AND event."detail" ->> 'stage' IN ('translate', 'proofread');
