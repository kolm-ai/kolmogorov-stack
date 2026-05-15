# Import Canonical Checksum Rules - 2026-05-13

## Scope

This memo defines checksum rules for future import fixtures, import manifests, normalized rows, eval cases, score rows, and loss reports. It is required before executable Langfuse fixture files are generated because the current fixture blueprint intentionally uses symbolic checksums.

The rule is simple:

```text
sha256:jcs-rfc8785:<hex>
```

where `<hex>` is SHA-256 over UTF-8 bytes of a JSON Canonicalization Scheme payload. For exact source files and raw sidecars, use byte checksums:

```text
sha256:bytes:<hex>
```

## Canonicalization Basis

Use RFC 8785 JSON Canonicalization Scheme for JSON payloads. The useful properties for Kolm imports are:

- no insignificant whitespace,
- deterministic object-property ordering,
- UTF-8 output,
- deterministic JSON primitive serialization,
- I-JSON constraints.

Do not rely on pretty JSON, insertion-order JSON, PowerShell `ConvertTo-Json`, Node `JSON.stringify`, Python `json.dumps`, or database JSON output as the checksum format unless a tested JCS implementation wraps them and proves RFC 8785-compatible output.

## Domain Separation

Never hash a bare row object directly. Hash a domain-separated envelope:

```json
{
  "domain": "kolm.import.source_row",
  "checksum_rule": "import-checksum-2026-05-13",
  "source_system": "langfuse",
  "source_file": "observations-v2-page-1.json",
  "source_row_id": "obs_generation_001",
  "payload": {}
}
```

The `domain` field prevents the same payload from having the same checksum when used as a source row, normalized row, eval case, score row, manifest, or loss row.

Recommended domains:

| Domain | Target |
| --- | --- |
| `kolm.import.source_file` | Exact input file byte checksum envelope when file metadata is recorded. |
| `kolm.import.source_row` | One source trace, observation, score, dataset, dataset item, or retention row. |
| `kolm.import.normalized_row` | One `kolm-trace-1` or related normalized import row after privacy mode is applied. |
| `kolm.import.score_row` | One `kolm-score-1` row after privacy mode is applied. |
| `kolm.import.evalcase` | One artifact-bound `kolm-evalcase-1` row after artifact-field allowlist is applied. |
| `kolm.import.loss_row` | One loss-report row with code, path, count, and sample policy. |
| `kolm.import.manifest.content` | Immutable manifest content excluding mutable purge state and signatures. |
| `kolm.import.manifest.state` | Mutable purge/anonymize state after an operation. |
| `kolm.import.jsonl_file` | Canonical JSONL output file produced from canonical lines. |
| `kolm.import.raw_sidecar` | Exact raw payload sidecar bytes when raw mode is explicitly allowed. |

## Source File Checksums

Use `sha256:bytes:<hex>` over exact source file bytes for:

- `traces.json`,
- `observations-v2-page-1.json`,
- `observations-v2-page-2.json`,
- `scores.json`,
- `datasets.json`,
- `dataset-items.json`,
- `dataset-run-items.json`,
- `retention.json`,
- `score-map.json`.

This catches line-ending, spacing, field-order, and byte-level file changes. It is not a semantic checksum.

## Source Row Checksums

Use JCS over a source-row envelope after parsing JSON. The payload is the source row object exactly as parsed, including source field names and source values.

Do not:

- redact before computing source row checksum,
- normalize timestamps before source row checksum,
- round numeric values,
- sort arrays,
- drop unknown fields,
- map source field names to Kolm field names.

If source JSON cannot be parsed, compute only the file byte checksum and emit a parse-loss row. Do not invent a source row checksum from invalid JSON text.

## Normalized Row Checksums

Use JCS over a normalized-row envelope after:

- privacy mode is applied,
- source fields are mapped to Kolm fields,
- timestamps are normalized to UTC ISO 8601 strings,
- latency fields are converted to integer microseconds,
- score-map rules are applied,
- artifact-denied fields are excluded from evalcase rows.

The payload must exclude:

- the row checksum field itself,
- generated debug fields,
- non-deterministic `generated_at` values,
- transient import process IDs,
- signature fields.

