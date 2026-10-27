"""Authenticated, bounded loopback HTTP v2 service for the BA PixAI adapter."""

import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time

from pixai_loader import (
    BACKBONE_SHA, CLASSES, CONFIG_SHA, HEAD_HASHES, HEAD_SHA, INTRA_OP_THREADS,
    PIPELINE_SHA, load_encoder, load_head,
)

MODEL_ID = "pixai-int8-three-class"
MODEL_REVISION = "pixai-int8-sha256:" + BACKBONE_SHA + ":config:" + CONFIG_SHA + ":pipeline:" + PIPELINE_SHA
DECISION_VERSION = "l2-softmax3-head-sha256:" + HEAD_SHA + ":original-pil-rescalepad1008-v1"
SCORE_ID = "pixai-ba-art-softmax3-" + HEAD_SHA
NATIVE_MODEL_ID = "pixai-int8-native"
NATIVE_DECISION_VERSION = "pixai-native-blue-archive-v1"
NATIVE_SCORE_ID = "pixai-blue-archive-native-" + BACKBONE_SHA
NATIVE_DEFINITION = {
    "definitionId": NATIVE_SCORE_ID, "kind": "native_score", "target": "ba",
    "range": [0, 1], "higherIsMoreRelevant": True, "label": "BA标签分",
}
DEFINITION = {
    "definitionId": SCORE_ID, "kind": "native_score", "target": "ba_art",
    "range": [0, 1], "higherIsMoreRelevant": True, "label": "BA画作分",
}
MAX_REQUEST = 48 << 20
MAX_INPUT = 32 << 20
MAX_PIXELS = 40_000_000
MAX_CONFIG = 64 << 10


class Invalid(Exception):
    """Fixed protocol error codes; never private exception or input text."""


class NativeEncoder:
    """Retain the strongest BA character even outside the native top ten tags."""

    def __init__(self, encoder):
        self.encoder = encoder
        self.character = None
        self.indices = [i for i, tag in enumerate(encoder.tags) if "(blue_archive)" in tag]
        self.hook = encoder.model.register_forward_hook(self.capture)

    def capture(self, module, args, logits):
        self.character = None
        if self.indices:
            scores = logits[0, self.indices].float().sigmoid()
            index = int(scores.argmax())
            self.character = {"tag": self.encoder.tags[self.indices[index]], "score": float(scores[index])}

    def encode_paths(self, paths, check_parity=False):
        output = self.encoder.encode_paths(paths, check_parity=check_parity)
        if self.character and self.character["tag"] not in [entry["tag"] for entry in output["top_evidence"][0]]:
            output["top_evidence"][0].append(self.character)
        return output

    def close(self):
        try:
            self.hook.remove()
        finally:
            self.encoder.close()


def head_scores(features, head):
    # Retain the original Python L2 / dot product / stable softmax operation order.
    if len(features) != len(head["weights"]) or not all(math.isfinite(float(value)) for value in features):
        raise Invalid("invalid_features")
    norm = math.sqrt(sum(float(value) ** 2 for value in features))
    if norm <= 0:
        raise Invalid("invalid_features")
    logits = [float(head["bias"][i]) + sum(float(value) / norm * float(weight[i]) for value, weight in zip(features, head["weights"])) for i in range(3)]
    values = [math.exp(value - max(logits)) for value in logits]
    return [value / sum(values) for value in values]


def evidence(native, ba):
    result = [{"kind": "tag", "label": "blue_archive", "score": float(ba)}]
    characters = [entry for entry in native if "(blue_archive)" in entry["tag"]]
    if characters:
        entry = max(characters, key=lambda entry: entry["score"])
        result.append({"kind": "character", "label": entry["tag"], "score": float(entry["score"])})
    for entry in native:
        if len(result) == 5:
            break
        if entry["tag"] not in [value["label"] for value in result]:
            result.append({"kind": "tag", "label": entry["tag"], "score": float(entry["score"])})
    return result


