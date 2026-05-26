# Configuration Policy

Scope: every configurable value read by the kolm server, CLI, gateway, or
workers. This policy is the canonical reference enforced by the W890-7
sub-wave audit (ledger row in `KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md`
Part K-3) and the lock-in tests in `tests/wave890-7-configuration.test.js`.

Cross-references:

- [`docs/reference/config-toml.md`](./config-toml.md) — TOML schema, file
  paths, every section and key, `kolm config` verbs (W889-12.1).
- [`docs/reference/storage-policy.md`](./storage-policy.md) — storage type
  selection (sqlite / postgres / s3) and retention policy (W890-8).
- [`docs/reference/error-handling-policy.md`](./error-handling-policy.md) —
  redaction of secrets in error messages (W890-3).
- [`docs/reference/logging-policy.md`](./logging-policy.md) — redaction of
  secrets in structured logs (W890-4).

## Hierarchy

Highest precedence wins. Resolver lives in
[`src/config.js`](../../src/config.js) → `loadConfig({ flags, env, cwd })`.

| order | source | mechanism |
|-------|--------|-----------|
| 1 (highest) | **CLI flag** | dotted flag, e.g. `--gateway.default_provider=openai` |
| 2 | **environment variable** | `KOLM_<SECTION>_<KEY>`, e.g. `KOLM_GATEWAY_DEFAULT_PROVIDER` |
| 3 | **user TOML** | `~/.kolm/config.toml` |
| 4 | **project TOML** | `./kolm.toml` (walks up from cwd, stops at HOME) |
| 5 (lowest) | **default** | the `DEFAULTS` map in `src/config.js` |

`kolm config list` prints every key with its current value AND the source
label so you can debug "which layer won." End-to-end verification of all
five layers (plus a secondary-key trace) is the lock-in in
`data/w890-7-hierarchy.json`.

## Defaults

Every configurable value has a sensible default. The full TOML schema is in
[`docs/reference/config-toml.md`](./config-toml.md). At a glance:

| section | key | default | notes |
|---------|-----|---------|-------|
| `account` | `api_key` | `null` | explicit policy: expect `kolm login` or `kolm signup` |
| `gateway` | `default_provider` | `"openai"` | first try in the routing chain |
| `gateway` | `fallback_providers` | `["anthropic","openai"]` | tried in order |
| `gateway` | `pii_mode` | `"mask"` | redact PII by default |
| `gateway` | `capture_rate` | `1.0` | full capture |
| `compile` | `default_target` | `"gguf-q4km"` | INT4 quantize fits 5090 |
| `compile` | `kscore_gate` | `0.85` | minimum K-Score before promote |
| `serve` | `default_port` | `8765` | local daemon |
| `serve` | `kv_cache` | `"static"` | swap to `shard` for huge contexts |
| `serve` | `auto_detect` | `true` | runtime + hardware probe on serve |
| `storage` | `type` | `"sqlite"` | local capture store |
| `telemetry` | `enabled` | `false` | strict opt-in |

A `null` default means "no auto-fill; expect the user to set it before
the related verb runs." `kolm doctor` surfaces missing required values as
explicit warnings, not silent failures.

## Environment variables

Single source of truth: [`.env.example`](../../.env.example) at the repo
root.

### What's in `.env.example`

User-facing config that an operator must / may set when deploying:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_UPSTREAM_URL` — Anthropic
  pass-through.
- `OPENAI_UPSTREAM_URL` — OpenAI capture-proxy upstream.
- `PORT`, `HOST` — bind address.
- `KOLM_DATA_DIR`, `KOLM_ARTIFACT_DIR`, `KOLM_RECALL_ROOT`, `KOLM_DB_PATH` —
  storage paths.
- `KOLM_STORE_DRIVER`, `KOLM_ALLOW_JSON_STORE` — storage driver selection.
- `RECIPE_RECEIPT_SECRET`, `ADMIN_KEY` — required secrets in production.
- `STRIPE_PAYMENT_LINK_*`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` —
  billing.
- `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GITHUB_OAUTH_CLIENT_ID/SECRET`,
  `OAUTH_REDIRECT_BASE` — OAuth.
- `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` — transactional email.
- `KOLM_TRAINER_BRIDGE_URL`, `KOLM_TRAINER_BRIDGE_TOKEN` — auto-distill
  worker.
- `INVITE_ONLY`, `RATE_LIMIT_PER_SEC`, `RATE_LIMIT_BURST` — gating.
- `PUBLIC_BASE`, `REGION`, `KOLM_JUDGE_ID`, `DEFAULT_TENANT` — branding /
  receipt identity.

### What's NOT in `.env.example`

Three categories of env var are referenced in code but intentionally
omitted from `.env.example`. The audit
(`data/w890-7-env-vars.json` classification) labels each:

| bucket | example | rationale |
|--------|---------|-----------|
| `system` | `HOME`, `PATH`, `CI`, `DEBUG`, `NODE_ENV` | OS / runtime; not kolm config |
| `external` | `RUNPOD_API_KEY`, `MODAL_TOKEN_ID`, `HF_TOKEN`, `CUDA_VISIBLE_DEVICES` | third-party SDK env vars; documented by the upstream tool |
| `test` | `KOLM_CONNECTOR_FIXTURE`, `KOLM_ASSISTANT_TEST_SHIM`, `KOLM_AUDIT_DEBUG` | per-test shims; never read in production |
| `internal` | `KOLM_LLM_RETRIES`, `KOLM_DETACHED`, `KOLM_NO_HW_DETECT` | advanced operator overrides; documented inline in `src/router.js` / `cli/kolm.js` next to the reader |

