# BA PixAI adapter

Candidate category tags use the native classes: `ba_art` → **BA 漫画／插画** (success), `ba_related` → **BA 相关** (info), and `other` → **非 BA 内容** (neutral). Text and colors are adapter display metadata, separate from inference identity and review thresholds. They report predictions and do not assert human approval.

This optional adapter includes a TypeScript HTTP client and an independently runnable Python CPU inference service. The implementation is public; the model config, INT8 checkpoint, frozen classifier head, credentials and real images are supplied privately. **Without those model artifacts, this adapter cannot classify images.** It never downloads a model or fabricates fallback scores.

Comiku's default installation does not install PyTorch or start this service. Run one resident service separately and let the API and worker share it. The service and clients must share the same loopback network namespace.

## Private model inputs

Keep model artifacts in a private directory outside the checkout. Supply their paths through the model process's environment, explicit CLI flags or optional JSON configuration; filenames and layout are arbitrary. No new repository-root configuration or model directory is required.

The loader reads only `config.json` from the configured model directory, the specified checkpoint and the specified head. It does not search a default directory, load Python source from the model directory or depend on training/experiment tools.

Only the frozen artifacts recognized by this implementation are accepted. Renaming or retraining a model does not make it compatible. The loader verifies SHA-256 for the backbone, model config, packaged pipeline, extraction helper, preprocessor config and classifier head before restoring the model. It also checks the head's three ordered classes, 1024 feature dimensions, L2 normalization, matrix shape and finite values.

| Artifact        | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| INT8 checkpoint | `bcb66dd898ee241e2172bfd4aa9e03c9df3f538df503c2404657980c02cc5c4b` |
| Model config    | `f8a19b38661c37dc5fd519f2137be70f6f897972021b4ebc17b7d35a0e27b9dd` |
| R3 head         | `c7c33ed851bdb48e4780cb4a584facf6416c0d5d9ccacfd28d9c77362f6bce49` |
| R4 head         | `5ea2a9ac1cf7c6294e823fb624aadd7e03d9645bd43c7c0fcc8741ba0eba45f2` |
| R5 head         | `fd3a830bc8d19a932a0cde80a42aa1dbd43b085270625f225af4389d396cc862` |

No model artifact or access entitlement is distributed with the code. Obtain compatible artifacts through an authorized source. Do not commit model files, private adapter configuration, samples or generated inference output, or include them in a Docker build context.

## Install the optional runtime

Use Python 3.10+ on an x86-64 CPU with PyTorch's `x86` quantization engine. Create a separate virtual environment; then run these commands from the repository root, with that environment active:

```sh
python -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r apps/server/src/image-analysis/adapters/ba-pixai/python/requirements.txt
```

These are the frozen runtime versions, not an instruction to upgrade a shared Python environment. Training and export dependencies are not required. The service uses only CPU INT8 restoration, sets Hugging Face/Transformers offline mode, and does not execute remote model code.

## Start the service

Use your existing private `model.env` or service-manager configuration to supply the model process's environment. For example:

```dotenv
PIXAI_MODEL_DIR=/srv/comiku-models/ba-pixai/model
PIXAI_CHECKPOINT=/srv/comiku-models/ba-pixai/pixai-linear-dynamic-int8-state.pt
PIXAI_HEAD_FILE=/srv/comiku-models/ba-pixai/INT8-three-class-head.frozen.json
PIXAI_SERVICE_TOKEN=replace-with-a-private-random-token
PIXAI_HOST=127.0.0.1
PIXAI_PORT=19123
PIXAI_INTRA_OP_THREADS=2
```

The service reads process environment variables; it does not parse `.env` files itself. Have systemd inject a private file with `EnvironmentFile=/absolute/path/to/model.env`, or export variables in your shell before starting Python. Keep the model environment separate from Comiku's application environment in production so the model process does not receive database or R2 credentials.

With that environment injected, run from the repository root:

