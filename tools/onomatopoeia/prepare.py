#!/usr/bin/env python3
"""Prepare privately held reference files; never imports into a database."""
import argparse
from collections import Counter
from datetime import date, datetime, time, timedelta
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit
from xml.etree import ElementTree
import zipfile


PARSER_VERSION = "onomatopoeia-prepare/3"
MAX_BYTES = 32 * 1024 * 1024
MAX_XLSX_SHEETS = 16
MAX_XLSX_ROWS = 100000
MAX_XLSX_COLUMNS = 64
MAX_XLSX_CELLS = 1000000


def invalid_text(value, maximum, multiline=False):
    if not isinstance(value, str) or len(value) > maximum:
        return True
    return any((ord(c) < 32 and not (multiline and c in "\n\r\t"))
               or 127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF for c in value)


def entry(ref, original, meaning, language):
    return {"sourceRef": ref, "original": original, "explanationZh": meaning if language == "zh" else None,
            "explanationJa": meaning if language == "ja" else None, "translationZh": None, "notes": None}


def append_meaning(current, text, language):
    key = "explanationZh" if language == "zh" else "explanationJa"
    current[key] = "\n".join(filter(None, [current[key], text])) or None


def parse_rows(rows, overrides, language):
    """One explicit accounting item for every physical line/sheet row, even blank."""
    entries, accounting, errors, used = [], [], [], set()
    current = None
    for ref, raw, original, meaning, category in rows:
        if category == "sheet_boundary":
            current = None
            continue  # Boundary events are not physical rows and cannot be overridden.
        audit = {"ref": ref, "raw": raw}
        decision = overrides.get(ref)
        if decision is not None:
            used.add(ref)
            if (not isinstance(decision, dict) or decision.get("raw") != raw
                    or not isinstance(decision.get("reason"), str) or not decision["reason"].strip()):
                category = "exception"
                audit["error"] = "override must match exact source row and include a review reason"
            else:
                category = decision.get("kind")
                audit["overrideReason"] = decision["reason"]
                if category == "record":
                    original, meaning = decision.get("original"), decision.get("explanation")
                elif category == "continuation":
                    meaning = decision.get("explanation")
                elif category != "heading":
                    category = "exception"
                    audit["error"] = "override kind must be record, continuation or heading"
        if category == "record":
            if not isinstance(original, str) or not original.strip() or (meaning is not None and not isinstance(meaning, str)):
                category = "exception"
                audit["error"] = "record requires original text and nullable explanation"
            else:
                current = entry(ref, original.strip(), meaning.strip() or None if meaning is not None else None, language)
                entries.append(current)
        elif category == "continuation":
            if current is None or not isinstance(meaning, str):
                category = "exception"
                audit["error"] = "orphan or invalid continuation"
            else:
                append_meaning(current, meaning.strip(), language)
                audit["entryRef"] = current["sourceRef"]
        elif category == "heading":
            current = None
        elif category != "blank":
            category = "exception"
            audit.setdefault("error", "unresolved source format; explicit reviewed override required")
        audit["kind"] = category
        if category == "record":
            audit["entryRef"] = ref
        if category == "exception":
            errors.append({"ref": ref, "error": audit["error"]})
            current = None
        accounting.append(audit)
    for unused in sorted(set(overrides) - used):
        errors.append({"ref": unused, "error": "override points outside the source"})
    return entries, accounting, errors


def txt_rows(content):
    # str.splitlines also treats forbidden C0/C1 controls as line boundaries.
    # Count actual CR/LF physical lines so those characters remain detectable.
    lines = re.split(r"\r\n|\r|\n", content.decode("gb18030"))
    if lines and lines[-1] == "":
        lines.pop()
    for number, raw in enumerate(lines, 1):
        original, meaning = None, None
        if not raw.strip():
            kind = "blank"
        elif raw[0].isspace():
            kind, meaning = "continuation", raw.strip()
        else:
            # Markers describe a source relation, not a restriction to kana-only terms.
            head = re.sub(r"^[＊※*]\s*", "", raw.strip())
            parts = re.split(r"\s{2,}|\t+", head, maxsplit=1)
            if len(parts) == 2 and all(p.strip() for p in parts):
                kind, original, meaning = "record", parts[0], parts[1]
                if re.match(r"^[0-9①-⑳⑴-⒇]", original):
                    kind = "exception"  # Review definition numbering rather than inventing a headword.
            else:
                kind = "exception"
        yield f"line:{number}", raw, original, meaning, kind


