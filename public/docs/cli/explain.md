---
title: kolm explain · kolm.ai
description: Plain-English description of a .kolm artifact.
---

# kolm explain

> Plain-English description of a .kolm artifact. What it does, what trained it, the base model, and the recipe summary.

## Usage

```bash
kolm explain <artifact.kolm> [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | structured envelope |

## Prints

- Task description from the manifest
- Training corpus stats: rows, holdout count, K-score, comparator
- Base model + tokenizer + size
- `production_ready` flag
- Recipe summary (id, name, source size in lines)

## Examples

```bash
kolm explain phi-redactor.kolm
kolm explain phi-redactor.kolm --json | jq '.k_score'
```

## Notes

Read-only. Same artifact bytes you would feed to [`kolm inspect`](/docs/cli/inspect) and [`kolm verify`](/docs/cli/verify). The output is a human-readable narration; reach for `--json` only when scripting.

## See also

- [Quickstart](/quickstart)
- [kolm inspect](/docs/cli/inspect)
- [kolm verify](/docs/cli/verify)
- [kolm fix](/docs/cli/fix)
