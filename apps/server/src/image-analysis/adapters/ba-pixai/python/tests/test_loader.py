"""Artifact/CLI rejection tests use no torch, transformers or private files."""

from contextlib import redirect_stderr
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))


def runtime_module(name):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as error:
        if error.name == name:
            raise AssertionError("The standalone public runtime is missing") from error
        raise


class CLITests(unittest.TestCase):
    def test_help_runs_without_loading_optional_ml_dependencies(self):
        result = subprocess.run([sys.executable, "-S", str(RUNTIME / "pixai_bridge.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--model-dir", "--checkpoint", "--head-file"):
            self.assertIn(flag, result.stdout)

    def test_model_paths_are_all_required_absolute_inputs(self):
        module = runtime_module("pixai_bridge")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            argv = ["--model-dir", str(root), "--checkpoint", str(root / "weights.pt"), "--head-file", str(root / "head.json")]
            args = module.parse_args(argv)
            self.assertEqual(args.model_dir, root)
            self.assertEqual(args.checkpoint, root / "weights.pt")
            self.assertEqual(args.head_file, root / "head.json")
            self.assertEqual((args.host, args.port), ("127.0.0.1", 19123))
            self.assertEqual(args.intra_op_threads, 2)
            for bad in ([], argv[:-2], [*argv[:1], "relative/model", *argv[2:]], [*argv, "--host", "0.0.0.0"], [*argv, "--port", "0"]):
                with self.subTest(arguments=bad), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    module.parse_args(bad)

    def test_thread_budget_is_explicit_and_validated_before_model_loading(self):
        module = runtime_module("pixai_bridge")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            argv = ["--model-dir", str(root), "--checkpoint", str(root / "weights.pt"), "--head-file", str(root / "head.json")]
            self.assertEqual(module.parse_args([*argv, "--intra-op-threads", "4"]).intra_op_threads, 4)
            for count in ("0", "17", "bad"):
                with self.subTest(count=count), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    module.parse_args([*argv, "--intra-op-threads", count])

    def test_startup_uses_only_explicit_paths_and_closes_encoder_on_bind_failure(self):
        module = runtime_module("pixai_bridge")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["--model-dir", str(root / "base"), "--checkpoint", str(root / "weights.pt"), "--head-file", str(root / "head.json"), "--intra-op-threads", "4"]
            closed = []
            encoder = SimpleNamespace(close=lambda: closed.append(True))
            loaded = []
            def load(model, checkpoint, intra_op_threads=2):
                loaded.append((model, checkpoint, intra_op_threads))
                return encoder
            with patch.dict(os.environ, PIXAI_SERVICE_TOKEN="synthetic-secret-1234"), patch.object(module, "load_head", return_value=({}, module.HEAD_SHA)), patch.object(module, "load_encoder", side_effect=load), patch.object(module, "NativeEncoder", side_effect=lambda value: value), patch.object(module, "BoundedHTTPServer", side_effect=OSError("private path")), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    module.main(args)
            self.assertEqual(loaded, [(root / "base", root / "weights.pt", 4)])
            self.assertEqual(closed, [True])

    def test_invalid_service_tokens_fail_before_any_model_load(self):
        module = runtime_module("pixai_bridge")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["--model-dir", str(root), "--checkpoint", str(root / "weights.pt"), "--head-file", str(root / "head.json")]
            for token in ("", "short", "é" * 20, "abc\n" * 8):
                with self.subTest(token=bool(token)), patch.dict(os.environ, PIXAI_SERVICE_TOKEN=token), patch.object(module, "load_encoder", side_effect=AssertionError("must not load")), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    module.main(args)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.loader = runtime_module("pixai_loader")

    def test_bad_config_is_rejected_before_optional_imports_or_checkpoint_load(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)
            (model / "config.json").write_text("{}", encoding="utf-8")
            with patch.dict(sys.modules, torch=None), self.assertRaisesRegex(RuntimeError, "config.*SHA"):
                self.loader.load_encoder(model, model / "missing-weights.pt")

    def test_tampered_checkpoint_is_rejected_before_torch_import(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)
            raw = b"synthetic-config"
            (model / "config.json").write_bytes(raw)
            checkpoint = model / "weights.pt"
            checkpoint.write_bytes(b"not a checkpoint")
            with patch.object(self.loader, "CONFIG_SHA", hashlib.sha256(raw).hexdigest()), patch.dict(sys.modules, torch=None), self.assertRaisesRegex(RuntimeError, "checkpoint.*SHA"):
                self.loader.load_encoder(model, checkpoint)

    def test_every_packaged_code_and_processor_artifact_is_verified_before_import(self):
        for name in ("tagger_pipeline.py", "frozen_feature_helper.py", "preprocessor_config.json"):
            with self.subTest(artifact=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for packaged in self.loader.PACKAGED_HASHES:
                    (root / packaged).write_bytes((self.loader.PIXAI_DIR / packaged).read_bytes())
                (root / name).write_bytes(b"tampered")
                with patch.object(self.loader, "PIXAI_DIR", root), self.assertRaisesRegex(RuntimeError, "SHA mismatch"):
                    self.loader.verify_packaged_runtime()

    def test_checked_in_frozen_sources_match_the_served_model_identity(self):
        self.loader.verify_packaged_runtime()
        self.assertEqual(self.loader.file_sha256(self.loader.PIXAI_DIR / "tagger_pipeline.py"), "3431279fdfff234f62664999fc1fe6bb20f1e8756f7435d0e165ebd4456f7fcd")
        self.assertEqual(self.loader.file_sha256(self.loader.PIXAI_DIR / "frozen_feature_helper.py"), "e6447fe4254a25e359801d2cb5d400a43c51159cf14b9cb5ef708f628b3cd374")

    def test_loader_binds_explicit_paths_cpu_engine_and_thread_budget(self):
        # The restore/architecture imports are the only heavy boundaries. Keep
        # path validation, artifact order and CPU runtime configuration real.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, checkpoint = root / "base", root / "weights.pt"
            thread_counts = []
            torch = SimpleNamespace(
                set_num_threads=lambda count: thread_counts.append(("intra", count)),
                set_num_interop_threads=lambda count: thread_counts.append(("inter", count)),
                backends=SimpleNamespace(quantized=SimpleNamespace(supported_engines=["x86"], engine=None)),
            )
            pipeline = object()
            def restore(passed_pipeline):
                self.assertIs(passed_pipeline, pipeline)
                return "restored-model"
            def wrap(restored, passed_pipeline, device):
                return (restored, passed_pipeline, device)
            helper = SimpleNamespace(restore_int8=restore, PixAIEncoder=wrap)
            def load_module(name, path):
                return helper if name == "frozen_pixai_feature_helper" else pipeline
            with patch.object(self.loader, "checked"), patch.object(self.loader, "verify_packaged_runtime"), patch.object(self.loader, "load_module", side_effect=load_module), patch.object(self.loader.platform, "machine", return_value="AMD64"), patch.dict(sys.modules, torch=torch), patch.dict(os.environ):
                result = self.loader.load_encoder(model, checkpoint, intra_op_threads=4)
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            self.assertEqual(result, ("restored-model", pipeline, "cpu"))
            self.assertEqual((helper.MODEL, helper.CHECKPOINT), (model, checkpoint))
            self.assertEqual(torch.backends.quantized.engine, "x86")
            self.assertEqual(thread_counts, [("intra", 4), ("inter", 1)])

    def test_loader_refuses_non_x86_hosts_before_optional_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(self.loader, "checked"), patch.object(self.loader, "verify_packaged_runtime"), patch.object(self.loader.platform, "machine", return_value="aarch64"), patch.dict(sys.modules, torch=None), self.assertRaisesRegex(RuntimeError, "x86-64"):
                self.loader.load_encoder(root, root / "weights.pt")

    def test_unrecognized_head_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "head.json"
            path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "head hash"):
                self.loader.load_head(path)

    def test_known_head_requires_exact_dimensions_classes_and_finite_numbers(self):
        head = {"classes": ["ba_art", "ba_related", "other"], "feature_dimension": 1024, "feature_normalization": "L2eachvector", "weights": [[0.0, 0.0, 0.0] for _ in range(1024)], "bias": [0.0, 0.0, 0.0]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "head.json"
            for normalization in ("L2eachvector", "L2 each vector"):
                head["feature_normalization"] = normalization
                raw = json.dumps(head).encode("utf-8")
                path.write_bytes(raw)
                digest = hashlib.sha256(raw).hexdigest()
                with patch.object(self.loader, "HEAD_HASHES", frozenset([digest])):
                    loaded, loaded_digest = self.loader.load_head(path)
                self.assertEqual((loaded, loaded_digest), (head, digest))
            for field, value in (("weights", [[0.0, 0.0, 0.0]]), ("bias", [0.0, 0.0]), ("classes", ["other", "ba_related", "ba_art"]), ("bias", [float("nan"), 0.0, 0.0])):
                bad = dict(head, **{field: value})
                raw = json.dumps(bad).encode("utf-8")
                path.write_bytes(raw)
                with self.subTest(field=field), patch.object(self.loader, "HEAD_HASHES", frozenset([hashlib.sha256(raw).hexdigest()])), self.assertRaisesRegex(RuntimeError, "head schema"):
                    self.loader.load_head(path)


if __name__ == "__main__":
    unittest.main()
