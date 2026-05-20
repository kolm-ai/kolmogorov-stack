---
title: kolm tune · kolm.ai
description: Evolve a local student artifact from skeleton to a promoted revision.
---

# kolm tune

> Evolve an artifact's local adapter from a skeleton LoRA into a living model. Init, capture, step, eval, promote.

## Usage

```bash
kolm tune init --artifact <art.kolm> --base <model_path_or_id> [--rank 8] [--alpha 16]
kolm tune capture-on --artifact <art.kolm>
kolm tune capture-off --artifact <art.kolm>
kolm tune step --artifact <art.kolm> [--epochs 1] [--airgap] [--batch-size 4] [--lr 2e-4]
kolm tune eval --artifact <art.kolm> [--rev vN]
kolm tune promote --artifact <art.kolm> --rev vN [--force]
kolm tune rollback --artifact <art.kolm>
kolm tune watch --artifact <art.kolm> [--interval 30000]
kolm tune status --artifact <art.kolm>
```

## Pipeline

| Verb | Effect |
| ---- | ------ |
| `init` | v0 skeleton (PEFT config, zero weights). Required first step |
| `capture-on` | every `kolm run` writes (input, output) to `captures.jsonl` |
| `step` | SFT on captures (Python: torch + peft + transformers). Writes `vN+1` |
| `eval` | recompute K-score for the candidate |
| `promote` | if K-score(vN) >= gate (default 0.85) AND >= current head, flip HEAD |
| `rollback` | restore the prior HEAD revision from `head.prev` |
| `watch` | daemon: when captures grow past threshold, auto step then eval then promote |

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--base <path|id>` | none | base model path or HuggingFace id (required for init) |
| `--rank <n>` | `8` | LoRA rank |
| `--alpha <n>` | `16` | LoRA alpha |
| `--epochs <n>` | `1` | training epochs |
| `--batch-size <n>` | `4` | training batch size |
| `--lr <rate>` | `2e-4` | learning rate |
| `--airgap` | off | sets `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, `HF_HUB_OFFLINE=1`. Refuses any `base_model` that is not a local path |
| `--rev vN` | latest | revision id |
| `--force` | off | promote even when K-score is below current head |
| `--interval <ms>` | `30000` | watch daemon poll interval |

## Examples

```bash
kolm tune init --artifact redactor.kolm --base ./qwen2.5-3b
kolm tune capture-on --artifact redactor.kolm
# ... your app runs the artifact in production for a while ...
kolm tune step --artifact redactor.kolm --epochs 2
kolm tune eval --artifact redactor.kolm
kolm tune promote --artifact redactor.kolm --rev v3
```

## Dependencies (for `step` only)

```bash
pip install 'torch>=2.2' 'transformers>=4.42' 'peft>=0.11' \
 'datasets>=2.18' 'accelerate>=0.30' 'trl>=0.9'
```

## See also

- [Quickstart](/quickstart)
- [kolm compile](/docs/cli/compile)
- [kolm distill](/docs/cli/distill)
- [Training guide](/docs/training)
