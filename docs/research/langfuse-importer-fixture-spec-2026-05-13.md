# Langfuse Importer Fixture Spec - 2026-05-13

## Scope

This memo turns the prior trace schema, score normalization, privacy, and purge research into the first source-specific importer target: Langfuse. It remains a research artifact under `docs/research`; no product code is changed here.

The first implementation should be fixture-only:

```text
kolm import langfuse --fixture ./fixtures/langfuse --privacy redacted --retention-days 30 --namespace support --out normalized.jsonl
```

Do not start with live API credentials. The first goal is to prove field preservation and loss reporting from representative Langfuse fixture files into `kolm-trace-1`, `kolm-score-1`, `kolm-evalcase-1`, and `kolm-import-manifest-1`.

## Why Langfuse First

Langfuse is the cleanest first importer because it has:

- trace and observation query surfaces,
- score objects attached to traces, observations, sessions, or dataset runs,
- dataset items with input and expected output,
- links from dataset items back to source traces and observations,
- versioned datasets and schema enforcement,
- project-level retention and deletion controls,
- an open API/SDK posture that buyers can self-host or use in multiple cloud regions.

This maps directly to Kolm's desired wedge: import production traces and eval evidence from an existing system, compile portable artifacts, then write receipts and artifact metadata back later.

## Current Kolm Gap

Kolm has `kolm capture`, `kolm labels`, and hosted capture routes, but no `kolm import` command and no external source connector. Existing capture rows are lossy compared with Langfuse:

- prompt/response are flattened,
- namespace has drift between `corpus_namespace` and `namespace`,
- no source trace/span hierarchy,
- no score objects,
- no dataset item links,
- no retention/purge manifest,
- no source write-back state.

The Langfuse importer should not write to existing `observations` directly at first. It should emit normalized JSONL and an import manifest, then a later implementation can decide how to store those rows.

## Fixture Pack

Minimum fixture directory:

```text
fixtures/langfuse/
  traces.json
  observations-v2.json
  scores.json
  datasets.json
  dataset-items.json
  dataset-run-items.json
  retention.json
  expected.normalized.jsonl
  expected.evalcases.jsonl
  expected.manifest.json
  expected.loss-report.json
```

Recommended fixture cases:

1. One trace with user ID, session ID, tags, environment, and timestamp.
2. One generation observation with `input` and `output` as JSON strings containing chat messages.
3. One span observation that is not a generation and should stay trace evidence but not become an eval case by default.
4. One generation with usage, cost, model, prompt, latency, and time-to-first-token fields.
5. One numeric score attached to the generation observation.
6. One boolean score attached to the trace.
7. One categorical score that requires score-map conversion.
8. One text score that remains qualitative evidence only.
9. One dataset item with input, expected output, metadata, source trace ID, and source observation ID.
10. One archived dataset item that must not become a holdout eval by default.
11. One dataset version timestamp to prove reproducible fixture selection.
12. One invalid observation payload that triggers a loss-report row without sample values.

## Normalization Targets

Trace rows:

- `source.system = langfuse`
- `source.trace_id = trace.id`
- `source.source_row_id = trace.id` for trace root rows
- `identity.user_hash` from user ID using tenant salt
- `identity.session_hash` from session ID using tenant salt
- `routing.tags` from Langfuse tags
- `routing.environment` from Langfuse environment

Observation rows:

- `source.trace_id = observation.traceId`
- `source.span_id = observation.id`
- `source.parent_span_id = observation.parentObservationId`
- `kind = generation | span | event` from Langfuse observation type
- `timestamps.started_at = startTime`
- `timestamps.ended_at = endTime`
- `input.messages` when `input` parses to a messages object
- `output.message` or `output.text` when `output` parses as assistant message or text
- `metrics.model = providedModelName || model`
- `metrics.prompt_tokens`, `completion_tokens`, `total_tokens` from usage details
- `metrics.cost_usd` from total cost
- `metrics.latency_us` from latency seconds
- `metrics.first_token_latency_us` from time-to-first-token seconds

Score rows:

- Use `kolm-score-1`
- Preserve Langfuse score ID, name, type, value, string value, comment, config ID, trace ID, observation ID, session ID, and dataset run ID
- Require score-map for categorical labels before any eval-selection use
- Never set K-score directly from a Langfuse score

Dataset item rows:

- Map input and expected output to `kolm-evalcase-1`
- Preserve source trace ID and source observation ID in sidecar metadata, not embedded artifact evals
- Preserve dataset name, item ID, item status, metadata, and version timestamp in manifest
- Exclude archived/deleted items from holdout evals by default

Manifest:

- `spec = kolm-import-manifest-1`
- source system, export refs, source checksum, row checksums
- privacy mode and retention
- counts by trace, observation, score, dataset item, eval case, blocked row, and loss row
- non-purgeable artifact list starts empty for fixture-only import

## Loss Rules

The importer must report, not silently drop:

- observation `input` or `output` that cannot be parsed as JSON when parse mode expects JSON,
- unknown Langfuse score data type,
- numeric score without known direction or threshold,
- categorical score without score-map,
- text score incorrectly requested for eval selection,
- dataset item with missing expected output,
- archived or deleted dataset item skipped from holdout selection,
- observation type that is not generation when `--eval-source generations-only` is used,
- raw field blocked by selected privacy mode,
- identity fields hashed or dropped.

Loss report defaults to field paths and counts only. No raw sample values unless raw mode is explicitly selected.

## First Acceptance Criteria

The fixture-only importer is ready when it can prove:

1. All fixture source rows either produce normalized rows or explicit loss rows.
2. Generation observation chat messages are preserved structurally, not flattened only.
3. Usage, cost, latency, model, environment, user/session hashes, and tags survive normalization.
4. Score types are preserved and score-map failures fail closed.
5. Dataset items produce eval cases only when expected output is present and status allows it.
6. Source trace and observation IDs remain in manifest/sidecar metadata, not artifact eval bodies.
7. Privacy mode changes output shape deterministically.
8. Manifest counts match normalized rows, eval cases, scores, and loss rows.
9. Dry-run purge over the manifest enumerates all imported rows and sidecars.
10. No K-score field is produced by the importer.

## Recommended Next Backlog

After this spec, the next research/implementation slice should create fixture examples and JSON schema drafts under a non-production fixture path. Product code should still wait until the fixtures lock the contract.

