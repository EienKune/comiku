-- LabelPlus writes normalized marker coordinates with three decimal places.
ALTER TABLE "translation_entries"
  ALTER COLUMN "marker_x" TYPE DECIMAL(4, 3) USING ROUND("marker_x", 3),
  ALTER COLUMN "marker_y" TYPE DECIMAL(4, 3) USING ROUND("marker_y", 3);

ALTER TABLE "translation_version_entries"
  ALTER COLUMN "marker_x" TYPE DECIMAL(4, 3) USING ROUND("marker_x", 3),
  ALTER COLUMN "marker_y" TYPE DECIMAL(4, 3) USING ROUND("marker_y", 3);
