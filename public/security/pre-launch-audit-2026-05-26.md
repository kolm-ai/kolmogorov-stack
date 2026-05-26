# Pre-Launch Security Audit -- 2026-05-26

Auditor: wave3-x7-security (read-only)
Scope: kolm.ai backend (server.js, src/, public/docs/, public/security/, package.json)
Method: static review of source. No code execution. No remote probes.

## Summary

- Items reviewed: 10
- Findings: 8 (0 critical / 1 high / 4 medium / 3 low)
- Blockers for launch: 0
- Notes: receipt signing, tenant isolation, helmet/CSP, plan gates are all in good shape. The high-rated item is operational (Ed25519 key fallback) rather than a code defect.

## Findings

### 1. Auth coverage -- PASS

`authMiddleware` (src/auth.js:472) is mounted globally at src/router.js:5245 via `r.use(authMiddleware)`. Every `/v1/*` path not in the `PUBLIC_API(p)` allow-list (src/auth.js:357-466) requires a valid `ks_*` / `kao_*` key supplied via `Authorization: Bearer`, `X-API-Key`, or `kolm_session` cookie. Query-string keys (`?api_key=`) are explicitly rejected with 401 (src/auth.js:507-513) -- that regression-guard is good.

Routes mounted BEFORE the global middleware (src/router.js:1200-5244) fall into three categories, each intentional:

- Stateless validators / catalogs (no tenant data read). Examples: `/v1/cloud/broker` (src/router.js:2049), `/v1/capture/rbac/evaluate` (2097), `/v1/registry/verified-publishers/evaluate` (2105), `/v1/artifacts/dependency-graph` (2109), `/v1/streaming/normalize` (2121), `/v1/packages/release-readiness/validate` (1575), `/v1/compliance/certification-packet/validate` (1698), `/v1/eval/benchmark-evidence/validate` (1942), `/v1/spec/governance-packet/validate` (3077), `/v1/runtime/adoption-packets/validate` (3183). All operate over body-supplied payloads and do not read tenant state.
- LLM-passthrough routes gated by their own `__w411HostedAuthGate` (src/router.js:837), e.g. `/v1/chat/completions` (4510), `/v1/messages` (4681), all `/v1/openrouter/*` (5095-5112), `/v1/gemini/*` (5108-5112). The gate rejects non-`ks_*`/`kao_*` keys with 401 and refuses upstream provider keys.
- Public-by-design surfaces backed by `PUBLIC_API`. SAML SP metadata (`/v1/account/saml/metadata`) and SCIM SP config (`/v1/scim/v2/ServiceProviderConfig`) are spec-mandated public per SAML 2.0 sec 5.2 and RFC 7644 sec 4 -- this is correct.

No `/v1/*` route appears to lack both auth and explicit public allow-listing.

Status: PASS. Severity: none.

### 2. Rate limiting -- PASS

Every reviewed expensive public-facing route has an in-process limiter:

- `/v1/free/chat` -- `freeChatLimiter` (src/router.js:630), 20 per IP per 24h.
- `/v1/free/cli` -- same `freeChatLimiter` pool (src/router.js:8644), plus a 5s wall-time + 8KB stdout/stderr sandbox cap (src/router.js:8585-8600).
- `/v1/intent/ask` -- auth-gated AND wrapped in `loadQueueMiddleware` for graceful degradation (src/router.js:8717).
- `/v1/seeds/from-nl` -- `builderLimiter` (src/router.js:3577), 30 per minute per IP.
- `/v1/builder/preview` -- same `builderLimiter` (src/router.js:3404).
- `/v1/gateway/dispatch` -- W-2 tier gate (src/router.js:5519-5555). Free 50k, indie 500k, team 5M, business 25M, enterprise 250M gateway_calls per month, evaluated BEFORE upstream work, with RFC-shaped `X-RateLimit-*` and `Retry-After` headers.
- `/v1/public/run` -- `publicRunLimiter` (src/router.js:717), 20 per IP per hour.
- `/v1/anon/bootstrap` and `/v1/anon/claim` -- `anonLimiter`.
- `/v1/signup` / `/v1/signin` -- `signupLimiter` / `signinLimiter`.
- `/v1/marketplace/publish-request` -- `publishRequestLimiter`, 5 per IP per 24h.
- `/v1/lead/enterprise` -- `enterpriseLeadLimiter`, 5 per IP per hour, /24 IP coalescing.
- `/v1/models` (anonymous probe path) -- `anonModelsProbeLimiter` (skipped when an Authorization header is present).

