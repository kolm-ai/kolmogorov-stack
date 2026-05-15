# Trace Import Privacy Policy - 2026-05-13

This is a product and engineering policy memo, not legal advice.

## Decision

Trace import must fail closed until the caller chooses a privacy mode and retention policy. The default should not be raw import.

Recommended CLI shape:

```text
kolm import langfuse --fixture trace.json --privacy redacted --retention-days 30 --namespace support
kolm import helicone --fixture export.jsonl --privacy hash-only --namespace support
kolm import langsmith --fixture runs.parquet --privacy raw --retention-days 7 --allow-raw
```

The importer should emit normalized rows plus an import manifest. The manifest must record privacy mode, retention, source checksums, row checksums, source delete references when known, and loss reports.

## Privacy Modes

`hash-only`:

- Store source IDs, row hashes, prompt/output hashes, metrics, model, timestamps, score summaries, and safe metadata.
- Do not store raw input, output, messages, tool arguments, attachments, comments, user IDs, or session IDs.
- Cannot directly create `.kolm` eval cases unless the user supplies a separate approved eval source.

`redacted`:

- Run local redaction before persistence.
- Store redacted input/output plus original checksums.
- Store redaction report: matched detectors, field paths, counts, and whether any field was dropped.
- May derive eval cases only from redacted fields.

`raw`:

- Store raw imported input/output and source metadata.
- Requires explicit `--allow-raw`, a retention period, and a namespace.
- Never embed raw source metadata, raw payload refs, user hashes, or source score comments inside `.kolm` artifacts.

`blocked`:

- Refuse import because required privacy fields or consent basis are missing.
- Use for unknown source exports, missing retention, unknown data residency, or unsupported attachment/media fields.

## Required Row Fields

Every imported `kolm-trace-1` row should carry:

```json
{
  "privacy": {
    "redaction_state": "hash-only | redacted | raw | blocked",
    "consent_basis": "customer-import | explicit-user-consent | synthetic | unknown",
    "retention_days": 30,
    "purge_after": "2026-06-12T00:00:00.000Z",
    "data_residency": "us | eu | customer-hosted | unknown",
    "raw_payload_ref": null,
    "raw_payload_checksum": "sha256:...",
    "pii_flags": [],
    "user_hash": "sha256:...",
    "session_hash": "sha256:..."
  }
}
```

`user_hash` and `session_hash` should use a tenant-scoped salt. Do not import source user IDs directly into portable artifacts.

## Current Kolm Gaps

Local capture already stores prompt and response text in `observations`. Prompt text can be stored up to 8000 characters and response text up to 16000 characters. There is no namespace-level retention, redaction-before-persist, observation purge route, raw-payload sidecar separation, deletion certificate, or importer manifest.

Account delete is currently a tenant authentication soft-delete, not a purge of observations, invocations, compile jobs, artifacts, cache files, or public/private registry data.

Capture triage is not binding. Discarded observations are hidden from the inbox by default, but label export and auto-distill do not exclude them.

The trace import schema therefore needs to be stricter than current capture until capture itself is migrated.

## External Source Baseline

Langfuse exposes data retention controls for traces, observations, scores, and media assets. Retention is project-level, defaults to indefinite, and deletion can cover traces, batches, query matches, projects, organizations, and user accounts. Trace deletion also deletes related scores and observations.

LangSmith exposes retention tiers and delete APIs. Some retention changes apply to new traces only, and trace deletions are not instant. Delete-by-metadata is supported, and related feedback, aggregations, and stats are deleted.

Phoenix self-hosting positions data control as customer-owned. Its default retention is indefinite, but projects can use time/count retention policies, and self-hosted telemetry can be disabled. Air-gapped mode disables telemetry and external resources.

Braintrust logs are production trace data and can be deleted through the UI or by marking log rows for deletion through the API.

These products set the buyer expectation: trace systems need explicit retention/deletion controls. Kolm should not import from them into a weaker local lifecycle.

## Artifact Boundary

Portable `.kolm` artifacts should embed only approved eval fields:

- `input`
- `expected`
- optional `params`
- minimal generated case ID

Artifacts should not embed:

- raw source trace IDs,
- source user IDs or session IDs,
- raw payload refs,
- comments containing user text,
- source API URLs,
- source deletion tokens,
- import manifest rows,
- score loss reports.

Keep source provenance in importer manifests and receipt sidecars. This lets artifacts remain portable and reduces downstream regulated-data blast radius.

## Purge Contract

Importer manifests should support a future purge command:

```text
kolm import purge --manifest import-manifest.json --mode delete
kolm import purge --manifest import-manifest.json --mode anonymize
```

Minimum purge scope:

- normalized trace rows,
- raw payload sidecars,
- loss reports with sample values,
- local label exports generated from the import,
- cache entries keyed by imported rows,
- queued import jobs,
- source write-back pending state.

Purge should not mutate already distributed `.kolm` artifacts. That is why raw/source metadata must stay out of artifacts.

## Implementation Sequence

1. Add privacy fields to `kolm-trace-1` schema.
2. Add importer CLI gates for `--privacy`, `--retention-days`, `--namespace`, and `--allow-raw`.
3. Add a local redaction hook interface and a no-op detector fixture.
4. Add manifest and purge fixtures.
5. Migrate capture observations to the same privacy fields.
6. Add retention job for observations and imported trace rows.
7. Only then publish importer or capture privacy claims.

