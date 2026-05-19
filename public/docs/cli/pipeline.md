---
title: kolm pipeline · kolm.ai
description: End-to-end compile pipeline. Tokenize, distill, compile, full.
---

# kolm pipeline

> End-to-end compile pipeline. Run the steps individually (`tokenize`, `distill`, `compile`) or the whole thing at once (`full`).

## Usage

```bash
kolm pipeline tokenize <corpus-file-or-text> [--vocab-size N] [--algorithm bpe|unigram|wordpiece]
kolm pipeline distill  --namespace <n> [--student-base <m>] [--mode kd_softmax|kd_top_k|rejection_sampling] [--max-steps N]
kolm pipeline compile  --namespace <n> [--strict] [--force] [--no-sign] [--no-install] [--install-target <id>]
kolm pipeline full     --namespace <n> [--strict] [--force] [--no-sign] [--k-target 0.85] [--max-steps 200] [--vocab-size 4000]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--vocab-size <n>` | `4000` | tokenizer vocab size |
| `--algorithm <a>` | `bpe` | `bpe`, `unigram`, or `wordpiece` |
| `--namespace <n>` | required | which captured namespace to compile |
| `--student-base <m>` | auto-pick | student model id |
| `--mode <m>` | `kd_softmax` | `kd_softmax`, `kd_top_k`, or `rejection_sampling` |
| `--max-steps <n>` | `200` | training step cap |
| `--k-target <f>` | `0.85` | K-score gate for the final compile |
| `--strict` | off | refuse to ship below `--k-target` |
| `--force` | off | ship even when production gates fail |
| `--no-sign` | off | skip sigstore signing |
| `--no-install` | off | skip the final install step |
| `--install-target <id>` | none | install onto a registered device after compile |
| `--json` | off | NDJSON event stream |

## Examples

```bash
# step by step
kolm pipeline tokenize ./corpus.txt --vocab-size 8000 --algorithm bpe
kolm pipeline distill  --namespace claims-router --mode kd_softmax --max-steps 500
kolm pipeline compile  --namespace claims-router --strict

# one shot
kolm pipeline full --namespace claims-router --k-target 0.92 --strict

# NDJSON stream for the TUI / wizard
kolm pipeline full --namespace claims-router --json
```

## Notes

`tokenize` writes a tokenizer.json under `~/.kolm/tokenizers/<hash>.json`. `distill` walks teacher captures and writes student weights under `~/.kolm/distill/<namespace>/`. `compile` rolls everything (tokenizer + student + receipts) into a single `.kolm`. `full` runs all three sequentially.

## See also

- [Quickstart](/quickstart)
- [kolm distill](/docs/cli/distill)
- [kolm compile](/docs/cli/compile)
- [Training guide](/docs/training)
