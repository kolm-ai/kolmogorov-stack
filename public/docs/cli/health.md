---
title: kolm health - kolm.ai
description: Ping the configured cloud base, readiness gate, and authenticated capture health.
---

# kolm health

> Ping the configured cloud base, readiness gate, and authenticated capture health. Useful for liveness checks and production smoke gates in CI, cron, or shell scripts.

## Usage

```bash
kolm health [--json] [--require-ready] [--require-auth] [--require-capture] [--slow-ms <N>] [--timeout-ms <N>]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--slow-ms <n>` | `2000` | RTT threshold above which the run exits 2 |
| `--timeout-ms <n>` | `max(slow+500, 5000)` | abort RTT |
| `--json` | off | emit a structured report |
| `--require-ready` | off | require `{base}/ready` to return 2xx |
| `--require-auth` | off | require the saved API key to validate via `/v1/account` |
| `--require-capture` | off | require `/v1/capture/health` to return 2xx with `durable:true` |

## Examples

```bash
kolm health
kolm health --json
kolm health --require-ready --json
kolm health --require-ready --require-auth --require-capture --json
kolm health --slow-ms 1000 --timeout-ms 4000
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | healthy: `{base}/health` returned 2xx within `--slow-ms` |
| `1` | down, still initializing, auth failed, or capture unhealthy when the matching `--require-*` flag is set |
| `2` | slow: reachable but RTT exceeded `--slow-ms`. CI can alarm on this |

## Notes

Default mode is a public liveness check: it reports `/health`, `/ready`, and `/v1/capture/health` but only fails on `/health` down or slow. Add `--require-ready` for production dependency readiness. Add `--require-auth --require-capture` when the CI job has a real tenant key and must prove authenticated capture durability.

## See also

- [Quickstart](/quickstart)
- [kolm status](/docs/cli/status)
- [kolm doctor](/docs/cli/doctor)
- [kolm loop](/docs/cli/loop)
- [Troubleshooting](/docs/troubleshooting)
