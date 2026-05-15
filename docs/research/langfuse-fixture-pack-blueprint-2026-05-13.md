# Langfuse Fixture Pack Blueprint - 2026-05-13

## Scope

This blueprint turns the Langfuse importer fixture spec into concrete fixture-file contracts. It is still research-only. No importer code, product route, or public page should depend on these files until the fixture pack and validation harness are implemented.

The fixture pack should prove that Kolm can convert Langfuse traces, observations, scores, and dataset items into portable import rows without losing structure, leaking source identifiers into artifacts, or copying external scores into K-score.

## Source Facts To Preserve

Langfuse Observations API v2 returns observations for spans, generations, and events. It uses selectable field groups: `core`, `basic`, `time`, `io`, `metadata`, `model`, `usage`, `prompt`, and `metrics`. If fields are not specified, only `core` and `basic` are returned. It uses cursor pagination and returns input/output as strings unless JSON parsing is requested.

Langfuse datasets are collections of inputs and optional expected outputs. Dataset items can link back to source traces and source observations, datasets can be fetched at version timestamps, dataset item changes create new versions, and input or expected-output JSON schemas can validate dataset items.

Langfuse scores have a name, value, data type, and optional comment. Scores can attach to traces, observations, sessions, or dataset runs. The fixture pack must preserve those scores as `kolm-score-1` evidence, not as Kolm K-score.

## Proposed Directory

Use a single small but complete fixture directory first:

```text
docs/research/fixtures/langfuse/support-v1/
  traces.json
  observations-v2-page-1.json
  observations-v2-page-2.json
  scores.json
  datasets.json
  dataset-items.json
  dataset-run-items.json
  retention.json
  score-map.json
  expected.normalized.redacted.jsonl
  expected.evalcases.redacted.jsonl
  expected.manifest.redacted.json
  expected.loss-report.redacted.json
  expected.normalized.hash-only.jsonl
  expected.loss-report.hash-only.json
```

Do not add raw-mode expected outputs in the first pack. Raw mode should wait until redacted and hash-only behavior are locked.

## Source Fixture Records

### `traces.json`

```json
{
  "data": [
    {
      "id": "trc_support_001",
      "name": "support.refund_status",
      "timestamp": "2026-05-01T10:00:00.000Z",
      "userId": "user-42@example.test",
      "sessionId": "sess-support-007",
      "environment": "production",
      "tags": ["support", "refund"],
      "metadata": {
        "tenant": "acme-support",
        "channel": "chat",
        "ticketTier": "paid"
      }
    }
  ]
}
```

Expected behavior:

- `userId` and `sessionId` become tenant-salted hashes.
- `tags` and `environment` remain routing metadata.
- `tenant` may stay in manifest metadata only if the tenant boundary allows it.

### `observations-v2-page-1.json`

```json
{
  "data": [
    {
      "id": "obs_generation_001",
      "traceId": "trc_support_001",
      "parentObservationId": null,
      "type": "GENERATION",
      "name": "refund-answer",
      "startTime": "2026-05-01T10:00:01.000Z",
      "endTime": "2026-05-01T10:00:02.250Z",
      "completionStartTime": "2026-05-01T10:00:01.420Z",
      "environment": "production",
      "userId": "user-42@example.test",
      "sessionId": "sess-support-007",
      "input": "{\"messages\":[{\"role\":\"system\",\"content\":\"Answer support questions with account-safe detail.\"},{\"role\":\"user\",\"content\":\"Where is my refund?\"}]}",
      "output": "{\"role\":\"assistant\",\"content\":\"Your refund is still processing and should post within three business days.\"}",
      "metadata": {
        "route": "refund-status",
        "source": "chat-widget"
      },
      "providedModelName": "gpt-4o-mini",
      "model": "gpt-4o-mini-2026-04",
      "modelParameters": {
        "temperature": 0.2
      },
      "usageDetails": {
        "input": 41,
        "output": 18,
        "total": 59
      },
      "costDetails": {
        "input": 0.00000615,
        "output": 0.0000108,
        "total": 0.00001695
      },
      "totalCost": 0.00001695,
      "promptId": "pr_refund_v3",
      "promptName": "refund-status",
      "promptVersion": 3,
      "latency": 1.25,
      "timeToFirstToken": 0.42
    },
    {
      "id": "obs_tool_001",
      "traceId": "trc_support_001",
      "parentObservationId": "obs_generation_001",
      "type": "SPAN",
      "name": "lookup-refund-status",
      "startTime": "2026-05-01T10:00:01.050Z",
      "endTime": "2026-05-01T10:00:01.180Z",
      "input": "{\"ticketId\":\"redacted-ticket\"}",
      "output": "{\"status\":\"processing\"}",
      "metadata": {
        "system": "billing"
      }
    }
  ],
  "meta": {
    "cursor": "fixture-cursor-page-2"
  }
}
```