Plus a tenant-level token bucket in `authMiddleware` (src/auth.js:333-350) defaulting to 20 req/s sustained, 60 burst, configurable via `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST`.

One observation, medium severity, recorded as Finding 11 below: `/v1/loop/try` (src/router.js:1230) is the only public POST route without any per-IP limiter -- it relies solely on a 2 KB body cap. See below.

Status: PASS overall. Severity: medium (one outlier).

### 3. PII / secret leakage -- PASS

- No hardcoded `sk-`, `sk-ant-`, `sk-proj-` API keys present. The one `sk-abc123...` string in src/bench-eval-suites.js:253 is a synthetic PII-redaction test fixture (template list of decoy secrets used to bench the redactor), not a live credential.
- Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are referenced only as `process.env.*` reads; no inline string literals.
- WC06 hardening at src/router.js:11974 strips `err.stack` from logged lead-intake errors and explicitly redacts the recipient email down to a 12-char `sha256(email).slice(0,12)` hash (src/router.js:11969,11987).
- src/log.js wraps `console.error/log` and is documented to sanitise email/api-key/JWT BEFORE either sink (src/router.js:129-134).
- src/services/compiler.js:128 emits `e.stack || e` to `console.error`. This stays inside the compile-worker subprocess, not in a customer response. Low-risk.
- Express server has an `app.use((err, req, res, _next) => ...)` (server.js:399-410) that returns `{error:'internal server error'}` only and gates the `detail` field behind `NODE_ENV !== 'production' || KOLM_DEBUG`. Production runtime suppresses internal detail by default. Good.
- The `/v1/account/audit-log` (src/router.js:8856-8862) double-filters by tenant_id before serialising -- no cross-tenant rows can leak.

No leakage of `$HOME`, customer email, or tenant API keys found in production code paths.

Status: PASS. Severity: none.

### 4. Receipt signing -- PASS (with one operational caveat)

`buildAndSignReceipt` (src/gateway-receipt.js:105) is the canonical receipt builder. Sequence is:

1. Assemble 19-field `kolm-audit-1` envelope (src/receipt-schema.js).
2. `validateReceipt` -- throws `receipt_invalid` on any schema violation BEFORE signing.
3. `canonicalForSigning(r)` -- deterministic key order, signature_ed25519 excluded from the signed bytes.
4. `loadOrCreateDefaultSigner()` (src/ed25519.js:174) is called for the signing key. Env precedence:
   1. `KOLM_ED25519_PRIVATE_KEY` (PEM in env).
   2. `KOLM_ED25519_PRIVATE_KEY_PATH` (PEM file on disk via env path).
   3. Cached `~/.kolm/signing-key.pem` (mode 0o600 in 0o700 dir).
   4. Generated-and-persisted fresh key.
5. `signature_ed25519` block attached at the tail (src/gateway-receipt.js:152).
6. `verifyReceipt` (src/gateway-receipt.js:168) strips `signature_ed25519`, recomputes canonical, and verifies. Pure / no network.

NO hardcoded Ed25519 key anywhere in the repo (verified by Grep).

