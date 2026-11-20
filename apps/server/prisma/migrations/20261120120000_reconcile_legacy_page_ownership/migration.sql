-- Reconcile only the conservative legacy hold created by the first additive migration.
-- No source assets, text, immutable versions, membership history or publication records are removed.
BEGIN;

-- Actual historical work is permanent evidence even when a later exit cleared its current draft.
WITH historical_work AS (
 SELECT work_id,min(started_at) AS started_at FROM (
  SELECT id AS work_id,production_started_at AS started_at FROM works WHERE production_started_at IS NOT NULL
  UNION ALL SELECT id,typeset_handoff_started_at FROM works WHERE typeset_handoff_started_at IS NOT NULL
  UNION ALL SELECT work_id,created_at FROM work_events WHERE action IN
   ('stage_started','stage_submitted','stage_contribution_completed','translation_imported','translation_revision_submitted','typeset_handoff_started','typeset_version_uploaded','proofreading_skipped','publish_confirmed')
  UNION ALL SELECT work_id,submitted_at FROM work_stage_participants WHERE submitted_at IS NOT NULL
  UNION ALL SELECT work_id,created_at FROM work_images WHERE translation_revision>0
  UNION ALL SELECT i.work_id,e.created_at FROM translation_entries e JOIN work_images i ON i.id=e.work_image_id
  UNION ALL SELECT work_id,created_at FROM translation_versions
  UNION ALL SELECT work_id,created_at FROM typeset_image_versions
 ) facts GROUP BY work_id
)
UPDATE works w SET production_started_at=h.started_at FROM historical_work h WHERE h.work_id=w.id
AND (w.production_started_at IS NULL OR w.production_started_at>h.started_at);

CREATE TEMP TABLE legacy_page_reconciliation ON COMMIT DROP AS
SELECT w.id AS work_id,
CASE
 WHEN NOT EXISTS(SELECT 1 FROM work_images i WHERE i.work_id=w.id)
 THEN '缺少有效原稿页，需先核对作品素材'
 WHEN EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL GROUP BY p.stage,p.user_id HAVING count(*)>1)
 THEN '同一成员存在重复的当前职责记录，需核对加入关系'
 WHEN w.collaboration_mode='single' AND EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL GROUP BY p.stage HAVING count(*)>1)
 THEN '单人模式同一职责有多名当前成员，需核对负责人'
 WHEN EXISTS(SELECT 1 FROM work_stage_assignments a JOIN work_stage_participants p ON p.id=a.participant_id JOIN work_images i ON i.id=a.work_image_id WHERE p.work_id=w.id AND p.left_at IS NULL AND p.stage IN ('translate','typeset') AND i.work_id<>w.id)
 THEN '旧页分工指向其他作品，需核对页身份'
 WHEN EXISTS(SELECT 1 FROM work_stage_assignments a JOIN work_stage_participants p ON p.id=a.participant_id WHERE p.work_id=w.id AND p.left_at IS NULL AND p.stage IN ('translate','typeset') GROUP BY p.stage,a.work_image_id HAVING count(*)>1)
 THEN '同一职责同一页有重叠负责人，需明确保留归属'
 WHEN w.collaboration_mode='multi' AND EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.stage IN ('translate','typeset') AND NOT EXISTS(SELECT 1 FROM work_stage_assignments a JOIN work_images i ON i.id=a.work_image_id WHERE a.participant_id=p.id AND i.work_id=w.id))
 THEN '旧多人职责存在零页成员，需明确参加页范围'
 WHEN w.collaboration_mode='multi' AND (w.workflow_status NOT IN ('pending_translate','translating') OR EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.submitted_at IS NOT NULL))
 THEN '旧多人整阶段完成不能代替当前逐页有效提交，需核对交稿事实'
 WHEN w.collaboration_mode='multi' AND w.current_typeset_version_id IS NOT NULL
 THEN '旧多人成图尚无可靠的逐页交付归属，需核对映射'
 WHEN w.collaboration_mode='multi' AND EXISTS(
  SELECT 1 FROM translation_entries e JOIN work_images i ON i.id=e.work_image_id
  WHERE i.work_id=w.id AND NOT EXISTS(
   SELECT 1 FROM work_stage_assignments a JOIN work_stage_participants p ON p.id=a.participant_id
   WHERE a.work_image_id=i.id AND p.work_id=w.id AND p.stage='translate' AND p.left_at IS NULL AND p.user_id=e.created_by AND p.user_id=e.updated_by
  )
 ) THEN '旧多人当前译稿与页负责人不一致，需核对稿件归属'
 WHEN w.collaboration_mode='single' AND EXISTS(
  SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.submitted_at IS NOT NULL
   AND ((p.stage='translate' AND w.workflow_status IN ('pending_translate','translating'))
     OR (p.stage='proofread' AND w.workflow_status IN ('pending_translate','translating','pending_proofread','proofreading'))
     OR (p.stage='typeset' AND w.workflow_status NOT IN ('pending_publish','archived')))
 ) THEN '旧单人提交与当前阶段不一致，需核对有效交接轮次'
 WHEN w.collaboration_mode='single' AND w.workflow_status NOT IN ('pending_translate','translating','archived') AND NOT EXISTS(
  SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.stage='translate' AND p.left_at IS NULL AND p.submitted_at IS NOT NULL
 ) THEN '已交接单人作品缺少当前正式翻译负责人，需核对历史关系'
 WHEN w.collaboration_mode='single' AND EXISTS(
  SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.submitted_at IS NOT NULL AND p.stage IN ('translate','proofread') AND NOT EXISTS(
   SELECT 1 FROM translation_versions v JOIN work_events e ON e.work_id=v.work_id AND e.action='stage_submitted'
   WHERE v.work_id=w.id AND v.stage=p.stage AND v.created_by=p.user_id
    AND e.detail->>'stage'=p.stage::text AND e.detail->>'translationVersionId'=v.id::text
    AND e.detail->'participantIds'=jsonb_build_array(p.id::text)
    AND (p.stage='proofread' OR cardinality(v.contributor_user_ids)=0 OR (cardinality(v.contributor_user_ids)=1 AND v.contributor_user_ids[1]=p.user_id))
    AND NOT EXISTS(SELECT 1 FROM work_images i WHERE i.work_id=w.id AND i.created_at>v.created_at)
  )
 ) THEN '旧单人文本提交缺少一致的正式快照和提交证据，需人工核对'
 WHEN w.collaboration_mode='single' AND EXISTS(
  SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.stage='typeset' AND p.submitted_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM typeset_image_versions v JOIN work_events e ON e.work_id=v.work_id AND e.action='stage_submitted'
   WHERE v.id=w.current_typeset_version_id AND v.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM typeset_image_version_images vi WHERE vi.version_id=v.id)
    AND e.detail->>'stage'='typeset' AND e.detail->>'typesetVersionId'=v.id::text
    AND e.detail->'participantIds'=jsonb_build_array(p.id::text)
  )
 ) THEN '旧单人成图提交缺少一致的完整版本和提交证据，需人工核对'
 ELSE NULL
