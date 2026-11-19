"""Synthetic fixtures only; no team reference text belongs in this suite."""
import hashlib
from contextlib import redirect_stdout
from datetime import date, datetime, time, timedelta
import importlib.util
from io import StringIO
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from openpyxl import Workbook


SCRIPT = Path(__file__).with_name("prepare.py")
SPEC = importlib.util.spec_from_file_location("reference_prepare", SCRIPT)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_tool(self, source, adapter="txt-zh", overrides=None, extra=None, timeout=8):
        output, report = self.root / "data.json", self.root / "report.json"
        args = [sys.executable, str(SCRIPT), str(source), "--adapter", adapter,
                "--source-key", "synthetic", "--source-name", "Synthetic reference",
                "--source-version", "fixture-v1", "--mapping-version", "fixture-map-v1",
                "--output", str(output), "--report", str(report)]
        if overrides is not None:
            mapping = self.root / "overrides.json"
            mapping.write_text(json.dumps({"fileSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                           "mappingVersion": "fixture-map-v1", "lines": overrides}), encoding="utf8")
            args += ["--overrides", str(mapping)]
        args += extra or []
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf8", timeout=timeout)
        return result, output, report

    def txt(self, text):
        path = self.root / "fixture.txt"
        path.write_bytes(text.encode("gb18030"))
        return path

    def test_txt_keeps_multiline_duplicates_and_non_kana_words(self):
        source = self.txt("合成标题\nぱたぱた  第一义\n  第二义\n漢字交じり\t合成说明\nぱたぱた   另一个记录\n")
        result, output, report = self.run_tool(source, overrides={"1": {"kind": "heading", "raw": "合成标题", "reason": "Synthetic title"}})
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(output.read_text(encoding="utf8"))
        self.assertEqual([e["original"] for e in data["entries"]], ["ぱたぱた", "漢字交じり", "ぱたぱた"])
        self.assertEqual(data["entries"][0]["explanationZh"], "第一义\n第二义")
        self.assertIsNone(data["entries"][0]["translationZh"])
        self.assertEqual(data["entries"][2]["sourceRef"], "line:5")
        self.assertEqual(data["source"]["fileSha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertIn("fixture-map-v1", data["source"]["importerVersion"])
        audit = json.loads(report.read_text(encoding="utf8"))
        self.assertTrue(audit["applyReady"])
        self.assertEqual(len(audit["accounting"]), 5)

    def test_unresolved_line_blocks_output_and_is_accounted(self):
        result, output, report = self.run_tool(self.txt("ぴっ  synthetic\nambiguous\n"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        audit = json.loads(report.read_text(encoding="utf8"))
        self.assertFalse(audit["applyReady"])
        self.assertEqual(audit["accounting"][1]["kind"], "exception")

    def test_single_space_requires_explicit_review_override(self):
        source = self.txt("ぴっ 单空格\n  续行\n")
        result, output, _ = self.run_tool(source, overrides={"1": {"kind": "record", "raw": "ぴっ 单空格", "original": "ぴっ", "explanation": "单空格", "reason": "Reviewed boundary"}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf8"))["entries"][0]["explanationZh"], "单空格\n续行")

    def test_stale_override_does_not_generate_ready_output(self):
        result, output, report = self.run_tool(self.txt("ぴっ 单空格\n"), overrides={"1": {"kind": "heading", "raw": "different", "reason": "Wrong version"}})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertIn("override", report.read_text(encoding="utf8"))

    def test_conflicting_override_aliases_are_rejected(self):
        raw = "ぴっ single"
        decision = {"kind": "record", "raw": raw, "original": "ぴっ", "explanation": "single", "reason": "Reviewed"}
        result, output, report = self.run_tool(self.txt(raw + "\n"), overrides={"1": decision, "line:1": decision})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertIn("duplicate", report.read_text(encoding="utf8"))

    def test_changed_mapping_changes_importer_identity_for_identical_bytes(self):
        source = self.txt("ぴっ synthetic\n")
        decision = {"kind": "record", "raw": "ぴっ synthetic", "original": "ぴっ", "explanation": "first reviewed meaning", "reason": "Reviewed boundary"}
        result, output, _ = self.run_tool(source, overrides={"1": decision})
        self.assertEqual(result.returncode, 0, result.stderr)
        first = json.loads(output.read_text(encoding="utf8"))
        output.unlink()
        decision["explanation"] = "corrected reviewed meaning"
        result, output, _ = self.run_tool(source, overrides={"1": decision})
        self.assertEqual(result.returncode, 0, result.stderr)
        second = json.loads(output.read_text(encoding="utf8"))
        self.assertEqual(first["source"]["fileSha256"], second["source"]["fileSha256"])
        self.assertNotEqual(first["source"]["importerVersion"], second["source"]["importerVersion"])

    def test_override_file_hash_is_checked_before_output(self):
        source = self.txt("ぴっ  合成\n")
        mapping = self.root / "wrong.json"
        mapping.write_text(json.dumps({"fileSha256": "0" * 64, "mappingVersion": "fixture-map-v1", "lines": {}}), encoding="utf8")
        result, output, report = self.run_tool(source, extra=["--overrides", str(mapping)])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertIn("SHA", report.read_text(encoding="utf8"))

    def test_unsafe_source_url_is_rejected(self):
        result, output, report = self.run_tool(self.txt("ぴっ  合成\n"), extra=["--source-url", "file:///private/input"])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertIn("http/https", report.read_text(encoding="utf8"))

    def test_source_url_matches_single_line_2048_no_credentials_contract(self):
        urls = ["https://user:password@example.test/ref", "https://example.test/" + "x" * 2050,
                "https://example.test/\npath", "https://example.test/\tpath", "https://example.test/\rpath",
                "https://example.test:999999/ref", "https://invalid host/ref"]
        source = self.txt("ぴっ  合成\n")
        for url in urls:
            with self.subTest(url=url[:80]):
                (self.root / "data.json").unlink(missing_ok=True)
                result, output, report = self.run_tool(source, extra=["--source-url", url])
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())
                self.assertFalse(json.loads(report.read_text(encoding='utf8'))['applyReady'])

    def test_source_url_accepts_2048_boundary_without_credentials(self):
        prefix = "https://example.test/"
        url = prefix + 'x' * (2048 - len(prefix))
        result, output, _ = self.run_tool(self.txt("ぴっ  合成\n"), extra=["--source-url", url])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text(encoding='utf8'))['source']['sourceUrl'], url)

    def test_success_cannot_overwrite_the_input(self):
        source = self.txt("ぴっ  合成\n")
        original = source.read_bytes()
        result, _, _ = self.run_tool(source, extra=["--output", str(source)])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(source.read_bytes(), original)

    def test_xlsx_formula_requires_explicit_review(self):
        workbook = Workbook()
        workbook.active.append([None, "ぴっ", "=1+1"])
        source = self.root / "formula.xlsx"
        workbook.save(source)
        result, output, report = self.run_tool(source, "xlsx-ja")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(json.loads(report.read_text(encoding="utf8"))["accounting"][0]["kind"], "exception")

    def test_xlsx_continuations_cannot_cross_worksheet_boundaries(self):
        for include_empty_sheet in (False, True):
            with self.subTest(emptyBetween=include_empty_sheet):
                (self.root / "data.json").unlink(missing_ok=True)
                workbook = Workbook()
                workbook.active.title = "First"
                workbook.active.append([None, "synthetic", "first meaning"])
                if include_empty_sheet:
                    workbook.create_sheet("Empty")
                workbook.create_sheet("Second").append([None, None, "orphan second meaning"])
                source = self.root / "multisheet.xlsx"
                workbook.save(source)
                result, output, report = self.run_tool(source, "xlsx-ja")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())
                audit = json.loads(report.read_text(encoding="utf8"))
                second = next(row for row in audit["accounting"] if row["ref"] == "Second:B1")
                self.assertEqual(second["kind"], "exception")
                self.assertNotIn("entryRef", second)

    def shape_workbook(self, dimensions):
        workbook = Workbook()
        for index in range(len(dimensions)):
            sheet = workbook.active if index == 0 else workbook.create_sheet()
            sheet.append([None, "synthetic", "meaning"])
        source = self.root / "shape.xlsx"
        workbook.save(source)
        with zipfile.ZipFile(source) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        for index, dimension in enumerate(dimensions, 1):
            key = f"xl/worksheets/sheet{index}.xml"
            replacement = b'' if dimension is None else f'<dimension ref="{dimension}"/>'.encode('ascii')
            parts[key] = re.sub(b'<dimension[^>]*/>', replacement, parts[key])
        with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for key, value in parts.items():
                archive.writestr(key, value)
        return source

    def test_xlsx_inflated_dimensions_are_rejected_within_bounded_time(self):
        source = self.shape_workbook(["A1:XFD1048576"])
        self.assertLess(source.stat().st_size, 10000)
        try:
            result, output, report = self.run_tool(source, "xlsx-ja", timeout=2)
        except subprocess.TimeoutExpired:
            self.fail("XLSX shape must be rejected before iterating virtual cells")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertIn("budget", json.loads(report.read_text(encoding='utf8'))['errors'][0]['error'])

    def test_xlsx_shape_and_aggregate_budgets_are_explicit(self):
        cases = {
            "column": ["A1:BM1"],
            "row": ["A1:C100001"],
            "total row": ["A1:C60000", "A1:C60000"],
            "total cell": ["A1:BL10000", "A1:BL10000"],
            "sheet": ["A1:C1"] * 17,
            "missing dimension": [None],
        }
        for case, dimensions in cases.items():
            with self.subTest(case=case):
                (self.root / "data.json").unlink(missing_ok=True)
                source = self.shape_workbook(dimensions)
                try:
                    result, output, report = self.run_tool(source, "xlsx-ja", timeout=2)
                except subprocess.TimeoutExpired:
                    self.fail(f"{case} must be rejected before iteration")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())
                error = json.loads(report.read_text(encoding='utf8'))['errors'][0]['error']
                self.assertTrue("budget" in error or "dimension" in error, error)

    def test_xlsx_understated_dimensions_cannot_silently_hide_source_cells(self):
        for dimension in ("A1:B1", "A1:C1"):
            with self.subTest(dimension=dimension):
                (self.root / 'data.json').unlink(missing_ok=True)
                source = self.shape_workbook([dimension])
                if dimension == "A1:C1":
                    with zipfile.ZipFile(source) as archive:
                        parts = {name: archive.read(name) for name in archive.namelist()}
                    key = "xl/worksheets/sheet1.xml"
                    parts[key] = parts[key].replace(b'</sheetData>', b'<row r="2"><c r="C2" t="inlineStr"><is><t>hidden second row</t></is></c></row></sheetData>')
                    with zipfile.ZipFile(source, 'w') as archive:
                        for key, value in parts.items():
                            archive.writestr(key, value)
                result, output, report = self.run_tool(source, 'xlsx-ja')
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())
                self.assertIn('dimension', report.read_text(encoding='utf8'))

    def test_xlsx_native_dates_in_a_b_c_have_typed_serializable_audit(self):
        for column, value, type_name, iso in [(0, datetime(2026, 1, 1), "datetime", "2026-01-01T00:00:00"),
                                               (1, date(2026, 1, 2), "date", "2026-01-02"),
                                               (2, time(12, 34, 56), "time", "12:34:56")]:
            with self.subTest(column=column):
                (self.root / 'data.json').unlink(missing_ok=True)
                workbook = Workbook()
                workbook.iso_dates = True
                row = [None, "synthetic", "synthetic explanation"]
                row[column] = value
                workbook.active.append(row)
                source = self.root / 'dates.xlsx'
                workbook.save(source)
                original = source.read_bytes()
                result, output, report = self.run_tool(source, 'xlsx-ja')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(output.exists())
                audit = json.loads(report.read_text(encoding='utf8'))
                self.assertEqual(audit['accounting'][0]['raw'][column], {'type': type_name, 'value': iso})
                self.assertTrue(audit['applyReady'])
                self.assertEqual(source.read_bytes(), original)

    def test_xlsx_date_audit_survives_exception_and_reviewed_heading(self):
        typed = {'type': 'datetime', 'value': '2026-01-01T00:00:00'}
        for case in ('extra-column', 'orphan', 'reviewed-heading'):
            with self.subTest(case=case):
                (self.root / 'data.json').unlink(missing_ok=True)
                workbook = Workbook()
                if case == 'extra-column':
                    workbook.active.append([None, 'synthetic', 'meaning', datetime(2026, 1, 1)])
                elif case == 'orphan':
                    workbook.active.append([None, None, datetime(2026, 1, 1)])
                else:
                    workbook.active.append([datetime(2026, 1, 1)])
                workbook.active.append([None, 'following', 'meaning'])
                source = self.root / 'date-exceptions.xlsx'
                workbook.save(source)
                overrides = None if case != 'reviewed-heading' else {'Sheet:B1': {
                    'kind': 'heading', 'raw': [typed], 'reason': 'Reviewed typed heading'}}
                result, output, report = self.run_tool(source, 'xlsx-ja', overrides=overrides)
                self.assertEqual(result.returncode, 0 if overrides else 2, result.stderr)
                audit = json.loads(report.read_text(encoding='utf8'))
                self.assertEqual(audit['accounting'][0]['raw'][-1], typed)
                self.assertEqual(audit['accounting'][0]['kind'], 'heading' if overrides else 'exception')
                self.assertEqual(output.exists(), bool(overrides))

    def test_report_directory_failure_cannot_publish_new_import(self):
        source = self.txt('synthetic  explanation\n')
        report_directory = self.root / 'report-directory'
        report_directory.mkdir()
        result, output, _ = self.run_tool(source, extra=['--report', str(report_directory)])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertTrue(report_directory.is_dir())
        self.assertNotIn('Traceback', result.stderr)

    def test_report_parent_file_failure_cannot_publish_new_import(self):
        source = self.txt('synthetic  explanation\n')
        blocked_parent = self.root / 'parent-file'
        blocked_parent.write_text('preserve this file', encoding='utf8')
        result, output, _ = self.run_tool(source, extra=['--report', str(blocked_parent / 'report.json')])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(blocked_parent.read_text(encoding='utf8'), 'preserve this file')
        self.assertNotIn('Traceback', result.stderr)

    def main_args(self, source):
        return [str(source), '--adapter', 'txt-zh', '--source-key', 'synthetic', '--source-name', 'Synthetic',
                '--source-version', 'v1', '--mapping-version', 'fixture-v1',
                '--output', str(self.root / 'data.json'), '--report', str(self.root / 'report.json')]

    def test_report_permission_failure_preserves_previous_report_and_no_new_import(self):
        source = self.txt('synthetic  explanation\n')
        report = self.root / 'report.json'
        report.write_text('old report must survive', encoding='utf8')
        with patch.object(PREPARE, 'write_json', side_effect=PermissionError('synthetic report permission failure')):
            try:
                with redirect_stdout(StringIO()):
                    result = PREPARE.main(self.main_args(source))
            except OSError as error:
                self.fail(f'Report failure must return controlled failure: {error}')
        self.assertEqual(result, 2)
        self.assertFalse((self.root / 'data.json').exists())
        self.assertEqual(report.read_text(encoding='utf8'), 'old report must survive')

    def test_report_atomic_replace_failure_preserves_previous_bytes(self):
        source = self.txt('synthetic  explanation\n')
        report = self.root / 'report.json'
        report.write_bytes(b'previous audit bytes')
        with patch.object(PREPARE.os, 'replace', side_effect=PermissionError('synthetic replace permission denied')):
            with redirect_stdout(StringIO()):
                result = PREPARE.main(self.main_args(source))
        self.assertEqual(result, 2)
        self.assertEqual(report.read_bytes(), b'previous audit bytes')
        self.assertFalse((self.root / 'data.json').exists())
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_import_publication_observes_complete_parseable_report_first(self):
        source = self.txt('synthetic  explanation\n')
        publish = PREPARE.os.link
        observed = []
        def verify_report_then_publish(staged, destination):
            report = json.loads((self.root / 'report.json').read_text(encoding='utf8'))
            observed.append(report['accounting'][0]['entryRef'])
            self.assertTrue(report['applyReady'])
            self.assertEqual(json.loads(Path(staged).read_text(encoding='utf8'))['entries'][0]['original'], 'synthetic')
            publish(staged, destination)
        with patch.object(PREPARE.os, 'link', side_effect=verify_report_then_publish):
            with redirect_stdout(StringIO()):
                result = PREPARE.main(self.main_args(source))
        self.assertEqual(result, 0)
        self.assertEqual(observed, ['line:1'])
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_xlsx_duration_keeps_exact_decoded_type_and_value_in_audit(self):
        workbook = Workbook()
        workbook.active.append([timedelta(days=2, seconds=3, microseconds=4000), 'synthetic', 'meaning'])
        source = self.root / 'duration.xlsx'
        workbook.save(source)
        result, _, report = self.run_tool(source, 'xlsx-ja')
        self.assertEqual(result.returncode, 0, result.stderr)
        raw = json.loads(report.read_text(encoding='utf8'))['accounting'][0]['raw'][0]
        self.assertEqual(raw, {'type': 'timedelta', 'days': 2, 'seconds': 3, 'microseconds': 4000})

    def test_report_serialization_failure_cannot_publish_new_import(self):
        source = self.txt('synthetic  explanation\n')
        serialize = json.dumps
        def fail_report(value, *args, **kwargs):
            if isinstance(value, dict) and 'accounting' in value:
                raise TypeError('synthetic report serialization failure')
            return serialize(value, *args, **kwargs)
        with patch.object(PREPARE.json, 'dumps', side_effect=fail_report):
            try:
                with redirect_stdout(StringIO()):
                    result = PREPARE.main(self.main_args(source))
            except TypeError as error:
                self.fail(f'Report serialization must return controlled failure: {error}')
        self.assertEqual(result, 2)
        self.assertFalse((self.root / 'data.json').exists())

    def test_orphan_continuation_does_not_silently_disappear(self):
        result, output, _ = self.run_tool(self.txt("  orphan\nぴっ  explanation\n"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())

    def test_control_character_blocks_ready_output(self):
        result, output, _ = self.run_tool(self.txt("ぴっ  forbidden\x00text\n"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())

    def test_c1_line_separator_cannot_hide_a_control_character(self):
        result, output, report = self.run_tool(self.txt("ぴっ  synthetic\x85びっ  different\n"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(len(json.loads(report.read_text(encoding="utf8"))["accounting"]), 1)

    def test_numbered_definition_cannot_become_a_false_headword(self):
        result, output, report = self.run_tool(self.txt("ぴっ  第一义\n①\t第二义\n"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(json.loads(report.read_text(encoding="utf8"))["accounting"][1]["kind"], "exception")

    def test_reviewed_non_indented_definition_retains_its_number(self):
        source = self.txt("ぴっ  第一义\n①\t第二义\n")
        result, output, _ = self.run_tool(source, overrides={"2": {"kind": "continuation", "raw": "①\t第二义", "explanation": "①\t第二义", "reason": "Reviewed numbered continuation"}})
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(output.read_text(encoding="utf8"))["entries"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["explanationZh"], "第一义\n①\t第二义")

    def workbook(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Sheet1"
        sheet.append(["あ行", None, None])
        sheet.append([None, "ぴっ", "合成の意味"])
        sheet.append([None, None, "続く意味"])
        sheet.append([None, "ぴっ", "別の意味"])
        for index, value in enumerate([None, "", "   ", "\n", "\u3000"]):
            sheet.append([None, f"synthetic-{index}", value])
        source = self.root / "fixture.xlsx"
        workbook.save(source)
        return source

    def test_xlsx_preserves_continuations_five_blank_meanings_and_duplicates(self):
        source = self.workbook()
        result, output, report = self.run_tool(source, "xlsx-ja")
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(output.read_text(encoding="utf8"))["entries"]
        self.assertEqual(len(entries), 7)
        self.assertEqual(entries[0]["sourceRef"], "Sheet1:B2")
        self.assertEqual(entries[0]["explanationJa"], "合成の意味\n続く意味")
        self.assertEqual(sum(e["explanationJa"] is None for e in entries), 5)
        self.assertTrue(all(e["explanationZh"] is None and e["translationZh"] is None for e in entries))
        self.assertEqual(len(json.loads(report.read_text(encoding="utf8"))["accounting"]), 9)

    def test_shared_strings_xlsx_is_supported(self):
        source = self.workbook()
        with zipfile.ZipFile(source) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet1.xml"].replace(b'<c r="B2" t="inlineStr"><is><t>', b'<c r="B2" t="s"><v>0</v></c><c r="Z99" t="inlineStr"><is><t>', 1)
        # Remove the temporary placeholder cell, retaining all other synthetic cells.
        import re
        parts["xl/worksheets/sheet1.xml"] = re.sub(b'<c r="Z99".*?</c>', b'', parts["xl/worksheets/sheet1.xml"])
        parts["xl/sharedStrings.xml"] = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>ぴっ</t></si></sst>'.encode("utf8")
        parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(b'</Types>', b'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
        with zipfile.ZipFile(source, "w") as archive:
            for name, body in parts.items():
                archive.writestr(name, body)
        result, output, _ = self.run_tool(source, "xlsx-ja")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf8"))["entries"][0]["original"], "ぴっ")


if __name__ == "__main__":
    unittest.main()