def validate_workbook_shape(workbook, content):
    """Reject virtual-cell amplification before calling any worksheet iterator."""
    if len(workbook.sheetnames) > MAX_XLSX_SHEETS:
        raise ValueError("XLSX sheet count exceeds 16-sheet budget")
    total_rows, total_cells = 0, 0
    for sheet in workbook:
        rows, columns = sheet.max_row, sheet.max_column
        if rows is None or columns is None:
            raise ValueError("XLSX requires explicit worksheet dimensions before bounded preparation")
        if not 1 <= rows <= MAX_XLSX_ROWS or not 1 <= columns <= MAX_XLSX_COLUMNS:
            raise ValueError("XLSX worksheet shape exceeds 100000-row/64-column budget")
        total_rows += rows
        total_cells += rows * columns
        if total_rows > MAX_XLSX_ROWS or total_cells > MAX_XLSX_CELLS:
            raise ValueError("XLSX aggregate shape exceeds 100000-row/1000000-cell budget")
    # Validate actual coordinates without expanding sparse gaps. Read-only
    # openpyxl otherwise trusts a falsely small dimension and drops source cells.
    actual_rows, actual_cells = 0, 0
    with zipfile.ZipFile(BytesIO(content)) as archive:
        for sheet in workbook:
            # Pinned openpyxl 3.1.5 adapter's reference to the worksheet ZIP part.
            with archive.open(sheet._worksheet_path) as stream:
                for event, node in ElementTree.iterparse(stream, events=("start", "end")):
                    name = node.tag.rsplit("}", 1)[-1]
                    if event == "end":
                        node.clear()
                    elif name == "row":
                        actual_rows += 1
                        row = node.get("r", "")
                        if (actual_rows > MAX_XLSX_ROWS or not re.fullmatch(r"[0-9]{1,6}", row)
                                or not 1 <= int(row) <= sheet.max_row):
                            raise ValueError("XLSX actual row exceeds declared dimension/row budget")
                    elif name == "c":
                        actual_cells += 1
                        match = re.fullmatch(r"([A-Z]{1,2})([0-9]{1,6})", node.get("r", ""))
                        if match is None:
                            raise ValueError("XLSX cell coordinate exceeds dimension/cell budget")
                        column = 0
                        for char in match[1]:
                            column = column * 26 + ord(char) - ord("A") + 1
                        if (actual_cells > MAX_XLSX_CELLS or column > sheet.max_column
                                or not 1 <= int(match[2]) <= sheet.max_row):
                            raise ValueError("XLSX actual cell exceeds declared dimension/cell budget")


def audit_cell(value):
    """Preserve decoded Excel temporal types without relying on JSON coercion."""
    if isinstance(value, (datetime, date, time)):
        return {"type": type(value).__name__, "value": value.isoformat()}
    if isinstance(value, timedelta):
        return {"type": "timedelta", "days": value.days, "seconds": value.seconds,
                "microseconds": value.microseconds}
    return value


