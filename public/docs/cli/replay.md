---
title: kolm replay · kolm.ai
description: Replay captured prompts against a compiled artifact and report per-row diffs.
---

# kolm replay

> Replay captured prompts from the durable capture store against a compiled artifact. Emits per-row diff (upstream vs local) with jaccard K-score, latency-delta, and cost-delta.

## Usage

```bash
# cloud replay (W216)
kolm replay <concept_or_version_id> [--namespace ns] [--limit N] [--preview] [--json]
kolm replay --concept-id <id> [--namespace ns] [--limit N]
kolm replay --version-id <ver_...> [--namespace ns] [--limit N]

# local replay (W371)
kolm replay trace <trace_id> --against <artifact|model> [--json]
kolm replay namespace <namespace> --against <artifact|model> [--limit N] [--json]
kolm replay dataset <dataset_id> --against <artifact|model> [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--namespace <n>` | `default` | which captured namespace to replay |
| `--limit <n>` | server default | cap replay row count |
| `--concept-id <id>` | inferred | force concept id resolution |
| `--version-id <ver_...>` | inferred | force version id (those starting `ver_`) |
| `--preview` | off | hit `GET /v1/replay/preview`. No replay execution; just count + plan |
| `--against <ref>` | required (local) | `.kolm` path or model id |
| `--stub-model` | off | use deterministic stub-model for local replays without `KOLM_LLM_PROVIDER` |
| `--json` | off | structured output |

## Examples

```bash
kolm replay phi-redactor --namespace claims-router --limit 50
kolm replay --version-id ver_018b1f --preview
kolm replay trace trc_018a3e --against redactor.kolm
kolm replay namespace claims-router --against gpt-4o-mini --limit 100
kolm replay dataset ds_018a3e --against ./redactor.kolm --json
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | replay completed |
| `2` | bad args |
| `3` | artifact not found |
| `5` | network error |

503 with `error: capture_store_unavailable` means the durable capture store is initializing or unreachable. See [Troubleshooting](/docs/troubleshooting).

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm capture](/docs/cli/capture)
- [kolm distill](/docs/cli/distill)
- [Captures](/captures)
