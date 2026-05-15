# Trace/Eval Schema Spec - 2026-05-13

## Scope

This memo defines a proposed `kolm-trace-1` interchange row and derived `kolm-evalcase-1` eval case for importer work. It is a research artifact, not an implemented contract. The goal is to let Kolm ingest traces, datasets, and eval results from existing observability, gateway, and eval tools without losing provenance, privacy controls, tool-call structure, score evidence, or avoided-call accounting.

The immediate product sequence should be:

1. Add `kolm-trace-1` JSON schema and golden fixtures.
2. Build a Langfuse importer fixture first.
3. Add Helicone and OpenPipe JSONL importers.
4. Add LangSmith Parquet/SDK and Braintrust/Weave eval importers.
5. Add receipt write-back after import receipts exist.

## Current Kolm Shape

Kolm already has three partial data shapes:

- `observations` rows from `/v1/bridges/observe` and capture proxy calls. These preserve prompt, response, model, latency, cost, tenant, template hash, and timestamps, but not source trace hierarchy, scores, token counts, raw chat messages, tool calls, consent, data residency, or source-system write-back state.
- `rs-1-evals` inside `.kolm` artifacts. These store `cases[]` with `id`, `input`, `expected`, optional `params`, and coverage, but they do not preserve original trace IDs, source scores, split, user/session hashes, or score/rubric provenance.
- `kolm-benchmark-1` reports. These prove artifact behavior against embedded eval cases and report latency, egress, integrity, and K-score data, but they do not join back to external traces or original model costs.

There is also a local field drift worth fixing before importers land: capture rows use `corpus_namespace`, while the inbox and some bridge code read `namespace`. `kolm-trace-1` should use one `namespace` field and map legacy capture rows into it.

## Proposed `kolm-trace-1` Row

Required fields:

```json
{
  "spec": "kolm-trace-1",
  "row_id": "ktr_...",
  "source": {
    "system": "langfuse",
    "source_row_id": "trace-or-span-id",
    "trace_id": "optional-trace-id",
    "span_id": "optional-span-id",
    "parent_span_id": null,
    "project": "optional-project-or-dataset",
    "export_ref": "file-or-api-cursor",
    "imported_at": "2026-05-13T00:00:00.000Z"
  },
  "tenant": {
    "tenant_id": "internal-tenant-id",
    "namespace": "default"
  },
  "kind": "generation",
  "status": "success",
  "input": {},
  "output": {},
  "metrics": {},
  "privacy": {
    "redaction_state": "raw",
    "consent_basis": "customer-import",
    "retention_days": null
  },
  "proof": {
    "source_checksum": "sha256:...",
    "row_checksum": "sha256:..."
  }
}
```

Recommended optional fields:

```json
{
  "timestamps": {
    "created_at": "2026-05-13T00:00:00.000Z",
    "started_at": null,
    "ended_at": null,
    "first_token_at": null
  },
  "input": {
    "prompt": "flattened text when available",
    "messages": [],
    "variables": {},
    "tools": [],
    "tool_choice": null,
    "raw_ref": null,
    "hash": "sha256:..."
  },
  "output": {
    "text": "assistant text when available",
    "message": null,
    "tool_calls": [],
    "raw_ref": null,
    "error": null,
    "hash": "sha256:..."
  },
  "expected": {
    "output": null,
    "rubric": null,
    "source": null,
    "reference_id": null
  },
  "scores": [
    {
      "name": "correctness",
      "type": "boolean",
      "value": true,
      "passed": true,
      "comment": null,
      "scorer_ref": "source scorer id",
      "source_id": "source score id"
    }
  ],
  "metrics": {
    "provider": "openai",
    "model": "gpt-4o",
    "latency_us": 1200000,
    "prompt_tokens": 100,
    "completion_tokens": 30,
    "total_tokens": 130,
    "cost_usd": 0.0012,
    "first_token_latency_us": null
  },
  "identity": {
    "user_hash": null,
    "session_hash": null,
    "thread_id": null
  },
  "privacy": {
    "redaction_state": "raw | redacted | hash-only | blocked",
    "consent_basis": "customer-import | explicit-user-consent | synthetic | unknown",
    "data_residency": null,
    "pii_flags": [],
    "retention_days": null,
    "raw_payload_ref": null
  },
  "routing": {
    "tags": [],
    "environment": null,
    "split": "train | test | validation | holdout | unknown",
    "weight": 1,
    "negative": false
  },
  "writeback": {
    "state": "none | pending | written | failed",
    "target_ref": null,
    "artifact_id": null,
    "receipt_id": null
  }
}
```

## Derived `kolm-evalcase-1`

Importer output should not feed artifact evals directly. It should derive a smaller eval case object, because a source trace row can contain extra data that should not be embedded in a portable artifact.

