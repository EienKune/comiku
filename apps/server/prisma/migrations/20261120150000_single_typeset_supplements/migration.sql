ALTER TABLE typeset_image_version_images ADD COLUMN supplement_id UUID, ADD COLUMN supplement_position VARCHAR(8);
ALTER TABLE typeset_image_version_images ADD CONSTRAINT typeset_supplement_identity CHECK ((supplement_id IS NULL AND supplement_position IS NULL) OR (supplement_id IS NOT NULL AND supplement_position IS NOT NULL AND supplement_position IN ('start','end') AND work_image_id IS NULL));

