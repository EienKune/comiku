"""Load the frozen local CPU encoder without training tools or remote code.

Only the allowlisted config, checkpoint and head are private inputs. Architecture,
preprocessing and extraction code are packaged beside this loader.
"""

import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sys

BACKBONE_SHA = "bcb66dd898ee241e2172bfd4aa9e03c9df3f538df503c2404657980c02cc5c4b"
CONFIG_SHA = "f8a19b38661c37dc5fd519f2137be70f6f897972021b4ebc17b7d35a0e27b9dd"
PIPELINE_SHA = "3431279fdfff234f62664999fc1fe6bb20f1e8756f7435d0e165ebd4456f7fcd"
HELPER_SHA = "e6447fe4254a25e359801d2cb5d400a43c51159cf14b9cb5ef708f628b3cd374"
PREPROCESSOR_SHA = "14f343f7b7c5884cf42bd59b057c6c87300e1db5edfcd11d979dcfb7bc0fd920"
HEAD_SHA = "c7c33ed851bdb48e4780cb4a584facf6416c0d5d9ccacfd28d9c77362f6bce49"
HEAD_HASHES = frozenset([
    HEAD_SHA,
    "5ea2a9ac1cf7c6294e823fb624aadd7e03d9645bd43c7c0fcc8741ba0eba45f2",
    "fd3a830bc8d19a932a0cde80a42aa1dbd43b085270625f225af4389d396cc862",
])
CLASSES = ["ba_art", "ba_related", "other"]
INTRA_OP_THREADS = 2
PIXAI_DIR = Path(__file__).resolve().parent / "pixai"
PACKAGED_HASHES = {
    "tagger_pipeline.py": PIPELINE_SHA,
    "frozen_feature_helper.py": HELPER_SHA,
    "preprocessor_config.json": PREPROCESSOR_SHA,
}


def file_sha256(path):
    # Do not allocate another checkpoint-sized buffer during the startup check.
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def checked(path, expected, artifact):
    try:
        actual = file_sha256(path)
    except OSError:
        raise RuntimeError(artifact + " is unavailable") from None
    if actual != expected:
        raise RuntimeError(artifact + " SHA mismatch")


def verify_packaged_runtime():
    for name, expected in PACKAGED_HASHES.items():
        checked(PIXAI_DIR / name, expected, name)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def load_head(path):
    try:
        with Path(path).open("rb") as source:
            raw = source.read((4 << 20) + 1)
    except OSError:
        raise RuntimeError("Frozen head is unavailable") from None
    digest = hashlib.sha256(raw).hexdigest()
    if len(raw) > 4 << 20 or digest not in HEAD_HASHES:
        raise RuntimeError("Unrecognized frozen head hash")
    try:
        head = json.loads(raw)
        weights = head["weights"]
        bias = head["bias"]
        valid = (
            head.get("classes") == CLASSES
            and head.get("feature_dimension") == 1024
            and head.get("feature_normalization") in ("L2eachvector", "L2 each vector")
            and isinstance(weights, list)
            and len(weights) == 1024
            and all(isinstance(row, list) and len(row) == 3 and all(finite_number(value) for value in row) for row in weights)
            and isinstance(bias, list)
            and len(bias) == 3
            and all(finite_number(value) for value in bias)
        )
    except (ValueError, TypeError, KeyError, AttributeError):
        valid = False
    if not valid:
        raise RuntimeError("Invalid frozen head schema")
    return head, digest


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def load_encoder(model_dir, checkpoint, intra_op_threads=INTRA_OP_THREADS):
    """Restore one exact INT8 encoder on CPU; never download or read model code.

    The frozen helper's numerical code is kept byte-identical. Binding MODEL and
    CHECKPOINT on a fresh module replaces its historical experiment defaults.
    Its pipeline()/load_encoder() experiment entrypoints are never invoked.
    """
    model_dir, checkpoint = Path(model_dir), Path(checkpoint)
    if not model_dir.is_absolute() or not checkpoint.is_absolute():
        raise RuntimeError("Model paths must be absolute")
    if type(intra_op_threads) is not int or not 1 <= intra_op_threads <= 16:
        raise RuntimeError("Intra-op threads must be between 1 and 16")
    checked(model_dir / "config.json", CONFIG_SHA, "PixAI model config")
    checked(checkpoint, BACKBONE_SHA, "Frozen PixAI checkpoint")
    verify_packaged_runtime()
    if platform.machine().lower() not in ("x86_64", "amd64"):
        raise RuntimeError("Frozen PixAI requires an x86-64 CPU")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        import torch
    except ImportError:
        raise RuntimeError("Install the optional pinned PixAI runtime dependencies") from None
    if "x86" not in torch.backends.quantized.supported_engines:
        raise RuntimeError("Frozen INT8 requires the x86 quantization engine")
    torch.set_num_threads(intra_op_threads)
    torch.set_num_interop_threads(1)
    torch.backends.quantized.engine = "x86"
    helper = load_module("frozen_pixai_feature_helper", PIXAI_DIR / "frozen_feature_helper.py")
    helper.MODEL = model_dir
    helper.CHECKPOINT = checkpoint
    pipeline = load_module("pixai_local_feature_pipeline", PIXAI_DIR / "tagger_pipeline.py")
    return helper.PixAIEncoder(helper.restore_int8(pipeline), pipeline, "cpu")
