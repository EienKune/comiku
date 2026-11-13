BEGIN;

ALTER TABLE "works" ADD COLUMN "candidate_import_series_intent" JSONB;

CREATE TABLE "work_series" (
  "id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_series_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_series_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "work_series_author_id_archived_updated_at_id_idx" ON "work_series"("author_id", "archived", "updated_at", "id");
CREATE INDEX "work_series_archived_updated_at_id_idx" ON "work_series"("archived", "updated_at", "id");

CREATE TABLE "work_series_entries" (
  "id" UUID NOT NULL,
  "series_id" UUID NOT NULL,
  "work_id" UUID NOT NULL,
  "order_index" DOUBLE PRECISION NOT NULL,
  "label" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_series_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_series_entries_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "work_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "work_series_entries_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "work_series_entries_finite_order" CHECK ("order_index" > '-Infinity'::float8 AND "order_index" < 'Infinity'::float8)
);
CREATE UNIQUE INDEX "work_series_entries_work_id_key" ON "work_series_entries"("work_id");
CREATE INDEX "work_series_entries_series_id_order_index_id_idx" ON "work_series_entries"("series_id", "order_index", "id");

CREATE TABLE "work_series_audits" (
  "id" UUID NOT NULL,
  "series_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "detail" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_series_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_series_audits_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "work_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "work_series_audits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "work_series_audits_series_id_revision_key" ON "work_series_audits"("series_id", "revision");
CREATE TABLE "work_series_mutation_receipts" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_series_mutation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_series_mutation_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "work_series_mutation_receipts_actor_id_request_id_key" ON "work_series_mutation_receipts"("actor_id", "request_id");

COMMIT;
