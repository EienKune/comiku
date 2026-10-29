# gallery-dl bridge

Python handles gallery-dl's native extractors; TypeScript owns Comiku identity, durable cursors, media transfer and candidate records.

Install `python/requirements.txt` in a separate Python environment. Set `GALLERY_DL_PYTHON` to its absolute Python executable and `GALLERY_DL_X_CONFIG` / `GALLERY_DL_PIXIV_CONFIG` to private gallery-dl JSON configurations outside this repository. The bridge requires gallery-dl 1.32.11 because its native pagination hooks are version-specific. Upgrades require replay and real-session validation.

gallery-dl is an external dependency licensed under GPL-2.0-only. Its upstream source and license are at https://github.com/mikf/gallery-dl. No upstream extractor source is copied here. Preserve applicable dependency notices and source obligations when distributing a bundled runtime.

Run offline checks with `python -m unittest discover -s apps/server/src/source-ingestion/adapters/gallery-dl/python`. These fixtures never use real credentials. Platform IDs are serialized as strings to preserve all digits in JavaScript. Missing or unavailable native photos fail the page rather than admitting a partial post.

TypeScript, Python and pinned requirements live in this adapter directory. The server build copies the Python bridge and requirements next to the compiled adapter; private configurations and credentials are never copied.

The default `runtime` Docker target has no Python. Build the optional `gallery-runtime` target to include Python/gallery-dl, then mount private configuration files and set the platform config paths. The standard runtime keeps its original dependency footprint.

## Pixiv pagination

Pixiv uses two bounded stages. The App API enumerates native pages of at most 30 works with ordered overlap checks. When gallery-dl's `sanity` option is enabled (the upstream default), a separate AJAX stage supplements the App API: it reads at most 100 work metadata entries and resolves at most 20 recent static works per bridge call. It reuses native original-media conversion, rather than attaching the native full-traversal sanity iterator to each offset page. Known old App works also skip expensive media conversion. Optional comments, user/bookmark/caption enrichment and animation downloads are disabled in this ingestion bridge.

The AJAX stage validates actual author, timezone-aware publication date and artwork type before applying the cutoff. Pixiv list timestamps may retain seconds while detail timestamps are truncated to a minute: validation accepts exact equality or that explicit UTC-minute truncation relationship, not arbitrary time drift. Discovery conservatively includes the cutoff's entire minute, while native detail timestamps remain unchanged and control persistence. Old metadata pages do not terminate the scan: lower IDs are not proof of older publication dates. Static works permit at most 1,000 images, checked before native list allocation. Animations are explicitly excluded.

Version 3 provider cursors bind the source, both window bounds, successful discovery baseline, stage and bounded progress. AJAX cursors carry fixed-length fingerprints and offsets, not the whole author's ID list. Each AJAX page checks the catalog before and after processing; final completion also rechecks the App API head. A changed snapshot restarts the same frozen window once, without pretending that it completed. Network failures retain the normal retry path. Legacy Pixiv cursors restart from the safe lower boundary; X retains its existing restart behavior.

The service fixes each scan to `[startTime, endTime)`. A new account uses its configured initial window. Subsequent scans begin at the last successfully covered upper bound minus the configured overlap; successful empty scans also advance coverage. Publication watermarks do not define coverage, and interrupted scans retain both original bounds. Native detail timestamps control the exact boundary; known future works are deferred rather than added to the successful baseline.

With sanity enabled, two complete, ordered App pages older than the lower bound switch to the AJAX supplement. The first successful scan establishes a source-bound catalog baseline and may inspect historical metadata once, including for `none` initialization; old works do not expand original media. Subsequent scans check catalog additions and 20 prefix IDs. The full ID listing remains necessary to find new low IDs, but old metadata is not fetched repeatedly. Future IDs and the upper-bound minute during `none` initialization remain outside the baseline for the next scan. The baseline is committed only with complete coverage, separately from the resumable cursor, and omitted from ordinary account/history responses.

The catalog is capped at 100,000 IDs, with at most 1,000 deferred future IDs in a cursor. Calls retain the existing 120-second process limit; one job retains the 100-page safety limit. A later Pixiv run can resume durable progress after interruption or the page limit; cumulative page count is not a permanent 100-page ceiling. The service stores its verified observed publication watermark alongside the cursor and applies it only after complete coverage. These limits bound individual calls, not total collection time: initial bootstrap and anomalous ordering can require more work, and platform accounts continue to share the network lane. Measure full-run time and request volume before increasing account counts.

Setting `sanity: false` intentionally skips the AJAX supplement and cannot claim coverage of AJAX-only works. Tests use synthetic sources; real-session validation remains necessary when changing gallery-dl or its response contracts.
