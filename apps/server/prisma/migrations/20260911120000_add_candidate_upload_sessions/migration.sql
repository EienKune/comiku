CREATE TYPE "CandidateUploadSessionStatus" AS ENUM (
  'pending',
  'finalizing',
  'completed',
  'expired'
);

CREATE TYPE "CandidateUploadItemStatus" AS ENUM (
  'pending',
  'created',
  'failed'
);

CREATE TABLE "candidate_upload_sessions" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "text" TEXT,
  "source_url" VARCHAR(2048),
  "status" "CandidateUploadSessionStatus" NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "candidate_upload_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "candidate_upload_items" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "source_name" VARCHAR(255) NOT NULL,
  "object_key" TEXT NOT NULL,
  "content_type" VARCHAR(255) NOT NULL,
  "size" BIGINT NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "status" "CandidateUploadItemStatus" NOT NULL DEFAULT 'pending',
  "result_message" VARCHAR(500),
  "warnings" JSONB,
  "candidate_post_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "candidate_upload_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_upload_items_object_key_key"
  ON "candidate_upload_items"("object_key");
CREATE UNIQUE INDEX "candidate_upload_items_candidate_post_id_key"
  ON "candidate_upload_items"("candidate_post_id");
CREATE INDEX "candidate_upload_sessions_actor_id_created_at_idx"
  ON "candidate_upload_sessions"("actor_id", "created_at");
CREATE INDEX "candidate_upload_sessions_status_expires_at_idx"
  ON "candidate_upload_sessions"("status", "expires_at");
CREATE INDEX "candidate_upload_items_session_id_status_idx"
  ON "candidate_upload_items"("session_id", "status");

ALTER TABLE "candidate_upload_sessions"
  ADD CONSTRAINT "candidate_upload_sessions_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "candidate_upload_sessions"
  ADD CONSTRAINT "candidate_upload_sessions_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "authors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "candidate_upload_items"
  ADD CONSTRAINT "candidate_upload_items_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "candidate_upload_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "candidate_upload_items"
  ADD CONSTRAINT "candidate_upload_items_candidate_post_id_fkey"
  FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
