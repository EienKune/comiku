-- A request and its author are committed together; only the opaque payload hash is retained.
BEGIN;

CREATE TABLE "author_creation_requests" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "author_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "author_creation_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "author_creation_requests_actor_id_idempotency_key_key" ON "author_creation_requests"("actor_id", "idempotency_key");
CREATE INDEX "author_creation_requests_author_id_idx" ON "author_creation_requests"("author_id");
ALTER TABLE "author_creation_requests" ADD CONSTRAINT "author_creation_requests_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "author_creation_requests" ADD CONSTRAINT "author_creation_requests_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The author directory uses a deterministic database order and a bounded keyset page.
CREATE INDEX "authors_active_name_id_idx" ON "authors" ("display_name" COLLATE "C", "id") WHERE "deleted_at" IS NULL;

COMMIT;
