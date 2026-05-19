---
title: kolm fix · kolm.ai
description: Auto-iterate on a failing artifact. Surface failing cases and suggest seed fixes.
---

# kolm fix

> Auto-iterate on a failing artifact. Re-runs the embedded evals, surfaces the top failing cases, and suggests seed rows that would address them.

## Usage

```bash
kolm fix <artifact.kolm> [--apply] [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--apply` | off | write `<basename>.fix-seeds.jsonl` in cwd so you can re-compile against the fixed seeds |
| `--json` | off | structured envelope |

## Examples

```bash
kolm fix phi-redactor.kolm
kolm fix phi-redactor.kolm --apply
# now: edit phi-redactor.fix-seeds.jsonl and re-compile

kolm fix phi-redactor.kolm --json | jq '.failing[0]'
```

## Notes

Reads the artifact's evals, runs them, and ranks the failing cases by frequency. For each failing case, suggests one or more rows that would close the gap (input + observed correct expected). Use `--apply` to drop the suggestions into a JSONL you can feed back to [`kolm compile --examples`](/docs/cli/compile).

## See also

- [Quickstart](/quickstart)
- [kolm eval](/docs/cli/eval)
- [kolm compile](/docs/cli/compile)
- [kolm explain](/docs/cli/explain)
- [Troubleshooting](/docs/troubleshooting)
