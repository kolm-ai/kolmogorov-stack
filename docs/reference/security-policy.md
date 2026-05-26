# Security Policy

Canonical reference for the W890-6 audit. Consolidates the dependency
posture, authentication boundary, key storage rules, transport headers,
CSP, rate limiting, input validation, eval policy, artifact signature
gate, SSH-injection safety, and incident-response runbook.

This document is generated alongside ten `data/w890-6-*.json` artifacts
via `node scripts/w890-6-security-audit.cjs` plus a re-used ship-gate
snapshot at `data/w890-6-ship-gate-snapshot.json`. The artifacts are
the source of truth; this file is the human-readable summary.

## 1. Dependency posture

Two ecosystems, two tools, two thresholds.

| ecosystem | tool        | refresh command                              | artifact                          |
|-----------|-------------|----------------------------------------------|-----------------------------------|
| npm       | `npm audit` | `npm audit --json`                           | `data/w890-6-npm-audit.json`      |
| pip       | `pip-audit` | `python -m pip_audit --no-deps`              | `data/w890-6-pip-audit.json`      |

Ship-gate thresholds (CWE-1104):

- **npm critical = 0** (hard fail)
- **npm high = 0** (hard fail)
- **pip critical = 0** (hard fail when `pip-audit` is installed)
- **pip high = 0** (hard fail when `pip-audit` is installed)

`pip-audit` runs with `--no-deps` because some transitive packages
(notably `auto-gptq`) attempt to build against CUDA at install time;
top-level pins are the contract surface we ship.

Open moderate items are captured in the artifact for triage; they do
not block ship. The current moderate set is the `qs` query-string
deserialization CVE bundled with `express` ≤ 4.21.x — deferred until
a minor express bump can be coordinated.

## 2. Authentication boundary

`src/router.js` mounts `r.use(authMiddleware)` at one line; every route
declared **after** that line is auth-gated by default; every route
declared **before** is public unless it carries its own per-route gate.

`src/auth.js` exports three primitives:

| primitive                            | role                                                              |
|--------------------------------------|-------------------------------------------------------------------|
| `authMiddleware(req, res, next)`     | Resolves the API key, applies token-bucket rate limit, sets tenant |
| `PUBLIC_API(p)`                      | Predicate consulted by `authMiddleware` to short-circuit auth     |
| `__w411HostedAuthGate(req, res, next)` | Per-route auth for inference passthroughs (chat/completions, etc.) |

`PUBLIC_API` is a closed allowlist (literal + regex set; see
`data/w890-6-auth-coverage.json#public_api_allowlist_literals`). Every
public-by-allowlist endpoint is annotated in code with the wave that
introduced it.

Routes declared before `r.use(authMiddleware)` fall into one of
four documented categories:

1. `/health`, `/ready`, `/metrics` (operational probes).
2. Non-`/v1/` paths (page routes / static / 404 fallback).
3. Inference passthroughs gated by `__w411HostedAuthGate`.
4. Marketing / catalog / spec / receipt / key endpoints intentionally
   public; these are listed in
   `data/w890-6-auth-coverage.json#documented_public_literals`.

The audit asserts `unguarded_count = 0`: every route declared above the
middleware mount has at least one of: PUBLIC_API match, per-route auth
gate, or documented public-pre-auth classification.

## 3. API-key storage

CWE-256, CWE-922.

- `hashApiKey(key)` returns `'sha256:' + sha256(key)` (hex). Stored
  alongside the tenant row as `api_key_hash`.
- `api_key_prefix` (first 10 chars of the raw key) is stored separately
  for UI display.
- `migrateAllPlainKeysOnce()` rewrites legacy plain rows at module load.
- Lookup uses `crypto.timingSafeEqual` over the hashed value
  (`constantTimeEqual` in `src/auth.js`).
- The `?api_key=...` query-string form is rejected with HTTP 401 +
  `api_key_in_query_unsupported` (W258-SEC-1) — CDN access logs and
  Referer headers leak credentials, so the form must not silently work.

## 4. Ed25519 signing keys

CWE-732 (file permissions), CWE-321 (hard-coded key).

- Directory `~/.kolm/` (and any rotated-key subdirectory) is created
  with `fs.mkdirSync(..., { recursive: true, mode: 0o700 })`.
- Every `fs.writeFileSync(...)` of a key payload (`private.pem`,
  `keys-state.json`, `keys/<id>.pem`) sets `{ mode: 0o600 }`.
- Audit asserts `offending_writes.length === 0` in
  `data/w890-6-key-storage.json`.