def xlsx_rows(content):
    try:
        from openpyxl import load_workbook
    except ImportError as error:
        raise ValueError("XLSX support is opt-in: install tools/onomatopoeia/requirements.txt") from error
    with zipfile.ZipFile(BytesIO(content)) as archive:
        if sum(item.file_size for item in archive.infolist()) > 512 * 1024 * 1024:
            raise ValueError("expanded XLSX exceeds 512 MiB preparation budget")
    workbook = load_workbook(BytesIO(content), read_only=True, data_only=False, keep_links=False)
    try:
        validate_workbook_shape(workbook, content)
        for sheet in workbook:
            yield None, None, None, None, "sheet_boundary"
            for number, cells in enumerate(sheet.iter_rows(), 1):
                raw = [cell.value for cell in cells]
                # Retain exact source values, including trailing cells, in the private report.
                while raw and raw[-1] is None:
                    raw.pop()
                values = (raw + [None] * 3)[:3]
                _, original, meaning = [str(v).strip() if v is not None else None for v in values]
                if any(cell.data_type == "f" for cell in cells) or any(v is not None for v in raw[3:]):
                    kind = "exception"
                elif original:
                    kind = "record"
                elif meaning:
                    kind = "continuation"
                elif any(v is not None and str(v).strip() for v in raw):
                    kind = "heading"  # A-only navigation/title/footer; always visible in report.
                else:
                    kind = "blank"
                yield f"{sheet.title}:B{number}", [audit_cell(value) for value in raw], original, meaning, kind
    finally:
        workbook.close()


