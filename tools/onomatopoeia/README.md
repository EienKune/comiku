# Offline reference preparation

This optional developer tool converts privately held reference material into the
versioned reference-dictionary import JSON. It does not connect to the application,
network services or a database. Keep original files, overrides, generated JSON and
review reports outside Git and Docker build contexts. Only use material you are
authorized to process; source licensing is independent from this tool's MIT license.

## Setup and synthetic tests

Python 3.10 or later is sufficient for the GB18030 text adapter. XLSX preparation
and the synthetic test suite additionally need the optional pinned dependency:

```powershell
python -m venv C:/private/reference-venv
C:/private/reference-venv/Scripts/python.exe -m pip install -r tools/onomatopoeia/requirements.txt
C:/private/reference-venv/Scripts/python.exe -m unittest discover -s tools/onomatopoeia -v
```

Application images and ordinary Node workspace installation do not need this
dependency. Tests generate synthetic XLSX files in temporary directories, including
both inline and shared strings; no real material is bundled.

## Prepare and review

```powershell
python tools/onomatopoeia/prepare.py C:/private/reference.txt `
  --adapter txt-zh --source-key example-reference `
  --source-name "Example reference" --source-version snapshot-v1 `
  --mapping-version reviewed-v1 --overrides C:/private/overrides.json `
  --output C:/private/import-v1.json --report C:/private/review-v1.json
```

Use a **new output path** for each attempt. Existing outputs are never overwritten;
this avoids confusing a previous ready file with an unsuccessful preparation.
The report may be regenerated and contains source text, so it is private too.
Source, output, report and overrides must resolve to different paths.
The complete audit report is serialized and atomically written before publishing
the new import JSON. Report serialization or write failures return exit code 2
and publish no new import; a failed report replacement preserves any older report.
Both files are staged completely before publication. New import publication uses
an atomic hard link in the output directory and never replaces an existing file;
the local filesystem must support hard links.

`txt-zh` strictly decodes GB18030. A non-indented line starts a record when its
headword and explanation are separated by a tab or at least two whitespace
characters. An initial `＊`, `※` or `*` relation marker is removed from the
headword; the original line remains in the report. Indented lines continue the
last record. Definitions retain line breaks, numbering and cross-references.
Single/fullwidth whitespace separators, missing separators, titles and
non-indented numbered definitions require explicit review. Headwords are not
restricted to kana, and repeated headwords remain separate records.

`xlsx-ja` reads every sheet and physical row, using B as the original and C as
the Japanese explanation. C-only rows continue the previous record. A-only
navigation, titles and footers are accounted as headings; completely empty rows
are accounted as blank. B/C column labels need a reviewed heading override.
Formulas and populated columns after C require review. Empty explanations become
JSON null and do not remove the record. Source references use the actual sheet
name and starting B cell, for example `Sheet1:B3`.
Continuation state resets at every worksheet boundary, including empty sheets;
a leading C-only row in another worksheet requires explicit review.

Before row iteration the XLSX adapter validates all worksheet dimensions:
at most 16 sheets, 64 columns per sheet, 100,000 total rows and 1,000,000 total
virtual cells. Missing dimensions and over-budget shapes are rejected without
truncation. A streaming XML coordinate check also rejects source cells outside
the declared dimensions, so a falsely small dimension cannot silently hide data.
Decoded Excel datetime/date/time values have typed ISO audit objects, for example
`{"type":"datetime","value":"2026-01-01T00:00:00"}`. Durations record their
`timedelta` type and exact days/seconds/microseconds. Such representations are
preserved in every audited row, including exception and reviewed-heading rows;
an override's `raw` value must match that typed representation. B/C values still
follow the adapter's existing string conversion for import fields.

Every physical text line or sheet row is classified in the report as `record`,
`continuation`, `heading`, `blank` or `exception`. Orphan continuations, unresolved
exceptions, unused/stale overrides, control characters, invalid metadata and
contract bounds block import JSON output with exit code 2. Successful preparation
returns exit code 0 and `applyReady: true`. Review counts, duplicate words, blank
meanings and **all** heading/exception decisions before using the generated JSON.

## Reviewed overrides

Overrides are tied to the exact original byte SHA256 and mapping version. Each
decision matches the exact source line (or exact XLSX value list) and states a
review reason. Do not publish a real override file. This is a synthetic example:

```json
{
  "fileSha256": "<64 lowercase hexadecimal characters>",
  "mappingVersion": "reviewed-v1",
  "lines": {
    "line:1": {
      "kind": "heading",
      "raw": "Synthetic title",
      "reason": "Reviewed title, not a headword."
    },
    "line:2": {
      "kind": "record",
      "raw": "ぴっ single-space example",
      "original": "ぴっ",
      "explanation": "single-space example",
      "reason": "Reviewed the word boundary."
    },
    "line:3": {
      "kind": "continuation",
      "raw": "①\tSynthetic second sense",
      "explanation": "①\tSynthetic second sense",
      "reason": "Reviewed numbering belongs to the previous record."
    },
    "Sheet1:B2": {
      "kind": "heading",
      "raw": ["Navigation", "Original", "Meaning"],
      "reason": "Reviewed column labels."
    }
  }
}
```

Use only keys present in the selected source; this combined example illustrates
both adapters. Text keys may also use a physical line number such as `"2"`;
duplicate canonical keys are rejected. A continuation override's explanation
must include any meaningful numbering from the original line.

## Import contract and provenance

The output contains `formatVersion: 1`, one `source` object and an `entries`
array. `source` records the original file's byte SHA256, supplied source version,
and `importerVersion` combining the parser version, supplied mapping version and
canonical override SHA256. Changing reviewed overrides changes import identity
even if the caller accidentally retains the supplied mapping version.
The report also records parser/mapping versions, canonical mapping SHA256 and
the override file's byte SHA256.
Use a short mapping version so the combined importer version fits 160 characters.
Change mapping version whenever reviewed mappings change. Change parser version
whenever parsing behavior changes; identical bytes can then be deliberately
reimported after a correction. `sourceRef` is local to one snapshot and must never
be treated as a stable identity across file versions.

Chinese text explanations go to `explanationZh`; Japanese spreadsheet explanations
go to `explanationJa`. `translationZh` stays null: explanatory prose does not
automatically become a ready-to-use translation. Optional `--source-url`,
`--attribution` and `--license` preserve known provenance; do not invent missing
copyright or redistribution permission. Filesystem paths are not source metadata.

The import contract bounds source keys to 64 characters, names/versions/importer
versions to 160, source references to 160, originals to 256 Unicode code points,
each explanation/translation/note to 16,000, and entries to 1–50,000. Both source
and output files are limited to 32 MiB; expanded XLSX content is limited to
512 MiB. Multiline fields allow LF/CR/TAB; other C0/C1 controls and surrogate code
points are rejected.
Source URLs must be a single line of at most 2,048 code points, use absolute
HTTP/HTTPS, contain no credentials or controls, and have a valid host and port.
The application's developer importer must independently
validate JSON and perform its own dry-run/revision-fenced transaction; a preparation
report is not database-import authorization.