The payload must include:

- `spec`,
- row ID,
- source system,
- privacy mode,
- row kind,
- source refs allowed by the row type,
- metrics and normalized fields allowed by the row type.

Redacted and hash-only mode outputs must have different normalized row checksums because the payloads are different.

## JSONL File Checksums

For expected JSONL files:

1. Each line must be one JCS-canonical JSON object.
2. Lines are sorted by stable row ID unless the schema defines a different order.
3. Join lines with LF.
4. Do not add a trailing LF for the checksum input.
5. Hash a `kolm.import.jsonl_file` envelope containing file name, line count, row checksums, and the exact joined content checksum.

The raw file may still end with a trailing LF for editor ergonomics, but the file checksum must state whether the trailing LF was included.

## Manifest Checksums

Use two checksums:

- `manifest_content_checksum` for immutable import facts,
- `manifest_state_checksum` for mutable purge/anonymize state.

`manifest_content_checksum` includes:

- spec,
- manifest ID,
- source system,
- source window,
- fixture name or export refs,
- source file byte checksums,
- source row checksums,
- normalized row checksums,
- score row checksums,
- evalcase checksums,
- loss row checksums,
- privacy mode,
- retention policy,
- counts,
- artifact refs.

It excludes:

- `manifest_content_checksum`,
- `manifest_state_checksum`,
- signatures,
- mutable purge state,
- mutable last-accessed values,
- generated debug timing.

`manifest_state_checksum` includes:

- manifest ID,
- prior content checksum,
- purge state,
- per-target purge or anonymize result,
- operation timestamp,
- operator or service actor hash,
- partial-failure details.

## Loss Row Checksums

Loss rows use JCS over:

- manifest ID,
- privacy mode,
- source system,
- source file,
- source row ID when known,
- source path,
- loss code,
- count,
- blocked reason,
- `sample_included`.

Loss rows in redacted or hash-only mode must not include raw source samples. If raw mode later allows samples, the raw sample must be a sidecar with `sha256:bytes:<hex>` and explicit retention metadata.

## Number And String Rules

Numbers:

- keep source numeric values as parsed,
- do not round cost or latency source values,
- reject non-finite values such as NaN or Infinity,
- convert normalized latency to integer microseconds,
- keep decimal-like identifiers as strings if the source supplied strings.

Strings:

- use the exact parsed Unicode string for JSON checksums,
- do not apply Unicode normalization,
- do not trim whitespace,
- do not case-fold identifiers,
- redact or hash only after source row checksums are computed.

Arrays:

- preserve source array order,
- do not sort arrays unless a future schema explicitly marks the field as order-insensitive,
- record any future array sorting rule in `checksum_rule`.

## Minimal Fixture Manifest Block

Every future import manifest should include:

```json
{
  "checksum_rules": {
    "json": "jcs-rfc8785",
    "hash": "sha256",
    "rule_id": "import-checksum-2026-05-13",
    "source_file_checksum": "sha256:bytes",
    "json_row_checksum": "sha256:jcs-rfc8785",
    "jsonl_line_order": "row_id_ascending",
    "jsonl_trailing_lf_included": false
  }
}
```

## Required Negative Tests

The checksum fixture harness should fail when:

1. An object property order change changes a JCS row checksum.
2. An object property value change does not change a JCS row checksum.
3. A file byte change does not change the source file checksum.
4. A row checksum is computed without the domain envelope.
5. A normalized row checksum includes its own checksum field.
6. A redacted-mode row checksum equals a hash-only-mode row checksum for different payloads.
7. A malformed JSON source row gets a semantic source row checksum.
8. A loss row includes raw sample values in redacted or hash-only mode.
9. A manifest content checksum changes after only purge state changes.
10. A manifest state checksum does not change after purge state changes.

## Implementation Order

1. Add a tiny JCS canonicalizer dependency or implementation behind one helper.
2. Add unit vectors from RFC 8785 before import-specific tests.
3. Add domain-envelope checksum tests.
4. Add source file byte checksum tests.
5. Add Langfuse support-v1 fixture checksums.
6. Add manifest content and state checksum checks.
7. Only then turn symbolic fixture checksums into executable expected values.

