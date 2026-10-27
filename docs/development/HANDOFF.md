# Development handoff

This tracked document records reusable implementation constraints. Business rules live in [architecture](../architecture.md), configuration in [configuration](../configuration.md), and visual rules in [DESIGN](../../DESIGN.md). Keep machine addresses, credentials, real samples, local experiments and deployment session notes outside the public repository.

## Source ingestion

- Each account/adapter pair owns its cursor, watermark, health, cooldown and lease. Never reuse a cursor between the X web-session, X official API and gallery-dl implementations.
- Interrupted collection must resume the existing run/account/adapter record. Recreating it violates its unique constraint; preserve counters, skip completed accounts and propagate cancellation instead of treating it as an ordinary platform failure.
- Exhausted background jobs may never re-enter their handler. Recovery must settle the run/items and release stale account locks without advancing an unsafe watermark.
- gallery-dl may omit unavailable media slots. Validate original-photo coverage and page completeness before committing progress. Skip unsupported Pixiv animations explicitly.
- Pinned gallery-dl uses `quoted_id` for a post's referenced target and `quote_id` for an expanded quote context; keep a user's own attached images while excluding the expanded target's images. Pixiv sanity entries must pass native AJAX resolution before checking their real author, date and type; unknown metadata must not masquerade as complete static media.
- Adding a source client requires backend capabilities and author-form wiring as well as registry registration. Pixiv starts with collection disabled; the X form may enable collection when a supported capability is available. Editing must preserve existing collection settings.
- Removing a configured adapter must not prevent maintaining or pausing an existing account/channel. Preserve the previous sync window when pausing; require available capabilities for new activation or a changed window. A token authentication failure is separate from a missing runtime configuration. Keep pause controls accessible when capability discovery fails.
- Technical collection history belongs to System Management and requires `system:manage`. Manual source synchronization remains a source-role business action; its empty account selection targets all eligible authorized accounts, independently of candidate-list filters.
- Manual and scheduled enqueue paths share the same transaction lock. Reuse an equivalent active account set and reject overlapping different sets; do not rely on a per-page disabled button. Test actual execution after exhausted-job cleanup, not only the allocation of a new run ID.
- Fence protected writes with the background-job row and lock author/account/adapter rows in the management-compatible order. Network requests never belong in these transactions. Recheck actor permissions for existing observations as well as new candidates; stale failures must not clear another execution's lease or overwrite a management change.
- Lease fencing holds only when the same transaction client is passed through the protected write; an autocommit `this.db` check is only an instantaneous check. Parent user/author/account rows use share locks so management updates are fenced while foreign-key key-share checks remain compatible; adapter state uses a no-key-update lock. Recheck a terminal job after locking it before clearing its source leases, and leave a live final attempt alone.
- Recovery must clear current error fields on running/success transitions and retain a separate recovery event. Stream actual download bytes and cancel at the limit; Content-Length and a timeout alone do not bound memory or transfer.

## Image analysis

- Adapters declare their ordered taxonomy; generic validation supports binary and multiclass outputs. Taxonomy is part of the immutable model identity. Review priority is independent of the class probabilities.
- A model identity change creates new results; never rewrite historical successes to impersonate the new model. Persist original SHA and identity, retain bounded retries and verify the lease under the candidate lock before aggregation.
- Candidate summaries carry `analysisModelKey` provenance. Only complete summaries matching the configured active adapter affect priority/sorting; mismatches and disabled adapters preserve history but do not display stale priority. The worker can rebuild at most 20 unmatched summaries per scan from actual current-model results without repeating successful inference. Configure API and worker consistently and restart them together on model changes.
- Analysis does not change human review status or revision. Disabled/unavailable models must not fabricate a classification.
- Candidate cards show why a candidate was promoted and actionable analysis states; completed results do not need a second high/medium/low score-band badge. Keep scores available for sorting without duplicating the priority grouping on screen.
- An optional adapter review policy promotes candidates by winning-class confidence, independently of ranking score. Read only complete current-model prediction caches; retain human/legacy photo and blocked-tag precedence and never manufacture tag matches. Rebuild missing caches from validated persisted outputs with bounded work. BA uses native `ba_art/ba_related/other`; the generic example's labels do not define the public port's taxonomy.
- Candidate sections can exchange rows when analysis completes. Coordinate refreshes across active groups and perform a final refresh when queued rows disappear; independently polling only the source group can leave the destination empty. Pause background polling and clean up timers and subscriptions.
- Keep the hashed BA extraction/pipeline/processor files byte-identical. Formatting these files changes their artifact identity. Preserve third-party license and attribution files when packaging runtime assets.
- Exact-byte runtime artifacts need path-level `-text` Git attributes as well as formatter exclusions. Check staged blob SHA-256, not only working-tree bytes: line-ending normalization can otherwise make a fresh Linux checkout fail the runtime integrity check.
- The BA runtime reads model paths from its process environment, explicit CLI flags or an optional JSON configuration; JSON-relative paths resolve against that configuration file. Model artifacts can remain outside the checkout, with no required repository directory. The runtime does not read executable code from a model directory or require training tools.
- Reuse a resident model with bounded handlers, one inference lock and a measured CPU thread budget. HTTP disconnect does not cancel an in-progress PyTorch call; shutdown must drain accepted work before removing hooks.

## Verification and operations

- Use the pinned Node/pnpm versions. Run ordinary tests with synthetic fixtures; PostgreSQL integration tests require a separate disposable `_test` database.
- Do not use a distant database connection to diagnose transaction timeouts as application defects without checking network latency. Do not reset a business database to fix test setup.
- Use the optional Python environments for adapter tests. A missing gallery-dl dependency in a different system Python does not establish an adapter defect.
- Capacity and live-platform coverage require explicit environment tests. A worker heartbeat, passing fixtures or a built image does not prove every collection job succeeded.
- Short object-storage signatures depend on correct host time. Inspect time offset and source reachability separately; a running time daemon does not establish synchronization.
- Probe API readiness on its own listener before checking a dependent reverse proxy. Stopping a systemd unit may stop services that require it; explicitly restore dependent test services, and retry readiness rather than treating `active` as proof that a listener is ready.
- Test connection admission without sending unread bytes when asserting an immediate overload response; TCP reset behavior differs across operating systems.
- Build scripts copy an explicit list of public non-TS runtime assets and required notices. They must not copy private configuration, model files or tests into production assets.

Before an authorized commit, inspect the full staged diff and untracked files. Commit messages describe the problem and concrete changes only. Keep verification records, deployment notes and remaining scope in the appropriate handoff or PR description; do not include environment secrets or unrelated work.