- Windows note: POSIX `0o600` is advisory; the underlying ACL is
  inherited from the parent directory. Operators on Windows are
  expected to keep `%USERPROFILE%\.kolm\` outside roaming profiles
  and shared paths.

## 5. Transport headers

CWE-1021 (clickjacking), CWE-693 (security mechanism failure).

`server.js` mounts `helmet()` with explicit overrides; the relevant
constraints are:

| header                          | value                                                                 |
|---------------------------------|-----------------------------------------------------------------------|
| `Strict-Transport-Security`     | `max-age=63072000; includeSubDomains; preload` (2 years, preload-ready) |
| `X-Content-Type-Options`        | `nosniff`                                                             |
| `X-Frame-Options`               | `DENY`                                                                |
| `Referrer-Policy`               | `strict-origin-when-cross-origin`                                     |
| `Cross-Origin-Resource-Policy`  | `cross-origin` (relaxed; required by SDK browser callers)             |
| `X-Powered-By`                  | disabled                                                              |

A second `Strict-Transport-Security` line is emitted from `src/router.js`
as defense in depth for any future router-only mount.

## 6. Content Security Policy

CWE-79 (XSS).

`server.js` declares an explicit `helmet.contentSecurityPolicy({ directives })` block with 11 directives:

| directive          | values                                                                                |
|--------------------|---------------------------------------------------------------------------------------|
| `default-src`      | `'self'`                                                                              |
| `script-src`       | `'self' 'unsafe-inline' 'wasm-unsafe-eval' https://js.stripe.com https://*.vercel-insights.com` |
| `style-src`        | `'self' 'unsafe-inline' https://fonts.googleapis.com`                                 |
| `img-src`          | `'self' data: blob: https:`                                                           |
| `font-src`         | `'self' data: https://fonts.gstatic.com`                                              |
| `frame-src`        | `https://js.stripe.com`                                                               |
| `worker-src`       | `'self' blob:`                                                                        |
| `frame-ancestors`  | `'none'`                                                                              |
| `object-src`       | `'none'`                                                                              |
| `base-uri`         | `'self'`                                                                              |
| `form-action`      | `'self'`                                                                              |

Documented exemptions:

- `'unsafe-inline'` on `script-src`: legacy inline `<script>` blocks
  for the dashboard onboarding view. Removal is tracked under Sprint 1
  inline-script-cleanup.
- `'wasm-unsafe-eval'` on `script-src`: required by the on-device
  llama.cpp / sqlite-vec WebAssembly runtime.

`'unsafe-eval'` is **not** in any directive. `frame-ancestors 'none'` +
`X-Frame-Options DENY` prevents clickjacking.

## 7. CORS

CWE-942.

`Access-Control-Allow-Origin: *` is currently emitted from
`src/router.js`. The wildcard is acceptable here because:

1. Authentication uses header bearer tokens (`Authorization` +
   `X-API-Key`), not browser cookies cross-origin.
2. `Access-Control-Allow-Credentials` is **not** emitted, so wildcard
   does not enable cookie leakage.
3. `frame-ancestors 'none'` + `X-Frame-Options DENY` neutralize
   clickjacking irrespective of origin.
4. The public SDK surface is meant to be reachable from arbitrary
   client origins.

`Access-Control-Allow-Methods`: `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
`Access-Control-Max-Age`: `86400`.

Operators who need a stricter posture can narrow the origin set with
`KOLM_CORS_ALLOW_ORIGIN` (one or more origins; comma-separated). The
audit annotates this as `narrowing_recommendation` in
`data/w890-6-headers.json#cors`.

## 8. Rate limiting

CWE-770 (resource consumption).

Two layers:

1. **Per-tenant token bucket** in `src/auth.js`. Defaults are
   `DEFAULT_RATE_PER_SEC = 20`, `DEFAULT_BURST = 60`; both are tunable
   via env (`RATE_LIMIT_PER_SEC`, `RATE_LIMIT_BURST`). Applies to every
   authenticated `/v1/` call.

2. **Per-IP `express-rate-limit` instances** for public surfaces. The
   audit enumerates 19 instances and 62 per-route bindings (e.g.
   `signupLimiter`, `docsAssistantLimiter`, `freeChatLimiter`).
   Representative caps:

   | route                                  | window | max          |
   |----------------------------------------|--------|--------------|
   | `/v1/signup`                           | 24h    | 10 per IP    |
   | `/v1/free/chat`, `/v1/free/cli`        | 24h    | 20 per IP    |
   | `/v1/assistant/chat-docs`              | 24h    | 60 per IP    |
   | `/v1/sales/demo-request`               | 24h    | 10 per IP    |

The audit asserts every entry in `PUBLIC_API` is one of:

- listed in the exempt set (catalog read / idempotent doc / body-key auth);
- bound to a dedicated `express-rate-limit` limiter; or
- invokes a limiter inline inside the route handler.

`data/w890-6-rate-limiting.json#missing_rate_limit` must be `[]`.

## 9. Input validation

