CREATE TABLE work_source_asset_replacements (
 id UUID NOT NULL PRIMARY KEY, work_id UUID NOT NULL REFERENCES works(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 work_image_id UUID NOT NULL REFERENCES work_images(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 old_file_object_id UUID NOT NULL REFERENCES file_objects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 new_file_object_id UUID NOT NULL REFERENCES file_objects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 asset_revision INTEGER NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX work_source_asset_replacements_work_id_created_at_idx ON work_source_asset_replacements(work_id, created_at);

