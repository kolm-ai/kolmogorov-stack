---
title: kolm logs · kolm.ai
description: Tail the local run-history log.
---

# kolm logs

> Tail the local run-history log at `~/.kolm/logs/runs.jsonl`. Append-only. No cloud egress. No PII in the body.

## Usage

```bash
kolm logs [--limit n] [--artifact <name|path>] [--since 7d|24h|10m] [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--limit <n>` | `50` | maximum rows to print |
| `--artifact <name|path>` | none | filter by artifact |
| `--since <window>` | none | only rows newer than the window. `7d`, `24h`, `10m`, etc. |
| `--json` | off | machine-readable JSONL |

## Examples

```bash
kolm logs --limit 20
kolm logs --artifact redactor.kolm --since 24h
kolm logs --json | jq '.[] | select(.k_composite < 0.85)'
```

## Notes

Each row records: timestamp, command (`run|bench|mcp`), artifact, recipe, latency, K-score composite, success. The log is append-only at `~/.kolm/logs/runs.jsonl`; no cloud egress, no PII in the body.

## See also

- [Quickstart](/quickstart)
- [kolm jobs](/docs/cli/jobs)
- [kolm watch](/docs/cli/watch)
