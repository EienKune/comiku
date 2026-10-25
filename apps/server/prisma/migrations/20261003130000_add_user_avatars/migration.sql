-- Preserve the unused legacy avatar_object_key; never infer a file from an arbitrary key.
ALTER TABLE "users" ADD COLUMN "avatar_file_object_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_file_object_id_fkey" FOREIGN KEY ("avatar_file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "user_avatar_upload_sessions" (
 "id" UUID NOT NULL, "user_id" UUID NOT NULL, "object_key" TEXT NOT NULL,
 "source_name" VARCHAR(255) NOT NULL, "content_type" VARCHAR(255) NOT NULL,
 "size" INTEGER NOT NULL, "checksum" CHAR(64) NOT NULL, "expected_revision" INTEGER NOT NULL,
 "expires_at" TIMESTAMPTZ(3) NOT NULL, "completed_at" TIMESTAMPTZ(3),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "user_avatar_upload_sessions_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "user_avatar_upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_avatar_upload_sessions_object_key_key" ON "user_avatar_upload_sessions"("object_key");
CREATE INDEX "user_avatar_upload_sessions_user_id_expires_at_idx" ON "user_avatar_upload_sessions"("user_id", "expires_at");
