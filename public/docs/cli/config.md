# kolm config

Read and write CLI configuration at `~/.kolm/config.json`. The CLI reads
this file on every invocation to pick up the API key, base URL, and
active profile.

## Usage

```
kolm config get [key]              # print one key or the full document
kolm config set <key> <value>      # write one key
kolm config unset <key>            # remove one key
kolm config edit                   # open in $EDITOR
kolm config path                   # print the file path
```

## Common keys

- `base`: API base URL (default `https://kolm.ai`).
- `key`: API key. Prefer `kolm login` over manual edits.
- `profile`: name of the active profile (see `kolm profile`).
- `default_namespace`: namespace prefilled for capture verbs.
- `editor`: fallback editor when `$EDITOR` is unset.

## Environment overrides

Environment variables override config-file values for a single invocation:

- `KOLM_KEY` overrides `key`.
- `KOLM_BASE` overrides `base`.
- `KOLM_PROFILE` overrides `profile`.

## See also

- `kolm whoami` to inspect the resolved identity.
- `kolm profile` for multi-tenant config sets.
