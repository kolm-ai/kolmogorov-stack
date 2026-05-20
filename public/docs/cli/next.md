---
title: kolm next · kolm.ai
description: Recommended next action. 1-3 high-value verbs with the exact command to copy-paste.
---

# kolm next

> Recommended next action. Ranks 1-3 high-value verbs with the exact command to copy-paste.

## Usage

```bash
kolm next [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | structured ranked array |

## Examples

```bash
kolm next
# 1. kolm distill --namespace claims-router (1248 pairs ready, 1000 threshold cleared)
# 2. kolm watch job_018b1f (compile in progress)
# 3. kolm doctor --loop (5 rungs, ensure cloud reachable)

kolm next --json | jq '.[0]'
```

## Notes

Inspects the current state (artifacts, captures, jobs, config) and ranks: login, build first artifact, distill a ready namespace, watch a running job, run the value-loop smoke, install an MCP harness. The first recommendation is the highest-value action available given what kolm sees on disk.

## See also

- [Quickstart](/quickstart)
- [kolm what](/docs/cli/what)
- [kolm do](/docs/cli/do)
