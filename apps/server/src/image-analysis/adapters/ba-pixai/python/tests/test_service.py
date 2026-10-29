"""Offline protocol tests. Synthetic images and features never load model weights."""

import base64
import hashlib
import http.client
import importlib
import io
import json
from pathlib import Path
import socket
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))


def runtime_module(name):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as error:
        if error.name == name:
            raise AssertionError("The standalone public runtime is missing") from error
        raise


class FakeEncoder:
    def __init__(self):
        self.active = 0
        self.maximum = 0
        self.parity_checks = 0

    def encode_paths(self, paths, check_parity=False):
        if check_parity:
            self.parity_checks += 1
        # The bridge must retain the exact original bytes, including metadata.
        with Image.open(paths[0]) as image:
            image.verify()
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        time.sleep(0.01)
        self.active -= 1
        return {
            "features": [[1.0, 0.0]],
            "blue_archive": [0.8],
            "top_evidence": [[
                {"tag": "girl", "score": 0.9},
                {"tag": "shiroko_(blue_archive)", "score": 0.7},
            ]],
        }


class ServiceFixture(unittest.TestCase):
    def setUp(self):
        self.module = runtime_module("pixai_bridge")
        self.encoder = FakeEncoder()
        self.head = {
            "classes": ["ba_art", "ba_related", "other"],
            "weights": [[2.0, 0.0, -2.0], [0.0, 0.0, 0.0]],
            "bias": [0.0, 0.0, 0.0],
        }
        self.bridge = self.module.Bridge(self.encoder, self.head)
        self.request = {
            "schemaVersion": 2,
            "requestId": "synthetic-request",
            "expectedModelRevision": self.module.MODEL_REVISION,
            "expectedDecisionVersion": self.module.DECISION_VERSION,
            "items": [{
                "itemId": "synthetic-item",
                "preprocessVersion": "original-whole-v1",
                "views": [{"viewId": "whole"}],
            }],
        }
        self.set_image("PNG")

    def set_image(self, format):
        buffer = io.BytesIO()
        Image.new("RGB", (2, 2)).save(buffer, format=format)
        self.set_bytes(buffer.getvalue())

    def set_bytes(self, raw):
        item = self.request["items"][0]
        item["sourceSha256"] = hashlib.sha256(raw).hexdigest()
        item["views"][0]["jpegBase64"] = base64.b64encode(raw).decode("ascii")

    def analyze_item(self):
        return self.bridge.analyze(self.request)["items"][0]


