# gallery-dl bridge

Python handles gallery-dl's native extractors; TypeScript owns Comiku identity, durable cursors, media transfer and candidate records.

Install `python/requirements.txt` in a separate Python environment. Set `GALLERY_DL_PYTHON` to its absolute Python executable and `GALLERY_DL_X_CONFIG` / `GALLERY_DL_PIXIV_CONFIG` to private gallery-dl JSON configurations outside this repository. The bridge requires gallery-dl 1.32.11 because its native pagination hooks are version-specific. Upgrades require replay and real-session validation.

gallery-dl is an external dependency licensed under GPL-2.0-only. Its upstream source and license are at https://github.com/mikf/gallery-dl. No upstream extractor source is copied here. Preserve applicable dependency notices and source obligations when distributing a bundled runtime.

Run offline checks with `python -m unittest discover -s apps/server/src/source-ingestion/adapters/gallery-dl/python`. These fixtures never use real credentials. Platform IDs are serialized as strings to preserve all digits in JavaScript. Missing or unavailable native photos fail the page rather than admitting a partial post.

TypeScript, Python and pinned requirements live in this adapter directory. The server build copies the Python bridge and requirements next to the compiled adapter; private configurations and credentials are never copied.

The default `runtime` Docker target has no Python. Build the optional `gallery-runtime` target to include Python/gallery-dl, then mount private configuration files and set the platform config paths. The standard runtime keeps its original dependency footprint.
