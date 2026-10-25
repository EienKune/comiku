ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_handoff_started';

ALTER TABLE "works"
  ADD COLUMN "typeset_handoff_started_at" TIMESTAMPTZ(3);
