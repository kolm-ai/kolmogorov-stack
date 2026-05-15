# External Score Normalization Audit - 2026-05-13

## Bottom Line

External scores should become trace evidence, eval-selection signals, rubric hints, and source-system write-back context. They should not become Kolm K-score directly.

K-score is an artifact property. It is recomputed from artifact bytes, embedded eval cases, runtime latency, size, cost, and coverage. Langfuse scores, LangSmith feedback, Braintrust scores, Phoenix evaluator output, Weave scorer results, and human annotations are source evidence. They can decide which rows become eval cases and how cases are weighted, but the final artifact must pass its own portable evals.

## Current Local Truth

`src/artifact.js` computes `k-score-1` from accuracy, size, latency, cost, and coverage. Accuracy and coverage are clamped to `[0..1]`; size, latency, and cost are normalized by formula; the ship gate is `0.85`.

`src/compile.js` builds `rs-1-evals` from positive examples. It stores `input`, `expected`, and coverage from synthesis pass rate. There is no slot for external scorer provenance, score direction, thresholds, source evaluator IDs, or human review comments.

`src/artifact-runner.js` recomputes artifact eval accuracy by deep equality against embedded expected output. It does not run rubrics, LLM judges, weighted cases, partial credit, categorical scorer maps, or source feedback.

`src/benchmark.js` reports K-score, eval pass counts, latency, egress, and receipt integrity, but it does not join back to source scores or original trace cost.

## Proposed `kolm-score-1` Normalized Object

The `scores[]` array on `kolm-trace-1` should use this shape:

```json
{
  "spec": "kolm-score-1",
  "source_system": "langfuse",
  "source_id": "score-id",
  "attached_to": {
    "trace_id": "source-trace-id",
    "span_id": "source-observation-or-run-id",
    "dataset_run_id": null
  },
  "name": "correctness",
  "type": "numeric",
  "value_raw": 0.9,
  "value_numeric": 0.9,
  "label": null,
  "direction": "higher_is_better",
  "min": 0,
  "max": 1,
  "threshold": 0.8,
  "passed": true,
  "comment": "optional scorer reasoning",
  "scorer": {
    "kind": "human | llm | code | user | unknown",
    "ref": "source evaluator or feedback source",
    "version": null
  },
  "normalized": {
    "confidence": 0.9,
    "usable_for_eval_selection": true,
    "usable_for_k_score": false
  }
}
```

## Normalization Rules

Boolean scores map to `passed=true|false`, `value_numeric=1|0`, and confidence `1` or `0`, unless the source exposes uncertainty.

Numeric scores require scale and direction. If a source score has no known range or direction, store it as raw evidence and mark `usable_for_eval_selection=false` until a score map is supplied.

Categorical scores require an explicit mapping. Safe default mappings can include `correct/pass/good/yes -> passed=true` and `incorrect/fail/bad/no -> passed=false`, but any other categories should require a user-provided map.

Text scores are comments or qualitative evidence. They should not produce pass/fail automatically.

Score direction must be explicit. Phoenix exposes direction as part of its Score object. Other sources often require score-config lookup or user mapping.

Scorer origin matters. Human, user-feedback, LLM-judge, code-check, and automated evaluator scores should be stored separately because they carry different reliability and audit meaning.

Aggregated scores should not create eval cases. Weave summary pass rates and means, Langfuse analytics, and dashboard aggregates are useful for importer manifests, not row-level artifact evals.

## K-Score Guardrail

External scores may affect:

- which traces become train/test/holdout rows,
- which expected outputs are trusted enough to embed,
- eval case weights,
- rubric text,
- candidate prioritization,
- importer loss reports,
- source-system write-back.

External scores may not directly set:

- manifest `k_score.accuracy`,
- manifest `k_score.coverage`,
- `receipt.eval_score`,
- artifact ship gate,
- public benchmark pass rate.

Those values must come from running the artifact against embedded or generated eval cases and recording the resulting benchmark/receipt evidence.

## Source-Specific Notes

Langfuse scores support numeric, categorical, boolean, and text types. They attach to traces, observations, sessions, or dataset runs, and include names, values, data types, and comments. Kolm should preserve the attachment target and score type.

LangSmith feedback stores key, score, value, comment, feedback source, session ID, and run ID. This maps cleanly to `name`, `value_numeric`, `label`, `comment`, `scorer.kind`, and source attachment fields.

Braintrust stores scores on project logs, experiments, and inserted events; BTQL can query and export rows with scores. Kolm should map each score key to a normalized score object and keep the original scores map.

Phoenix Score objects include name, kind, direction, optional numeric score, optional label, optional explanation, and metadata. Phoenix should be the template for requiring `direction`.

Weave evaluation export returns per-row model output, scorer results, resolved dataset inputs, and aggregate scorer stats. Row-level scores should map into `scores[]`; summary pass rates and means should map to importer manifests only.

Helicone datasets and OpenPipe exports are primarily data/export surfaces rather than score systems. Their curation, split, cost, and token fields should affect selection and accounting, not score normalization unless separate score metadata exists.

## Required Fixtures

1. Langfuse numeric, boolean, categorical, and text score examples.
2. LangSmith feedback with numeric score, categorical value, comment, and feedback source.
3. Braintrust event with multiple score keys.
4. Phoenix score with direction, label, explanation, and metadata.
5. Weave eval row with scorer results and row digest.
6. Aggregated Weave/Langfuse summary that is rejected for row-level eval generation.
7. Unknown categorical score that fails without a user score map.
8. Numeric score with missing direction that imports as evidence but cannot select evals.

## Implementation Recommendation

Add a `score-map` layer before importer code becomes API-backed:

```json
{
  "correctness": {
    "type": "numeric",
    "min": 0,
    "max": 1,
    "direction": "higher_is_better",
    "threshold": 0.8,
    "eval_use": "select_holdout"
  },
  "verdict": {
    "type": "categorical",
    "map": {
      "correct": true,
      "incorrect": false
    },
    "eval_use": "select_holdout"
  }
}
```

The importer should emit a loss report for every score it cannot normalize. Unknown scores remain in `scores[]` as raw evidence, but they must not influence eval selection or artifact gates.

