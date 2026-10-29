# Image analysis adapters

Image analysis is optional and disabled by default. With no `IMAGE_ANALYSIS_ADAPTER` setting, or with `IMAGE_ANALYSIS_ADAPTER=disabled`, Comiku collects media and leaves new media unclassified. An unavailable model never supplies a fallback classification or fabricated score.

Only one adapter is active per process. Configure the API and worker with the same adapter and versions; use the controlled activation procedure below when changing them. Inference runs through the persistent `analysis/global` slot, independently of the `heavy` export/thumbnail slot, source collection and human review.

`ImageAnalysisAdapter` is the model integration entry point. The unused legacy `CandidateMediaClassifier` hook in source ingestion has been removed. Manual manga/photo classification and reads of historical classification suggestions remain supported; no historical rows are deleted. Custom model labels do not automatically change the manga/photo classification.

## Contract

The public port is `apps/server/src/image-analysis/image-analysis-adapter.ts`. Each adapter declares an immutable identity and implements `analyze(itemId, originalBytes, abortSignal)`. Comiku verifies the original file's SHA-256 before inference.

| Identity field      | Identifies                                   |
| ------------------- | -------------------------------------------- |
| `adapterId`         | Provider or implementation                   |
| `adapterVersion`    | Adapter protocol and label mapping           |
| `modelId`           | Model architecture or artifact family        |
| `modelRevision`     | Frozen model weights                         |
| `decisionVersion`   | Classifier head, decision and priority rules |
| `preprocessVersion` | Image decoding, views and preprocessing      |
| `labels`            | Ordered output taxonomy                      |

The six identity strings must be nonempty and at most 256 characters. `labels` is an ordered array of **2–100 unique, nonempty strings**, each at most 256 characters. The generic interface has no fixed class enum; binary and multiclass models use the same port.

Comiku derives `modelKey` from all identity fields, including the ordered taxonomy, using a versioned SHA-256 digest. Different providers or taxonomies cannot share results merely because model revision strings match. Change the relevant identity whenever output behavior changes. Keep URLs and secrets out of identities.

For an adapter whose labels are `["accept", "reject"]`, a valid result is:

```js
{
  score: 0.91,
  predictedClass: "reject",
  classScores: [
    { label: "accept", value: 0.20 },
    { label: "reject", value: 0.80 }
  ],
  evidence: [{ /* JSON evidence for later inspection */ }]
}
```

`classScores` must contain exactly the declared labels in their declared order. Probabilities must be finite numbers in `[0, 1]` and sum to one within `0.00001`. `predictedClass` must name the highest-probability class; the first declared label wins ties.

`score` is an independent, finite review-priority value in `[0, 1]`, defined by the adapter. It need not equal a class probability. Candidate priority is the maximum score across all successfully analyzed media for the active identity; scores from different identities are not combined. A provider-specific taxonomy can be mapped explicitly, retaining original evidence and versioning the mapping in `adapterVersion`.

Evidence contains at most 32 JSON objects. The complete result is limited to 1 MiB; original input is limited to 32 MiB. Invalid results and exceptions fail the job with a controlled error. Adapters must honor cancellation, bound network calls and response sizes, and avoid logging credentials or upstream bodies. Both the adapter boundary and persistence service validate against `identity.labels`. Full identity is persisted with successful results and queued job payloads.

An adapter can optionally declare `reviewPolicy: { positiveLabels: ["accept"], minimumConfidence: 0.5 }`. Labels must be unique members of its taxonomy and the threshold must be finite and within `[0, 1]`. A neutral candidate enters the priority group when at least one image's winning class is a positive label with confidence at or above that threshold. The independent ranking `score` does not decide promotion. Human/legacy photo classification and blocked tags take precedence; configured valid tags remain valid. Without a policy, model results only affect ranking.

Validated successful images from the current model are summarized in `analysisPredictions` with each winning label's maximum confidence and maximum ranking `score`, calculated independently. Candidate listing uses this cache together with `analysisModelKey` and valid ranked evidence, independently of summary completion state, avoiding per-image result joins. Missing, queued, failed or malformed sibling results do not erase valid successful evidence and never count as `other`. Stale or disabled-model summaries cannot promote a candidate. A bounded scan upgrades at most 20 candidate summaries per pass to `analysisSummaryVersion=1`, including malformed or empty summaries, from validated persisted results without repeating successful inference. The version records completed summary processing, not successful inference. The frozen review policy is applied at read time and is not part of `modelKey`; changing only the routing threshold does not relabel or recompute model outputs. Configure API and worker consistently and restart both after a policy change.

