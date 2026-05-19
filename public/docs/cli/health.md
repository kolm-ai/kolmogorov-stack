---
title: kolm health · kolm.ai
description: Ping the configured cloud base and report round-trip timing.
---

# kolm health

> Ping the configured cloud base and report round-trip timing. Useful for liveness checks in CI, cron, or shell scripts.

## Usage

```bash
kolm health [--json] [--slow-ms <N>] [--timeout-ms <N>]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--slow-ms <n>` | `2000` | RTT threshold above which the run exits 2 |
| `--timeout-ms <n>` | `max(slow+500, 5000)` | abort RTT |
| `--json` | off | emit a structured report |

## Examples

```bash
kolm health
kolm health --json
kolm health --slow-ms 1000 --timeout-ms 4000
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | healthy: `{base}/health` returned 2xx within `--slow-ms` |
| `1` | down: unreachable or non-2xx response |
| `2` | slow: reachable but RTT exceeded `--slow-ms`. CI can alarm on this |

## Notes

Probes `{base}/health` (unauthenticated) and `{base}/v1/capture/health`, reports round-trip ms, and whether the capture driver is durable. The same probe drives the live status badge on [/value-loop](/value-loop).

## See also

- [Quickstart](/quickstart)
- [kolm status](/docs/cli/status)
- [kolm doctor](/docs/cli/doctor)
- [kolm loop](/docs/cli/loop)
- [Troubleshooting](/docs/troubleshooting)
