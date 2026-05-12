# API Docs Contract Drift Audit

Date: 2026-05-12

Scope: local review of `public/api.html`, `public/docs.html`, `public/quickstart.html`, `README.md`, `docs/AUTHORING.md`, `src/router.js`, `src/compile.js`, and prior SDK/billing/auth/compliance audits.

## Executive Findings

1. P1: `/api` is not the API source of truth. It says "Every endpoint. Every schema." but documents 25 paths while `src/router.js` exposes 84 `/v1` route declarations plus `/health` and `/ready`.
2. P1: several documented contracts disagree with code. Account, billing, delete, compile, registry export, receipt verification, and auto-distill examples all have request/response or status-code drift.
3. P1: error and auth semantics are over-normalized in docs. The docs promise JSON errors with `code` and `request_id`, while route handlers mostly return ad hoc `{error}` shapes or text/plain webhook errors. Auth docs omit actual credential precedence and query-key behavior.
4. P1: product-critical APIs are absent from `/api`. Public run, anon bootstrap/claim, synthesize, verify, concepts, recipes, bridges, specialists, telemetry, admin, public submit, and audit log routes are either omitted or only partially covered elsewhere.
5. P1: docs examples are hand-authored, not generated. The static tests check links and encoding, but no test executes or snapshots the documented request/response examples.

## Coverage Snapshot

Extracted from local files:

```text
public/api.html documented paths: 25
src/router.js /v1 route declarations: 84
```

The API reference documents:

- account basics,
- compile basics,
- run/wrap/recall/embed,
- capture/labels/auto-distill,
- receipt verification,
- registry public/export,
- health/ready.

It omits or under-documents:

- pricing, anonymous bootstrap/claim, signout, session login/logout,
- public concepts, public run, public featured, public submit,
- synthesize, synthesize stream/batch, verify, publish,
- concepts, recipes, search, compose,
- jobs, specialists, waitlist/train/run/weights,
- bridge observations/suggestions/auto-synthesize,
- telemetry, library, admin, diagnostics, Stripe webhook,
- audit log and memory recall.

## Most Important Contract Drifts

- `POST /v1/account/delete`: docs require `confirm` and return `deleted_at`; code ignores `confirm` and returns only `{ok,message}`.
- `POST /v1/account/cancel`: docs say period-end downgrade; code immediately changes the tenant to free.
- `POST /v1/account/change-plan`: docs return a nested tenant object; code returns current plan plus pending plan and payment URL.
- `GET /v1/account`: docs show `usage`; code returns `used`, `remaining`, pending billing fields, Stripe ids, OAuth provider flags, and no `usage`.
- `POST /v1/compile`: docs include `mode`; code accepts `task`, `examples`, `corpus_namespace`, `base_model`, and `deploy_hook`.
- compile examples: docs use `cmp_` ids and `ready`; code uses `job_` ids and queued/running/completed/failed.
- `GET /v1/registry/export`: docs say NDJSON; code returns a JSON envelope.
- `POST /v1/receipts/verify`: docs claim 409/410 errors; code returns 200 invalid envelopes for signature failures and 503 if secret is missing.

## Recommended Fix

Make route contracts generated:

1. Add a route manifest with method, path, auth status, maturity, request schema, response schema, and examples.
2. Generate `/api`, README API inventory, SDK fixtures, and docs examples from that manifest.
3. Add tests that compare documented examples against route snapshots.
4. Mark routes as `public`, `authenticated`, `admin`, `webhook`, `preview`, `internal`, or `legacy`.
5. Keep manual prose for explanation only; never hand-maintain request/response schemas in multiple files.

See `api-docs-contract-matrix-2026-05-12.csv` for row-level findings.