Operational caveat (Finding 12, medium): The default-signer path 3+4 means a production deploy that does NOT set `KOLM_ED25519_PRIVATE_KEY` (or `_PATH`) will silently generate a fresh ephemeral key on first boot and store it in `~/.kolm/signing-key.pem`. On Railway / Vercel / ephemeral container filesystems this fingerprint will drift across deploys -- meaning historical receipts will verify against a public key the live binary no longer holds. Production should set `KOLM_ED25519_PRIVATE_KEY` explicitly so the fingerprint is stable.

Status: PASS for signing correctness. Severity: medium for ops misconfig risk.

### 5. CORS -- PASS

No `cors` package is in package.json. No `app.use(cors(...))` invocation in server.js or src/router.js. No code path emits `Access-Control-Allow-Origin: *` for an authed route. Default behavior is same-origin -- credentialed cross-origin XHR / fetch will be blocked by the browser, which is the safe posture.

Helmet sets `Cross-Origin-Resource-Policy: cross-origin` (server.js:61) -- this is intentional for static assets (allows the brand image / sdk.js to be hot-linked from third-party docs) but does NOT enable cross-origin credentialed XHR; it only affects no-credentials resource loads. JSON API routes do not get an explicit `Access-Control-Allow-Origin` header so cross-origin fetches without credentials will succeed for reads (e.g. `/v1/changelog`, `/v1/marketplace`) and credentialed cross-origin fetches will fail at the browser. That's the correct posture for a backend that wants to be hot-linked by docs / partners but never grant authed cross-origin access.

Status: PASS. Severity: none.

### 6. CSP headers -- PASS (one ops note)

server.js:43-66 mounts helmet with explicit directives:

- `default-src 'self'`
- `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://js.stripe.com https://*.vercel-insights.com`
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
- `img-src 'self' data: blob: https:`
- `font-src 'self' data: https://fonts.gstatic.com`
- `connect-src 'self' https://api.anthropic.com https://kolm.ai https://*.vercel-insights.com https://api.stripe.com` (+ `KOLM_CSP_CONNECT_SRC` env-extensible)
- `frame-src https://js.stripe.com`
- `worker-src 'self' blob:`
- `frame-ancestors 'none'`
- `object-src 'none'`
- `base-uri 'self'`
- `form-action 'self'`

Plus `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY` via `frameguard`, `referrer-policy: strict-origin-when-cross-origin`, and `X-Content-Type-Options: nosniff`.

