---
title: kolm what · kolm.ai
description: One-screen snapshot of where you are. Artifacts, captures, jobs, next steps.
---

# kolm what

> One-screen snapshot. Artifacts, captures, jobs, recommended next steps.

## Usage

```bash
kolm what [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | structured envelope |

## What it reads

- `~/.kolm/artifacts/` for local artifact count
- the local capture store for namespace counts
- `~/.kolm/jobs/` for running and recent jobs
- your config for tenant / base

## Examples

```bash
kolm what
# artifacts: 5  captures: 2348 (4 namespaces, 1 distill-ready)
# jobs: 1 running, 3 done
# next: kolm distill --namespace claims-router

kolm what --json
```

## Notes

The next-steps section ranks 1-3 high-value actions and prints the exact command to copy-paste. See [`kolm next`](/docs/cli/next) for the same logic surfaced standalone.

## See also

- [Quickstart](/quickstart)
- [kolm next](/docs/cli/next)
- [kolm do](/docs/cli/do)
- [kolm logs](/docs/cli/logs)