def validate_payload(payload):
    errors, refs = [], set()
    source = payload["source"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", source["key"]):
        errors.append({"error": "invalid source key"})
    for key in ("name", "version", "importerVersion"):
        if not source[key].strip() or invalid_text(source[key], 160):
            errors.append({"error": f"invalid source {key}"})
    for key in ("attribution", "license"):
        value = source.get(key)
        if value is not None and (not value.strip() or invalid_text(value, 16000, True)):
            errors.append({"error": f"invalid source {key}"})
    url = source.get("sourceUrl")
    if url is not None:
        if not url.strip() or invalid_text(url, 2048):
            errors.append({"error": "source URL must be a single line of at most 2048 code points without controls"})
        else:
            try:
                parsed = urlsplit(url)
                # Access .port to reject malformed/out-of-range ports as the server URL parser does.
                port = parsed.port
                if (parsed.scheme not in ("http", "https") or not parsed.hostname or "@" in parsed.netloc
                        or re.search(r"[\s#%/<>?@\[\]\\^|]", parsed.hostname)):
                    raise ValueError("invalid absolute URL or forbidden userinfo/host")
            except ValueError:
                errors.append({"error": "source URL must be absolute http/https without credentials and with a valid host/port"})
    if not 1 <= len(payload["entries"]) <= 50000:
        errors.append({"error": "entry count must be 1..50000"})
    for item in payload["entries"]:
        ref = item["sourceRef"]
        if ref in refs:
            errors.append({"ref": ref, "error": "duplicate sourceRef"})
        refs.add(ref)
        for key, limit in (("sourceRef", 160), ("original", 256), ("explanationZh", 16000),
                           ("explanationJa", 16000), ("translationZh", 16000), ("notes", 16000)):
            value = item[key]
            if value is not None and invalid_text(value, limit, key not in ("original", "sourceRef")):
                errors.append({"ref": ref, "error": f"invalid {key}"})
    return errors


def write_bytes(path, content, replace):
    """Stage complete bytes beside the destination; never expose a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            # An atomic hard link publishes complete bytes, and fails if another
            # process already created this fresh output. Never replace old input.
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path, payload):
    # Serialize before opening/staging anything, preserving an older audit on failure.
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf8")
    write_bytes(path, encoded, replace=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--adapter", choices=("txt-zh", "xlsx-ja"), required=True)
    for flag in ("source-key", "source-name", "source-version", "mapping-version"):
        parser.add_argument("--" + flag, required=True)
    for flag in ("source-url", "attribution", "license"):
        parser.add_argument("--" + flag)
    parser.add_argument("--overrides", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    report = {"applyReady": False, "parserVersion": PARSER_VERSION, "mappingVersion": args.mapping_version,
              "accounting": [], "errors": []}
    encoded, report_allowed = None, False
    try:
        paths = [args.input, args.output, args.report] + ([args.overrides] if args.overrides else [])
        report_allowed = args.report.resolve() not in {p.resolve() for p in [args.input, args.output] + ([args.overrides] if args.overrides else [])}
        if len({path.resolve() for path in paths}) != len(paths):
            raise ValueError("input, output, report and overrides must be different files")
        if args.output.exists():
            raise ValueError("output already exists; use a fresh output path to avoid stale apply-ready data")
        if args.input.stat().st_size > MAX_BYTES:
            raise ValueError("source exceeds 32 MiB")
        content = args.input.read_bytes()
        digest = sha256(content).hexdigest()
        report["fileSha256"] = digest
        overrides = {}
        if args.overrides:
            mapping = json.loads(args.overrides.read_text(encoding="utf-8-sig"))
            if mapping.get("fileSha256") != digest or mapping.get("mappingVersion") != args.mapping_version:
                raise ValueError("override file SHA/mappingVersion does not match source and requested mapping")
            overrides = mapping.get("lines")
            if not isinstance(overrides, dict):
                raise ValueError("override lines must be an object keyed by sourceRef")
            # TXT accepts human-friendly physical line numbers, canonicalized before audit.
            canonical_overrides = {}
            for key, value in overrides.items():
                canonical = f"line:{key}" if key.isdecimal() else key
                if canonical in canonical_overrides:
                    raise ValueError("duplicate canonical override sourceRef")
                canonical_overrides[canonical] = value
            overrides = canonical_overrides
            report["overridesSha256"] = sha256(args.overrides.read_bytes()).hexdigest()
        rows = txt_rows(content) if args.adapter == "txt-zh" else xlsx_rows(content)
        entries, accounting, errors = parse_rows(rows, overrides, "zh" if args.adapter == "txt-zh" else "ja")
        report["accounting"] = accounting
        mapping_sha = sha256(json.dumps(overrides, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf8")).hexdigest()
        report["mappingSha256"] = mapping_sha
        payload = {"formatVersion": 1, "source": {"key": args.source_key, "name": args.source_name,
                   "version": args.source_version, "fileSha256": digest,
                   "importerVersion": f"{PARSER_VERSION};{args.mapping_version};{mapping_sha}", "sourceUrl": args.source_url,
                   "attribution": args.attribution, "license": args.license}, "entries": entries}
        errors.extend(validate_payload(payload))
        report["errors"] = errors
        counts = Counter(item["kind"] for item in accounting)
        report["counts"] = {"physicalRows": len(accounting), **dict(counts), "entries": len(entries),
                            "distinctOriginals": len({item["original"] for item in entries}),
                            "blankMeanings": sum(not item["explanationZh"] and not item["explanationJa"] for item in entries)}
        duplicates = Counter(item["original"] for item in entries)
        report["duplicates"] = {word: count for word, count in duplicates.items() if count > 1}
        report["applyReady"] = not errors
        if not errors:
            encoded = (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf8")
            if len(encoded) > MAX_BYTES:
                raise ValueError("prepared import JSON exceeds 32 MiB")
    except (TypeError, ValueError, OSError, UnicodeError, zipfile.BadZipFile, ElementTree.ParseError) as error:
        report["applyReady"] = False
        report["errors"].append({"error": str(error)})
    # A completed audit is the publication fence. A serialization/write error
    # returns controlled failure before any new import output can become visible.
    report_written = False
    if report_allowed:
        try:
            write_json(args.report, report)
            report_written = True
        except (TypeError, ValueError, OSError, UnicodeError) as error:
            report["applyReady"] = False
            report["errors"].append({"error": f"Cannot produce audit report: {error}"})
    if report_written and report["applyReady"] and encoded is not None:
        try:
            write_bytes(args.output, encoded, replace=False)
        except OSError as error:
            report["applyReady"] = False
            report["errors"].append({"error": f"Cannot publish prepared import: {error}"})
            try:
                write_json(args.report, report)
            except (TypeError, ValueError, OSError, UnicodeError) as report_error:
                report["errors"].append({"error": f"Cannot update audit report: {report_error}"})
    print(json.dumps({"applyReady": report["applyReady"], "counts": report.get("counts"), "errors": len(report["errors"])}, ensure_ascii=True))
    return 0 if report["applyReady"] else 2


if __name__ == "__main__":
    sys.exit(main())
