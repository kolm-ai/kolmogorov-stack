---
title: kolm profile · kolm.ai
description: Multi-tenant config switcher. Save and activate per-tenant kolm settings.
---

# kolm profile

> Multi-tenant config switcher. Each profile carries `{url, key_id, tenant_id, base_model, default_target}` and lives at `~/.kolm/profiles/<name>.json`. The active profile is recorded at `~/.kolm/active-profile`.

## Usage

```bash
kolm profile list # default when no subverb
kolm profile save <name> [--base-model M] [--default-target T]
kolm profile use <name>
kolm profile show [<name>]
kolm profile delete <name>
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--base-model <m>` | none | base model id captured into the profile |
| `--default-target <t>` | none | default target hardware |

## Environment

| Env var | Description |
| ------- | ----------- |
| `KOLM_PROFILE` | name of the active profile |
| `KOLM_URL` | cloud endpoint captured into the profile on save |
| `KOLM_KEY_ID` | api key id captured on save |
| `KOLM_TENANT_ID` | tenant id captured on save |
| `KOLM_PROFILE_DIR` | override `~/.kolm/profiles/` (used by tests) |

## Examples

```bash
# capture the current env as a profile
KOLM_URL=https://kolm.ai KOLM_KEY_ID=ks_018 kolm profile save acme-prod

# activate it
kolm profile use acme-prod

# inspect
kolm profile show
kolm profile list

# enter the profile in your shell
export $(kolm profile show acme-prod --env | xargs)
```

## Notes

`save` writes the JSON; `use` rewrites the active-profile sentinel. Subsequent commands read it via `KOLM_PROFILE` env var or the active-profile file. Deleting the active profile clears the sentinel as well.

## See also

- [Quickstart](/quickstart)
- [kolm config](/docs/cli/config)
- [kolm whoami](/docs/cli/whoami)
- [Team](/docs/cli/team)
