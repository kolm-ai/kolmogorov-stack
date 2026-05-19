---
title: kolm list · kolm.ai
description: Show every local .kolm artifact.
---

# kolm list

> Show every local .kolm artifact. Alias: `kolm ls`.

## Usage

```bash
kolm list [--json]
```

## Scan order

| Directory | Source |
| --------- | ------ |
| `~/.kolm/artifacts/` | global. Where `kolm compile` writes by default |
| `./.kolm/artifacts/` | project-scoped (when a `kolm.yaml` sits at cwd) |
| `./` | current dir. Picks up `kolm build` outputs |

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | machine-readable array |

## Examples

```bash
kolm list
kolm list --json | jq '.[] | {name, k_score: .k_score.composite}'
```

## Notes

Default output is a table: name, K-score, size, age, source. `--json` is what CI and agents read.

## See also

- [Quickstart](/quickstart)
- [kolm inspect](/docs/cli/inspect)
- [kolm artifacts](/docs/cli/artifacts) for the cloud list
