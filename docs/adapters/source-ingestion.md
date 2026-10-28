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
        pixiv_paging.py
        requirements.txt
        test_adapter.py
        test_pixiv_paging.py
```

Daily runtime composition registers only configured gallery-dl X/Pixiv clients. The two TypeScript X implementations remain public historical source with independent synthetic tests; old web-session/official credentials do not register them, and gallery failures cannot fall back to them. Historical run details retain their original adapter names. The registry itself remains extensible for custom and synthetic clients, including metered clients; compatibility budget inputs do not add a client to daily composition.

`SourceAccountScanState` owns each account's trustworthy `discoveredThroughAt`, frozen unfinished `windowJson`, job lease and execution epoch. Adapter protocol cursors, discovery baselines, observed publication watermarks, health and cooldown remain in `SourceAdapterState`. Switching implementations rebuilds provider state from the shared unfinished bounds; it never copies another provider's cursor or baseline. Successful empty scans advance shared coverage; failure and the 100-page guard preserve the unfinished window. Replacing the stable identity creates a separate account and inherits no coverage.

The forward migration inherits only gallery coverage with a matching account/platform and successful item evidence. Retired adapter timestamps do not establish account coverage. A bound unfinished gallery window is retained independently from successful coverage. Unknown legacy timestamps never become a maximum across providers. Daily author account DTOs exclude the retired X channel switches; unavailable gallery/custom states remain maintainable and technical run history preserves retired rows.

Account collection must be enabled and its author authorized. Missing active adapter states are provisioned enabled by default. Configuring gallery-dl does not grant author permissions.

## Build assets

TypeScript compilation emits JavaScript; it does not copy Python bridges or requirements. `apps/server/scripts/copy-adapter-assets.mjs` copies a fixed list of public runtime assets for gallery-dl and BA PixAI from `src` to the corresponding `dist` directories after server compilation, including the required third-party licenses. The gallery-dl adapter resolves its bridge relative to its own module, so development and compiled deployments use the same directory shape. The script does not install Python, download a model, copy credentials or run collection.

## Runs and logs

Adapter errors expose only a controlled public message/code. `SourceResponseError.details` is non-enumerable and contains a controlled native reason, a failure scope (`credential`, `source`, `post`, `media`, `transport`, `storage`, `protocol` or `configuration`) and private diagnostics. Worker failure events use the explicit `sourceDiagnostic` extraction boundary and correlate the run, job/attempt when executing a job, account, platform, adapter, page/window and known post/media IDs. Unknown exceptions produce `unknown_failure` with an `unknown` log scope and retain the service-observed stage (such as `download`, `store` or `candidate_commit`), without arbitrary exception text. Details never enter API DTOs or persisted public error messages. A protected source or missing post does not establish shared credential failure; an original-file CDN 403/429 remains a media failure. API authentication/challenge/rate-limit failures retain their distinct native reasons.

Diagnostic fields and response headers use fixed allowlists. Free text drops URL userinfo, query and fragment, sensitive assignments and known credential values (including encoded, escaped and partial values) before truncation. A field is omitted when decoding would introduce whitespace/quote delimiters or exceeds the bounded decoding depth, or when a sensitive assignment spans multiple lines; this preserves privacy when original query or JSON boundaries are ambiguous. Sensitive keys are processed before credential fragments can erase them. Fields are limited to 16 KiB, at most 32 fields and 64 KiB serialized total. Fields above 256 Ki characters are omitted; more than 128 known secrets, a secret above 1,024 characters or more than 64 Ki characters of secret material suppress the diagnostic instead of constructing unbounded redaction work. Trusted local gallery configuration/cookie files are read only to establish the secret set, with a 1 MiB per-file read limit; their contents and paths are never logged. Unknown exceptions do not serialize arbitrary objects or messages. Conservative fragment removal can erase incidental matching text.

The gallery runner retains its 120-second timeout and 16 MiB process-output cap. Startup, exit, timeout, output-limit and malformed-JSON failures have separate private reasons with bounded stderr/status/duration fields. Large unsanitized stderr is omitted, and stdout is never logged. Normal successful-page logs retain counts without enabling HTTP debug output. Treat these events as administrator-only operational data; keep the deployment's existing bounded journal retention/rotation policy and include its disk budget in capacity checks. Application configuration does not alter shared system journal settings.

The underlying run, per-account item, background-job and cursor records are durable database state. System Management reads the latest 20 runs and includes attempt/retry metadata; both the list and individual technical-detail endpoints require the administrator's `system:manage` permission. Manual source synchronization remains a source-role business action in the candidate page. Its POST response contains only the batch ID and status, including when reusing an equivalent active batch; a shared read-only business summary restores progress after navigation. Structured worker events are an additional diagnostic channel; only allowlisted metadata is logged. Neither a healthy worker heartbeat nor a successful HTTP request proves that every account completed successfully. Check the final run/item outcomes and retry state, including accounts skipped during cooldown.

Every account scan uses a frozen `[startTime, endTime)` window. The first scan follows the account's initial setting; later scans begin at shared `discoveredThroughAt` minus `SOURCE_OVERLAP_MINUTES`. Successful empty scans advance this coverage bound. Failed or interrupted scans retain their original bounds and do not advance coverage. The latest observed post timestamp is a separate watermark, because an inactive author must not force repeated historical traversal.

Pixiv App API discovery and AJAX-only supplementation use separate stages with source/window/baseline-bound versioned cursors. Ordered old App pages stop historical enumeration; an initial metadata bootstrap creates a catalog baseline. Later scans inspect new IDs plus a bounded prefix, retaining real author/type/media checks. The union must complete before atomically advancing coverage and replacing the baseline. Future IDs remain eligible for the next scan. See the adapter guide for bootstrap, page, catalog and runtime limits.

Manual requests normalize the eligible account set and share a database enqueue lock with scheduled checks. An equivalent active batch is returned with its existing ID; an overlapping but different set returns HTTP 409. Disjoint sets can queue separately. These checks apply across users and browser tabs, not just to the currently disabled button. Requests never reset cursors or interrupt an existing batch. Omitting accountIds targets all currently eligible accounts.

Accounts from different platforms share a batch and are processed sequentially; each selects its platform's clients and retains separate account/adapter cursors. The global network lane permits one live job across workers. This implementation does not provide separate X and Pixiv worker lanes.

Downloads and external requests run outside database transactions. Candidate/observation and cursor commits recheck author authorization, account and adapter revisions, the shared account epoch, actor permissions and both executing leases in short protected transactions. Management changes stop subsequent writes; stale error handlers must not overwrite a newer channel state or release a replacement account epoch. Recovery clears the current error fields while retaining counters, job attempts and a safe structured recovery event.

Long pages renew the account lease at a five-minute interval between media operations, under the current background-job fence and the same management locks. Renewal requires the existing owner, revisions, authorization and an unexpired account lease; it cannot resurrect a stale execution. Ordinary per-image checks do not add a renewal transaction before that interval, and network work remains outside these transactions.

Original downloads enforce the 25 MiB limit on actual streamed bytes, even without a trustworthy Content-Length, and cancel rejected responses. Accepted chunks plus final concatenation can briefly require roughly twice the payload limit; include this and the separate model process in memory budgets.

Normal tests use synthetic fixtures and do not call live platforms or object storage. Before enabling real accounts, validate credentials, window boundaries, multipage coverage, rate limits, interruption recovery and original-file completeness in the intended environment. See the [gallery-dl adapter guide](../../apps/server/src/source-ingestion/adapters/gallery-dl/README.md).
