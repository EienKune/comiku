ALTER TYPE "TypesetHandoffPackageKind" ADD VALUE 'unified_handoff';

ALTER TABLE "typeset_handoff_packages"
ADD COLUMN "marker_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "typeset_image_version_images"
ALTER COLUMN "work_image_id" DROP NOT NULL;
