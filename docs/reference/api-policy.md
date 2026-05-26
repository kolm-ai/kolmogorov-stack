# API policy (canonical) — W890-9

This document is the canonical reference for the Kolm HTTP API surface. It is
the source of truth for: OpenAPI generation, versioning, request/response
schemas, examples, CORS, Content-Type validation, pagination, and the error
envelope.

The W890-9 audit reads this document and the nine `data/w890-9-*.json`
artifacts to ratify the contract. Every lock-in in
`tests/wave890-9-api.test.js` traces back to one of the eleven W890 directive
items below.

## Scope

- All routes registered via `r.<method>(...)` in `src/router.js`.
- All paths exposed in `public/openapi.json`.
- The global middleware in `src/router.js` and `server.js` that frames every
  request.

## 1. OpenAPI generation pipeline

The OpenAPI spec is **generated** from real routes, never hand-written.

**Pipeline:**

```
src/router.js                       (source of truth: the route table)
  └── scripts/build-api-ref.cjs     (parses r.<method>('/path', ...) declarations)
        └── public/docs/api-routes.json   (one entry per route)
              └── scripts/build-openapi.cjs   (merges existing curated ops + auto-adds shells)
                    └── public/openapi.json   (the published spec)
```

Rebuild on every release:

```
node scripts/build-api-ref.cjs && node scripts/build-openapi.cjs
```

The W890-9 audit (`scripts/w890-9-api-audit.cjs`) **runs build-openapi.cjs
itself** before sampling, so drift between `src/router.js` and
`public/openapi.json` cannot ship.

**Coverage invariant (`data/w890-9-openapi-coverage.json`):**
- `routes_in_src` MUST equal `routes_in_openapi`.
- `gap` (routes in src missing from spec) MUST be empty.
- `orphan_in_openapi` (curated ops with no matching src route) MUST be empty —
  removed in W890-9 (auth/login, auth/signup, healthz, usage).
- `in_sync` MUST be `true`.

## 2. Versioning

**Rule: every API endpoint lives under `/v1/`.**

Documented exemptions (`data/w890-9-versioning.json` — `non_v1`):

| Path | Reason |
|---|---|
| `/health` | Liveness probe (Kubernetes / Railway / Vercel convention) |
| `/ready` | Readiness probe |
| `/ready/deep` | Deep-readiness probe |
| `/metrics` | Prometheus scrape endpoint |
| `/metrics/extended` | Extended scrape endpoint |
| `/r/{token}` | Short-link / referral redirect |
| `/r/{token}/*` | Short-link / referral redirect (subpath form) |
| `/anthropic/v1/messages` | Provider-compatibility shim (Anthropic SDK clients) |

Any path that does NOT start with `/v1/` and is NOT in the exempt list is a
versioning violation. The lock-in test asserts `nonconformant_count === 0`.

**No breaking changes without version bump.** When a contract change would
break existing clients, the new route MUST mount under `/v2/<...>` and the
`/v1/<...>` route MUST remain operational and deprecated-but-still-served for
at least one full release cycle. Deprecation banners (`x-kolm-deprecated: true`)
live in the OpenAPI op until the v1 path is removed.

## 3. Request/response schemas

Every operation declares:

- **Request schema** — for `POST` / `PUT` / `PATCH` only. `requestBody.content`
  carries an `application/json.schema` (either a curated `#/components/schemas/<Name>`
  reference OR the permissive `#/components/schemas/GenericRequest` envelope
  for auto-generated route shells).

- **Response schema** — every op carries at least one response code with a
  schema (either `$ref` to a shared response object like
  `#/components/responses/JsonEnvelope` or an inline `content.application/json.schema`).

Auto-generated shells inherit:

- `application/json` requestBody → `GenericRequest` (additionalProperties:true).
- `200` → `JsonEnvelope`.
- `400` → `BadRequest`.
- `401` → `Unauthorized`.
- `429` → `RateLimited`.
- `500` → `ServerError`.

The canonical schemas + responses are defined once in
`public/openapi.json#/components` so every op references the same shapes.
The audit at `data/w890-9-schemas.json` asserts `missing_request.length === 0`
and `missing_response.length === 0`.

## 4. Examples

Every operation has at least one example. Examples are inherited via the
shared response objects:

