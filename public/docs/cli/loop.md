---
title: kolm loop · kolm.ai
description: Run the value-loop smoke against an in-process router. Five rungs, green or red.
---

# kolm loop

> Run the value-loop smoke against an in-process router. Five rungs. Green or red.

## Usage

```bash
kolm loop # human-readable [PASS]/[FAIL] rung table
kolm loop --json # structured report keyed by rung name
kolm loop --remote # walk the same rungs against your configured cloud
kolm loop --remote --json # remote run, JSON output
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | structured report keyed by rung name |
| `--remote` | off | walk the same rungs against your configured cloud base using your saved api_key |

## What it does

Boots `buildRouter()` in-process with a fresh anon tenant (or, with `--remote`, hits the base URL in `~/.kolm/config.json` using your saved api_key) and walks five rungs:

1. **capture/log** - `POST /v1/capture/log` (durable receipt check)
2. **capture/health** - `GET /v1/capture/health` (driver + thresholds shape)
3. **bridges/observations** - `GET /v1/bridges/observations?namespace=`
4. **distill/from-captures** - `POST /v1/distill/from-captures` (mode=recipe)
5. **replay** - `POST /v1/replay` (contract guard 400)

## Next steps (printed on green)

Five copy-pasteable verbs that move you from "loop works" to "loop works on my traffic":

- `kolm proxy`
- `kolm tail captures`
- `kolm distill`
- `kolm replay`
- [https://kolm.ai/value-loop](/value-loop)

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | every rung is green |
| `1` | at least one rung failed. Inspect the report for which one |

## Alias

Equivalent to `kolm doctor --loop` with the same `--remote / --json` flags.

## See also

- [Quickstart](/quickstart)
- [kolm doctor](/docs/cli/doctor)
- [kolm health](/docs/cli/health)
- [Value loop](/value-loop)
- [Troubleshooting](/docs/troubleshooting)
