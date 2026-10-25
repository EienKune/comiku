-- CreateEnum
CREATE TYPE "TranslationPresenceMode" AS ENUM ('view', 'edit');

-- CreateTable
CREATE TABLE "translation_editor_presences" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "mode" "TranslationPresenceMode" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_editor_presences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_editor_presences_work_id_session_id_key" ON "translation_editor_presences"("work_id", "session_id");

-- CreateIndex
CREATE INDEX "translation_editor_presences_work_id_last_seen_at_idx" ON "translation_editor_presences"("work_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "translation_editor_presences_session_id_idx" ON "translation_editor_presences"("session_id");

-- AddForeignKey
ALTER TABLE "translation_editor_presences" ADD CONSTRAINT "translation_editor_presences_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_editor_presences" ADD CONSTRAINT "translation_editor_presences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_editor_presences" ADD CONSTRAINT "translation_editor_presences_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
