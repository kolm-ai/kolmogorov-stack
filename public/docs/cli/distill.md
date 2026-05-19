---
title: kolm distill · kolm.ai
description: Auto-distill a captured namespace into a local LoRA via the kolm trainer bridge.
---

# kolm distill

> Auto-distill a captured namespace into a local LoRA via the kolm trainer bridge.

## Usage

```bash
kolm distill --namespace <n> [--base-model <name>] [--target <size>]

kolm distill --local-worker --spec <file> --seeds <file> --out <dir>
             [--mode stub|collect|full|doctor]
             [--teacher <vendor:model>] [--student-base <name>]
             [--teacher-version <string>]
             [--student-base-revision <commit-hash>]
             [--distillation-method lora|qlora|full-ft|prompt-distill]
             [--allow-unknown-student-base]
             [--split-seed N] [--redact phi|pci|multi|none|auto]
             [--no-redact]

kolm distill --local-worker --list-catalog
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--namespace <n>` | none | the namespace captured via `kolm capture` |
| `--base-model <name>` | `Qwen/Qwen2.5-3B-Instruct` | base model id |
| `--target <size>` | `phi-3-mini` | target artifact size |
| `--local-worker` | off | run the in-tree distill worker, no cloud bridge |
| `--spec <file>` | none | spec.json describing the recipe |
| `--seeds <file>` | none | jsonl seed pairs |
| `--out <dir>` | none | worker output dir (becomes `--distill-provenance` for `kolm compile`) |
| `--mode <m>` | `stub` | `stub|collect|full|doctor`. `full` requires the Python ML stack |
| `--teacher <vendor:model>` | none | e.g. `anthropic:claude-opus-4-7`, `openai:gpt-5`, `local:llama3.1-8b` |
| `--student-base <name>` | none | e.g. `qwen2.5-3b`, `phi-3.5-mini`, `llama-3.2-3b` |
| `--distillation-method <m>` | derived | `lora|qlora|full-ft|prompt-distill` |
| `--redact <class>` | `auto` | `none|phi|pci|multi|auto`. Auto reads `redact_class` from the spec |

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
# bridge path (after kolm capture has filled the namespace)
kolm distill --namespace tickets

# local-worker path with a cross-vendor teacher
kolm distill --local-worker \
  --spec phi.spec.json --seeds seeds.jsonl --out ./out \
  --teacher anthropic:claude-haiku-4-5-20251001 \
  --student-base qwen2.5-3b \
  --mode full --redact phi

# inspect the catalog
kolm distill --local-worker --list-catalog
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
