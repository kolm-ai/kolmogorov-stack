# kolm.yaml schema, v1.0

STATUS: DRAFT, 2026-05-24. Wave: W820 (T2).

This document specifies the schema of `kolm.yaml`, the declarative file kolm
users place at the root of their repo to pin the inputs to the kolm distill
loop. `kolm.yaml` is the single source of truth that
`.github/workflows/kolm-template.yml` and the `kolm/distill-action@v1`
composite action read on every CI run.

The schema is the same one enforced by `src/kolm-yaml.js`
(`KOLM_YAML_VERSION = 'w732-v1'`). The parser is hand-rolled and supports a
strict YAML subset; flow style, anchors, tags, and block scalars are
explicitly rejected with snake_case error tokens.

## 1. File location

`kolm.yaml` MUST live at the root of the consuming repo. `kolm` walks up
from the current working directory looking for the first `kolm.yaml`, so
nested invocations from a subdirectory still find the root file. For
monorepos that need per-package configs, pass `--file path/to/kolm.yaml`
to `kolm yaml validate` and `kolm-yaml-path` to the composite action.

## 2. Required fields

| Field         | Type    | Description                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------ |
| `version`     | string  | Schema version. MUST equal `w732-v1` for the v1.0 schema.                                  |
| `namespaces`  | list    | Non-empty list of namespace declarations. Each entry MUST contain `name` and `teacher`.    |

### 2.1 `namespaces[]` entry

| Field          | Type    | Required | Description                                                                                            |
| -------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`         | string  | yes      | Namespace identifier matching `/^[a-z0-9][a-z0-9_-]{0,63}$/i`.                                         |
| `teacher`      | string  | yes      | Teacher model id (e.g. `claude-sonnet-4-6`, `gpt-4o-mini`, `claude-opus-4-7`).                         |
| `student`      | string  | no       | Student architecture id (e.g. `qwen2.5-7b-int4`). When omitted, kolm picks per workload.               |
| `min_captures` | integer | no       | Minimum captures the namespace must collect before a distill run is allowed.                           |

## 3. Optional fields

| Field            | Type    | Description                                                                                       |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `quality_gates`  | mapping | Per-axis gates a freshly compiled `.kolm` must clear before promotion. See section 3.1.           |
| `re_distill`     | mapping | Re-distill policy: when to trigger, when to back off. See section 3.2.                            |
| `publish`        | mapping | Publish policy: where to push the `.kolm` after a successful build. See section 3.3.              |
| `eval_set`       | mapping | Pin to a held-out eval set. See section 3.4.                                                      |
| `guardrails`     | list    | Per-input/output redaction or refusal patterns. Validated by `src/guardrails.js` (W736).          |

### 3.1 `quality_gates` (optional)

```yaml
quality_gates:
  min_kscore: 0.85
  max_cost_per_call_usd: 0.001
  block_on_regression: true
```

| Field                    | Type    | Range     | Description                                                            |
| ------------------------ | ------- | --------- | ---------------------------------------------------------------------- |
| `min_kscore`             | number  | [0, 1]    | The K-Score the artifact must meet or exceed.                          |
| `max_cost_per_call_usd`  | number  | >= 0      | Maximum per-call cost in USD; gates artifacts that are too expensive.  |
| `block_on_regression`    | boolean | —         | If true, fail the gate when the new K-Score is below the prior one.    |

### 3.2 `re_distill` (optional)

```yaml
re_distill:
  on_drop_below: 0.85
  cooldown_hours: 24
  max_per_week: 3
```

| Field             | Type    | Description                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `on_drop_below`   | number  | If measured K-Score < this value, trigger a re-distill.                           |
| `cooldown_hours`  | integer | Minimum hours between consecutive distill runs.                                   |
| `max_per_week`    | integer | Cap on distill runs per rolling 7-day window. Defends teacher budget.             |

### 3.3 `publish` (optional)

```yaml
publish:
  github_release: true
  marketplace: false
  s3_bucket: ''
```

| Field             | Type    | Description                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `github_release`  | boolean | If true and the workflow runs on a release event, attach the `.kolm` as an asset. |
| `marketplace`     | boolean | If true, publish the `.kolm` to the kolm marketplace post-build.                  |
| `s3_bucket`       | string  | Optional S3 bucket to upload the `.kolm` to (uses runner-side AWS creds).         |

### 3.4 `eval_set` (optional)

```yaml
eval_set:
  ref: holdouts/support-bot-v3.jsonl
  pinned_sha256: 0123...
```

| Field           | Type    | Description                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------------- |
| `ref`           | string  | Path inside the repo to the held-out eval set (JSONL).                            |
| `pinned_sha256` | string  | SHA-256 of the eval-set file; the runtime rejects drift.                          |

## 4. Validation

Run `kolm yaml validate` locally or `kolm yaml validate --json` in CI to lint
your `kolm.yaml`. The validator returns either:

```json
{ "ok": true }
```

or:

```json
{ "ok": false, "errors": [
  { "path": "namespaces[0].name",     "error": "must_match_namespace_pattern" },
  { "path": "quality_gates.min_kscore","error": "must_be_between_0_and_1" }
] }
```

Each error is a jq-style path plus a snake_case error token. Paths nest as
`namespaces[0].name` so a CI annotation can point at the exact offending
line. Every error in the file is reported (not just the first) so a single
CI run shows the full repair list.

## 5. Example

A complete `kolm.yaml` for a single namespace with quality gates and an
eval-set pin lives at `docs/cookbook/kolm.yaml`. Copy that file to your
repo root and edit the namespace name + teacher to match your setup.

## 6. Compatibility

The schema is versioned via the `version` field. Future schema bumps will
follow the kolm format-versioning policy in `docs/spec/kolm-format-v1.0.md`
section 4 (semver; major bump = parser break; minor = optional fields;
patch = clarifications only).

`v1.0` consumers MUST set `version: w732-v1` exactly. Any other value
returns `must_equal_w732-v1` from the validator.