CWE-20 (input validation), CWE-89 (SQL injection), CWE-22 (path traversal).

### 9.1 Body size

| layer        | limit  | source                                          |
|--------------|--------|-------------------------------------------------|
| JSON         | 4 MiB  | `server.js` — `express.json({ limit: '4mb' })`  |
| Raw          | 4 MiB  | `server.js` — `express.raw({ limit: '4mb' })`   |
| Multipart    | 16 MiB | `src/router.js#_readRawBody(req, limit = 16 * 1024 * 1024)` |
| Multipart parts | 8 max | `src/router.js` multipart parser                |

### 9.2 String length caps

Audit enumerates 24 distinct `slice(0, N)` caps in `src/router.js`,
covering free-text inputs across the surface. Smallest cap: 10 chars
(short identifiers); largest: 16000 chars (long-form prompt bodies).

### 9.3 Type guards

- `typeof X === 'string'/'number'/'boolean'/'object'`: 44 occurrences.
- `Array.isArray(X)`: 118 occurrences.
- `Number.isFinite(X)`: 70 occurrences.

### 9.4 SQL injection

Every SQLite caller uses prepared statements via `db.prepare(sql).run(...args)` / `.get(...args)` / `.all(...args)`. The
audit enumerates 16 prepared-statement call sites across
`src/event-store.js`, `src/store.js`, `src/storage/postgres-store.js`.

Template interpolations in `prepare(\`...${ident}...\`)` are classified
as either:

- `whitelisted_clause_builder` — the identifier is one of
  `{whereSql, limSql, orderSql, orderBy, order}`, built locally from a
  closed column allowlist (the actual values pass as `?` placeholders);