Expected behavior:

- `obs_generation_001` becomes a generation trace row and may seed an eval case only through the dataset item.
- `obs_tool_001` remains trace evidence and is skipped for `--eval-source generations-only`.
- `latency` and `timeToFirstToken` convert from seconds to microseconds.

### `observations-v2-page-2.json`

```json
{
  "data": [
    {
      "id": "obs_generation_invalid_io",
      "traceId": "trc_support_001",
      "parentObservationId": null,
      "type": "GENERATION",
      "name": "invalid-json-output",
      "startTime": "2026-05-01T10:00:03.000Z",
      "endTime": "2026-05-01T10:00:03.500Z",
      "input": "{\"messages\":[{\"role\":\"user\",\"content\":\"Can I cancel?\"}]}",
      "output": "{\"role\":\"assistant\",\"content\":\"Malformed fixture\"",
      "providedModelName": "gpt-4o-mini",
      "usageDetails": {
        "input": 12,
        "output": 5,
        "total": 17
      },
      "totalCost": 0.000004
    }
  ],
  "meta": {
    "cursor": null
  }
}
```

Expected behavior:

- The malformed `output` produces a loss row with path `observations[obs_generation_invalid_io].output`.
- The loss report does not include the malformed raw value in redacted or hash-only mode.
- Import completeness requires consuming page 2 and seeing `cursor: null`.

### `scores.json`

```json
{
  "data": [
    {
      "id": "score_numeric_001",
      "name": "correctness",
      "dataType": "NUMERIC",
      "value": 0.87,
      "comment": "Matches policy answer.",
      "configId": "cfg_correctness_0_1",
      "traceId": "trc_support_001",
      "observationId": "obs_generation_001"
    },
    {
      "id": "score_boolean_001",
      "name": "resolved",
      "dataType": "BOOLEAN",
      "value": true,
      "traceId": "trc_support_001"
    },
    {
      "id": "score_categorical_001",
      "name": "risk_label",
      "dataType": "CATEGORICAL",
      "stringValue": "low_risk",
      "observationId": "obs_generation_001"
    },
    {
      "id": "score_categorical_unmapped",
      "name": "tone_label",
      "dataType": "CATEGORICAL",
      "stringValue": "warm",
      "observationId": "obs_generation_001"
    },
    {
      "id": "score_text_001",
      "name": "review_note",
      "dataType": "TEXT",
      "stringValue": "Agent answer is concise but should mention card issuer delays.",
      "sessionId": "sess-support-007"
    }
  ]
}
```

Expected behavior:

- All score rows emit `kolm-score-1` evidence rows.
- `correctness` can be eligible for eval selection only because `score-map.json` defines scale, direction, and threshold.
- `tone_label` creates a score-map loss row because no categorical mapping exists.
- `review_note` is qualitative evidence only.
- No score row emits `k_score`, `eval_score`, or artifact score fields.

### `score-map.json`

```json
{
  "source": "langfuse",
  "maps": {
    "correctness": {
      "type": "numeric",
      "scale": {"min": 0, "max": 1},
      "direction": "higher_is_better",
      "threshold": 0.8,
      "eval_use": "selector"
    },
    "resolved": {
      "type": "boolean",
      "true_means": "pass",
      "eval_use": "evidence"
    },
    "risk_label": {
      "type": "categorical",
      "categories": {
        "low_risk": "pass",
        "high_risk": "fail"
      },
      "eval_use": "selector"
    }
  }
}
```

### `datasets.json`

