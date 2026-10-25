-- AlterTable
ALTER TABLE "work_images" ADD COLUMN     "translation_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "work_images" ADD CONSTRAINT "work_images_translation_revision_check" CHECK ("translation_revision" >= 0);