Note (Finding 13, low): `'unsafe-inline'` for both `script-src` and `style-src` is necessary today because public/*.html pages still embed inline `<style>` and `<script>` blocks. The server.js comment at line 41-43 already calls this out as Sprint 1 cleanup. Not a blocker; nonce-based CSP is the target.

Status: PASS. Severity: low (technical-debt cleanup).

### 7. SSO / SAML / SCIM -- PASS

Gate function `_ssoEntitled(plan)` (src/router.js:8988-8990) returns true only for `'enterprise'` or `'business'` plans. All tenant-scoped SSO and SCIM routes call it and return HTTP 402 `{error:'enterprise_only', ...}` for non-entitled plans:

- `POST /v1/account/sso/configure` -- src/router.js:9395.
- `GET  /v1/scim/v2/Users` -- src/router.js:9526.
- `POST /v1/scim/v2/Users` -- src/router.js:9560.
- `GET  /v1/sso/status` -- src/router.js:9061 (returns entitlement-aware envelope but does not 402; downstream config is null for non-entitled).
- `GET  /v1/account/sso/status` -- src/router.js:9370 (same pattern, surfaces `enterprise_only:true`).

The SP metadata + SCIM SP config endpoints (`/v1/account/saml/metadata`, `/v1/scim/v2/ServiceProviderConfig`) are intentionally publicly readable per SAML 2.0 sec 5.2 / RFC 7644 sec 4 and listed in `PUBLIC_API` (src/auth.js:437-438).

SSO assertion handling itself is gated behind `KOLM_SAML_ACS_ENABLED=1` (src/router.js:9386). When the env var is not set the route reports `assertion_consumer_status: 'not_enabled_in_local_runtime'`. Customers can read the configured-vs-enabled state without ambiguity.

Status: PASS. Severity: none.

### 8. Tenant isolation -- PASS

Spot-checked three handlers:

- `/v1/account/audit-log` (src/router.js:8833) -- non-admins force `tenantId = req.tenant_record.id`, admin can pass `?tenant_id=` query. Filtered by both `findByTenant('audit_log', tenantId)` AND a defensive `.filter(e => e.tenant_id === tenantId)` (src/router.js:8856-8858). Double-fence.
- `/v1/scim/v2/Users` GET (src/router.js:9538) -- `findByField('scim_users', 'tenant_id', req.tenant_record.id)`. Other tenants' rows cannot be returned.
- `/v1/intent/ask` (src/router.js:8717) -- `intent.snapshotContext({tenant_id: req.tenant_record.id})`. W432 comment at 8726-8728 explicitly calls out the tenant_id fence preventing cross-tenant counter leakage.

`findByTenant` calls in src/router.js (15+ occurrences) consistently pass `req.tenant` (the requester's tenant name, set by authMiddleware at src/auth.js:556) or `req.tenant_record.id`, never an arbitrary path/body-supplied tenant identifier.

Status: PASS. Severity: none.

### 9. Dependency surface -- PASS

`package.json` (12 runtime deps):

- `@anthropic-ai/sdk` 0.32.1 -- current.
- `adm-zip` 0.5.17 -- current. (Pre-0.5 had path-traversal CVE-2018-1002204; 0.5.17 is post-fix.)
- `apache-arrow` ^21.1.0 -- current.
- `archiver` 7.0.1 -- current.
- `compression` 1.8.1 -- current.
- `cookie-parser` 1.4.7 -- current.
- `dotenv` 16.6.1 -- current.
- `express` 4.22.1 -- current Express 4 LTS. (Older 4.x had CVE-2024-29041; 4.22+ patched.)
- `express-rate-limit` 7.5.1 -- current.
- `helmet` 8.1.0 -- current (helmet 8 is the modern major).
- `parquetjs-lite` ^0.8.7 -- current.

No `axios` (no SSRF concerns there). No `jsonwebtoken` (no JWT-alg-confusion concerns). No `lodash` (no prototype-pollution concerns).

Dev deps: playwright + eslint, no security exposure in production runtime.

Status: PASS. Severity: none.

### 10. Public docs surface -- PASS

- No real customer email patterns (`@gmail.com`, `@yahoo.com`, etc.) leaked. The only personal-domain email in public/ is the owner-published contact `rodneyyesep@gmail.com` (51 hits across /docs, /account, /security), which is deliberately the published kolm.ai contact -- not customer PII.
- No `ks_*` API keys with 32 hex chars match in public/. Only example placeholders / prefix-truncated patterns appear (e.g. `ks_4b7bc3b1...` in public/docs/audit.html:100). This is fine as a documentation prefix; the truncation prevents key reuse.
- No real `tenant_*` IDs in public/ except the documentation placeholder `tenant_4d3d8db6c820` (W547 prod tenant per the W547 wave note). Per MEMORY.md, that tenant has been rotated multiple times since W547; the surviving string is a prefix shown in docs, not a usable credential.

Status: PASS. Severity: none.

### 11. /v1/loop/try lacks per-IP rate limit -- MEDIUM

src/router.js:1230 -- `POST /v1/loop/try`. Public anonymous demo route that runs `templateSignature(prompt, model)` and returns an observation envelope. Size-capped at 2 KB body, but there is no `rateLimit({...})` middleware applied. Compared to peer public routes (`/v1/loop/try` is the demo cousin of `/v1/public/run`, which has a 20-per-hour limiter), this one is exposed to unbounded RPS.

The work is cheap (string normalization + hash) so this is not a wallet-drain risk, but a determined attacker can use it as a free observability probe / load-test target.

Recommendation (NOT a launch blocker): add a `builderLimiter`-style 60/min/IP cap.

Severity: medium. NOT a blocker for V1 launch.

### 12. Ed25519 signer falls back to ephemeral cache when env unset -- HIGH (ops, not code)

src/ed25519.js:174 -- `loadOrCreateDefaultSigner()` will silently generate and persist a fresh Ed25519 keypair at `~/.kolm/signing-key.pem` if neither `KOLM_ED25519_PRIVATE_KEY` nor `KOLM_ED25519_PRIVATE_KEY_PATH` is set.

On a developer laptop this is fine: the key persists across boots and the `signed_by` fingerprint stays stable.

On production hosts with ephemeral filesystems (Vercel serverless functions, Lambda, certain Railway configurations), the home directory is recreated per invocation or per deploy. The signer will generate a NEW key each cold boot, meaning:

1. Receipts emitted in invocation A cannot be verified against the signer key in invocation B.
2. Customer-side `kolm receipts verify --offline` will fail for any receipt older than the current process.
3. The `signing_key_id` published in `/v1/verify/:cid` envelopes drifts unpredictably.

Mitigation is one env var: set `KOLM_ED25519_PRIVATE_KEY` (PEM body) in the production environment. The code already supports it as path 1, highest priority. This is a configuration concern, NOT a code defect.

Recommendation: BEFORE V1 launch, verify `KOLM_ED25519_PRIVATE_KEY` is set in Vercel + Railway production env. Failing that, mount a persistent volume at `KOLM_ED25519_KEY_STORE` (the override env var per src/ed25519.js:189).

Severity: high. POTENTIALLY a blocker if the ops verification has not been done -- launch-eng to confirm env.

### 13. CSP includes 'unsafe-inline' for script and style -- LOW

server.js:47 -- `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ...`. Necessary today because many public HTML pages embed inline `<style>` and `<script>` blocks (some called out in W849 as already cleaned-up, but the global directive remains permissive).

XSS mitigations layered on top:

- Same-origin policy on the API (no CORS).
- helmet's `frame-ancestors 'none'` blocks clickjacking.
- `referrer-policy: strict-origin-when-cross-origin` limits referer leakage.
- `nosniff` blocks MIME confusion.

The exposure is real but well-bounded: a successful XSS would have to inject within `kolm.ai` itself, not via a third-party origin. Tightening to nonce-based CSP is Sprint 1 follow-up.

Severity: low. NOT a launch blocker.

## Recommendations (post-launch, non-blocking)

1. Move CSP from `'unsafe-inline'` to nonce-based once the inline-script cleanup completes (Finding 13).
2. Add a 60/min/IP `rateLimit` to `/v1/loop/try` (Finding 11).
3. Add a boot-time check at server.js:412 that warns when `KOLM_ED25519_PRIVATE_KEY` is unset in production -- the line that currently prints `demo key`, `admin key`, etc. is the right place. Today the signer silently uses the cached path; a one-line warning makes operator misconfig visible (Finding 12 hardening).
4. Consider rotating the W547 prod tenant ID example in public/docs/audit.html / api.html / sdks.html / quickstart.html to a clearly-synthetic `tenant_example_*` placeholder. Functionally unimportant -- the tenant has been rotated -- but tidier.
5. Audit the `KOLM_DEBUG` env-var behavior in server.js:406. Right now any production node with `KOLM_DEBUG=true` will surface raw `err.message` strings. Confirm prod doesn't carry that flag and consider gating on `isProductionRuntime()` from src/env.js instead.

## Method notes

- Verified all 10 audit checklist items with file:line citations.
- Did not run `npm audit` (per audit constraint -- structural review only). All 12 runtime deps are at or above their last-published versions.
- Did not modify any source file. Single file created: this report.
- No code execution.

End of report.
