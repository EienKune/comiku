ALTER TYPE "WorkEventAction" ADD VALUE 'publish_confirmed';

CREATE TABLE "publish_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publish_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "publish_records" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "typeset_version_id" UUID NOT NULL,
    "template_id" UUID,
    "template_name_snapshot" VARCHAR(100) NOT NULL,
    "template_revision" INTEGER NOT NULL,
    "template_content_snapshot" TEXT NOT NULL,
    "generated_text_snapshot" TEXT NOT NULL,
    "note" VARCHAR(1000),
    "idempotency_key" UUID NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publish_templates_key_key" ON "publish_templates"("key");
CREATE INDEX "publish_templates_is_active_key_idx" ON "publish_templates"("is_active", "key");
CREATE UNIQUE INDEX "publish_records_work_id_idempotency_key_key" ON "publish_records"("work_id", "idempotency_key");
CREATE INDEX "publish_records_work_id_published_at_idx" ON "publish_records"("work_id", "published_at");
CREATE INDEX "publish_records_typeset_version_id_idx" ON "publish_records"("typeset_version_id");
CREATE INDEX "publish_records_published_by_published_at_idx" ON "publish_records"("published_by", "published_at");

ALTER TABLE "publish_templates"
    ADD CONSTRAINT "publish_templates_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "publish_records"
    ADD CONSTRAINT "publish_records_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "publish_records"
    ADD CONSTRAINT "publish_records_typeset_version_id_fkey"
    FOREIGN KEY ("typeset_version_id") REFERENCES "typeset_image_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "publish_records"
    ADD CONSTRAINT "publish_records_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "publish_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "publish_records"
    ADD CONSTRAINT "publish_records_published_by_fkey"
    FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "publish_templates" (
    "id",
    "key",
    "name",
    "content",
    "updated_at"
) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'default',
    'Comiku 默认发布文案',
    E'**{{title}}**\n{{body}}作者：{{author}}\n\n翻译：{{translation_credits}}\n校对：{{proofread_credits}}\n嵌字：{{typeset_credits}}\n点赞加关注可以看到更多汉化作品\n转载请注明原作者',
    CURRENT_TIMESTAMP
);