```sh
python apps/server/src/image-analysis/adapters/ba-pixai/python/pixai_bridge.py
```

The three environment model paths must be absolute. CLI flags take priority over optional JSON `runtime` settings, then process environment, then defaults. All three paths are required through those sources. Host permits only `127.0.0.1`; port accepts 1–65535 and defaults to 19123; intra-op threads accept 1–16 and default to 2. Boolean-like strings and invalid numeric values are rejected. Inter-op threads remain 1.

`PIXAI_SERVICE_TOKEN` takes priority over optional JSON `token`, independently of runtime parameter precedence. The selected secret must contain at least 16 printable ASCII characters without whitespace. An empty environment value fails validation instead of falling back. Keep it equal to the Node client's JSON token.

The original three absolute-path CLI flags remain supported:

```sh
python apps/server/src/image-analysis/adapters/ba-pixai/python/pixai_bridge.py \
  --model-dir /srv/comiku-models/ba-pixai/model \
  --checkpoint /srv/comiku-models/ba-pixai/pixai-linear-dynamic-int8-state.pt \
  --head-file /srv/comiku-models/ba-pixai/INT8-three-class-head.frozen.json \
  --host 127.0.0.1 --port 19123 --intra-op-threads 2
```

Optionally, `--config /absolute/path/to/ba-pixai.json` reads a shared client/runtime UTF-8 JSON object of at most 64 KiB. Its `runtime` object accepts `modelDir`, `checkpoint`, `headFile`, `host`, `port` and `intraOpThreads`. JSON paths may be absolute or relative to that JSON file's directory. Known field types and runtime bounds are validated before model loading. Configuration and CLI errors do not print private values.

Choose a CPU budget after measuring memory, inference latency and contention on the target host. Starting another process loads another copy of the model. Graceful shutdown drains accepted requests before removing encoder hooks.

The packaged `python/` directory is also standalone: it can be copied intact and run as `python /path/to/python/pixai_bridge.py ...`. It has no dependency on the Comiku checkout, its database, a training directory or an experiment layout. The upstream frozen helper retains historical default-path code for provenance; `pixai_loader.py` binds the explicit inputs on a fresh module and calls only its CPU restore/encoder path.

## Connect Comiku

Keep the main Comiku `.env` configuration focused on selecting the adapter and private client JSON file:

```dotenv
IMAGE_ANALYSIS_ADAPTER=ba-pixai
IMAGE_ANALYSIS_CONFIG_FILE=/etc/comiku/ba-pixai.json
```

Authenticated `GET /v2/capabilities` reports the exact served `modelRevision`, `decisionVersion`, score definition and resource limits. Read that response before enabling the adapter; the chosen head's actual hash determines its decision version. The private client JSON contains:

```json
{
  "url": "http://127.0.0.1:19123",
  "token": "your-private-secret",
  "modelRevision": "copy-modelRevision-from-capabilities",
  "decisionVersion": "copy-decisionVersion-from-capabilities",
  "preprocessVersion": "original-whole-v1"
}
```

Configure both API and worker with those same settings. Python does not need this JSON file when its environment or CLI supplies the model paths and token. If you choose to pass it through `--config`, it can also hold the optional `runtime` object; Node ignores that object. Client revision fields never redefine the Python service's frozen identity. Keep `url` consistent with the effective model listener. See the [image-analysis configuration guide](../../../../../../docs/adapters/image-analysis.md) for adapter selection, persistence and version changes. The TS adapter sends original bytes to `POST /v2/analyze`; it does not start Python itself.

The service retains the existing HTTP v2 identity and response protocol. Each request has one item and one `whole` view with `preprocessVersion: original-whole-v1`, original-byte `sourceSha256`, and base64 original JPEG, PNG, GIF or static WebP bytes in `jpegBase64`. Despite the field name, no JPEG re-encoding is applied. URLs are never fetched. Every route requires the bearer token. `/capabilities` and `/analyze` aliases remain available; `/native/v2/capabilities` and `/native/v2/analyze` expose the original native BA tag score from the same model.

