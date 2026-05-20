---
title: kolm eval · kolm.ai
description: Re-run a .kolm's embedded eval set and show per-case pass / fail.
---

# kolm eval

> Re-run the artifact's embedded eval set and print this artifact's K-score plus the per-case breakdown.

K-score is per-artifact. Each .kolm has its own eval set and its own number. This command re-runs THIS artifact's evals and prints THIS artifact's pass / fail breakdown plus what each failing case got vs what was expected.

## Usage

```bash
kolm eval <artifact.kolm> [flags]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--examples <file>` | embedded | eval against a fresh JSONL of `{"input":..., "expected":...}` rows (also accepts `output` in place of `expected`). The embedded eval set is bypassed |
| `--trace` | off | show every failing case. Default is the first 5 |
| `--json` | off | emit the full machine-readable doc (used by CI / agents) |

## Examples

```bash
kolm eval my-redactor.kolm
kolm eval my-redactor.kolm --examples holdout.jsonl
kolm eval my-redactor.kolm --trace
kolm eval my-redactor.kolm --json > eval-report.json
```

## Notes

Use `--examples` to A/B an artifact against real holdout data without recompiling. The score reflects the new corpus; the embedded eval set is ignored for that run.

For an active 7-check audit (manifest signature, content identifier, Ed25519 receipt chain, receipt body signature, provenance credential, K-score gate, eval coverage) use [`kolm verify`](/docs/cli/verify) instead.

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [K-score methodology](/docs/k-score-methodology)
- [kolm compile](/docs/cli/compile)
