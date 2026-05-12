# Audit Observability Evidence Audit

Date: 2026-05-12

Scope: local review of audit log, telemetry, health, readiness, status, receipt verification, runtime invocation metrics, admin diagnostics, public trust/security/status/API/audit pages, and matching tests.

This slice focuses on operational evidence: what the product can prove after an action happens, not whether the action itself works.

## Executive Findings

1. P0: the durable tenant audit log is not implemented. `/audit-log` promises per-tenant JSON/CSV logs for captures, label exports, distill jobs, artifact signings, plan changes, and key rotation, but `GET /v1/audit/log` always returns a 503 beta envelope with `entries: []`.
2. P1: there is no append-only audit event table or shared `recordAudit` path. Current state is spread across `invocations`, `compile_jobs`, `observations`, `stripe_events`, `tenants`, and local artifact-runner callbacks.
3. P1: telemetry overstates receipt evidence. `/v1/telemetry` sets `receipts_verified` equal to successful invocations and `receipt_bearing_runs` also counts runs where the caller could request `receipt: false`.
4. P1: the status page is mostly client-side probing plus static uptime and incident copy. It has no stored uptime history, no incident table, and some `/ready` fields it tries to render are not emitted by the route.
5. P1: the public API error contract promises `code` and `request_id`, but route handlers mostly return ad hoc `{error}` envelopes or text responses with no request-id middleware.
6. P1: privacy wording around audit rows is ahead of code. Public audit copy says full prompt/response text is not logged and raw observation text is opt-in/purgeable, while hosted capture stores prompt/response slices and no purge route was found.

## Evidence Map

| Surface | Current Evidence | Operational Truth |
| --- | --- | --- |
| `/health` | Public route returns status, version, region, uptime, and store counts. | Useful liveness probe, not readiness or incident evidence. |
| `/ready` | Public route returns readiness status and public low-detail checks from `runtimeReadiness()`. | Useful deploy gate, but no version, uptime, check hints, or stored history. |
| `/v1/health` | Admin-only route returns feature flags, readiness, stats, and environment shape. | Useful staff diagnostic surface; access itself is not audited. |
| `/v1/telemetry` | Uses `invocations` and `compile_jobs` to derive counts, latency, cache, K-score median, and recent events. | Useful aggregate telemetry, not an audit log or receipt-verification ledger. |
| `runtime.logInvocation` | Persists version id, concept id, tenant, latency, cache, error, and timestamp. | Good minimal run metrics without input/output bodies. |
| `runArtifact(..., { audit })` | Local artifact runner can call a callback with `kolm-audit-1` entries. | Good local hook, but not a durable hosted tenant audit log. |
| Stripe webhooks | Stores `stripe_events` id/type/received_at and skips duplicate ids. | Solid idempotency evidence, but not enough for tenant-visible billing audit history. |
| `/v1/audit/log` | Always returns `503`, `audit_log_beta`, and `entries: []`. | The shipped route is a stub, not a queryable audit log. |

## Highest-Risk Gaps

### Durable Audit Log

The audit-log page says every action touching data leaves a signed per-tenant entry and can be exported as JSON, CSV, or JSONL. The route currently returns a 503 beta envelope. No local source search found an `audit_events` table, an opt-in route, export formats, or event writers for capture, label export, distill, compile signing, account deletion, plan change, key rotation, or admin access.

Launch interpretation: audit logging should be described as planned/beta until a durable append-only event path exists.

### Receipt Metrics

`/v1/telemetry` documents the truth in comments: `receipt_bearing_runs` is derived from successful invocations and `receipts_verified` is a legacy alias. That means the metric is not a count of verifier calls. Because `/v1/run` logs invocation inside `runtime.runVersion` before the route decides whether to attach a receipt, `receipt_bearing_runs` can also count runs where the caller passed `receipt: false`.

Launch interpretation: call the current field `successful_runs` or add real receipt issuance and verification tables.

### Status Evidence

The status page probes a few endpoints from the viewer's browser and renders static uptime windows and incident entries. It says uptime is updated continuously from health probes, while the repo scan found status copy and client probes, not a cron, probe history, uptime store, or incident data model. The page also expects `/ready` fields such as `version`, `uptime_s`, `hint`, and `public`, while the route emits only `status`, `production_like`, and checks with `name`, `ok`, `required`, and `label`.

Launch interpretation: status is a browser smoke page plus static incident notes, not an evidence-grade status system.

### Error Traceability

`public/api.html` promises every endpoint returns JSON errors with `error`, `code`, and `request_id`. Source search found no request-id middleware or standard error envelope. Many routes return bare `{error}`, and webhook failures return `text/plain`.

Launch interpretation: do not promise request IDs until middleware and tests enforce them across routes.

### Privacy And Evidence Boundaries

Audit-log copy says full prompt/response text is not logged and observation raw text is opt-in/purgeable. Hosted capture routes currently store prompt and response slices in `observations`, and label export can return full pairs. Local artifact-runner audit callbacks include `input_preview`; the test asserts that an email address appears in the preview. These are not automatically wrong, but they need explicit data classification, retention, redaction, and purge policy.

Launch interpretation: separate "audit metadata", "captured training corpus", and "local hook payload" in public copy and code.

## Release-Blocking Tests

- `GET /v1/audit/log` returns tenant-scoped events only after opt-in, supports JSON/CSV/JSONL, and never returns another tenant's row.
- Capture proxy, label export, auto-distill, compile, publish, account delete, key rotation, and plan change each write one audit event with expected redaction.
- `POST /v1/receipts/verify` writes a verification event and increments a verifier metric.
- `/v1/run` with `receipt: false` does not increment receipt-bearing counts.
- A request-id middleware attaches `request_id` to JSON errors and response headers across representative 4xx/5xx routes.
- `/status` renders from a stored status/incident source or labels hardcoded sections as static.
- `/ready` schema tests cover the fields consumed by `status.html`.

## Recommended Build Order

1. Add an `audit_events` table and a shared `recordAudit({ tenant, actor, op, resource, hashes, metadata, redactions })` helper.
2. Add request-id middleware and a typed error envelope before expanding public API docs.
3. Add `receipt_issuance` and `receipt_verifications` records so telemetry can distinguish issued, opted-out, verified, invalid, and unverifiable receipts.
4. Add a small `status_events` or external monitor import path before making uptime/SLA claims.
5. Generate audit/status/API docs from route and event schemas so the public pages cannot drift silently.

See `audit-observability-evidence-matrix-2026-05-12.csv` for row-level evidence and actions.