## Category tags

An adapter can declare optional `labelPresentation` entries such as `{ label: "accept", text: "Accepted category", tone: "info" }`. Each label must belong to its taxonomy and appear at most once. Text is nonempty and at most 256 characters; tone uses the existing `neutral`, `info`, `success`, `warning` or `danger` presentation tokens. Undeclared labels fall back to their raw class name and neutral tone. Display metadata is validated and frozen, but does not enter the inference identity: changing text or colors never triggers inference again.

Candidate responses expose `classificationTags` as at most one `{ label, text, tone }` entry from validated current-model prediction caches: the winning class of the highest-ranking image. Equal ranking scores use taxonomy order as a stable tie-breaker. Class confidence is not substituted for ranking score, and old caches without ranking scores must be rebuilt before displaying a representative category. Promotion checks all images independently of this representative: a lower-ranking positive image can promote the post even if the representative has another class. Disabled or stale caches, or candidates with no valid successful images, supply no category tags. `canRetryAnalysis` independently indicates active current-model terminal failures, so successful evidence does not remove the retry action. `analysisPending` counts eligible media that can still advance or need summary-version/provenance repair; a failed sibling does not hide queued work, and terminal-only media stop polling. The cards keep original hashtag disposition separate and do not add model-hit, score-band or inference-state badges.

## Built-in BA PixAI adapter

The BA adapter and HTTP client are public source under `apps/server/src/image-analysis/adapters/ba-pixai/`. Their synthetic protocol tests are in `apps/server/test/ba-pixai-adapter.test.ts`. Model weights, credentials, training data and runtime output are supplied separately and must stay outside source control and the generic Docker build context.

```dotenv
IMAGE_ANALYSIS_ADAPTER=ba-pixai
IMAGE_ANALYSIS_CONFIG_FILE=/etc/comiku/ba-pixai.json
```

No `IMAGE_ANALYSIS_MODULE` setting is used for this built-in adapter. Keep these settings in the existing Comiku `.env` or process environment. The private client JSON file must have an absolute path and contain:

```json
{
  "url": "http://127.0.0.1:19123",
  "token": "replace-with-your-private-token",
  "modelRevision": "your-frozen-model-revision",
  "decisionVersion": "your-frozen-head-version",
  "preprocessVersion": "original-whole-v1"
}
```

Run the optional [resident PixAI HTTP v2 service](../../apps/server/src/image-analysis/adapters/ba-pixai/README.md) separately. Its implementation, frozen extraction helper and attributed architecture code live beside the TS adapter in `python/`; training tools are not required. Keep weights and classifier heads in a private directory outside the checkout. Supply absolute paths through `PIXAI_MODEL_DIR`, `PIXAI_CHECKPOINT` and `PIXAI_HEAD_FILE`, and set `PIXAI_SERVICE_TOKEN`. Optional `PIXAI_HOST`, `PIXAI_PORT` and `PIXAI_INTRA_OP_THREADS` configure the listener and CPU budget. Inject a private `model.env` with systemd `EnvironmentFile` or export the variables in your shell; Python does not parse `.env` files. Keep the model environment separate from database/R2 credentials in production. No repository-root model or configuration directory is required, and there is no default path search or automatic download.

Python runtime parameter precedence is CLI → optional JSON `runtime` → process environment → defaults. Its old `--model-dir`, `--checkpoint` and `--head-file` absolute-path invocation remains supported. `--config /absolute/path/to/ba-pixai.json` is optional; when used, it can share the Node client's JSON file. The optional `runtime` object accepts `modelDir`, `checkpoint`, `headFile`, `host`, `port` and `intraOpThreads`; JSON paths can resolve relative to that file's directory. Environment and CLI paths must be absolute. Runtime binding remains `127.0.0.1`; port accepts 1–65535 and intra-op threads 1–16, defaulting to 19123 and 2. `PIXAI_SERVICE_TOKEN` overrides Python's JSON token when present; keep it equal to the Node client's token. Node ignores `runtime`, and client revision fields do not redefine Python's served identity.

