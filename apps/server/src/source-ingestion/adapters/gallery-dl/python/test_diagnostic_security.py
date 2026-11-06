"""Exercise the real pure text boundary without importing optional gallery-dl."""
import ast
import json
import pathlib
import re
import unittest
from urllib.parse import unquote, urlsplit

tree = ast.parse(pathlib.Path(__file__).with_name("adapter.py").read_text(encoding="utf-8"))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("private_text", "previous_diagnostic_text")]
namespace = {"re": re, "json": json, "unquote": unquote, "urlsplit": urlsplit, "diagnostic_secrets": ['synthetic-secret/"value']}
exec(compile(ast.Module(body=functions, type_ignores=[]), "adapter.py", "exec"), namespace)
private_text = namespace["private_text"]
previous_diagnostic_text = namespace["previous_diagnostic_text"]


class DiagnosticSecurityTests(unittest.TestCase):
    def test_previous_diagnostic_surrogates_cannot_replace_original_failure(self):
        for message in ("upstream \ud800 message", "upstream \udfff message", r"upstream \ud800 message", r"upstream \udfff message"):
            value = previous_diagnostic_text({"stage": "conversion", "message": message})
            parsed = json.loads(value)
            self.assertEqual("conversion", parsed["stage"])
            self.assertIn("upstream", parsed["message"])
            self.assertLessEqual(len(value.encode("utf-8")), 8192)

    def test_previous_diagnostic_budget_counts_exact_serialized_unicode_representation(self):
        for text in ("汉\U0001f600" * 5000, r"\ud83d\ude00" * 5000, "\ud83d\ude00" * 5000):
            value = previous_diagnostic_text({"stage": "conversion", "message": text, "traceback": text})
            self.assertEqual("conversion", json.loads(value)["stage"])
            self.assertLessEqual(len(value.encode("utf-8")), 8192)

    def test_previous_controlled_fields_keep_context_without_decoding_serialized_json(self):
        value = previous_diagnostic_text({"stage": "conversion", "guard": "prior_guard", "message": "earlier conversion error", "traceback": "Traceback\n'quoted line'\n" + 'synthetic-secret/"value', "payload": {"access_token": "opaque-7291"}})
        self.assertIn("earlier conversion error", value)
        self.assertEqual("prior_guard", json.loads(value)["guard"])
        self.assertNotIn("opaque-7291", value)
        self.assertNotIn("synthetic-secret", value)
        self.assertLessEqual(len(value.encode("utf-8")), 8192)

    def test_malformed_percent_utf8_cannot_split_encoded_query_suffix(self):
        for encoded in ("%FF", "%C3", "%E0%A4", "%F0%9F", "%E2%28%A1", "%ED%A0%80", "%25FF"):
            value = "https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst" + encoded + "privatesuffix"
            self.assertNotIn("privatesuffix", private_text(value, 4096))

    def test_independent_opaque_header_canaries_remain_available(self):
        previous = namespace["diagnostic_secrets"]
        namespace["diagnostic_secrets"] = ["fixture-secret-token", "fixture-csrf-value"]
        try:
            for value in ("cf-a7d3b9e2", "req-9c5e7a1b"):
                self.assertEqual(value, private_text(value, 512))
            self.assertNotIn("fixture-secret-token", private_text("fixture-secret-token", 512))
            self.assertNotIn("opaque-7291", private_text('{"access_token":"opaque-7291"}', 512))
        finally:
            namespace["diagnostic_secrets"] = previous

    def test_fully_encoded_delimiters_are_omitted_before_decoding(self):
        for code in ("0a", "0d", "22", "27"):
            for value in ("https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst%" + code + "privatesuffix", r"https:\u002f\u002fexample.invalid/path?q=first\u00" + code + "privatesuffix", r'{"access_token":"first\u00' + code + 'privatesuffix"}'):
                self.assertNotIn("privatesuffix", private_text(value, 4096))

    def test_encoded_and_escaped_secrets_are_removed(self):
        for value in ('synthetic-secret%2F%22value', r'synthetic-secret/\"value', r'synthetic-\u0073ecret/\"value', 'synthetic-secret'):
            self.assertNotIn("synthetic-secret", private_text(value, 4096))

    def test_urls_drop_userinfo_query_fragment_before_secret_replacement(self):
        value = private_text('https://user:pass@example.invalid/path?signature=private#fragment', 4096)
        self.assertEqual('https://example.invalid/path', value)
        for value in ('https://example.invalid/path?q=first%0Aprivatesuffix', 'https://example.invalid/path?q=first%22privatesuffix', r'https://example.invalid/path?q=first\u000aprivatesuffix'):
            self.assertNotIn("privatesuffix", private_text(value, 4096))

    def test_nested_fields_and_headers_never_expose_values(self):
        value = private_text('{"access_token":"private-json"}\nAuthorization: Bearer private-header', 4096)
        self.assertNotIn("private-json", value)
        self.assertNotIn("private-header", value)
        self.assertNotIn("private-suffix", private_text(r'{"access_token":"first\"private-suffix"}', 4096))
        for newline in ("\r", "\n", "\r\n"):
            self.assertNotIn("privatesuffix", private_text('{"access_token":"first' + newline + 'privatesuffix"}', 4096))

    def test_excessive_input_is_omitted_instead_of_partially_redacted(self):
        self.assertEqual("[diagnostic omitted]", private_text("x" * 262145, 4096))

    def test_secrets_and_partial_fragments_are_removed_before_head_and_tail_caps(self):
        for tail in (False, True):
            value = private_text("x" * 30 + 'synthetic-secret/"value' + "x" * 30, 40, tail)
            self.assertNotIn("synthetic", value)
            self.assertNotIn('"value', value)


if __name__ == "__main__":
    unittest.main()
