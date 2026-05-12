# Public Registry Governance Audit - 2026-05-12

## Scope

This pass reviews the public registry, public concept listing, publish paths, submission queue, Atlas, leaderboard, registry export, browser SDK, service worker cache, SDK helpers, seed data, and existing test coverage.

Reviewed local sources:

- `src/router.js`
- `src/registry.js`
- `src/verifier.js`
- `src/auth.js`
- `server.js`
- `public/registry.html`
- `public/leaderboard.html`
- `public/api.html`
- `public/device.html`
- `public/trust.html`
- `public/docs/rs-1.md`
- `public/sdk.js`
- `public/sw.js`
- `sdk/node/index.mjs`
- `sdk/node/test/sdk.test.mjs`
- `examples/*.json`
- `tests/e2e.test.js`
- `tests/site.test.js`

## Executive Findings

The public registry is useful as a demo catalog and as a public executable-source feed. It is not yet governed like a trusted artifact registry.

The review workflow is advisory rather than enforced. `POST /v1/public/submit` writes a `pending_review` submission row, and admins can list submissions. No approval, rejection, promotion, or status mutation route was found. Separately, the authenticated synthesis and manual publish routes accept `visibility: "public"` and call `registry.createConcept` directly, making public entries visible, exportable, and runnable without passing through that submission queue.

The manual publish path is especially weak for public trust. `POST /v1/publish` compiles the submitted source and runs `verify`, but it does not require non-empty examples, does not enforce `QUALITY_GATE`, and publishes regardless of the returned score. A direct verifier smoke showed an empty evaluation set returns `quality_score: 1`, `pass_rate_positive: 1`, `reject_rate_negative: 1`, `runs: 0`. That means an authenticated tenant can publish a public entry with no actual evaluation evidence.

Atlas and Leaderboard overstate what their data can prove. Both pages fetch `/v1/public/concepts`, but that endpoint uses `registry.listConcepts`, which returns concept metadata without version evaluation, K-score, signature, manifest, size, or latency fields. The pages then try to derive K-score from missing `latest_version` or `versions` fields and hardcode `signed` in each row. The generated links point to `/registry/{id}`, but `server.js` only serves `/registry` and `/atlas`, not dynamic registry detail pages.

The export path distributes executable source without governance metadata. `GET /v1/registry/export` returns all public concepts' head version source, source hash, pass rate, latency, and size in a JSON envelope. It does not include review status, license, publisher identity, provenance, trust level, artifact hash, receipt/signature metadata, revocation status, moderation state, or the eval bundle used to justify public ranking. The browser SDK and service worker are designed to fetch and cache this export for offline execution, so stale or later-revoked entries need an explicit policy.

Existing tests do not protect this surface. The e2e suite checks that unauthenticated `GET /v1/public/concepts` returns 200. The Node SDK test exercises `POST /v1/public/submit` enough to see a `sub_` id. There is no test for review bypass, public manual publish with empty evals, `/v1/registry/export` schema and governance fields, Atlas/Leaderboard field availability, nonexistent detail links, public run abuse controls, or revocation behavior.

## Public Lifecycle Truth

| Step | Current Code Path | Governance Truth |
| --- | --- | --- |
| Create generated public concept | Authenticated `POST /v1/synthesize`, stream, or batch accepts `visibility` and calls `registry.createConcept`. | Public if accepted by synthesis; no review state. |
| Create manual public concept | Authenticated `POST /v1/publish` accepts `visibility`, compiles JS, runs verifier, then publishes. | Public even with empty evals or low quality score. |
| Submit for review | Authenticated `POST /v1/public/submit` inserts `status: pending_review`. | Queue is not on the critical path for public visibility. |
| Admin review | `GET /v1/admin/submissions` lists rows. | No approve/reject/promote route found. |
| Public browse | `GET /v1/public/concepts` returns last 200 public concept rows. | No version/eval/signature data for Atlas or Leaderboard. |
| Public detail | `GET /v1/public/concepts/:id` returns public concept with all stripped-vector versions. | Version source and evaluation are exposed as API JSON, not as a governed artifact page. |
| Public run | `POST /v1/public/run` runs public concept/version without auth. | No explicit route limiter; relies on the source safety scan and runtime limits. |
| Public export | `GET /v1/registry/export` returns executable source for all public head versions. | Rate-limited, but not signed as a registry release and not attached to trust metadata. |

## What Is Solid

- The public registry read path is intentionally separated before `authMiddleware`, while private concept APIs sit after `r.use(authMiddleware)`.
- `/v1/public/submit` is authenticated and checks tenant ownership before accepting a submission row.
- `registry.createConcept` sanitizes name, description, and tags before storing rows that later render publicly.
- `/v1/registry/export` has an explicit 60/min/IP limiter and a short cache header.
- Tenant-owned `.kolm` compile artifacts are still protected behind authenticated job routes; the public registry export is source rows, not direct artifact-file downloads.
- Seed examples are explicit JSON fixtures and currently include `visibility: "public"`, so the bootstrapped demo catalog is reproducible.

## Gaps That Need Correction

1. Make public visibility stateful. A concept/version should have `review_status`, `trust_level`, `published_by`, `approved_by`, `approved_at`, `license`, `provenance`, and `revoked_at` fields before it appears in public browse, run, export, SDK, or service-worker feeds.
2. Put the review queue on the critical path. Direct `visibility: "public"` should either create a private draft plus submission, or require admin privileges until the review workflow exists.
3. Enforce non-empty evaluation evidence for public publish. Empty evals must not produce public entries, and low quality must not be publishable unless explicitly marked unverified/private.
4. Canonicalize the public registry schema. Pick one browse endpoint and make Atlas, Leaderboard, API docs, SDKs, and tests consume the same fields.
5. Remove unsupported UI badges. Do not display K-score, signed, manifest, or comparable public-eval claims unless the row includes the evidence and a verifier can check it.
6. Implement public detail and download surfaces intentionally. Dynamic `/registry/{id}` links need either a real page or a different target. Public `.kolm` artifact download should be separate from source export and should carry signature/receipt evidence.
7. Add revocation and cache invalidation. The browser SDK and service worker cache `/v1/registry/export`; they need a revocation list, minimum registry version, and cache invalidation semantics.
8. Treat public run as an abuse surface. It needs a limiter, quota class, sandbox trust tier, and observability separate from authenticated tenant runs.

## Release-Blocking Tests

- Authenticated `POST /v1/publish` with `visibility: "public"` and empty evals must fail, or create a non-public draft.
- Authenticated `POST /v1/synthesize` with `visibility: "public"` must create a pending/private entry unless the caller has approval rights.
- `POST /v1/public/submit` must be paired with approve/reject tests before marketing public review.
- Atlas and Leaderboard should be fixture-tested against the actual `/v1/public/concepts` response shape.
- `/registry/{id}` links should be covered by route tests.
- `/v1/registry/export` should have schema tests for trust metadata, signature/registry hash semantics, license/provenance, and revocation.
- `/v1/public/run` should have unauthenticated abuse-limit tests.
- Browser SDK/service worker registry caching should be tested against revocation or registry-version changes.

## Decision

Treat the current public registry as an uncurated demo/source catalog until the governance model ships. It can support developer experiments if copy says so plainly. It should not be positioned as a signed, comparable, curated, marketplace-grade artifact registry until review enforcement, evidence fields, detail/download pages, revocation, and tests are in place.