The adapter sends original bytes to `/v2/analyze`; it does not load weights or start a model process. `url` must be an exact HTTP origin on `127.0.0.1`, with no path or redirect, and must agree with the effective listener. API/worker processes and the inference service must share the intended loopback network namespace. Mount private configuration read-only into both API and worker containers; only Python needs access to model artifacts. Real configuration, models and heads stay out of Git and Docker build contexts.

The client validates request/item IDs, frozen model/head revisions, probabilities, evidence and the reported BA score. This specific protocol requires the score to equal the `ba_art` probability. The BA adapter declares and preserves the native labels `ba_art` (BA comic/art), `ba_related` (other BA-related content), and `other`. Its review policy promotes a post when any image's winning class is `ba_art`, without an additional confidence cutoff. The generic interface remains independent of this taxonomy and scoring rule.

The category tags display `ba_art` as “BA 漫画／插画” with success tone, `ba_related` as “BA 相关” with info tone, and `other` as “非 BA 内容” with neutral tone. These are model predictions, independent of human approval or hashtag matching. The generic example uses its own comic-category presentation; other adapters may declare binary or multiclass labels without BA-specific UI code.

These classes represent BA source-review decisions; they do not establish that the model detects sequential comic panels. Adapter version 2 replaces the earlier generic label mapping and therefore creates a new model identity; existing generic-label results remain historical and are not renamed. The entire original successful result and character evidence remain under `evidence[0].originalResult`. Frozen model, head and preprocessing revisions must match the separately configured service.

## Synthetic example

```dotenv
IMAGE_ANALYSIS_ADAPTER=example
```

The built-in `example-synthetic` adapter demonstrates a three-class contract with labels `["comic", "comic_related", "other"]` and a `comic >= 0.5` review policy. Every input receives fixed probabilities `0.75 / 0.20 / 0.05`, score `0.75`, and evidence containing `synthetic: true`. It does not inspect the image and is unsuitable for real review decisions. Enable it only in a disposable demonstration environment. It is never selected automatically.

## External implementation

```dotenv
IMAGE_ANALYSIS_ADAPTER=external
IMAGE_ANALYSIS_MODULE=/opt/comiku/adapters/custom/adapter.mjs
IMAGE_ANALYSIS_CONFIG_FILE=/etc/comiku/image-analysis.json
```

Both paths must be absolute. For either the built-in BA adapter or an external adapter, the config file must contain a JSON object and be no larger than 64 KiB. Its contents are supplied only to the selected factory. Mount external module code and private configuration read-only into both API and worker containers. Relative imports within that module work normally; plain `.mjs` modules can use Node built-ins without compilation.

The module exports:

```ts
export function createImageAnalysisAdapter(
  config: Record<string, unknown>,
): ImageAnalysisAdapter | Promise<ImageAnalysisAdapter>;
```

The factory validates provider configuration, prepares a lightweight client and returns the port implementation with its own labels and priority rule. Invalid modules or configuration fail startup with a controlled error. Paths and provider errors are not returned to web clients. This is executable server code selected by a trusted administrator; no browser upload or selection mechanism is provided.

External implementations must declare `identity.labels`; older modules without a taxonomy must be updated before use. Binary classifiers can declare two domain-specific labels directly, without mapping into the built-in BA adapter's three classes.

## Queue and version changes

Analysis uses `image_analysis` jobs and `image-analysis:<mediaId>:<modelKey>` idempotency keys. New identities create independent media-analysis rows; historical successful rows and model keys remain unchanged. Adding or changing a taxonomy creates a new identity and triggers fresh analysis of existing media. Historical results are never relabelled to impersonate the new identity. Existing database migrations are not rewritten.

A bounded recovery scan settles queued analyses whose adapter has been disabled or replaced, and retires their generic jobs. A live lease is left to its owner; expired leases are settled on a later scan. Each call processes at most 100 retired rows and independently discovers at most 20 incremental and 20 historical images. Retries preserve identity, use existing lease checks and stop after three attempts. An exhausted worker claim is reconciled even if the process died before recording failure. Manual retry applies only to the active adapter's failed rows. Analysis does not change human review status, revision or review time.

