---
title: kolm bench · kolm.ai
description: Reproducible benchmark for a .kolm artifact or a public reproducer suite.
---

# kolm bench

> Reproducible artifact benchmark. Alias: `kolm benchmark`. Three modes: artifact-local, public reproducer, head-to-head vs an LLM.

## Usage

```bash
kolm bench <artifact.kolm> [flags] # artifact-local benchmark JSON
kolm bench --reproduce <suite> [flags] # public-reproducer suite (Docker)
kolm bench --compare <artifact.kolm> [flags] # head-to-head: kolm vs LLM
```

## Flags

### Artifact mode

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--runs <n>` | `1` | runs per embedded eval case |
| `--input '<json|string>'` | none | fallback input when the artifact has no evals |
| `--target <name>` | none | target label for the report |
| `--device <name>` | none | device label for the report |
| `--out <file>` | stdout | also write the JSON report to a file |
| `--json` | on | emit JSON to stdout |

### Compare mode

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--corpus <jsonl>` | none | external corpus, one `{input,output}` per line (`{prompt,completion}` legacy accepted) |
| `--runs <n>` | `5` | runs per case |
| `--llm-sample <n>` | `min(20, |corpus|)` | cap LLM paths to first N cases |
| `--md <file>` | none | write Markdown report |
| `--json <file>` | none | write JSON report |
| `--input '<json|string>'` | none | single ad-hoc input when no `--corpus` and no embedded evals |

Environment for compare mode: `ANTHROPIC_API_KEY` (required for llm-api path), `KOLM_BENCH_LLM_MODEL` (default `claude-haiku-4-5`), `KOLM_BENCH_LLM_INPUT_RATE`, `KOLM_BENCH_LLM_OUTPUT_RATE`, `KOLM_BENCH_LOCAL_LLM_URL` (default `http://127.0.0.1:11434`), `KOLM_BENCH_LOCAL_LLM_MODEL` (default `llama3.2:1b`).

### Reproduce mode

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--reproduce <suite>` | none | public reproducer. Available: `swebench-lite-n150` |
| `--seed <n>` | per-suite (e.g. 42) | seed |
| `--n <n>` | per-suite (e.g. 150) | sample size |
| `--out <file>` | `~/.kolm/bench/<suite>/report.json` | report path |
| `--dry-run` | off | print the plan; do not pull or run docker |
| `--api-key <key>` | none | override `ANTHROPIC_API_KEY` for the spawned container |

## Examples

```bash
kolm bench redactor.kolm --runs 5 --out report.json
kolm bench --compare redactor.kolm --corpus holdout.jsonl --md report.md
kolm bench --reproduce swebench-lite-n150 --api-key $ANTHROPIC_API_KEY
```

## Notes

The artifact-mode report follows the `kolm-benchmark-1` spec. It includes `k_score`, `evals.accuracy`, `latency_us.p50`, `latency_us.p95`, `privacy.runtime_egress_attempts`, `integrity.signature_valid`. The harness patches `fetch / http / https / net / tls / dns` at the process boundary - egress attempts are recorded and blocked.

Reproducer mode runs in a pinned Docker image so the evaluator and dataset versions are byte-identical to the published numbers. You bring your own `ANTHROPIC_API_KEY`; the harness mounts it into the container only.

Exit codes (reproduce mode): `0` succeeded, `1` bad args, `2` prerequisite missing.

## See also

- [Methodology](/articles/how-we-benchmark)
- [Quickstart](/quickstart)
- [API reference](/docs/api)
