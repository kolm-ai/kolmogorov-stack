---
title: kolm status · kolm.ai
description: One-line snapshot of where you are. No network.
---

# kolm status

> One-line snapshot of where you are. Local only. No network.

## Usage

```bash
kolm status [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | machine-readable JSON envelope |

## Prints

- kolm CLI version
- configured cloud base
- api-key fingerprint (prefix-10 + ellipsis + last-4, so screenshots don't leak the live token)
- count of active vs done jobs read from `~/.kolm/jobs/`

## Examples

```bash
kolm status
# kolm 7.x.y  base=https://kolm.ai  key=ks_018abcd...wxyz  jobs=1 active 3 done

kolm status --json | jq '{key: .key_fingerprint, jobs}'
```

## Exit codes

`0` always. Status is informational only. For cloud reachability use [`kolm doctor`](/docs/cli/doctor) or [`kolm whoami`](/docs/cli/whoami).

## See also

- [Quickstart](/quickstart)
- [kolm health](/docs/cli/health)
- [kolm whoami](/docs/cli/whoami)
- [Inspection verbs](/docs/cli/inspection)
