# Auth Boundary Audit

Date: 2026-05-12

Scope: local code review of `src/auth.js`, `src/oauth.js`, `src/router.js`, supporting server mount order, and focused local smokes. This is a codebase security audit slice for the living Kolm research repository, not a full penetration test.

## Executive Findings

1. P0: `POST /v1/anon/claim` can issue a fresh API key for an existing tenant identified only by email. A local smoke proved that a valid anon token plus `victim-audit@example.com` produced `mode: merged`, returned a `ks_` key for the existing tenant, made the new key usable, and invalidated the old victim key.
2. P1: `authMiddleware` accepts `?api_key=` query parameters. A local smoke against `/v1/account?api_key=...` returned 200, which confirms secret material can travel through URLs.
3. P1: public API status is split across route placement before `r.use(authMiddleware)` and `PUBLIC_API` middleware bypasses after it. This is workable, but too easy to review incorrectly without a generated route manifest.
4. P1: `/v1/public/run` is unauthenticated, runtime-executing, receipt-building, and not connected to an explicit per-IP limiter.
5. P1: `/v1/registry/export` intentionally publishes executable public recipe source. That aligns with the offline registry story, but it must be tied to artifact trust levels and the sandbox hardening decision because `node:vm` is not a production trust boundary.

## Boundary Shape

`src/router.js:802` mounts `r.use(authMiddleware)`. The extracted route inventory classified the API surface into four groups:

| Gate | Count | Examples |
| --- | ---: | --- |
| Public by placement before global auth | 17 | `/v1/anon/claim`, `/v1/public/run`, `/v1/receipts/verify`, `/v1/registry/export` |
| Explicit pre-auth protected | 2 | `/v1/wrap/verified`, `/v1/verified-inference` |
| Public by allowlist after global auth | 4 | `/v1/registry/public`, `/v1/stripe/webhook`, `/v1/specialists/waitlist`, `/v1/public/featured` |
| Protected by global auth | 67 | compile, artifacts, account, synthesize, registry writes, bridges, capture, specialists, memory |

The global boundary is broadly useful, but the security policy is not encoded in one place. `PUBLIC_API` describes middleware bypasses, while several public routes are public only because they are declared before line 802. This gap makes code review brittle.

## P0: Anonymous Claim Can Take Over Existing Email Tenants

The claim route is public by placement:

- `src/router.js:296` accepts `anon_token`, `email`, and `name` from the body.
- `src/auth.js` resolves the anon token and then looks up an existing real tenant by matching `t.email === email`.
- If an existing tenant is found, it rotates that tenant's key, returns the new key, reassigns anon concepts/observations, and deletes the anon tenant.

Local smoke result:

```json
{
  "mode": "merged",
  "returnedKeyPrefix": "ks_",
  "returnedTenantName": "victim-audit",
  "canUseNew": true,
  "oldStillWorks": false
}
```

This is account takeover if an attacker can create any anon tenant and knows or guesses a victim email. The endpoint has no email verification, OAuth proof, logged-in session, or rate limiter on the claim route itself.

Required fix: disable existing-email merge until the claimant proves control of that email through magic link or OAuth. A claim flow can still upgrade a brand-new anon tenant in place, but it must not return or rotate an existing tenant key without proof.

## P1: Query API Keys Leak Credentials

`authMiddleware` builds the credential as:

```text
kolm_session cookie, then Authorization bearer, then x-api-key, then req.query.api_key
```

Local smoke result:

```json
{
  "status": 200,
  "tenant": "query-audit",
  "email": "query-audit@example.com",
  "acceptedQueryKey": true
}
```

Query keys are likely to leak through access logs, referrers, browser history, screenshots, proxy telemetry, analytics, and support tickets. Deprecate query keys and move remaining CLI/server clients to `Authorization: Bearer` or `X-API-Key`.

## Public Execution Surfaces

`/v1/public/run` is intentionally unauthenticated so visitors can try public concepts. It also executes runtime code and builds receipts by default. Unlike signup, signin, anon bootstrap, registry export, verified inference, publishing, and waitlist routes, it has no explicit route limiter in `src/router.js`.

Minimum changes:

- add `publicRunLimiter`,
- set max input size lower than the global JSON limit,
- consider defaulting `receipt` to false for anonymous runs,
- add route tests for no-auth allowed, rate limit enforced, and private concept denied.

`/v1/registry/export` is rate-limited and public. It returns executable source for public recipes. This should remain possible for the offline registry story, but only after trust levels are explicit. Until stronger sandboxing ships, public export should be curated/signed rather than "anything public can be run as trusted code."

## OAuth And Sessions

OAuth routes are public by design. The callback validates the state cookie, fetches provider email, and uses `findOrCreateTenantByEmail`. `safeReturn` only accepts relative paths starting with `/` and rejects `//`, which reduces open-redirect risk.

The tradeoff is key rotation: existing-tenant OAuth sign-in mints a fresh API key for the browser session and invalidates the previous key. The source comments acknowledge this behavior. That is acceptable only if product copy and CLI UX explain the distinction between browser sessions and long-lived API keys, or if the implementation separates session tokens from API keys.

`authMiddleware` also prefers the `kolm_session` cookie over explicit headers. A browser request carrying both a cookie and `Authorization` will authenticate as the cookie tenant. Prefer explicit headers over cookies for API calls or reject ambiguous mixed-credential requests.

## Admin And Webhook Surfaces

The development admin fallback key is disabled in production-like runtimes, and `tests/auth.test.js` covers several production-like env names. Admin diagnostics and global job/artifact visibility are guarded by `req.is_admin`, but global admin reads should become auditable support events.

Stripe webhook routing is correct in shape: `server.js` mounts `express.raw` before JSON parsing for `/v1/stripe/webhook`, and `PUBLIC_API` allows the webhook to bypass API auth. This needs route-manifest coverage because the route appears after global auth but is intentionally public.

## Immediate Security Backlog

1. Block existing-email anon merge without verified email/OAuth proof.
2. Add `anonClaimLimiter` and tests for claim abuse.
3. Deprecate and later remove `req.query.api_key`.
4. Add `publicRunLimiter` and input caps.
5. Generate an auth route manifest from `src/router.js` plus OAuth mounts, then assert expected public/protected status in tests.
6. Add regression tests for `/v1/public/submit` requiring auth, Stripe webhook public bypass with signature rejection, and `/v1/registry/public` public access after the global middleware.

## Linked Matrix

See `auth-boundary-matrix-2026-05-12.csv` for row-level evidence, risk, and recommended action.