The frozen helper preserves PIL EXIF transpose, alpha handling and the upstream `RescalePadProcessor(size=1008)`. CPU INT8 restoration keeps the 131 quantized Linear layers and verifies native-logit feature replay on the first successful inference. The head uses the original Python L2, dot-product and stable three-class softmax operation order. The service reports `ba_art`, `ba_related`, `other`, with review score equal to the `ba_art` softmax component. This score is not a calibrated probability of suitability. Evidence retains the BA tag and strongest BA character, including characters outside the native top ten.

The TS adapter preserves the service's BA-specific taxonomy: `ba_art` means Blue Archive comics and illustrations, `ba_related` means related content, and `other` means other content. It also preserves the original result in evidence. This classification does not establish sequential-panel detection. For a complete current-model candidate, its review policy promotes the candidate when at least one image's winning class is `ba_art`, without an extra confidence cutoff. The post's category tag represents its highest-ranking image; promotion still checks all images.

Adapter version `2` replaces the earlier wrapper's generic `comic`/`comic_related` names with these native BA labels. This taxonomy change creates a new Comiku model key and new analysis results while retaining previous results as history. The Python protocol, model artifacts and frozen model revision remain unchanged.

## Resource limits and verification

The runtime admits at most two HTTP handlers before reading request bodies and uses one shared inference lock. Excess connections receive HTTP 429; an admitted request waits at most one second for inference before receiving item error `busy`. Request JSON is limited to 48 MiB, original image bytes to 32 MiB, and decoded images to 40 million pixels. Socket reads have a 15-second timeout. The TS client has a 600-second request timeout; disconnecting a client does not interrupt an already running PyTorch call. There is no persistent inference queue inside Python.

Memory includes resident model weights, temporary checkpoint restoration, two admitted JSON/base64 bodies, Pillow decoding and a temporary original-image file per admitted request. The frozen helper retains its own checkpoint checksum/restoration behavior. A small synthetic test cannot establish production capacity. Measure RSS/peak memory, CPU, single-image latency, HTTP transfer overhead and contention with other services before enabling production workloads. Comiku's persistent heavy queue should provide scheduling and retry rather than adding parallel resident model processes.

Run offline behavior tests from the repository root:

```sh
python -m unittest discover -s apps/server/src/image-analysis/adapters/ba-pixai/python/tests
```

Tests need only Pillow and the Python standard library, use synthetic images and a fake encoder, and do not import PyTorch/Transformers or load weights. They verify protocol compatibility, L2 score behavior, selected-head identity, byte/pixel/view limits, authenticated bounded HTTP handling, JSON size/types, relative config paths, CLI/JSON/environment precedence, token precedence, private-error handling, configured threads, artifact rejection and cleanup. `python python/pixai_bridge.py --help`, when run from this adapter directory, also needs no optional dependencies. These checks do not verify real model predictions; validate real inference separately with authorized private artifacts and fixtures.

## Licenses and provenance

Project-owned bridge/loader code uses Comiku's MIT license. The unmodified upstream `tagger_pipeline.py` and `preprocessor_config.json` originate from [PixAI Labs' pixai-tagger-v1.0](https://huggingface.co/pixai-labs/pixai-tagger-v1.0), revision `9fe10addf9326e292da8a85a98ea74cd91b41771`. Their Apache-2.0 [LICENSE](python/pixai/LICENSE) and original [NOTICE](python/pixai/NOTICE.md) are preserved beside them, including the architecture attribution comments. `frozen_feature_helper.py` is the project's original frozen extraction helper, also copied byte-for-byte. The NOTICE's historical `pixai_feature_helper.py` adapter is replaced here by `pixai_loader.py`; the frozen files themselves are unchanged.

Do not reformat or edit the hashed files under `python/pixai/` without intentionally defining and validating a new model/preprocessing identity. Model artifact licensing and access are separate from the service source license.
