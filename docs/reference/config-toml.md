# kolm config reference (TOML)

> Wave W889-12.1. Canonical reference for `~/.kolm/config.toml`, the
> hierarchy resolver, environment variables, and the `kolm config`
> verbs that read and write it.

## Resolution hierarchy

Highest precedence wins. The resolver lives in
[`src/config.js`](../../src/config.js) → `loadConfig()`.

| order | source | mechanism |
|-------|--------|-----------|
| 1 (highest) | **flag** | dotted CLI flag, e.g. `--gateway.default_provider=openai` |
| 2 | **env** | `KOLM_<SECTION>_<KEY>`, e.g. `KOLM_GATEWAY_DEFAULT_PROVIDER` |
| 3 | **user TOML** | `~/.kolm/config.toml` |
| 4 | **project TOML** | `./kolm.toml` (walks up from cwd, stops at HOME) |
| 5 (lowest) | **defaults** | the `DEFAULTS` map in `src/config.js` |

`kolm config list` prints every key with its current value AND the source
label so you can debug "which layer won."

## File locations

| path | scope | written by |
|------|-------|------------|
| `~/.kolm/config.toml` | user | `kolm config set <key> <val>` (default scope) |
| `./kolm.toml` | project | `kolm config set <key> <val> --scope project` |
| `~/.kolm/config.json` | legacy | W067 era. One-shot migrated into the TOML on first read; the JSON file is left in place for back-compat with older CLI builds. |

Permissions: the user TOML is chmod 0600 on POSIX. Project TOML inherits
your repo's umask — never commit one with secrets.

## Verbs

```
kolm config list                      Print the merged hierarchy with sources.
kolm config get <section.key>         Print one value (and its source).
kolm config set <section.key> <val>   Write to ~/.kolm/config.toml (--scope project for ./kolm.toml).
kolm config unset <section.key>       Remove a key from the scope file.
kolm config edit                      Open the user TOML in $EDITOR (or vi).
kolm config show                      Legacy two-key view (base + api_key). Kept for back-compat.
```

All verbs accept `--json` (machine-readable envelope) and `--show-secrets`
(reveal redacted values). `--scope user|project` selects the target file
for `set` / `unset`.

## Schema

Every key below is defined in [`src/config.js`](../../src/config.js)
under `SCHEMA`. Anything not listed will be **silently dropped** by
`kolm config set` with a clear error message; this is intentional — typos
must fail loud.

### `[account]`

| key | type | secret | description |
|-----|------|--------|-------------|
| `api_key` | string | yes | kolm bearer key (`ks_...`). Also readable from `KOLM_API_KEY`. |
| `plan` | string | no | Plan slug surfaced by the server (free / indie / pro / team / business / enterprise). |
| `tenant_id` | string | no | Tenant id (`tenant_...`). |

### `[gateway]`

| key | type | default | description |
|-----|------|---------|-------------|
| `default_provider` | string | `openai` | Primary upstream provider. |
| `fallback_providers` | array<string> | `["anthropic", "openai"]` | Ordered fallback list. |
| `pii_mode` | string | `mask` | One of `off` / `mask` / `hash` / `drop`. |
| `capture_rate` | number | `1.0` | Sampling rate 0..1. |

### `[compile]`

| key | type | default | description |
|-----|------|---------|-------------|
| `default_target` | string | `gguf-q4km` | One of `gguf-q4km` / `onnx` / `mlx` / `safetensors`. |
| `kscore_gate` | number | `0.85` | Minimum K-Score before an artifact is promotable. |
| `progressive_passes` | number | `1` | Number of distill passes (1..3). |
| `teacher_council` | array<string> | `[]` | Teacher model ids (e.g. `claude-4.7`, `gpt-5`, `deepseek-v3`). |

### `[serve]`

| key | type | default | description |
|-----|------|---------|-------------|
| `default_port` | number | `8765` | Default port for `kolm serve`. |
| `kv_cache` | string | `static` | One of `shard` / `static` / `off`. |
| `auto_detect` | boolean | `true` | Auto-detect runtime + hardware on serve. |

### `[cloud]`

| key | type | secret | description |
|-----|------|--------|-------------|
| `provider` | string | no | One of `runpod` / `modal` / `lambda` / `vast`. |
| `api_key` | string | yes | Cloud provider API key. |
| `default_gpu` | string | no | Preferred GPU SKU, e.g. `a100-40gb`. |

### `[storage]`