```json
{
  "data": [
    {
      "id": "dataset_support_refunds",
      "name": "support/refund-evals",
      "description": "Support refund answer regression cases.",
      "metadata": {
        "owner": "support-quality"
      },
      "version": "2026-05-01T10:05:00.000Z",
      "inputSchema": {
        "type": "object",
        "required": ["messages"],
        "properties": {
          "messages": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["role", "content"],
              "properties": {
                "role": {"type": "string"},
                "content": {"type": "string"}
              }
            }
          }
        }
      },
      "expectedOutputSchema": {
        "type": "object",
        "required": ["response"],
        "properties": {
          "response": {"type": "string"}
        }
      }
    }
  ]
}
```

### `dataset-items.json`

```json
{
  "data": [
    {
      "id": "item_refund_001",
      "datasetId": "dataset_support_refunds",
      "datasetName": "support/refund-evals",
      "status": "ACTIVE",
      "input": {
        "messages": [
          {"role": "user", "content": "Where is my refund?"}
        ]
      },
      "expectedOutput": {
        "response": "Refund is processing and should post within three business days."
      },
      "metadata": {
        "priority": "holdout"
      },
      "sourceTraceId": "trc_support_001",
      "sourceObservationId": "obs_generation_001",
      "createdAt": "2026-05-01T10:04:00.000Z",
      "updatedAt": "2026-05-01T10:05:00.000Z"
    },
    {
      "id": "item_archived_001",
      "datasetId": "dataset_support_refunds",
      "datasetName": "support/refund-evals",
      "status": "ARCHIVED",
      "input": {
        "messages": [
          {"role": "user", "content": "Old refund wording?"}
        ]
      },
      "expectedOutput": {
        "response": "Old wording."
      },
      "sourceTraceId": "trc_support_001",
      "sourceObservationId": "obs_generation_001"
    },
    {
      "id": "item_missing_expected_001",
      "datasetId": "dataset_support_refunds",
      "datasetName": "support/refund-evals",
      "status": "ACTIVE",
      "input": {
        "messages": [
          {"role": "user", "content": "What if my bank delays the refund?"}
        ]
      },
      "sourceTraceId": "trc_support_001",
      "sourceObservationId": "obs_generation_001"
    }
  ],
  "version": "2026-05-01T10:05:00.000Z"
}
```

Expected behavior:

- `item_refund_001` emits one `kolm-evalcase-1` row.
- `item_archived_001` is skipped from holdout evals with a loss-report reason.
- `item_missing_expected_001` is not an eval case and creates a missing-expected-output loss row.
- `sourceTraceId` and `sourceObservationId` are kept in the manifest or sidecar only.

### `retention.json`

```json
{
  "source_system": "langfuse",
  "exported_at": "2026-05-01T10:06:00.000Z",
  "source_region": "cloud-us",
  "source_retention_days": 30,
  "kolm_retention_days": 30,
  "purge_after": "2026-05-31T10:06:00.000Z",
  "source_deletion_refs": {
    "trace_delete_supported": true,
    "project_delete_supported": true
  }
}
```

## Expected Output Contracts

### Redacted Normalized JSONL

`expected.normalized.redacted.jsonl` should include at least:

```jsonl
{"spec":"kolm-trace-1","row_id":"lf-trace-trc_support_001","source":{"system":"langfuse","trace_id":"trc_support_001","source_row_id":"trc_support_001"},"identity":{"user_hash":"sha256:tenant-salt:user-42","session_hash":"sha256:tenant-salt:sess-support-007"},"routing":{"tags":["support","refund"],"environment":"production"}}
{"spec":"kolm-trace-1","row_id":"lf-obs-obs_generation_001","source":{"system":"langfuse","trace_id":"trc_support_001","span_id":"obs_generation_001"},"kind":"generation","input":{"messages":[{"role":"system","content":"Answer support questions with account-safe detail."},{"role":"user","content":"Where is my refund?"}]},"output":{"message":{"role":"assistant","content":"Your refund is still processing and should post within three business days."}},"metrics":{"model":"gpt-4o-mini","prompt_tokens":41,"completion_tokens":18,"total_tokens":59,"cost_usd":0.00001695,"latency_us":1250000,"first_token_latency_us":420000}}
{"spec":"kolm-score-1","row_id":"lf-score-score_numeric_001","source":{"system":"langfuse","score_id":"score_numeric_001"},"name":"correctness","type":"numeric","value":0.87,"attachment":{"trace_id":"trc_support_001","observation_id":"obs_generation_001"},"eval_use":"selector"}
```

