---
title: kolm sync · kolm.ai
description: Cloud-sync state and legacy git-mirror push / pull.
---

# kolm sync

> Cloud-sync state and a legacy git-mirror push / pull. The cloud-sync subverbs (`status`, `enable`, `disable`) drive the modern cloud-sync path; passing a git URL falls back to the legacy bundle pusher.

## Usage

```bash
# cloud-sync (W384)
kolm sync status
kolm sync enable  [--state <s>] [--base <url>] [--namespace <ns>] [--block <cls>]
kolm sync disable
kolm sync push                    # uses cloud-sync once enabled
kolm sync pull

# legacy git-mirror
kolm sync push <git-url> [--branch main] [--bundle <dir>]
kolm sync pull <git-url> [--branch main] [--bundle <dir>]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--state <s>` | `enabled` | cloud-sync state |
| `--base <url>` | configured base | override the sync endpoint |
| `--namespace <ns>` | `default` | scope the sync to one namespace |
| `--block <cls>` | none | block a privacy-membrane class (e.g. `phi`) from cross-sync |
| `--branch <b>` | `main` | git branch for legacy mirror |
| `--bundle <dir>` | `./.kolm-bundle` | working dir for the legacy mirror |

## Examples

```bash
kolm sync status
kolm sync enable --namespace claims-router --block phi
kolm sync push
kolm sync disable

# legacy git mirror
kolm sync push git@github.com:acme/kolm-artifacts.git --branch main
```

## Notes

Cloud-sync routes through `src/cloud-sync.js`. State, namespace scope, and privacy-membrane blocks live in `~/.kolm/sync.json`.

The legacy git-mirror path uses `spawnSync('git', ...)` only - no new dependencies. Honest failure modes: missing git, no remote, non-clean working copy. The bundle dir holds the artifact, manifest, and receipt-chain files; each `push` commits the diff and force-pushes to the named branch.

## See also

- [Quickstart](/quickstart)
- [Cloud sync](/docs/cloud-sync)
- [Team](/docs/cli/team)
