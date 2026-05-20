---
title: kolm artifacts · kolm.ai
description: List, show, and diff compiled .kolm artifacts in your tenant.
---

# kolm artifacts

> List, show, and diff compiled .kolm artifacts in your tenant. Hits `GET /v1/artifacts` (list) and `GET /v1/artifacts/:id` (show).

## Usage

```bash
kolm artifacts # alias for: kolm artifacts list
kolm artifacts list [--limit N] [--json]
kolm artifacts show <id> [--json]
kolm artifacts diff <a> <b> [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--limit <n>` | `50` | max rows in list. Max `200` |
| `--json` | off | machine-readable JSON |

## Examples

```bash
kolm artifacts list
kolm artifacts list --limit 200 --json
kolm artifacts show art_018b1f
kolm artifacts diff art_018a3e art_018b1f
```

## Diff output

Field-level differences across `recipe_class`, `base_model`, `k_score`, `k_score_composite`, `status`, `size_bytes`, `cid`, `created_at`. Same-value rows are suppressed unless `--json` is passed.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | ok |
| `1` | not logged in (no `api_key` in `~/.kolm/config.json` or `KOLM_API_KEY` env) |
| `2` | network or HTTP error |

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm list](/docs/cli/list) for the local artifact scan
- [kolm verify](/docs/cli/verify) for the receipt-chain audit
- [Inspection verbs](/docs/cli/inspection) for the consolidated read-only set