The default Comiku image includes lightweight adapter code and requires no model runtime when analysis is disabled. Measure a separate runtime's memory and latency, reuse resident models, and account for the single analysis/global lease slot and independent heavy exports when selecting runtime capacity. Identity changes require one fresh inference per media item; include this backfill cost in deployment planning.

## Persistent scheduling and activation

`ImageAnalysisActivation` stores the global active model key (nullable when disabled), generation, activation cutoff and historical pause. An absent row can bootstrap from the worker configuration only after all running image-analysis jobs drain. Existing rows are never replaced by an ordinary worker. A mismatched worker fails its claim transaction without consuming an attempt or fairness budget and backs off locally. Read-only API requests do not activate models.

For each `(mediaId, modelKey)`, an immutable work intent records its purpose and original activation generation. Without an intent, media created at or after the stored cutoff are incremental; earlier media are historical. Intent, analysis row and idempotent job registration commit together. Discovery after a media commit/process crash uses the same stored cutoff. Restarts, retries and switching back to an old key preserve existing intents and successful results. Queue policy is never part of model identity. The key remains `image-analysis:{mediaId}:{modelKey}`.

Every scan discovers at most 20 incremental and 20 historical images independently; a historical backlog cannot consume incremental discovery slots. The existing durable Jobs policy chooses incremental/historical 3:1 when both are eligible, sharing one analysis/global lease across workers. Historical discovery can be paused or restricted through `schedulePending(candidateId)`; persisted pause also gates already queued historical work without consuming attempts. Summary repair, partial-image evidence and exhausted-attempt reconciliation retain their existing bounded behavior.

### Controlled maintenance

The normal build ships `dist/ops/image-analysis.js`. From the server runtime directory:

```sh
node dist/ops/image-analysis.js status
node dist/ops/image-analysis.js activate <model-key-or-disabled> <expected-generation> <run-or-pause>
```

Derive the configured key from the shipped adapter descriptor without starting AppModule, a worker or inference (run from the server runtime directory with the target configuration):

```sh
node --input-type=module -e "const {loadEnvironment}=await import('./dist/config/environment.js'); const {loadImageAnalysisAdapter}=await import('./dist/image-analysis/adapter-loader.js'); const model=await loadImageAnalysisAdapter(loadEnvironment().imageAnalysis); console.log(model?.modelKey ?? 'disabled');"
```

This invokes the configured adapter factory only; an external adapter factory must follow the normal trusted-module deployment contract. The built-in adapters do not load weights or call inference during descriptor validation. The `status` and `activate` CLI paths themselves do not load adapter factories.

Use the emitted exact 64-character model key; `disabled` selects no model. Use `0` only for an absent activation row. The CLI loads database/queue helpers only, with no AppModule, adapter initialization, weights, source checkout or TSX. It emits safe activation metadata only. `pnpm --filter @comiku/server images:activation` is the full-checkout alias after compiling the server.

Disable scheduling, drain running inference and stop old workers before changing model configuration. Read the generation, perform the explicit compare-and-swap activation, then start API and workers with the matching configuration. A running job, including one with an expired lease, blocks activation until it is drained/reconciled. `run` enables historical work and `pause` suspends it; changing pause with the same key preserves the cutoff while advancing generation. A key change establishes a new persistent cutoff. A stale generation or stale local worker cannot reverse a switch.

On upgrade from the heavy lane, stop old workers after draining running image analysis. New scheduling migrates at most 20 queued legacy jobs per pass under the analysis/global then heavy/global claim barriers, taking job locks in stable order. Running jobs never move. New heavy claim gates defer legacy analysis jobs; new analysis claims wait while any legacy inference is running. This is a controlled upgrade, not compatibility with concurrently running old software. Other heavy tasks keep their existing lane and run independently.

All model/storage calls remain outside transactions. The healthy-worker concurrency guarantee is one leased job plus one resident model inference/encoding lock. An expired lease cannot physically stop an uncooperative executor or an already accepted remote inference; deployments must retain the resident single-encoding lock and drain before switching. Synthetic two-worker tests measure queue fairness, maximum inference concurrency, busy count, Node RSS/CPU and concurrent heavy-export latency. They do not measure real model memory, GPU throughput or production latency; those require environment-specific acceptance measurements.
