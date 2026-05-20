---
title: kolm jobs · kolm.ai
description: List, show, and prune the local job registry.
---

# kolm jobs

> List, show, and prune the local job registry at `~/.kolm/jobs/`. Records every long-running CLI verb.

## Usage

```bash
kolm jobs # alias for: kolm jobs list
kolm jobs list [--json]
kolm jobs <id> [--json]
kolm jobs prune
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | machine-readable JSON |

## Output

The list view shows one row per job:

```
<job-id> <kind> <status> <age> <log-path>
job_018a3e9c compile completed 2h ~/.kolm/jobs/job_018a3e9c/log
```

Kinds: `compile`, `distill`, `quantize`, `sync`, `runtime-build`.

Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`.

The detail view (`kolm jobs <id>`) prints the job header plus the last 8 KiB of the log:

```
# job_018a3e9c (compile, completed)
# log: ~/.kolm/jobs/job_018a3e9c/log
# pid: 42813
# meta: {"name":"redactor","namespace":"phi"}
---
... last 8 KiB of log ...
```

## Examples

```bash
kolm jobs list
kolm jobs job_018a3e9c
kolm jobs list --json | jq '.[] | select(.status=="failed")'

# drop completed jobs older than 7 days
kolm jobs prune
```

## Notes

`prune` drops every job whose `updated_at` is older than 7 days. The active (running) jobs are never pruned.

## See also

- [Quickstart](/quickstart)
- [kolm watch](/docs/cli/watch) for live log tailing
- [kolm logs](/docs/cli/logs) for the local run history