```json
{
  "spec": "kolm-evalcase-1",
  "id": "case_...",
  "input": {},
  "expected": {},
  "params": {},
  "rubric": null,
  "source_trace_ids": ["ktr_..."],
  "source_systems": ["langfuse"],
  "scores": [],
  "split": "test",
  "weight": 1,
  "privacy": {
    "redaction_state": "redacted",
    "raw_payload_ref": null
  }
}
```

Only `input`, `expected`, and optional `params` should be eligible for `rs-1-evals` embedding. Source IDs, scores, row hashes, and privacy metadata should be kept in an importer manifest or receipt sidecar so artifact evals stay portable and low-risk.

## Field Decisions

`input.messages` is first-class. OpenPipe and Helicone export chat messages, LangSmith run inputs often contain message arrays, and Langfuse observations can include generation inputs. Flattened `prompt` is a compatibility field, not the canonical representation.

`output.message` and `output.tool_calls` are first-class. Tool-call rows are important compile candidates and must not be flattened into lossy assistant text.

`scores[]` is separate from `expected`. A score proves how a source system judged a row; it is not necessarily the expected output for future evals.

`source.trace_id`, `source.span_id`, and `source.parent_span_id` are required when available. LangSmith and Phoenix are hierarchical span systems, and losing hierarchy prevents agent/tool-call compilation later.

`proof.row_checksum` should be computed over canonical JSON after normalization. `proof.source_checksum` should be computed over the raw imported record or file slice when available.

Raw payloads should default to out-of-band storage. Store `raw_payload_ref` plus checksums rather than embedding every source export body into the normalized row.

## Source Mapping Summary

Langfuse maps well to `source`, `input`, `output`, `scores`, `metrics`, `tags`, and dataset references. Its SDK/API surface exposes traces, observations, scores, datasets, metrics, filters, and pagination.

LangSmith maps strongly to trace hierarchy and cost/token metrics. Its run format has IDs, inputs, outputs, trace IDs, parent IDs, tags, status, token counts, costs, first-token timing, feedback stats, and dataset references. Bulk export is Parquet and plan-gated, so initial fixtures should use SDK/query mode before bulk export support.

Braintrust maps strongly to eval evidence. BTQL can export project logs, experiments, and datasets to JSON or Parquet, and queries can select scores and trace metadata.

Helicone maps strongly to request/dataset rows. Dataset exports include JSONL for fine-tuning and CSV for analysis, with request IDs, timestamps, model, token counts, cost, user messages, and assistant responses.

Phoenix maps strongly to OpenInference-style traces and imported/exported spans. The importer should preserve trace/span hierarchy even when only a subset becomes eval cases.

Weave maps strongly to eval runs. Its evaluation API returns evaluation runs, predictions, resolved dataset inputs, scorer results, summaries, and row digests.

OpenPipe maps strongly to chat fine-tuning rows. Its exported JSONL includes messages, tools, tool choice, and split, which must remain structured.

LiteLLM, Vercel AI SDK, Cloudflare AI Gateway, and Portkey should be treated as capture/routing sources rather than historical import sources until the schema and capture endpoint can accept full chat/tool metadata.

## First Fixture Set

The first fixture suite should include:

1. Langfuse trace with one generation observation and one numeric score.
2. Langfuse dataset item converted to a `kolm-evalcase-1`.
3. Helicone JSONL chat row with cost and token metadata.
4. OpenPipe JSONL row with tool calls and `split`.
5. LangSmith run row with parent/child IDs, token counts, cost, and feedback stats.
6. Weave evaluation result row with `row_digest`, resolved dataset input, model output, and scorer values.
7. Local Kolm observation row showing `corpus_namespace` mapped into `tenant.namespace`.
8. Local `rs-1-evals` case showing what is safe to embed in `.kolm`.

## Critical Risks

The highest-risk mistake is flattening every external source into `{input, output}`. That would discard the exact fields competitors use for value: scores, feedback, run hierarchy, token/cost accounting, tool calls, dataset splits, and row digests.

The second highest-risk mistake is importing raw traces without an explicit privacy state. Production traces may include regulated data. Every importer command should require a mode such as `raw`, `redacted`, or `hash-only`, record the mode on every row, and keep raw payload references out of portable artifacts by default.

The third highest-risk mistake is treating imported source scores as K-score directly. Source scores should inform eval selection and rubric confidence, but K-score should still be recomputed from embedded eval cases and artifact runs.

## Recommended Next Implementation

Add `schemas/kolm-trace-1.schema.json` and `schemas/kolm-evalcase-1.schema.json`, then add fixtures under a dedicated importer fixture directory. After that, implement `kolm import langfuse --fixture <file> --out <jsonl>` as a local-only transformation that emits normalized JSONL plus a manifest. Do not call external APIs in the first PR; use the fixture importer to lock field names and loss rules first.

