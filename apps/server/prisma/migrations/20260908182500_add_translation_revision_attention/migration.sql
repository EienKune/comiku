-- AlterEnum
ALTER TYPE "WorkEventAction" ADD VALUE 'translation_revision_submitted';

-- AlterTable
ALTER TABLE "works"
ADD COLUMN "translation_attention_stage" "WorkStage",
ADD COLUMN "translation_attention_version_number" INTEGER;

ALTER TABLE "works" ADD CONSTRAINT "works_translation_attention_pair_check" CHECK (
  ("translation_attention_stage" IS NULL AND "translation_attention_version_number" IS NULL)
  OR
  ("translation_attention_stage" IS NOT NULL AND "translation_attention_version_number" IS NOT NULL)
);

ALTER TABLE "works" ADD CONSTRAINT "works_translation_attention_version_check" CHECK (
  "translation_attention_version_number" IS NULL OR "translation_attention_version_number" > 0
);