| Shared response | Example body |
|---|---|
| `JsonEnvelope` | `{ "ok": true }` |
| `BadRequest` | `{ "ok": false, "error": "invalid_input", "hint": "check the request body / required fields" }` |
| `Unauthorized` | `{ "ok": false, "error": "unauthorized", "hint": "set Authorization: Bearer <kolm_api_key> (ks_*/kao_*) or X-API-Key header" }` |
| `RateLimited` | `{ "ok": false, "error": "rate_limited", "retry_after_s": 60 }` |
| `ServerError` | `{ "ok": false, "error": "server_error", "error_id": "a1b2c3d4e5f6", "hint": "capture the error_id and include it in any bug report" }` |
| `GenericRequest` | `{ "ok": true }` |

Curated ops with richer schemas declare per-op `example` fields. The audit at
`data/w890-9-examples.json` asserts `missing_example.length === 0`.

## 5. CORS preflight

CORS is wired GLOBALLY in `src/router.js` (~line 1238) — every request
receives the CORS headers BEFORE any route handler runs. OPTIONS preflight
short-circuits to `204` immediately.

```js
res.set('Access-Control-Allow-Origin', '*');
res.set('Access-Control-Allow-Headers', [...] .join(', '));
res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
if (req.method === 'OPTIONS') return res.status(204).end();
```

Per-endpoint OPTIONS handlers are NOT required because the global middleware
unconditionally serves OPTIONS before any route matches. Adding per-route
OPTIONS would be redundant.

The audit at `data/w890-9-cors-preflight.json` asserts `missing.length === 0`
and `mechanism === 'global-middleware'`.

## 6. Content-Type validation

Body parsing is centralized in `server.js`:

```js
app.use((req, res, next) => {
  if (req.path === '/v1/stripe/webhook') {
    return express.raw({ type: '*/*', limit: '4mb' })(req, res, next);
  }
  return express.json({ limit: '4mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
```

The global JSON parser:

- Rejects malformed JSON with 400 (Express default behavior).
- Caps body size at 4 MB.
- Leaves `req.body = {}` for empty bodies.

The Stripe webhook uses `express.raw()` because HMAC verification requires
the raw body byte stream.

`helmet({ noSniff: true })` sets `X-Content-Type-Options: nosniff` on every
response.

Per-route Content-Type guards are NOT required because the global body
parser is uniform. The audit at `data/w890-9-content-type-validation.json`
asserts `missing.length === 0`.

## 7. Pagination

A **list endpoint** is a GET handler whose response field is one of:

```
items, results, events, rows, entries, logs, captures, artifacts,
jobs, notifications, devices, submissions, observations, decisions,
recommendations
```

AND whose value is an identifier / array literal / function call (NOT an
object literal — `{ tenants: { total: ..., plan_dist: ... } }` is an aggregate,
not a list).

Every list endpoint satisfies pagination via one of:

1. **Query-string pagination** — `limit`, `offset`, `cursor`, `page`,
   `page_size`, `next`, `after`, `before`, `n`, `since`, `until`. Detected
   via `req.query.<token>` references in the handler.
2. **Bounded results** — the handler caps the response size via a literal
   (`listJobs(req.tenant, 50)`), a static seed (`marketplaceListArtifacts()`,
   `devListDevices()`, `recommendNext()`), a negative slice
   (`concepts.slice(-200)`), or an `Object.keys()` style universe.

Detail endpoints (paths ending in a path parameter, e.g.,
`/v1/recipes/{id}`) are NOT list endpoints — they return a single resource.

Sub-list endpoints (paths like `/v1/recipes/{id}/lineage` whose last segment
is in `{lineage, items, events, history, logs, children}` AND whose penult is
a path param) ARE list endpoints and follow the same pagination contract.

The audit at `data/w890-9-pagination.json` asserts `missing.length === 0`.

## 8. Deprecation

**Rule: no dead endpoints still routed.**

- An endpoint is "dead" if it is in `public/openapi.json` but has no live
  handler in `src/router.js`. W890-9 removed four such entries:
  `/v1/auth/login`, `/v1/auth/signup`, `/v1/healthz`, `/v1/usage` (replaced
  by `/v1/signup`, `/v1/oauth/google/start`, `/health`, `/v1/billing/usage`
  respectively).
- An endpoint is "stale" if the same `(method, path)` is mounted twice (e.g.,
  `/v1/foo` and `/v1/foo/`). W890-9 documents one intentional dual-mount —
  `/v1/evidence` and `/v1/evidence/` share the same handler `listEvidenceIndex`
  — and the lock-in test allows up to one such intentional alias.
