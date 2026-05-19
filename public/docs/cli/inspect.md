---
title: kolm inspect · kolm.ai
description: Show what a .kolm artifact is in plain text. Manifest, recipes, signature.
---

# kolm inspect

> Show what a .kolm artifact is in plain text. Passive read of the manifest. No chain replay, no secret needed.

## Usage

```bash
kolm inspect <artifact.kolm>          # human-readable summary
kolm inspect <artifact.kolm> --json   # full manifest dump
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--json` | off | full manifest dump (recipe names, pack/index keys, signature mode, etc.) |

## Examples

```bash
kolm inspect redactor.kolm
kolm inspect redactor.kolm --json | jq '.k_score'
```

## Notes

Text mode is the default. `--json` keeps the old behavior for scripts that parse the full manifest.

`inspect` is a passive read of the artifact's manifest. For active chain verification (recompute CID, replay HMAC audit chain, check signatures and K-score gate) use [`kolm verify`](/docs/cli/verify) instead.

## See also

- [Quickstart](/quickstart)
- [kolm verify](/docs/cli/verify) for the 7-check audit
- [kolm explain](/docs/cli/explain) for plain-English description
- [kolm artifacts](/docs/cli/artifacts) for the cloud-side list / show / diff