END::VARCHAR(200) AS reason
FROM works w
WHERE w.collaboration_migration_issue='Legacy collaboration or completed-stage facts require ownership review'
AND w.workflow_status<>'published';

-- A single current owner has explicit whole-work responsibility; unique legacy multi assignments are retained exactly.
UPDATE work_page_assignments a SET participant_id=owners.participant_id,
 generation=CASE WHEN owners.participant_id IS NULL THEN 0 ELSE 1 END,
 draft_revision=CASE WHEN a.stage='translate' THEN i.translation_revision ELSE 0 END,
 submitted_at=CASE WHEN w.collaboration_mode='single' THEN p.submitted_at ELSE NULL END,
 submitted_generation=CASE WHEN w.collaboration_mode='single' AND p.submitted_at IS NOT NULL THEN 1 ELSE NULL END,
 submitted_revision=CASE WHEN w.collaboration_mode='single' AND p.submitted_at IS NOT NULL THEN CASE WHEN a.stage='translate' THEN i.translation_revision ELSE 0 END ELSE NULL END
FROM legacy_page_reconciliation r JOIN works w ON w.id=r.work_id
JOIN work_images i ON i.work_id=w.id
CROSS JOIN (VALUES ('translate'::"WorkStage"),('typeset'::"WorkStage")) s(stage)
LEFT JOIN LATERAL (
 SELECT p0.id AS participant_id FROM work_stage_participants p0
 WHERE p0.work_id=w.id AND p0.stage=s.stage AND p0.left_at IS NULL
 AND (w.collaboration_mode='single' OR EXISTS(SELECT 1 FROM work_stage_assignments old WHERE old.participant_id=p0.id AND old.work_image_id=i.id))
) owners ON true
LEFT JOIN work_stage_participants p ON p.id=owners.participant_id
WHERE r.reason IS NULL AND a.work_id=w.id AND a.work_image_id=i.id AND a.stage=s.stage;

-- Retain the compatibility projection for old readers without replacing historical assignment records.
INSERT INTO work_stage_assignments(id,participant_id,work_image_id,assigned_by,assigned_at)
SELECT gen_random_uuid(),a.participant_id,a.work_image_id,p.user_id,p.joined_at
FROM work_page_assignments a JOIN legacy_page_reconciliation r ON r.work_id=a.work_id
JOIN work_stage_participants p ON p.id=a.participant_id
WHERE r.reason IS NULL AND a.participant_id IS NOT NULL
ON CONFLICT(participant_id,work_image_id) DO NOTHING;

UPDATE works w SET collaboration_migration_issue=r.reason FROM legacy_page_reconciliation r WHERE r.work_id=w.id;
COMMIT;
