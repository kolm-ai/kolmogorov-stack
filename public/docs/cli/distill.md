---
title: kolm distill · kolm.ai
description: Auto-distill a captured namespace into a local student artifact via the kolm trainer bridge.
---

# kolm distill

> Auto-distill a captured namespace into a local student artifact via the kolm trainer bridge.

## Usage

```bash
# Capture-driven distillation (the common path)
kolm distill --from-captures --namespace <n> [--base-model <name>] [--target <size>]

# Multi-teacher council (W718): per-capture best-of with attribution
kolm distill --teachers <a,b,c> --weights <auto|equal|domain> --namespace <n> [--base-model <name>]

# W711-W719 advanced recipes (mix-and-match with --from-captures)
kolm distill --from-captures --namespace <n> --importance-weighted              # W711
kolm distill --from-captures --namespace <n> --progressive                      # W712
kolm distill --from-captures --namespace <n> --reasoning-trace-loss-weight 0.5  # W713
kolm distill --from-captures --namespace <n> --contrastive                      # W714
kolm distill --from-captures --namespace <n> --curriculum                       # W717
kolm distill --from-captures --namespace <n> --auto-arch                        # W716 TAAS
kolm distill --from-captures --namespace <n> --mixed-precision auto             # W719 DAQ

# Reinforcement-learning subverbs (W480)
kolm distill onpolicy   --namespace <n> [--grader <vendor:model>]
kolm distill preference --namespace <n>
kolm distill dpo        --namespace <n>
kolm distill simpo      --namespace <n>

# Attention / KV optimization subverbs
kolm distill sparse-attention --namespace <n>                                   # W721 TSAC
kolm distill itkv             --namespace <n>                                   # W722 importance-tiered KV

# Lower-level: spec/seeds local worker
kolm distill --local-worker --spec <file> --seeds <file> --out <dir>
 [--mode stub|collect|full|doctor]
 [--teacher <vendor:model>] [--student-base <name>]
 [--teacher-version <string>]
 [--student-base-revision <commit-hash>]
 [--distillation-method lora|qlora|full-ft|prompt-distill]
 [--allow-unknown-student-base]
 [--split-seed N] [--redact phi|pci|multi|none|auto]
 [--no-redact]

# Subverbs
kolm distill --local-worker --list-catalog
kolm distill strategy   [--task ...] [--simulate ...]
kolm distill efficiency [--namespace <n>]                                       # W787
kolm distill improve    [--namespace <n>]                                       # W720 self-improve
kolm distill runs       [--namespace <n>] [--limit N]                           # W455 history
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--namespace <n>` | none | the namespace captured via `kolm capture` |
| `--from-captures` | off | use captured (prompt, completion) pairs as training data |
| `--base-model <name>` | `Qwen/Qwen2.5-3B-Instruct` | base / student model id |
| `--target <size>` | `phi-3-mini` | target artifact size |
| `--teachers <csv>` | none | **W718** comma-list of teacher model ids (e.g. `claude-opus-4-7,gpt-4o,deepseek-v4-pro`). Requires `--weights`. |
| `--weights <m>` | none | **W718** teacher weighting: `auto` (per-capture best-of), `equal`, or `domain` (route by capture metadata) |
| `--importance-weighted` | off | **W711** weight training pairs by capture rarity / surprise score |
| `--progressive` | off | **W712** 3-pass curriculum: easy → medium → hard |
| `--curriculum` | off | **W717** sort training pairs by difficulty before SFT |
| `--contrastive` | off | **W714** add a contrastive loss term on positive / negative response pairs |
| `--auto-arch` | off | **W716** TAAS searches student-architecture + merge recipe |
| `--mixed-precision <m>` | off | **W719** DAQ: per-layer bit budget. Values: `auto`, `int4`, `int8`, `bitnet158` |
| `--reasoning-trace-loss-weight <w>` | `0.0` | **W713** weight ∈ [0,1] on the CE loss over `<think>...</think>` spans |
| `--no-cot` | off | **W713** force `response_only` mode (don't include reasoning trace) |
| `--mtp <N>` | off | **W722** multi-token-prediction student head (predict N tokens / step) |
| `--local-worker` | off | run the in-tree distill worker, no cloud bridge |
| `--spec <file>` | none | spec.json describing the recipe |
| `--seeds <file>` | none | jsonl seed pairs |
| `--out <dir>` | none | worker output dir (becomes `--distill-provenance` for `kolm compile`) |
| `--mode <m>` | `stub` | `stub|collect|full|doctor`. `full` requires the Python ML stack |
| `--teacher <vendor:model>` | none | (local-worker path) e.g. `anthropic:claude-opus-4-7`, `openai:gpt-5`, `local:llama3.1-8b` |
| `--student-base <name>` | none | (local-worker path) e.g. `qwen2.5-3b`, `phi-3.5-mini`, `llama-3.2-3b` |
| `--distillation-method <m>` | derived | `lora|qlora|full-ft|prompt-distill` |
| `--grader <vendor:model>` | teacher | (onpolicy) the scorer for student rollouts |
| `--redact <class>` | `auto` | `none|phi|pci|multi|auto`. Auto reads `redact_class` from the spec |
| `--detach` | off | run the distill in a background session; `kolm resume <id>` to follow logs |

## Redact classes

| Class | Behavior |
| ----- | -------- |
| `none` | no redactor; teacher sees raw input. Required only for known-clean corpora |
| `phi` | HIPAA Safe Harbor: 18 identifiers + 3 kolm extensions (NPI, DEA, Medicaid ID). Receipt chain captures `redaction_map_hash`, `teacher_call_log_hash`, `reinjection_log_hash` |
| `pci` | payment-card masking profile |
| `multi` | `phi` + `pci` combined |
| `auto` | choose based on the spec's declared `redact_class` field |

## Examples

```bash
# Simple capture-driven distill (after kolm capture has filled the namespace)
kolm distill --from-captures --namespace tickets --base-model Qwen/Qwen2.5-7B-Instruct

# W718 Teacher Council: three teachers, per-capture best-of, attribution preserved
kolm distill --teachers claude-opus-4-7,gpt-4o,deepseek-v4-pro --weights auto \
  --namespace support --base-model Qwen/Qwen2.5-14B-Instruct

# W713 Reasoning-trace distill: student inherits the <think> spans, not just the answer
kolm distill --from-captures --namespace math \
  --base-model Qwen/Qwen2.5-7B-Instruct \
  --reasoning-trace-loss-weight 0.5

# W480 On-policy: student rolls out, an external grader scores, only positives flow back
kolm distill onpolicy --namespace support --grader anthropic:claude-opus-4-7 \
  --base-model Qwen/Qwen2.5-7B-Instruct

# W711 + W712 + W717 stacked: importance-weighted + progressive + curriculum
kolm distill --from-captures --namespace support \
  --importance-weighted --progressive --curriculum

# W716 TAAS: search student architecture and merge recipe
kolm distill --from-captures --namespace support --auto-arch

# W719 DAQ: mixed-precision auto-budget (heavy layers FP16, attention INT4, embedding INT8)
kolm distill --from-captures --namespace support --mixed-precision auto

# Background run (detach + watch)
kolm distill --from-captures --namespace support --detach
kolm resume <session-id>

# Lower-level local-worker path with explicit teacher / student / spec
kolm distill --local-worker \
 --spec phi.spec.json --seeds seeds.jsonl --out ./out \
 --teacher anthropic:claude-haiku-4-5-20251001 \
 --student-base qwen2.5-3b \
 --mode full --redact phi

# Inspect the catalog
kolm distill --local-worker --list-catalog

# Distill history (W455)
kolm distill runs --namespace support --limit 20
```

## Notes

Receipt chain captures `teacher_vendor`, `teacher_model`, `teacher_version`, `student_base`, `student_base_repo`, `student_base_origin`, `student_base_license`, `student_base_revision`, `distillation_method`. Verifier check #15 confirms the full set is present whenever `lineage.source='distillation'`.

Exit codes:

- `0` job started; the .kolm artifact lands in `~/.kolm/artifacts/` when done.
- `2` trainer bridge not configured on this kolm cloud (hosted-only feature).
- `3` not enough captured pairs yet (default threshold: 1000).

If the bridge is unavailable, run `kolm labels --namespace <n> --out corpus.jsonl` and train locally with the on-prem trainer, or run the local worker directly via `--local-worker`.

## See also

- [Quickstart](/quickstart)
- [kolm capture](/docs/cli/capture)
- [kolm compile](/docs/cli/compile)
- [API reference](/docs/api)
- [Distillation guide](/docs/distillation)
