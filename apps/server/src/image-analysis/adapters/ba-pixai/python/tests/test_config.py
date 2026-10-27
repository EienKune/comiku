"""Shared client/runtime JSON config tests without private artifacts or ML imports."""

from contextlib import redirect_stderr
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        clean_environment = {key: value for key, value in os.environ.items() if not key.startswith("PIXAI_")}
        environment = patch.dict(os.environ, clean_environment, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.module = importlib.import_module("pixai_bridge")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.config_file = self.root / "config" / "service.json"
        self.config_file.parent.mkdir()
        self.config = {
            "url": "http://127.0.0.1:19124",
            "token": "synthetic-config-secret",
            "modelRevision": "synthetic-revision",
            "decisionVersion": "synthetic-decision",
            "preprocessVersion": "original-whole-v1",
            "runtime": {
                "modelDir": "../models/base",
                "checkpoint": "../models/weights.pt",
                "headFile": "../models/head.json",
                "host": "127.0.0.1",
                "port": 19124,
                "intraOpThreads": 4,
            },
        }

    def write_config(self, value=None):
        self.config_file.write_text(json.dumps(self.config if value is None else value), encoding="utf-8")

    def parse_config(self, *extra):
        return self.module.parse_args(["--config", str(self.config_file), *extra])

    def assert_rejected_privately(self, argv):
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            self.module.parse_args(argv)
        self.assertEqual(raised.exception.code, 2)
        output = stderr.getvalue()
        for private in (str(self.root), self.config["token"], "sensitive-value"):
            self.assertNotIn(private, output)

    def test_shared_config_resolves_paths_relative_to_its_own_directory(self):
        self.write_config()
        # No file needs to exist, and the current working directory is unrelated.
        with patch.dict(os.environ, {}, clear=True):
            args = self.parse_config()
        self.assertEqual(args.model_dir, self.root / "models" / "base")
        self.assertEqual(args.checkpoint, self.root / "models" / "weights.pt")
        self.assertEqual(args.head_file, self.root / "models" / "head.json")
        self.assertEqual((args.host, args.port, args.intra_op_threads), ("127.0.0.1", 19124, 4))
        self.assertEqual(args.token, "synthetic-config-secret")

    def test_explicit_cli_overrides_every_runtime_setting(self):
        self.write_config()
        args = self.parse_config(
            "--model-dir", str(self.root / "override"),
            "--checkpoint", str(self.root / "override.pt"),
            "--head-file", str(self.root / "override.json"),
            "--host", "127.0.0.1", "--port", "19125", "--intra-op-threads", "1",
        )
        self.assertEqual(args.model_dir, self.root / "override")
        self.assertEqual(args.checkpoint, self.root / "override.pt")
        self.assertEqual(args.head_file, self.root / "override.json")
        self.assertEqual((args.host, args.port, args.intra_op_threads), ("127.0.0.1", 19125, 1))

    def test_config_runtime_may_be_partial_when_cli_supplies_remaining_inputs(self):
        self.config["runtime"] = {"modelDir": str(self.root / "base")}
        self.write_config()
        args = self.parse_config("--checkpoint", str(self.root / "weights.pt"), "--head-file", str(self.root / "head.json"))
        self.assertEqual(args.model_dir, self.root / "base")
        self.assertEqual((args.host, args.port, args.intra_op_threads), ("127.0.0.1", 19123, 2))

    def test_token_environment_takes_priority_including_explicit_empty_value(self):
        self.write_config()
        for token in ("synthetic-environment-secret", ""):
            with self.subTest(empty=not token), patch.dict(os.environ, PIXAI_SERVICE_TOKEN=token):
                self.assertEqual(self.parse_config().token, token)

    def model_environment(self):
        return {
            "PIXAI_MODEL_DIR": str(self.root / "external-base"),
            "PIXAI_CHECKPOINT": str(self.root / "external-weights.pt"),
            "PIXAI_HEAD_FILE": str(self.root / "external-head.json"),
            "PIXAI_SERVICE_TOKEN": "synthetic-environment-secret",
        }

    def test_environment_supplies_model_paths_listener_and_threads_without_json(self):
        environment = dict(self.model_environment(), PIXAI_HOST="127.0.0.1", PIXAI_PORT="19126", PIXAI_INTRA_OP_THREADS="3")
        with patch.dict(os.environ, environment):
            args = self.module.parse_args([])
        self.assertEqual(args.model_dir, self.root / "external-base")
        self.assertEqual(args.checkpoint, self.root / "external-weights.pt")
        self.assertEqual(args.head_file, self.root / "external-head.json")
        self.assertEqual((args.host, args.port, args.intra_op_threads), ("127.0.0.1", 19126, 3))
        self.assertEqual(args.token, "synthetic-environment-secret")

    def test_environment_only_fills_fields_missing_from_cli_and_json(self):
        self.config["runtime"] = {"modelDir": "../json-base", "intraOpThreads": 4}
        self.write_config()
        environment = dict(self.model_environment(), PIXAI_MODEL_DIR="ignored-relative", PIXAI_PORT="19126", PIXAI_INTRA_OP_THREADS="bad-ignored")
        with patch.dict(os.environ, environment):
            args = self.parse_config("--head-file", str(self.root / "cli-head.json"), "--port", "19127")
        self.assertEqual(args.model_dir, self.root / "json-base")
        self.assertEqual(args.checkpoint, self.root / "external-weights.pt")
        self.assertEqual(args.head_file, self.root / "cli-head.json")
        self.assertEqual((args.host, args.port, args.intra_op_threads), ("127.0.0.1", 19127, 4))

    def test_missing_or_relative_environment_model_paths_fail_privately(self):
        for key in ("PIXAI_MODEL_DIR", "PIXAI_CHECKPOINT", "PIXAI_HEAD_FILE"):
            for value in (None, "", "sensitive-value/relative"):
                with self.subTest(field=key, missing=value is None):
                    environment = self.model_environment()
                    if value is None:
                        environment.pop(key)
                    else:
                        environment[key] = value
                    with patch.dict(os.environ, environment):
                        self.assert_rejected_privately([])

    def test_environment_host_port_and_thread_errors_are_private(self):
        invalid = (
            ("PIXAI_HOST", "0.0.0.0"), ("PIXAI_HOST", "sensitive-value"),
            ("PIXAI_PORT", "0"), ("PIXAI_PORT", "65536"),
            ("PIXAI_PORT", "true"), ("PIXAI_PORT", "1.5"),
            ("PIXAI_PORT", "sensitive-value"),
            ("PIXAI_INTRA_OP_THREADS", "0"), ("PIXAI_INTRA_OP_THREADS", "17"),
            ("PIXAI_INTRA_OP_THREADS", "False"), ("PIXAI_INTRA_OP_THREADS", "1.5"),
            ("PIXAI_INTRA_OP_THREADS", "sensitive-value"),
        )
        for key, value in invalid:
            with self.subTest(field=key, kind=value):
                with patch.dict(os.environ, dict(self.model_environment(), **{key: value})):
                    self.assert_rejected_privately([])

    def test_environment_startup_without_json_reaches_model_validation_without_ml(self):
        command = [sys.executable, "-S", str(RUNTIME / "pixai_bridge.py")]
        result = subprocess.run(command, env=dict(os.environ, **self.model_environment()), capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("PixAI startup/runtime failed", result.stderr)
        self.assertNotIn(str(self.root), result.stderr)
        self.assertNotIn("synthetic-environment-secret", result.stderr)

    def test_config_token_reaches_startup_validation_without_optional_dependencies(self):
        self.write_config()
        env = dict(os.environ)
        env.pop("PIXAI_SERVICE_TOKEN", None)
        command = [sys.executable, "-S", str(RUNTIME / "pixai_bridge.py"), "--config", str(self.config_file)]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("PixAI startup/runtime failed", result.stderr)
        for token in ("", "short", "sensitive-value\n" * 2):
            with self.subTest(empty=not token):
                result = subprocess.run(command, env=dict(env, PIXAI_SERVICE_TOKEN=token), capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertIn("requires at least 16", result.stderr)
                self.assertNotIn(str(self.root), result.stderr)
                self.assertNotIn("sensitive-value", result.stderr)

    def test_json_must_be_a_bounded_utf8_object_and_never_echoes_content(self):
        invalid = (
            b"[]", b"null", b"true", b"\xff",
            b'{"token":"sensitive-value",',
            b" " * ((64 << 10) + 1),
        )
        for raw in invalid:
            with self.subTest(kind=raw[:8]):
                self.config_file.write_bytes(raw)
                self.assert_rejected_privately(["--config", str(self.config_file)])

    def test_config_file_path_is_explicit_absolute_and_read_errors_are_private(self):
        for path in ("sensitive-value.json", str(self.root / "missing-sensitive-value.json"), str(self.root)):
            with self.subTest(absolute=Path(path).is_absolute()):
                self.assert_rejected_privately(["--config", path])

    def test_known_config_fields_validate_types_and_runtime_bounds_before_loading(self):
        bad_fields = (
            ("runtime", None), ("runtime", []), ("token", 123),
            ("url", []), ("modelRevision", False), ("decisionVersion", {}),
            ("preprocessVersion", 1),
        )
        for field, value in bad_fields:
            with self.subTest(field=field):
                self.write_config(dict(self.config, **{field: value}))
                self.assert_rejected_privately(["--config", str(self.config_file)])
        bad_runtime = (
            ("modelDir", 1), ("modelDir", ""), ("modelDir", "bad\x00path"),
            ("checkpoint", []), ("headFile", None),
            ("host", "0.0.0.0"), ("host", "localhost"),
            ("port", True), ("port", "19123"), ("port", 0), ("port", 65536),
            ("intraOpThreads", False), ("intraOpThreads", 1.5),
            ("intraOpThreads", 0), ("intraOpThreads", 17),
        )
        for field, value in bad_runtime:
            with self.subTest(runtime=field, kind=type(value).__name__):
                self.write_config(dict(self.config, runtime=dict(self.config["runtime"], **{field: value})))
                self.assert_rejected_privately(["--config", str(self.config_file)])

    def test_cli_parse_failures_never_echo_private_values(self):
        self.write_config()
        for extra in (("--port", "sensitive-value"), ("--host", "sensitive-value"), ("--unknown", "sensitive-value")):
            with self.subTest(flag=extra[0]):
                self.assert_rejected_privately(["--config", str(self.config_file), *extra])

    def test_no_config_or_model_arguments_never_searches_or_downloads_a_model(self):
        result = subprocess.run([sys.executable, "-S", str(RUNTIME / "pixai_bridge.py")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