These examples show shape, not final checksums. The implemented fixture must compute canonical checksums from the exact source files.

### Redacted Evalcases JSONL

`expected.evalcases.redacted.jsonl` should include:

```jsonl
{"spec":"kolm-evalcase-1","case_id":"lf-dataset-item-item_refund_001","input":{"messages":[{"role":"user","content":"Where is my refund?"}]},"expected":{"response":"Refund is processing and should post within three business days."},"metadata":{"dataset":"support/refund-evals","priority":"holdout"}}
```

It must not include `sourceTraceId`, `sourceObservationId`, `trace_id`, direct user IDs, direct session IDs, or score IDs.

### Redacted Manifest JSON

`expected.manifest.redacted.json` must include:

```json
{
  "spec": "kolm-import-manifest-1",
  "manifest_id": "imp_langfuse_support_v1_redacted",
  "source": {
    "system": "langfuse",
    "fixture": "support-v1",
    "dataset_version": "2026-05-01T10:05:00.000Z"
  },
  "privacy": {
    "mode": "redacted",
    "retention_days": 30,
    "purge_after": "2026-05-31T10:06:00.000Z"
  },
  "counts": {
    "traces": 1,
    "observations": 3,
    "scores": 5,
    "datasets": 1,
    "dataset_items": 3,
    "eval_cases": 1,
    "loss_rows": 5
  },
  "purge_state": {
    "status": "active",
    "dry_run_available": true
  },
  "non_purgeable_artifacts": []
}
```

The implementation version must add real source checksums and row checksums.

### Redacted Loss Report JSON

`expected.loss-report.redacted.json` should contain these loss classes:

```json
{
  "manifest_id": "imp_langfuse_support_v1_redacted",
  "privacy_mode": "redacted",
  "losses": [
    {
      "code": "observation.output_parse_failed",
      "source_path": "observations[obs_generation_invalid_io].output",
      "count": 1,
      "sample_included": false
    },
    {
      "code": "observation.non_generation_skipped_for_eval",
      "source_path": "observations[obs_tool_001]",
      "count": 1,
      "sample_included": false
    },
    {
      "code": "score.categorical_map_missing",
      "source_path": "scores[score_categorical_unmapped]",
      "count": 1,
      "sample_included": false
    },
    {
      "code": "dataset_item.archived_skipped",
      "source_path": "datasetItems[item_archived_001]",
      "count": 1,
      "sample_included": false
    },
    {
      "code": "dataset_item.expected_output_missing",
      "source_path": "datasetItems[item_missing_expected_001].expectedOutput",
      "count": 1,
      "sample_included": false
    }
  ]
}
```

If the final expected count differs, the fixture harness must explain the change. The first implementation should prefer more explicit loss rows over silent drops.

## Acceptance Harness Requirements

The first validation harness should assert:

1. Both observation pages are consumed and the final cursor is null.
2. Field groups include IO, metadata, model, usage, prompt, and metrics.
3. Generation chat messages remain structured.
4. Non-generation observations are preserved as trace rows but skipped from evalcases.
5. Numeric, boolean, categorical, and text score rows are preserved as `kolm-score-1`.
6. Missing score maps fail closed.
7. Active dataset item with expected output becomes exactly one eval case.
8. Archived and missing-expected dataset items produce loss rows.
9. Redacted mode has no direct user ID, session ID, raw malformed output, or source trace IDs in artifact evalcases.
10. Hash-only mode drops IO payloads but keeps checksums and counts.
11. No imported row contains `k_score`, `eval_score`, or artifact score fields.
12. Manifest counts match source rows, normalized rows, evalcases, score rows, and loss rows.

## Implementation Sequence

1. Create the fixture files exactly once under a non-production fixture path.
2. Write a pure normalizer that accepts fixture files and produces expected outputs.
3. Add redacted-mode tests first.
4. Add hash-only-mode tests second.
5. Add purge dry-run expected output after manifest checks pass.
6. Only then add live Langfuse API fetch support.
