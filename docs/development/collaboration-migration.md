# Legacy page ownership reconciliation

The page-ownership migration preserves old content and publication history. Its initial conservative hold is reconciled by a separate additive migration. A published work is left historical and readable; ordinary production mutations stay closed.

A single current owner already has explicit whole-work responsibility. Completed single-person text is restored only when a matching immutable version and formal submission event identify exactly that participant, and the originals predate that snapshot. A completed single-person typeset stage also needs its current valid complete version and submission event. The migration never derives completion from a member boolean alone.

An unsubmitted multi-person translation can retain unique explicit page assignments, including its current draft only when that draft was created and last updated by the current page owner. A pristine multi-person work with no current participants can resume with unassigned pages. Overlap, cross-work assignments, zero-page members, unexplained draft ownership, ambiguous old completion and missing formal evidence stay read-only with a Chinese reason.

No original, text, immutable version, membership-history row or publication record is deleted. Historical starts, submissions, imports, formal material handoff and image uploads permanently retain the work-progress guard even if the current draft was later cleared.

Run this read-only report after migration. Review the original evidence and choose the current owner and draft disposition explicitly before resolving a remaining hold; do not clear a reason merely to re-enable writes.

```sql
SELECT
  w.work_number,
  w.workflow_status,
  w.collaboration_mode,
  w.collaboration_migration_issue AS reason,
  w.production_started_at,
  (SELECT count(*) FROM work_images i WHERE i.work_id=w.id) AS original_pages,
  (SELECT jsonb_agg(jsonb_build_object(
    'participantId',p.id,'userId',p.user_id,'stage',p.stage,
    'joinedAt',p.joined_at,'submittedAt',p.submitted_at,
    'pageIds',(SELECT jsonb_agg(a.work_image_id ORDER BY i.order_index)
      FROM work_stage_assignments a JOIN work_images i ON i.id=a.work_image_id
      WHERE a.participant_id=p.id)
  ) ORDER BY p.joined_at,p.id)
   FROM work_stage_participants p WHERE p.work_id=w.id AND p.left_at IS NULL
  ) AS current_roles
FROM works w
WHERE w.collaboration_migration_issue IS NOT NULL
ORDER BY w.work_number;
```

Keep review evidence and any environment-specific correction plan outside public source. A correction must preserve published snapshots, advance affected ownership generations, invalidate stale editing contexts and satisfy the same current membership and qualification constraints as normal production operations.
