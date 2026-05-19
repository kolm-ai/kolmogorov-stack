---
title: kolm doctor · kolm.ai
description: Sanity-check the environment. Detect GPU. Run the value-loop smoke.
---

# kolm doctor

> Sanity-check the environment. Detect GPU. Run the value-loop smoke.

## Usage

```bash
kolm doctor
kolm doctor --detect-hw [--json]
kolm doctor --loop      [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--detect-hw` | off | probe GPU via `nvidia-smi` / `system_profiler`; recommend a tier. Exit 0 on detection, 3 on no GPU |
| `--loop` | off | run the value-loop smoke (capture/log, capture/health, bridges/observations, distill/from-captures, replay) in-process against a fresh anon tenant |
| `--json` | off | machine-readable output |

## Checks (default mode)

- config file
- api key
- cloud reachability
- receipt secret
- node >= 18
- docker (optional, for `kolm bench --reproduce`)
- `ANTHROPIC_API_KEY` (optional)
- project config (`kolm.yaml`)
- project + global artifact counts

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | no blockers (warnings allowed) |
| `1` | one or more required checks failed |
| `3` | `--detect-hw` found no GPU |

## Examples

```bash
kolm doctor
kolm doctor --detect-hw
kolm doctor --loop --json | jq '.rungs'
```

## Notes

New install? Run `kolm doctor --loop` before pointing real traffic at kolm. Each rung either passes or fails and the report lists the offender. Equivalent to `kolm loop`.

## See also

- [Quickstart](/quickstart)
- [kolm loop](/docs/cli/loop)
- [kolm health](/docs/cli/health)
- [Troubleshooting](/docs/troubleshooting)