class ServiceTests(ServiceFixture):
    def test_three_class_response_matches_the_existing_typescript_contract(self):
        response = self.bridge.analyze(self.request)
        self.assertEqual(response["schemaVersion"], 2)
        self.assertEqual(response["requestId"], "synthetic-request")
        self.assertEqual(response["modelId"], "pixai-int8-three-class")
        self.assertEqual(response["modelRevision"], self.module.MODEL_REVISION)
        self.assertEqual(response["decisionVersion"], self.module.DECISION_VERSION)
        item = response["items"][0]
        self.assertEqual((item["itemId"], item["status"]), ("synthetic-item", "succeeded"))
        result = item["result"]
        self.assertEqual(result["predictedClass"], "ba_art")
        self.assertEqual([s["label"] for s in result["classScores"]], ["ba_art", "ba_related", "other"])
        self.assertAlmostEqual(result["score"]["value"], 0.8668133321973349)
        self.assertAlmostEqual(sum(s["value"] for s in result["classScores"]), 1)
        self.assertEqual(result["evidence"][0], {"kind": "tag", "label": "blue_archive", "score": 0.8})
        self.assertEqual(result["evidence"][1]["kind"], "character")

    def test_l2_head_is_scale_invariant_and_rejects_invalid_features(self):
        self.assertEqual(self.module.head_scores([1.0, 0.0], self.head), self.module.head_scores([3.0, 0.0], self.head))
        for features in ([0.0, 0.0], [float("nan"), 0.0], [1.0]):
            with self.subTest(features=features), self.assertRaises(self.module.Invalid):
                self.module.head_scores(features, self.head)

    def test_selected_r4_and_r5_head_identity_reaches_consumers(self):
        for digest in (
            "5ea2a9ac1cf7c6294e823fb624aadd7e03d9645bd43c7c0fcc8741ba0eba45f2",
            "fd3a830bc8d19a932a0cde80a42aa1dbd43b085270625f225af4389d396cc862",
        ):
            with self.subTest(head=digest):
                bridge = self.module.Bridge(self.encoder, self.head, head_sha=digest)
                decision = "l2-softmax3-head-sha256:" + digest + ":original-pil-rescalepad1008-v1"
                self.request["expectedDecisionVersion"] = decision
                response = bridge.analyze(self.request)
                self.assertEqual(response["decisionVersion"], decision)
                self.assertEqual(response["items"][0]["result"]["score"]["definitionId"], "pixai-ba-art-softmax3-" + digest)
                self.assertEqual(bridge.capabilities()["decisionVersion"], decision)
                self.request["expectedDecisionVersion"] = self.module.DECISION_VERSION
                with self.assertRaises(self.module.Invalid):
                    bridge.analyze(self.request)

    def test_unknown_frozen_head_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.module.Bridge(self.encoder, self.head, head_sha="0" * 64)

    def test_runtime_advertises_one_model_two_cpu_threads_and_bounded_input(self):
        caps = self.bridge.capabilities()
        self.assertFalse(caps["supportsBatch"])
        self.assertEqual(caps["runtime"]["effective"], {"inferenceBatchSize": 1, "maxConcurrency": 1, "intraOpThreads": 2})
        self.assertEqual(caps["limits"]["maxItems"], 1)
        self.assertEqual(caps["limits"]["maxViewsPerItem"], 1)
        self.assertEqual(caps["limits"]["maxRequestBytes"], 48 << 20)
        self.assertEqual(caps["limits"]["maxDecodedPixels"], 40_000_000)

    def test_configured_cpu_thread_budget_is_reported_for_both_endpoints(self):
        bridge = self.module.Bridge(self.encoder, self.head, intra_op_threads=4)
        for native in (False, True):
            with self.subTest(native=native):
                runtime = bridge.capabilities(native=native)["runtime"]
                self.assertEqual(runtime["configured"]["intraOpThreads"], 4)
                self.assertEqual(runtime["effective"]["intraOpThreads"], 4)

    def test_hash_mismatch_is_rejected_before_encoder(self):
        self.request["items"][0]["sourceSha256"] = "0" * 64
        self.assertEqual(self.analyze_item()["errorCode"], "original_sha_mismatch")
        self.assertEqual(self.encoder.parity_checks, 0)

    def test_multiple_views_preprocessing_changes_and_remote_urls_are_rejected(self):
        item = self.request["items"][0]
        item["views"] *= 2
        self.assertEqual(self.analyze_item()["errorCode"], "invalid_original_view")
        item["views"] = item["views"][:1]
        item["preprocessVersion"] = "resized"
        self.assertEqual(self.analyze_item()["errorCode"], "invalid_original_view")
        item["preprocessVersion"] = "original-whole-v1"
        item["views"][0]["jpegBase64"] = "https://example.invalid/image"
        self.assertEqual(self.analyze_item()["errorCode"], "invalid_base64")
        self.assertEqual(self.encoder.parity_checks, 0)

    def test_pixel_and_byte_limits_precede_inference(self):
        with patch.object(self.module, "MAX_PIXELS", 1):
            self.assertEqual(self.analyze_item()["errorCode"], "pixel_limit")
        with patch.object(self.module, "MAX_INPUT", 1):
            self.assertEqual(self.analyze_item()["errorCode"], "image_too_large")
        self.assertEqual(self.encoder.parity_checks, 0)

    def test_tiff_and_truncated_png_never_reach_encoder(self):
        self.set_image("TIFF")
        self.assertEqual(self.analyze_item()["errorCode"], "decode_failed")
        self.set_image("PNG")
        raw = base64.b64decode(self.request["items"][0]["views"][0]["jpegBase64"])
        self.set_bytes(raw[:-8])
        self.assertEqual(self.analyze_item()["errorCode"], "decode_failed")
        self.assertEqual(self.encoder.parity_checks, 0)

    def test_original_jpeg_png_gif_and_static_webp_are_accepted(self):
        for format in ("JPEG", "PNG", "GIF", "WEBP"):
            with self.subTest(format=format):
                self.set_image(format)
                self.assertEqual(self.analyze_item()["status"], "succeeded")

    def test_wrong_revision_and_multiple_items_are_rejected(self):
        self.request["expectedModelRevision"] = "wrong"
        with self.assertRaises(self.module.Invalid):
            self.bridge.analyze(self.request)
        self.request["expectedModelRevision"] = self.module.MODEL_REVISION
        self.request["items"] *= 2
        with self.assertRaises(self.module.Invalid):
            self.bridge.analyze(self.request)

    def test_shared_model_never_encodes_concurrently_and_checks_parity_once(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.bridge.analyze(self.request))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 4)
        self.assertTrue(all(result["items"][0]["status"] == "succeeded" for result in results))
        self.assertEqual(self.encoder.maximum, 1)
        self.assertEqual(self.encoder.parity_checks, 1)

    def test_busy_inference_returns_a_bounded_item_error(self):
        self.bridge.lock.acquire()
        try:
            start = time.monotonic()
            self.assertEqual(self.analyze_item()["errorCode"], "busy")
            self.assertLess(time.monotonic() - start, 2)
        finally:
            self.bridge.lock.release()

    def test_native_endpoint_keeps_sigmoid_and_shares_first_parity_check(self):
        self.request["expectedDecisionVersion"] = self.module.NATIVE_DECISION_VERSION
        native = self.bridge.analyze(self.request, native=True)
        self.assertEqual(native["modelId"], "pixai-int8-native")
        result = native["items"][0]["result"]
        self.assertEqual((result["score"]["value"], result["score"]["target"]), (0.8, "ba"))
        self.assertNotIn("classScores", result)
        self.request["expectedDecisionVersion"] = self.module.DECISION_VERSION
        self.bridge.analyze(self.request)
        self.assertEqual(self.encoder.parity_checks, 1)

    def test_native_wrapper_preserves_strongest_character_outside_top_ten(self):
        tags = ["blue_archive", "weaker_(blue_archive)", "stronger_(blue_archive)"]
        probabilities = [0.8, 0.3, 0.7]
        class Scores(list):
            def float(self):
                return self
            def sigmoid(self):
                return self
            def argmax(self):
                return max(range(len(self)), key=self.__getitem__)
        class Logits:
            def __getitem__(self, key):
                row, indices = key
                if row != 0:
                    raise AssertionError("unexpected batch row")
                return Scores(probabilities[index] for index in indices)
        hooks = []
        closed = []
        def register(callback):
            hooks.append(callback)
            return SimpleNamespace(remove=lambda: hooks.remove(callback))
        def encode(paths, check_parity=False):
            for callback in hooks:
                callback(None, None, Logits())
            return {"features": [[1.0, 0.0]], "blue_archive": [0.8], "top_evidence": [[{"tag": "tag-" + str(index), "score": 0.9} for index in range(10)]]}
        encoder = SimpleNamespace(tags=tags, model=SimpleNamespace(register_forward_hook=register), encode_paths=encode, close=lambda: closed.append(True))
        wrapper = self.module.NativeEncoder(encoder)
        self.bridge.encoder = wrapper
        result = self.analyze_item()["result"]
        self.assertEqual(len(result["evidence"]), 5)
        self.assertEqual(result["evidence"][1], {"kind": "character", "label": "stronger_(blue_archive)", "score": 0.7})
        wrapper.close()
        self.assertEqual(hooks, [])
        self.assertEqual(closed, [True])

    def test_inference_errors_do_not_expose_exception_text(self):
        def fail(*args, **kwargs):
            raise RuntimeError("private input detail")
        self.encoder.encode_paths = fail
        result = self.analyze_item()
        self.assertEqual(result, {"itemId": "synthetic-item", "status": "failed", "errorCode": "inference_failed"})