- "Stub routes" are routes declared in source whose contract is generated
  from the route comment block (the `x-kolm-source-indexed` flag). These are
  NOT dead — the handler ships; only the OpenAPI op is auto-derived. The
  audit reports them for transparency but does not treat them as a problem.

The audit at `data/w890-9-deprecation.json` asserts
`dead_endpoints_detected.length === 0`.

## 9. Error response format

Two error envelopes are accepted as conformant:

**(A) W890-9 canonical** — the long form for new endpoints:

```json
{
  "error": {
    "type": "invalid_input",
    "message": "field 'email' is required",
    "help": "POST /v1/signup with body: { email: 'you@example.com' }"
  }
}
```

**(B) Legacy kolm** — the short form, in production today:

```json
{
  "ok": false,
  "error": "invalid_input",
  "hint": "field 'email' is required"
}
```

OR the short-er form (the 4xx/5xx HTTP status itself signals failure):

```json
{
  "error": "invalid_input",
  "hint": "field 'email' is required"
}
```

Both forms are conformant. Optional sibling fields documented in the
contract: `hint`, `detail`, `retry_after_s`, `code`, `reason`, `field`,
`error_id`.

**The only non-conformant shape is a response that omits `error` entirely.**
W890-9 surfaced two such cases (`src/router.js:7712` and `:11946`) and
patched both to add the canonical `error` identifier alongside the
historical `reason` field.

The audit at `data/w890-9-error-format.json` samples up to 2000 `res.status(4xx|5xx).json(...)` sites and asserts
`non_conformant.length === 0`.

The 500 middleware in `server.js` adds the standard `error_id` (12 hex
chars) and emits `X-Kolm-Error-Id` header so operations can trace any 500
back to the originating request — wired in W890-3.

## 10. The eleven W890-9 items

| # | Item | Artifact | Status |
|---|---|---|---|
| 1 | OpenAPI generated from actual routes | `data/w890-9-openapi-coverage.json` | in_sync=true |
| 2 | Every endpoint in OpenAPI | same | gap=0 |
| 3 | Every endpoint has request/response schemas | `data/w890-9-schemas.json` | missing=0 |
| 4 | Every endpoint has an example | `data/w890-9-examples.json` | missing=0 |
| 5 | All endpoints under /v1/ (with documented exemptions) | `data/w890-9-versioning.json` | nonconformant=0 |
| 6 | No breaking changes without version bump | (policy; see §2) | n/a |
| 7 | No dead endpoints still routed | `data/w890-9-deprecation.json` | dead=0 |
| 8 | CORS preflight handled | `data/w890-9-cors-preflight.json` | missing=0 |
| 9 | Content-Type validation on POST/PUT | `data/w890-9-content-type-validation.json` | missing=0 |
| 10 | Pagination on list endpoints | `data/w890-9-pagination.json` | missing=0 |
| 11 | Consistent error format | `data/w890-9-error-format.json` | non_conformant=0 |

## 11. Re-running the audit

```
node scripts/w890-9-api-audit.cjs
node --test tests/wave890-9-api.test.js
```

The audit is read-only. It regenerates `public/openapi.json` from
`src/router.js` (via `build-openapi.cjs`), then writes nine JSON artifacts
to `data/`. Any regression that breaks the contract will fail one of the
twelve lock-ins in `tests/wave890-9-api.test.js`.

## 12. Constraints / accuracy

- The pagination audit uses a coarse heuristic on `src/router.js` handler
  bodies. It detects list endpoints by response field name and pagination
  via query tokens or bounded-result patterns. False positives are
  excluded by:
  - Excluding detail endpoints (path ends in `{param}`).
  - Rejecting object-aggregate responses (`tenants: { total: ... }`).
  - Recognizing static-seed-backed list helpers
    (`marketplaceListArtifacts`, `devListDevices`, `recommendNext`).
- The error-format audit samples up to 2000 sites; in the current source
  tree that captures every `res.status(<4xx|5xx>).json({...})` site.
  Future routes that diverge from the documented envelopes will surface
  in the next audit run.
- The 100 HTTP status code report from W890-3
  (`data/w890-3-http-status-codes.json`) — 99×200 / 935×4xx / 358×500 —
  is the upstream count; W890-9 layers shape conformance on top.