The audit lock-in is: **every var bucketed as `user` MUST appear in
`.env.example`.** As of W890-7 closeout, `undocumented.user_facing = 0`.

## Zero-config operation

`kolm doctor` must run with no environment variables set and no
`~/.kolm/config.toml`. The first-time / CI invocation is:

```
kolm doctor --allow-logged-out
```

The `--allow-logged-out` flag (W481 P0-8) demotes the optional auth check
("api key (server)") from `missing` to `warn`. Doctor then exits 0 with
0 blockers; every other check passes against built-in defaults.

Lock-in in `data/w890-7-zero-config-doctor.json`:

- `exit_code === 0`
- `blockers === 0`
- `critical_failures: []`

## Secret handling

### What counts as a secret

Any value where the schema in `src/config.js` declares `secret: true`, OR
the dotted key matches the heuristic
`/(_key|password|secret|token|dsn|connection_string)$/i`. The current
secret keys:

| key | shape |
|-----|-------|
| `account.api_key` | `ks_<32 hex>` |
| `cloud.api_key` | provider-specific |
| `storage.postgres_url` | `postgres://user:pass@host/db` |
| `KOLM_API_KEY` | mirror of `account.api_key` |
| `RECIPE_RECEIPT_SECRET` | random 32+ chars |
| `ADMIN_KEY` | `ks_admin_<48 hex>` |
| `STRIPE_SECRET_KEY` | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `RESEND_API_KEY` | `re_...` |
| `GOOGLE_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET` | OAuth secrets |

### Where secrets must NEVER appear

The W890-7 secret-leak scan (`data/w890-7-secret-leak-scan.json`) verifies
all five categories return 0:

1. **git history** — `git log --all -p` scanned with strict patterns
   (`sk-`, `sk_live_`, `whsec_`, `AKIA`, `ghp_`), excluding documented test
   fixtures (`abcdef`, `EXAMPLE`, etc.). 0 real-shape matches.
2. **error messages** — `throw new Error(...)`, `Error(...)`, `reject(...)`
   in `src/**` scanned. Anti-leak helpers: `redactValue()` in
   `src/config.js` returns `<first6>...<last4>` for any string ≥16 chars,
   else `***`.
3. **logs** — `console.log` / `error` / `warn` / `info` / `debug` in
   `src/**` + `cli/**` scanned. Same redactor used.
4. **client-side JS** — `public/**/*.js` + `public/**/*.html` scanned. The
   browser never sees a kolm bearer token unless it ran `kolm login` and
   the token sits in the user's own `~/.kolm/config.toml`.
5. **OpenAPI responses** — `public/openapi.json`, `public/openapi.yaml`,
   `data/api-routes.json` scanned. Response schemas never embed real
   credential examples.

### Redaction by `kolm config`

`kolm config list` calls `formatForPrint()` in `src/config.js`. Any key in
`SECRET_KEYS` is redacted via `redactValue()` unless the operator passes
`--show-secrets`. The reveal is opt-in and explicit; there is no
"helpful" feature that decides to render the unredacted value
automatically.

## `.gitignore` policy

Required entries (lock-in in `data/w890-7-gitignore.json`):

| pattern | rationale |
|---------|-----------|
| `.env` | local secrets file; NEVER committed |
| `*.key` | private keys (ed25519, jwt signing) |
| `*.pem` | TLS certificates and PEM-encoded keys |
| `.kolm/config.toml` (and `~/.kolm/config.toml`) | user TOML may contain `account.api_key` if a contributor symlinks the file into the repo tree |
| `captures.db` | local SQLite capture store |

The user TOML normally lives at `$HOME/.kolm/config.toml` (outside any
repo) and is `chmod 0600` on POSIX. The `.gitignore` rule is a defense in
depth so a contributor's accidental `cp ~/.kolm/config.toml ./` cannot
leak their key.

## Adding a new configurable

Checklist for new keys (enforced by the audit on next run):

1. **Schema** — add the key under the right section in `SCHEMA` in
   `src/config.js`. Include `type` (`string` | `number` | `boolean` |
   `array`), and `secret: true` if it's a credential.
2. **Default** — add the value under the same section in `DEFAULTS`. Use
   `null` when you genuinely cannot pick a default (opt-in feature).
3. **Doc** — update [`docs/reference/config-toml.md`](./config-toml.md)
   with the new row.
4. **`.env.example`** — if the value is also readable from an env var
   (the resolver auto-binds `KOLM_<SECTION>_<KEY>`), add a stub line with
   a comment explaining when it's needed.
5. **Lock-in** — the W890-7 lock-ins re-run the audit on every PR. The
   `defaults.json` audit will fail if you skip step 2; the env-vars audit
   will warn if you skip step 4.

## Audit data files

| file | what it asserts |
|------|-----------------|
| `data/w890-7-env-vars.json` | every var read by code is documented OR classified as system/external/test/internal |
| `data/w890-7-defaults.json` | every TOML SCHEMA key has a default in DEFAULTS |
| `data/w890-7-zero-config-doctor.json` | `kolm doctor --allow-logged-out` exits 0 from a pristine HOME |
| `data/w890-7-hierarchy.json` | 5-layer trace + secondary-key trace all pass |
| `data/w890-7-secret-leak-scan.json` | git / errors / logs / client / openapi each = 0 |
| `data/w890-7-gitignore.json` | required entries present; missing = empty |

Regenerate any time with the corresponding `scripts/audit-w890-7-*.cjs`
runner.