class Bridge:
    def __init__(self, encoder, head, intra_op_threads=INTRA_OP_THREADS, head_sha=HEAD_SHA):
        if head_sha not in HEAD_HASHES:
            raise RuntimeError("Unrecognized frozen head hash")
        self.encoder = encoder
        self.head = head
        self.lock = threading.Lock()
        self.parity_checked = False
        self.intra_op_threads = intra_op_threads
        self.decision_version = "l2-softmax3-head-sha256:" + head_sha + ":original-pil-rescalepad1008-v1"
        self.definition = dict(DEFINITION, definitionId="pixai-ba-art-softmax3-" + head_sha)

    def capabilities(self, native=False):
        runtime = {"inferenceBatchSize": 1, "maxConcurrency": 1, "intraOpThreads": self.intra_op_threads}
        return dict(
            schemaVersion=2, modelId=NATIVE_MODEL_ID if native else MODEL_ID,
            modelRevision=MODEL_REVISION,
            decisionVersion=NATIVE_DECISION_VERSION if native else self.decision_version,
            revisionVerification="served", scoreDefinitions=[NATIVE_DEFINITION if native else self.definition],
            supportsBatch=False,
            limits=dict(maxItems=1, maxViewsPerItem=1, maxRequestBytes=MAX_REQUEST,
                        maxEvidencePerItem=5, maxResponseBytes=1 << 20, maxDecodedPixels=MAX_PIXELS,
                        queueCapacity=0, queueTimeoutMs=1000, requestTimeoutMs=600000),
            runtime=dict(configured=runtime, effective=runtime),
        )

    def item(self, item, native=False):
        views = item.get("views")
        if item.get("preprocessVersion") != "original-whole-v1" or not isinstance(views, list) or len(views) != 1 or not isinstance(views[0], dict) or views[0].get("viewId") != "whole":
            raise Invalid("invalid_original_view")
        encoded = views[0].get("jpegBase64")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_INPUT + 2) // 3) * 4:
            raise Invalid("image_too_large")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise Invalid("invalid_base64") from None
        if not raw or len(raw) > MAX_INPUT:
            raise Invalid("image_too_large")
        if hashlib.sha256(raw).hexdigest() != item.get("sourceSha256"):
            raise Invalid("original_sha_mismatch")
        # Lazy import allows --help and argument validation without optional deps.
        from PIL import Image
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise Invalid("pixel_limit")
                if image.format not in ("JPEG", "PNG", "GIF", "WEBP") or (image.format == "WEBP" and getattr(image, "n_frames", 1) != 1):
                    raise Invalid("decode_failed")
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
        except Invalid:
            raise
        except Exception:
            raise Invalid("decode_failed") from None
        with tempfile.TemporaryDirectory(prefix="pixai-") as directory:
            path = Path(directory) / "original"
            path.write_bytes(raw)
            if not self.lock.acquire(timeout=1):
                raise Invalid("busy")
            try:
                output = self.encoder.encode_paths([path], check_parity=not self.parity_checked)
                self.parity_checked = True
            finally:
                self.lock.release()
        if native:
            ba = float(output["blue_archive"][0])
            accepted = ba >= 0.24
            return dict(
                relevance="ba" if accepted else "unknown", imageKind="unknown",
                strength="high" if ba >= 0.85 else "medium" if accepted else "low",
                reason="Original-image PixAI native blue_archive tag score.",
                provider="inference_http", model=NATIVE_MODEL_ID, version=2, elapsedMs=0,
                revisionVerification="served", score=dict(NATIVE_DEFINITION, value=ba),
                evidence=evidence(output["top_evidence"][0], ba),
            )
        scores = head_scores(output["features"][0], self.head)
        winner = max(range(3), key=scores.__getitem__)
        return dict(
            relevance="ba" if winner < 2 else "other", imageKind="unknown",
            strength="high" if scores[winner] >= 0.8 else "medium" if scores[winner] >= 0.55 else "low",
            reason="Original-image PixAI native features with frozen three-class head.",
            provider="inference_http", model=MODEL_ID, version=2, elapsedMs=0, revisionVerification="served",
            predictedClass=CLASSES[winner], classScores=[dict(label=label, value=value) for label, value in zip(CLASSES, scores)],
            score=dict(self.definition, value=scores[0]), evidence=evidence(output["top_evidence"][0], output["blue_archive"][0]),
        )

    def analyze(self, request, native=False):
        decision = NATIVE_DECISION_VERSION if native else self.decision_version
        model = NATIVE_MODEL_ID if native else MODEL_ID
        if not isinstance(request, dict) or request.get("schemaVersion") != 2 or not isinstance(request.get("requestId"), str) or not 0 < len(request["requestId"]) <= 200 or request.get("expectedModelRevision") != MODEL_REVISION or request.get("expectedDecisionVersion") != decision or not isinstance(request.get("items"), list) or len(request["items"]) != 1:
            raise Invalid("invalid_request")
        start = time.monotonic()
        item = request["items"][0]
        if not isinstance(item, dict) or not isinstance(item.get("itemId"), str) or not 0 < len(item["itemId"]) <= 200:
            raise Invalid("invalid_item")
        result = {"itemId": item["itemId"]}
        try:
            result.update(status="succeeded", result=self.item(item, native=native))
        except Invalid as error:
            result.update(status="failed", errorCode=str(error))
        except Exception:
            result.update(status="failed", errorCode="inference_failed")
        return dict(
            schemaVersion=2, requestId=request["requestId"], modelId=model, modelRevision=MODEL_REVISION,
            decisionVersion=decision, items=[result], elapsedMs=int((time.monotonic() - start) * 1000), usage={"calls": 1},
        )


