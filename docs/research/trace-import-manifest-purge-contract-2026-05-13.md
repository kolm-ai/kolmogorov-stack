# Trace Import Manifest And Purge Contract - 2026-05-13

## Purpose

Trace import needs a durable manifest before any source-specific importer ships. The manifest is the operational ledger that lets Kolm answer:

- which source export produced which normalized rows,
- what privacy mode and retention policy were used,
- where raw sidecars live,
- what scores or fields were dropped,
- which rows generated labels, eval cases, artifacts, receipts, or write-back jobs,
- what must be deleted or anonymized during purge.

Without this manifest, `kolm import purge` cannot be trustworthy.

## Manifest Shape

```json
{
  "spec": "kolm-import-manifest-1",
  "manifest_id": "kim_...",
  "created_at": "2026-05-13T00:00:00.000Z",
  "tenant": {
    "tenant_id": "tenant-id",
    "namespace": "support"
  },
  "source": {
    "system": "langfuse",
    "export_ref": "fixture-or-api-cursor",
    "source_project": "project",
    "source_checksum": "sha256:..."
  },
  "privacy": {
    "mode": "redacted",
    "retention_days": 30,
    "purge_after": "2026-06-12T00:00:00.000Z",
    "allow_raw": false,
    "redactor": "kolm-redactor-0",
    "identity_salt_ref": "tenant-key-id"
  },
  "counts": {
    "source_rows": 100,
    "normalized_rows": 95,
    "blocked_rows": 5,
    "raw_sidecars": 0,
    "scores": 40,
    "eval_cases": 20,
    "label_exports": 0,
    "artifacts": 0,
    "writebacks": 0
  },
  "artifacts": [],
  "rows": [],
  "loss_report_ref": "loss.json",
  "purge": {
    "status": "active",
    "last_checked_at": null,
    "purged_at": null,
    "mode": null
  }
}
```

Each row entry should be small:

```json
{
  "row_id": "ktr_...",
  "source_row_id": "trace-id",
  "row_checksum": "sha256:...",
  "privacy_mode": "redacted",
  "raw_payload_ref": null,
  "eval_case_ids": ["case_..."],
  "label_export_ids": [],
  "artifact_ids": [],
  "cache_keys": [],
  "writeback_ids": []
}
```

## Purge Modes

`delete`:

- remove normalized imported rows,
- remove score rows tied to imported rows,
- remove raw sidecars,
- remove loss reports that contain field paths or samples,
- remove generated label exports,
- remove pending write-back rows,
- delete cache entries listed in the manifest,
- append a purge audit event.

`anonymize`:

- keep aggregate counters and non-identifying checksums,
- remove or hash input/output fields,
- remove user/session hashes,
- clear comments and raw refs,
- keep manifest shell for audit.

`dry-run`:

- enumerate deletion targets and blocked targets,
- do not mutate storage,
- return counts by table and sidecar path.

## Non-Purgeable Outputs

Distributed `.kolm` artifacts are not safely mutable after distribution. Purge should mark artifact references as `distributed_or_unknown` and record that the source manifest is purged, but it should not attempt to rewrite shipped artifacts.

This is why source IDs, raw payload refs, direct user IDs, direct session IDs, comments, source delete tokens, and loss reports must not be embedded in artifacts.

## Current Local Feasibility

The store facade already has `insert`, `update`, and `remove` for JSON and SQLite-backed rows. That makes row-level purge feasible for tables such as `observations`, future `import_rows`, future `import_scores`, and future `import_manifests`.

The cache layer only exposes `invalidate(version_id)` and writes disk files under `data/cache` or `/tmp/data/cache`. It cannot currently delete by import row or input hash. A manifest therefore needs explicit `cache_keys`, and cache needs a delete-by-key helper before import purge can be complete.

The current audit endpoint reconstructs events from source tables. Purge needs a durable audit event or signed manifest update, because deleting source rows would otherwise erase the evidence that deletion happened.

Account delete is not enough. Import purge must be a separate operational command because imports can be purged by source export, namespace, retention window, or customer request without deleting the tenant.

## Required Command Contract

```text
kolm import manifest <manifest.json>
kolm import purge --manifest <manifest.json> --mode dry-run
kolm import purge --manifest <manifest.json> --mode delete --confirm <manifest_id>
kolm import purge --manifest <manifest.json> --mode anonymize --confirm <manifest_id>
```

Expected dry-run output:

```json
{
  "manifest_id": "kim_...",
  "mode": "dry-run",
  "targets": {
    "import_rows": 95,
    "import_scores": 40,
    "raw_sidecars": 0,
    "label_exports": 0,
    "cache_keys": 0,
    "writebacks": 0
  },
  "non_purgeable": {
    "artifacts": []
  },
  "blocked": []
}
```

## Implementation Sequence

1. Add import manifest JSON schema and examples.
2. Add import row IDs to normalized rows and score rows.
3. Add manifest writer for fixture import only.
4. Add purge dry-run over manifest rows.
5. Add delete/anonymize mode for JSON store.
6. Add SQLite parity tests.
7. Add cache delete-by-key helper.
8. Add durable purge audit event.
9. Add retention scan that selects manifests/rows by `purge_after`.
10. Add source write-back cleanup for pending write-back rows.

