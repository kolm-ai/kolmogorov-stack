---
title: kolm team · kolm.ai
description: Multi-tenant workspace management. Create teams, invite members, manage roles.
---

# kolm team

> Multi-tenant workspace management. Create teams, invite members, manage roles, namespace cloud-sync.

## Usage

```bash
kolm team create   <name> [--seats N]
kolm team list
kolm team show     <slug>
kolm team invite   <slug> <email> [--role member|admin|viewer]
kolm team accept   <token>
kolm team members  <slug>
kolm team role     <slug> <tenant_id> <role>
kolm team remove   <slug> <tenant_id>
kolm team transfer <slug> <new_owner_tenant_id>
kolm team delete   <slug>
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--seats <n>` | plan default | seats reserved at create time |
| `--role <r>` | `member` | `member`, `admin`, or `viewer` |

## Examples

```bash
kolm team create acme-health --seats 12
kolm team invite acme-health alice@acme.com --role admin
kolm team accept inv_018a3e9c
kolm team members acme-health
kolm team role acme-health tnt_018b1f bob admin
```

## Notes

All forms require a logged-in session (`kolm login`). Teams own a namespace; team members can read each others' captures and publish artifacts into the team handle (see `kolm publish --team`).

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm publish](/docs/cli/publish)
- [Enterprise](/enterprise)