| key | type | secret | description |
|-----|------|--------|-------------|
| `type` | string | no | One of `sqlite` (default) / `postgres` / `s3`. |
| `path` | string | no | Local artifact / capture path. Defaults to `~/.kolm/artifacts`. |
| `postgres_url` | string | yes | Postgres DSN (full URL incl. password). |
| `s3_bucket` | string | no | S3 bucket name. |
| `s3_region` | string | no | S3 region. |
| `s3_endpoint` | string | no | S3-compatible endpoint URL (for R2 / MinIO). |

### `[devices]`

| key | type | description |
|-----|------|-------------|
| `ssh_key_default` | string | Default SSH key path for `kolm deploy` / `kolm devices add --type ssh`. |

### `[telemetry]`

| key | type | default | description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Opt-in anonymised usage pings. |
| `endpoint` | string | `null` | Telemetry collector URL (override for self-hosted). |

## Environment variables

Every schema key has a paired env var. The mapping is
`KOLM_<SECTION>_<KEY>` (all caps, underscores). Examples:

```
gateway.default_provider   <-->  KOLM_GATEWAY_DEFAULT_PROVIDER
storage.s3_endpoint        <-->  KOLM_STORAGE_S3_ENDPOINT
account.api_key            <-->  KOLM_API_KEY            (legacy short name preserved)
```

A few legacy env vars are mirrored for back-compat — these win at the
env layer regardless of section name:

| legacy env var | maps to |
|----------------|---------|
| `KOLM_API_KEY` | `account.api_key` |
| `KOLM_BASE` / `KOLM_BASE_URL` | base URL (not in TOML; resolved per-call) |

Coercion: env-var values are strings on the wire. The resolver coerces
to the schema's declared type (number / boolean / array — comma-split).
Booleans accept `1/true/yes/on` (true) and `0/false/no/off/empty`
(false).

## Secret handling

Any key with `secret: true` in the schema, plus any key whose name
matches `/_key|password|secret|token|dsn|connection_string$/i`, is
**redacted** in `kolm config list` and `kolm config get` output. Pass
`--show-secrets` to reveal. The redactor returns `first6...last4` when
the value is ≥16 chars, else `***`.

## Example: production gateway with S3 capture

```toml
# ~/.kolm/config.toml

[account]
api_key  = "ks_4b7bc3b..."
plan     = "team"
tenant_id = "tenant_f33c240034c5"

[gateway]
default_provider   = "anthropic"
fallback_providers = ["openai", "deepseek"]
pii_mode           = "hash"
capture_rate       = 0.5

[compile]
default_target  = "gguf-q4km"
kscore_gate     = 0.90
teacher_council = ["claude-4.7", "gpt-5", "deepseek-v3"]

[storage]
type        = "s3"
s3_bucket   = "kolm-captures-prod"
s3_region   = "us-east-1"
s3_endpoint = "https://s3.amazonaws.com"

[telemetry]
enabled = false
```

## Example: project override committed to git

`./kolm.toml` lives at your project root and is picked up automatically
(walks up from cwd, stops at HOME). Commit this when team members need a
shared default. Never put secrets here.

```toml
# ./kolm.toml  (committed)

[compile]
default_target = "gguf-q5km"
kscore_gate    = 0.92

[gateway]
pii_mode = "drop"
```

## Migration from `~/.kolm/config.json`

When `loadConfig()` first runs and finds `~/.kolm/config.json` but no
`~/.kolm/config.toml`, it migrates the two W067 keys (`api_key`, `base`)
into the new TOML under `[account]` (api_key) and a comment-only trailer
for `base`. The legacy JSON file is left in place so older CLI builds
running concurrently still work.

You can force a re-migration by deleting `~/.kolm/config.toml` and
re-running any `kolm config` verb.

## Caveats

- The minimal in-tree TOML parser handles strings / numbers / booleans /
  string-arrays / single-level section headers. Inline tables, nested
  sections (`[a.b]`), datetimes, and multi-line strings are NOT
  supported. The full `@iarna/toml` parser is used when the dep is
  installed (declared in `package.json`).
- Arrays in higher-priority layers REPLACE arrays from lower layers —
  they do not concatenate. To extend, repeat the full list at the
  override layer.
- `kolm config set` validates against the schema. Setting an unknown
  key fails with `saveConfig: unknown key <section.key>` plus a hint
  pointing to this file.

## See also

- [`src/config.js`](../../src/config.js) — the resolver and TOML I/O.
- [`tests/wave888j-config.test.js`](../../tests/wave888j-config.test.js)
  — hierarchy lock-in tests.
- [`docs/spec-toml-reference.md`](../spec-toml-reference.md)
  — the OTHER TOML in the kolm stack (compile spec, not user config).
