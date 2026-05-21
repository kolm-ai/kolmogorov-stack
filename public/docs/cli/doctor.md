---
title: kolm doctor - kolm.ai
description: Run environment, auth, cloud, hardware, and value-loop checks before sending real traffic.
---

# kolm doctor

Run environment, auth, cloud, hardware, and value-loop checks before sending real traffic.

## Usage

```bash
kolm doctor
kolm doctor --detect-hw [--json]
kolm doctor --loop [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--detect-hw` | off | Probe GPU and platform capabilities, then recommend a compile or runtime tier. |
| `--loop` | off | Run the value-loop smoke against capture, health, observations, distill, and replay. |
| `--json` | off | Emit a machine-readable report for CI or support bundles. |

## Checks

- config file and saved base URL
- API key shape and authenticated account reachability
- public health and readiness endpoints
- receipt secret availability
- Node.js 18 or newer
- optional Docker for reproducible benchmarks
- optional provider keys used by local examples
- project config and artifact inventory

## Exit Codes

| Code | Meaning |
| ---- | ------- |
| `0` | No blocking checks failed. |
| `1` | One or more required checks failed. |
| `3` | `--detect-hw` found no supported acceleration path. |

## Notes

Run `kolm doctor --loop` before routing production traffic. The report names the failing rung so the fix is explicit instead of buried in logs.
