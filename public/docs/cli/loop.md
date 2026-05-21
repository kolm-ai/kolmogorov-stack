---
title: kolm loop - kolm.ai
description: Run the value-loop smoke against local or configured cloud routing.
---

# kolm loop

Run the value-loop smoke against local or configured cloud routing. Five rungs are checked and the command exits green or red.

## Usage

```bash
kolm loop
kolm loop --json
kolm loop --remote
kolm loop --remote --json
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | Emit a structured report keyed by rung name. |
| `--remote` | off | Run the same rungs against the configured cloud base using the saved API key. |

## What It Checks

1. `capture/log` writes a durable receipt.
2. `capture/health` returns the driver and threshold contract.
3. `bridges/observations` exposes captured observations by namespace.
4. `distill/from-captures` builds a recipe from observations.
5. `replay` enforces the contract guard.

## Exit Codes

| Code | Meaning |
| ---- | ------- |
| `0` | Every rung passed. |
| `1` | At least one rung failed. Inspect the report for the failing rung. |

## Alias

`kolm doctor --loop` runs the same smoke path and accepts the same JSON and remote modes.
