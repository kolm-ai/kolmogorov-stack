---
title: kolm labels · kolm.ai
description: Download a captured namespace corpus as JSONL or JSON.
---

# kolm labels

> Download the captured corpus for a namespace as JSONL or JSON.

## Usage

```bash
kolm labels [--namespace <n>] [--out <file>] [--format jsonl|json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--namespace <n>` | `default` | which namespace to dump |
| `--out <file>` | stdout | file path. Stdout when omitted |
| `--format <jsonl|json>` | `jsonl` | output format |

## Examples

```bash
kolm labels --namespace tickets --out tickets-corpus.jsonl
kolm labels --namespace tickets --format json | jq '.[0]'
```

## Notes

Use this when the trainer bridge is unavailable or when you want to inspect the raw corpus before distillation. The exported rows include `input`, `output`, captured timestamps, and any redaction labels applied by the privacy membrane.

## See also

- [Quickstart](/quickstart)
- [kolm capture](/docs/cli/capture)
- [kolm distill](/docs/cli/distill)
- [API reference](/docs/api)