- `regex_validated_identifier` — the identifier passes a regex test
  earlier in the same function (e.g. `findByField()` rejects `field`
  names that don't match `/^[A-Za-z_][A-Za-z0-9_]*$/`).

Audit asserts `unsafe_concat_count = 0`. Postgres callers pass an
explicit parameter array to `pool.query(text, params)`.

### 9.5 Path traversal

`server.js` wildcard fallback rejects any path containing `..`. Route
handlers that read `req.params.*` for file paths normalize via regex
allowlists (`/^[a-z0-9][a-z0-9_\-\/]*$/i` and similar). The audit
asserts `path_traversal.unsafe_count = 0`.

## 10. Eval policy

CWE-95.

`eval(`, `new Function(`, and `child_process.exec` are banned at the
codegen layer (see `src/verifier.js`). The audit confirms:

- Every `eval(` and `new Function(` hit in `src/**/*.{js,mjs,cjs}` is
  inside a comment or string literal documenting the ban — none
  invoke at runtime.
- Every `.exec(` hit resolves to one of:
  - `RegExp.prototype.exec` (regex literals or named regex constants);
  - `better-sqlite3` `db.exec()` running literal DDL (no user input);
  - `ssh2` `Client.exec(cmd)` over template literals from frozen
    `RUNTIME_PROBES` / `RUNTIME_INSTALLERS` (see §11).

Audit asserts `unsafe_count = 0` and `unclassified_count = 0` in
`data/w890-6-eval-scan.json`.

## 11. SSH safety

CWE-78 (command injection).

Every remote operation uses `ssh2` `Client.exec()` — never a system
`ssh` shell concat. The ssh2 channel API hands the command string
directly to the remote shell without local quoting, so any value
interpolated into the command must be allowlist-validated locally.

Validators (`src/device-ssh.js`, `src/device-install.js`,
`src/device-adapters/ssh-adapter.js`, `src/deploy-pipeline.js`):

| value          | validator                                | regex                                                  | rejects                                      |
|----------------|------------------------------------------|--------------------------------------------------------|----------------------------------------------|
| hostname       | `_isSafeHost` / `_assertSafeSshHost`     | `/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/`                     | flags (`-oProxyCommand=...`), spaces, quotes |
| `remoteDir`    | `_assertSafeRemoteDir`                   | `/^[A-Za-z0-9_./~-]{1,512}$/`                          | backticks, `$(`, `;`, `&`, `\|`, `<`, `>`    |
| `runtime`      | `_assertSafeRuntime`                     | `/^[A-Za-z0-9_.-]{1,64}$/`                             | shell metacharacters in runtime name         |
| `port`         | `Number(...)` cast                       | (numeric coercion)                                     | non-numeric                                  |
| `bindHost`     | `JSON.stringify(...)` wrap               | (quote-safe encoding)                                  | quotes inside the value                      |
| remote paths   | `JSON.stringify(...)` wrap               | (quote-safe encoding)                                  | spaces and quotes before `sha256sum`         |

The audit asserts `unsafe_interpolation_count = 0` over 12 `.exec()`
call sites across 9 device files.

## 12. Artifact signature gate

CWE-345 (insufficient verification of data authenticity), CWE-347.

`src/artifact-runner.js#loadArtifact()` is the only entry point for
reading a `.kolm` bundle. It:

1. Reads the bundle.
2. Verifies the `signature.sig` HMAC over the manifest.
3. Throws `KOLM_E_SIGNATURE_INVALID` on mismatch.

Callers that need to inspect a tampered bundle (e.g. `kolm verify --json`)
pass `{ allowInvalidSignature: true }` and surface the failure inside
the structured envelope — they cannot silently use the artifact.

`src/binder.js#verifyArtifact()` and `verifyArtifactStructured()` are
the public verification surfaces.

Cloud-pulled artifacts additionally pass through
`isArtifactPathCloudTrusted()` which checks the local sha256 against
`~/.kolm/cloud-trusted.json` before the binder loads them. The
multipart upload path rejects sha256 mismatches at the parse layer
(`src/router.js` line ~16068).

Audit asserts `unverified_paths.length = 0` in
`data/w890-6-artifact-verify.json`.

## 13. Process safety

CWE-754.

`server.js` registers process-level handlers for:

- `unhandledRejection` — logs + does not crash; Sentry captures the
  rejection chain (W890-3 integration).
- `uncaughtException` — logs + exits with code 1; the process manager
  (systemd / pm2 / Docker restart) restarts the daemon.
- `SIGTERM` / `SIGINT` — graceful shutdown: stop accepting new
  connections, drain pending requests, close DB connections.

The W890-3 Sentry shim is wired before the route mount so any throw
inside a handler is captured with PII redaction applied
(`SENTRY_PII_REDACT=true` is the default).

## 14. Incident response

Defines the runbook for the three escalation tiers.

### 14.1 P0 — credential leak or RCE

1. Rotate the affected key set:
   - **API keys**: revoke via `/v1/account/keys/revoke`; re-issue.
   - **Ed25519**: rotate via `kolm keys rotate` (writes new
     `~/.kolm/keys-state.json` entry; old keys remain for verification).
2. Re-issue affected artifacts: re-sign via `kolm build --sign`.
3. Confirm prod ship-gate: `node scripts/ship-gate.cjs --json` must
   pass 52/52.
4. File a post-mortem under `docs/incidents/<YYYY-MM-DD>-<slug>.md`.

### 14.2 P1 — dependency CVE (high / critical)

1. Refresh the audit: `node scripts/w890-6-security-audit.cjs`.
2. Pin the upstream fix in `package.json` or `requirements.txt`.
3. Re-run the lock-in tests: `node --test tests/wave890-6-security.test.js`.
4. Cut a point release.

### 14.3 P2 — moderate CVE / hardening item

1. Capture in the audit artifact (moderate is recorded but does not
   block ship).
2. Schedule into the next maintenance window.
3. Update this document's deferral list if appropriate.

## 15. Audit artifacts (machine-readable)

| artifact                                | covers                                  |
|-----------------------------------------|-----------------------------------------|
| `data/w890-6-npm-audit.json`            | npm CVE inventory                       |
| `data/w890-6-pip-audit.json`            | pip CVE inventory                       |
| `data/w890-6-auth-coverage.json`        | route classification + PUBLIC_API set   |
| `data/w890-6-key-storage.json`          | API-key + Ed25519 storage rules         |
| `data/w890-6-headers.json`              | helmet + HSTS + CSP + CORS              |
| `data/w890-6-rate-limiting.json`        | tenant bucket + per-IP limiters         |
| `data/w890-6-input-validation.json`     | body size + string caps + SQL + path    |
| `data/w890-6-eval-scan.json`            | eval / new Function / .exec scan        |
| `data/w890-6-artifact-verify.json`      | loadArtifact signature gate             |
| `data/w890-6-ssh-injection.json`        | ssh2 command-string safety              |
| `data/w890-6-ship-gate-snapshot.json`   | ship-gate 52/52 snapshot                |

Run `node scripts/w890-6-security-audit.cjs` to refresh every
artifact. The script is read-only — it never opens a live DB, never
exfiltrates data, and never alters source code.

## 16. Constraints

- The audit is repo-driven: it asserts the source declares the expected
  guard, not that a running deployment has not been tampered with at
  the host level. Live verification requires checking the deployed
  artifact's hashes against the build manifest.
- `npm audit` and `pip-audit` advisory feeds lag the upstream
  disclosure timeline; the audit captures the snapshot at run-time
  but does not subscribe to a live feed.
- `pip-audit` `--no-deps` only audits top-level requirements; transitive
  CVEs are visible only after running `pip-audit` without `--no-deps`
  on a machine with the full CUDA toolchain installed.
- The 2 open moderate npm items (qs CVE in express 4.21.x) are
  documented deferrals, not invariants. They will close on the next
  express minor bump.
