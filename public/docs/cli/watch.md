---
title: kolm watch · kolm.ai
description: Tail a job log file with rotation-safe follow semantics.
---

# kolm watch

> Tail a job log file with follow semantics. Rotation-safe: if the log gets truncated or rotated, the reader resets to byte 0 and streams from the new beginning.

## Usage

```bash
kolm watch <job-id> [--interval-ms 1000]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--interval-ms <n>` | `1000` | poll interval in milliseconds |

## Examples

```bash
kolm watch job_018a3e9c
kolm watch job_018a3e9c --interval-ms 250
```

## Notes

The watch loop stops when the job reaches a terminal state (`completed`, `failed`, `cancelled`) and the log has been fully drained.

Rotation guard: if the log file is now smaller than the last read offset, the file was rotated (logrotate, truncate, or the job restarted and wrote a fresh file). The reader resets to 0 and streams from the new beginning. Without this guard, a log-rotated job silently stops streaming.

Ctrl+C is honored cleanly: the SIGINT handler stops the loop without leaving a half-open file descriptor.

## See also

- [Quickstart](/quickstart)
- [kolm jobs](/docs/cli/jobs)
- [kolm tail](/docs/cli/tail) for the live capture-stream feed
