# Source ingestion adapters

Source ingestion separates the platform protocol from scheduling, durable cursors, downloads, candidate creation and human review. Every client implements `ContentSourceClient`; `ContentSourceRegistry` selects an available implementation for the requested platform and account policy.

## Directory map

```text
apps/server/src/source-ingestion/
  content-source.ts                 # Shared port, normalized pages and capabilities
  source-registry.ts                # Registration and selection
  source-ingestion.module.ts        # Environment-driven composition
  source-fetch.service.ts           # Durable runs, account locks and recovery
  media-downloader.ts              # Bounded original-file downloads
  adapters/
    x-web-session/
      x-web-session-content-source.ts
    x-official/
      x-content-source.ts
    gallery-dl/
      gallery-dl-content-source.ts
      README.md
      python/
        adapter.py
        requirements.txt
        test_adapter.py
```

The two TypeScript X adapters remain independent implementations. The web-session adapter uses X web GraphQL and administrator-supplied session/query configuration. The official adapter uses X API v2 and is metered. The optional gallery-dl implementation delegates X/Pixiv protocol handling to its pinned Python dependency; its normalization, coverage checks and cursor contract remain Comiku's responsibility. It does not replace the other clients.

Adapter keys stay stable when files move. Cursor state, watermarks, failures and cooldowns belong to each account/adapter pair; incompatible adapters must not exchange cursors. Official fallback remains subject to its request budget. Account collection must be enabled and its author authorized. Missing adapter states are provisioned enabled by default; configuring gallery-dl therefore makes it eligible ahead of the web-session implementation by priority, including for existing enabled accounts. Configuration does not grant author permissions.

## Build assets

TypeScript compilation emits JavaScript; it does not copy Python bridges or requirements. `apps/server/scripts/copy-adapter-assets.mjs` copies a fixed list of public runtime assets for gallery-dl and BA PixAI from `src` to the corresponding `dist` directories after server compilation, including the required third-party licenses. The gallery-dl adapter resolves its bridge relative to its own module, so development and compiled deployments use the same directory shape. The script does not install Python, download a model, copy credentials or run collection.

## Runs and logs

The underlying run, per-account item, background-job and cursor records are durable database state. System Management reads the latest 20 runs and includes attempt/retry metadata; the list endpoint requires the administrator's `system:manage` permission. Manual source synchronization remains a source-role business action in the candidate page, with progress for the batch just submitted. Structured worker events are an additional diagnostic channel; only allowlisted metadata is logged. Neither a healthy worker heartbeat nor a successful HTTP request proves that every account completed successfully. Check the final run/item outcomes and retry state.

Manual requests normalize the eligible account set and share a database enqueue lock with scheduled checks. An equivalent active batch is returned with its existing ID; an overlapping but different set returns HTTP 409. Disjoint sets can queue separately. These checks apply across users and browser tabs, not just to the currently disabled button. Requests never reset cursors or interrupt an existing batch. Omitting accountIds targets all currently eligible accounts.

Accounts from different platforms share a batch and are processed sequentially; each selects its platform's clients and retains separate account/adapter cursors. The global network lane permits one live job across workers. This implementation does not provide separate X and Pixiv worker lanes.

Downloads and external requests run outside database transactions. Candidate/observation and cursor commits recheck author authorization, account and adapter revisions, actor permissions and the executing lease in short protected transactions. Management changes stop subsequent writes; stale error handlers must not overwrite a newer channel state or trigger paid fallback. Recovery clears the current error fields while retaining counters, job attempts and a safe structured recovery event.

Original downloads enforce the 25 MiB limit on actual streamed bytes, even without a trustworthy Content-Length, and cancel rejected responses. Accepted chunks plus final concatenation can briefly require roughly twice the payload limit; include this and the separate model process in memory budgets.

Normal tests use synthetic fixtures and do not call live platforms or object storage. Before enabling real accounts, validate credentials, window boundaries, multipage coverage, rate limits, interruption recovery and original-file completeness in the intended environment. See the [gallery-dl adapter guide](../../apps/server/src/source-ingestion/adapters/gallery-dl/README.md).