class BoundedHTTPServer(ThreadingHTTPServer):
    # Drain accepted requests before closing model hooks during shutdown.
    daemon_threads = False
    request_queue_size = 2

    def __init__(self, address, request_handler, max_handlers=2):
        if address[0] != "127.0.0.1":
            raise ValueError("PixAI only supports IPv4 loopback")
        if type(max_handlers) is not int or not 1 <= max_handlers <= 2:
            raise ValueError("PixAI permits at most two HTTP handlers")
        self.slots = threading.BoundedSemaphore(max_handlers)
        super().__init__(address, request_handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(False):
            raw = b'{"errorCode":"busy"}'
            try:
                request.settimeout(0.1)
                request.sendall(b"HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + str(len(raw)).encode("ascii") + b"\r\n\r\n" + raw)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Socket/decoder failures must not leak request or private runtime data.
        pass


def handler(bridge, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def reply(self, status, obj):
            raw = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except OSError:
                pass

        def authorized(self):
            supplied = self.headers.get("Authorization", "").encode("utf-8")
            if not hmac.compare_digest(supplied, ("Bearer " + token).encode("utf-8")):
                self.reply(401, {"errorCode": "unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path in ("/v2/capabilities", "/capabilities", "/native/v2/capabilities"):
                self.reply(200, bridge.capabilities(native=self.path == "/native/v2/capabilities"))
            else:
                self.reply(404, {"errorCode": "not_found"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path not in ("/v2/analyze", "/analyze", "/native/v2/analyze"):
                self.reply(404, {"errorCode": "not_found"})
                return
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                    raise Invalid("invalid_length")
                length = int(lengths[0])
                if not 0 < length <= MAX_REQUEST:
                    self.reply(413, {"errorCode": "request_too_large"})
                    return
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise Invalid("invalid_length")
                self.reply(200, bridge.analyze(json.loads(raw), native=self.path == "/native/v2/analyze"))
            except (Invalid, ValueError, TypeError):
                self.reply(400, {"errorCode": "invalid_request"})
            except Exception:
                self.reply(500, {"errorCode": "service_failed"})

    return Handler


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError("model inputs must use absolute paths")
    return path


class RuntimeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default errors echo invalid values and private paths.
        self.exit(2, "PixAI configuration or arguments are invalid\n")


def load_runtime_config(path):
    """Read a shared client/runtime object without importing optional ML code."""
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_CONFIG + 1)
        if len(raw) > MAX_CONFIG:
            raise ValueError()
        config = json.loads(raw.decode("utf-8"))
        if not isinstance(config, dict):
            raise ValueError()
        for key in ("url", "token", "modelRevision", "decisionVersion", "preprocessVersion"):
            if key in config and not isinstance(config[key], str):
                raise ValueError()
        runtime = config.get("runtime", {})
        if not isinstance(runtime, dict):
            raise ValueError()
        runtime = dict(runtime)
        for key in ("modelDir", "checkpoint", "headFile"):
            if key not in runtime:
                continue
            value = runtime[key]
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError()
            supplied = Path(value)
            runtime[key] = (supplied if supplied.is_absolute() else path.parent / supplied).resolve()
        if "host" in runtime and runtime["host"] != "127.0.0.1":
            raise ValueError()
        for key, maximum in (("port", 65535), ("intraOpThreads", 16)):
            if key in runtime and (type(runtime[key]) is not int or not 1 <= runtime[key] <= maximum):
                raise ValueError()
        return dict(config, runtime=runtime)
    except (OSError, ValueError, TypeError, RuntimeError, RecursionError):
        raise argparse.ArgumentTypeError("Invalid PixAI configuration") from None


def parse_args(argv=None):
    parser = RuntimeArgumentParser(description=__doc__)
    parser.add_argument("--config", type=absolute_path, help="absolute shared client/runtime JSON config file")
    parser.add_argument("--model-dir", type=absolute_path, help="override directory containing the frozen model config.json")
    parser.add_argument("--checkpoint", type=absolute_path, help="override frozen INT8 checkpoint")
    parser.add_argument("--head-file", type=absolute_path, help="override allowlisted R3/R4/R5 head JSON")
    parser.add_argument("--host", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int)
    parser.add_argument("--intra-op-threads", type=int)
    args = parser.parse_args(argv)
    try:
        config = load_runtime_config(args.config) if args.config is not None else {}
    except argparse.ArgumentTypeError:
        parser.error("Invalid PixAI configuration")
    runtime = config.get("runtime", {})
    for attribute, key, environment, convert, default in (
        ("model_dir", "modelDir", "PIXAI_MODEL_DIR", absolute_path, None),
        ("checkpoint", "checkpoint", "PIXAI_CHECKPOINT", absolute_path, None),
        ("head_file", "headFile", "PIXAI_HEAD_FILE", absolute_path, None),
        ("host", "host", "PIXAI_HOST", str, "127.0.0.1"),
        ("port", "port", "PIXAI_PORT", int, 19123),
        ("intra_op_threads", "intraOpThreads", "PIXAI_INTRA_OP_THREADS", int, INTRA_OP_THREADS),
    ):
        if getattr(args, attribute) is None:
            if key in runtime:
                value = runtime[key]
            elif environment in os.environ:
                try:
                    value = convert(os.environ[environment])
                except (argparse.ArgumentTypeError, ValueError, TypeError):
                    parser.error("Invalid PixAI runtime environment")
            else:
                value = default
            setattr(args, attribute, value)
    if any(getattr(args, name) is None for name in ("model_dir", "checkpoint", "head_file")):
        parser.error("All three model paths are required through CLI, config or environment")
    if args.host != "127.0.0.1":
        parser.error("Only IPv4 loopback is supported")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not 1 <= args.intra_op_threads <= 16:
        parser.error("--intra-op-threads must be between 1 and 16")
    args.token = os.environ.get("PIXAI_SERVICE_TOKEN", config.get("token", ""))
    return args


def main(argv=None):
    args = parse_args(argv)
    token = args.token
    if len(token) < 16 or not all("!" <= char <= "~" for char in token):
        raise SystemExit("PIXAI_SERVICE_TOKEN or config token requires at least 16 printable ASCII characters without whitespace")
    encoder = None
    server = None
    try:
        head, head_sha = load_head(args.head_file)
        encoder = load_encoder(args.model_dir, args.checkpoint, intra_op_threads=args.intra_op_threads)
        encoder = NativeEncoder(encoder)
        bridge = Bridge(encoder, head, intra_op_threads=args.intra_op_threads, head_sha=head_sha)
        server = BoundedHTTPServer((args.host, args.port), handler(bridge, token))
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception:
        # No private paths, model config, image bytes or exception details in logs.
        raise SystemExit("PixAI startup/runtime failed; check local artifacts, pinned dependencies and listener") from None
    finally:
        if server is not None:
            server.server_close()
        if encoder is not None:
            encoder.close()


if __name__ == "__main__":
    main()
