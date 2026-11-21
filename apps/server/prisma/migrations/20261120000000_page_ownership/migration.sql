-- Additive compatibility migration: never infer old collaborative completion or remove content.
ALTER TABLE works ADD COLUMN collaboration_migration_issue VARCHAR(200), ADD COLUMN production_started_at TIMESTAMPTZ(3), ADD COLUMN source_asset_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE typeset_handoff_packages ADD COLUMN source_asset_revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX work_images_id_work_id_key ON work_images(id,work_id);
CREATE UNIQUE INDEX work_stage_participants_id_work_id_stage_key ON work_stage_participants(id,work_id,stage);
CREATE TABLE work_page_assignments (
 id UUID PRIMARY KEY, work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE ON UPDATE CASCADE,
 work_image_id UUID NOT NULL,
 stage "WorkStage" NOT NULL CHECK(stage IN ('translate','typeset')),
 participant_id UUID,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0), draft_revision INTEGER NOT NULL DEFAULT 0 CHECK(draft_revision>=0),
 submitted_revision INTEGER, submitted_generation INTEGER, submitted_at TIMESTAMPTZ(3),
 CONSTRAINT work_page_assignments_work_image_id_work_id_fkey FOREIGN KEY(work_image_id,work_id) REFERENCES work_images(id,work_id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT work_page_assignments_participant_id_work_id_stage_fkey FOREIGN KEY(participant_id,work_id,stage) REFERENCES work_stage_participants(id,work_id,stage) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT page_submission_consistent CHECK ((submitted_at IS NULL AND submitted_revision IS NULL AND submitted_generation IS NULL) OR (participant_id IS NOT NULL AND submitted_at IS NOT NULL AND submitted_revision IS NOT NULL AND submitted_generation IS NOT NULL))
);
CREATE UNIQUE INDEX work_page_assignments_work_image_id_stage_key ON work_page_assignments(work_image_id,stage);
CREATE INDEX work_page_assignments_work_id_stage_participant_id_idx ON work_page_assignments(work_id,stage,participant_id);
CREATE TABLE work_typeset_drafts (
 id UUID PRIMARY KEY, work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE ON UPDATE CASCADE,
 work_image_id UUID UNIQUE REFERENCES work_images(id) ON DELETE RESTRICT ON UPDATE CASCADE, participant_id UUID NOT NULL,
 file_object_id UUID NOT NULL REFERENCES file_objects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 assignment_generation INTEGER NOT NULL DEFAULT 0, source_name VARCHAR(255) NOT NULL,
 width INTEGER, height INTEGER, position VARCHAR(16) NOT NULL DEFAULT 'page', order_index INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, submitted_revision INTEGER,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX work_typeset_drafts_work_id_participant_id_idx ON work_typeset_drafts(work_id,participant_id);
CREATE INDEX work_typeset_drafts_file_object_id_idx ON work_typeset_drafts(file_object_id);
-- Store a bounded reason on ambiguous old work. Existing files, snapshots and participant rows remain intact.
UPDATE works w SET collaboration_migration_issue='Legacy collaboration or completed-stage facts require ownership review'
WHERE w.workflow_status <> 'published' AND (
 w.collaboration_mode='multi' OR NOT EXISTS(SELECT 1 FROM work_images i WHERE i.work_id=w.id)
 OR EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL AND p.submitted_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL GROUP BY p.stage HAVING count(*)>1)
);
INSERT INTO work_page_assignments(id,work_id,work_image_id,stage,participant_id,generation)
SELECT gen_random_uuid(),i.work_id,i.id,s.stage,p.id,CASE WHEN p.id IS NULL THEN 0 ELSE 1 END
FROM work_images i JOIN works w ON w.id=i.work_id CROSS JOIN (VALUES ('translate'::"WorkStage"),('typeset'::"WorkStage")) s(stage)
LEFT JOIN work_stage_participants p ON p.work_id=i.work_id AND p.stage=s.stage AND p.left_at IS NULL AND w.collaboration_migration_issue IS NULL AND w.collaboration_mode='single'
WHERE w.workflow_status<>'published';
-- Historical actual work permanently closes a progress-free multi -> single conversion.
UPDATE works w SET production_started_at = facts.started_at FROM (
 SELECT work_id,min(created_at) AS started_at FROM (
  SELECT i.work_id,e.created_at FROM translation_entries e JOIN work_images i ON i.id=e.work_image_id
  UNION ALL SELECT work_id,created_at FROM translation_versions
  UNION ALL SELECT work_id,created_at FROM typeset_image_versions
 ) all_facts GROUP BY work_id
) facts WHERE facts.work_id=w.id;
