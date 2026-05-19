# kolm whoami

Print the current authenticated identity, base URL, key fingerprint,
tenant, plan, and quota.

## Usage

```
kolm whoami
kolm whoami --json    # stable envelope: logged_in, base, cli_version,
                      # key_fingerprint, tenant{id,name,plan,quota,seats,email}
```

## Stable JSON envelope

```json
{
  "logged_in": true,
  "base": "https://kolm.ai",
  "cli_version": "11.x",
  "key_fingerprint": "kolm-XXXX...YYYY",
  "tenant": {
    "id": "tnt_...",
    "name": "Acme Health",
    "plan": "team",
    "quota": { "captures_per_month": 1000000, "compiles_per_month": 100 },
    "seats": 12,
    "email": "ops@acme.example"
  }
}
```

## Exit codes

- `0`: authenticated.
- `1`: not logged in or key rejected.
- `3`: `KOLM_KEY` env present but empty (CI safe-fail signal).

## See also

- `kolm login` to write `~/.kolm/config.json`.
- `kolm profile {save,use,list}` for multi-tenant switching.
- `kolm doctor` for a deeper environment check.
