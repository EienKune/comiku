CREATE TABLE "onomatopoeia_sources" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "version" VARCHAR(160) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "importer_version" VARCHAR(160) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "source_url" TEXT,
    "attribution" TEXT,
    "license" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "onomatopoeia_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onomatopoeia_entries" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "source_ref" VARCHAR(160) NOT NULL,
    "original" VARCHAR(256) NOT NULL,
    "search_key" TEXT NOT NULL,
    "explanation_zh" TEXT,
    "explanation_ja" TEXT,
    "translation_zh" TEXT,
    "notes" TEXT,
    CONSTRAINT "onomatopoeia_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "onomatopoeia_sources_key_key" ON "onomatopoeia_sources"("key");
CREATE UNIQUE INDEX "onomatopoeia_entries_source_id_source_ref_key" ON "onomatopoeia_entries"("source_id", "source_ref");
CREATE INDEX "onomatopoeia_entries_search_key_idx" ON "onomatopoeia_entries"("search_key");
ALTER TABLE "onomatopoeia_entries" ADD CONSTRAINT "onomatopoeia_entries_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "onomatopoeia_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