class HTTPTests(ServiceFixture):
    def start_server(self, max_handlers=2):
        self.server = self.module.BoundedHTTPServer(("127.0.0.1", 0), self.module.handler(self.bridge, "synthetic-secret-1234"), max_handlers=max_handlers)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_http_auth_protocol_and_native_aliases(self):
        self.start_server()
        self.assertEqual(self.call("GET", "/v2/capabilities")[0], 401)
        self.assertEqual(self.call("GET", "/v2/capabilities", headers={"Authorization": "Bearer é"})[0], 401)
        auth = {"Authorization": "Bearer synthetic-secret-1234"}
        status, caps = self.call("GET", "/v2/capabilities", headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(caps["modelId"], "pixai-int8-three-class")
        self.assertEqual(self.call("POST", "/v2/analyze", json.dumps(self.request), auth)[1]["items"][0]["status"], "succeeded")
        self.assertEqual(self.call("GET", "/native/v2/capabilities", headers=auth)[1]["modelId"], "pixai-int8-native")
        self.assertEqual(self.call("GET", "/capabilities", headers=auth)[0], 200)
        self.assertEqual(self.call("GET", "/unknown", headers=auth)[0], 404)

    def test_http_rejects_oversized_and_ambiguous_body_lengths(self):
        self.start_server()
        auth = {"Authorization": "Bearer synthetic-secret-1234"}
        self.assertEqual(self.call("POST", "/v2/analyze", headers=dict(auth, **{"Content-Length": str((48 << 20) + 1)}))[0], 413)
        self.assertEqual(self.call("POST", "/v2/analyze", "{}", dict(auth, **{"Transfer-Encoding": "chunked"}))[0], 400)
        self.assertEqual(self.call("POST", "/v2/analyze", "{", auth)[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.putrequest("POST", "/v2/analyze")
            connection.putheader("Authorization", "Bearer synthetic-secret-1234")
            connection.putheader("Content-Length", "2")
            connection.putheader("Content-Length", "3")
            connection.endheaders(b"{}")
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read()), {"errorCode": "invalid_request"})
        finally:
            connection.close()

    def test_third_socket_is_rejected_before_request_body_is_read(self):
        self.start_server()
        sockets = []
        try:
            for _ in range(2):
                held = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)
                held.sendall(b"POST /v2/analyze HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic-secret-1234\r\nContent-Length: 100\r\n\r\n")
                sockets.append(held)
            # Wait for admission using the server semaphore, not a timing guess.
            deadline = time.monotonic() + 2
            while self.server.slots._value != 0 and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertEqual(self.server.slots._value, 0)
            rejected = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)
            sockets.append(rejected)
            # Rejection must precede even the request headers. Sending unread
            # bytes can turn close into a platform-dependent TCP reset.
            self.assertIn(b"429 Too Many Requests", rejected.recv(1024))
        finally:
            for held in sockets:
                held.close()

    def test_listener_refuses_non_loopback_binding(self):
        with self.assertRaises(ValueError):
            self.module.BoundedHTTPServer(("0.0.0.0", 0), self.module.handler(self.bridge, "synthetic-secret-1234"))


if __name__ == "__main__":
    unittest.main()
