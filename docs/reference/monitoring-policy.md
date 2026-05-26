# Monitoring Policy

Canonical reference for the W890-15 audit. Twelve sections covering the
Sentry runbook, status-page contract, alert thresholds, uptime providers,
metrics catalog, dashboards-to-build, and the on-call rotation template.

This document is generated alongside seven `data/w890-15-*.json` artifacts
via `node scripts/w890-15-monitoring-audit.cjs`. The artifacts are the
source of truth; this file is the human-readable summary.

Cross-references:

- `docs/reference/codebase-organization.md` (W890-1)
- `docs/reference/code-quality-policy.md` (W890-2)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/logging-policy.md` (W890-4)
- `docs/reference/configuration-policy.md` (W890-7)
- `docs/reference/storage-policy.md` (W890-8)
- `docs/reference/api-policy.md` (W890-9)
- `docs/reference/cli-policy.md` (W890-11)
- `docs/reference/documentation-policy.md` (W890-12)
- `docs/runbook-alerts.md` (W890-15 companion runbook)

## 1. Sentry runbook

Server-side crash reporting is opt-in via `SENTRY_DSN`. The shim at
`src/sentry-init.js` calls `@sentry/node` dynamically and is a safe
no-op when either the env var OR the package is absent. This keeps the
default install footprint small while making crash visibility a single
env-var flip away.

Every 500 response in `server.js` calls
`globalThis.__kolmSentry.captureException(err, {...})` with tags
(`kind:'http_500'`, request method, the short `error_id`) and extras
(path, query, tenant id when attached). The same shim is also wired into
the process-level `unhandledRejection` + `uncaughtException` handlers,
so a stray throw outside an HTTP request still surfaces.

CLI and worker entry points have their own process handlers but do NOT
call Sentry — by design. CLI errors print to stderr; workers emit
`{ok:false,error,detail}` JSON on stdout and the parent process owns the
Sentry surfacing.

See `data/w890-15-sentry-coverage.json` for the audit shape.

## 2. Status page contract

`/status` (served from `public/status.html`) is a live status board. It
fetches `/health` on load and every 30 seconds, and surfaces:

- Liveness (`ok` flag)
- Version (from `/health` payload)
- Uptime (seconds since boot)
- Gateway operational state
- Capture store operational state
- Signing key operational state

When the fetch fails (network blip, offline), the card keeps its last
known values and stops updating. The static fallback grid (Gateway /
Capture / Registry / Distill / Forge / API / Website) remains visible
for crawlers and the no-JS path.

See `data/w890-15-status-page.json` for the audit shape.

## 3. Alert thresholds

Five conditions trigger pages. Threshold rationale is captured in
`docs/runbook-alerts.md`; the rationale traces to a measured baseline,
not an arbitrary number.

| Condition                  | Threshold      | Source of truth     |
|----------------------------|----------------|---------------------|
| server crash               | any            | process handlers    |
| error rate >5%             | 5 min window   | gateway 5xx counter |
| latency p95 >2s            | 5 min window   | gateway latency p95 |
| disk >90%                  | 5 min window   | retention sweep     |
| capture store unreachable  | 3 min window   | /v1/capture/health  |

See `data/w890-15-alerts.json` for the audit shape.

## 4. Uptime providers

External ping every 60s is provider-side. We support three vendors out of
the box (Betterstack, Pingdom, Datadog Synthetics) and one self-hosted
fallback (cron + curl + Slack webhook). The spec is "ping every 60s and
page on red", not a specific vendor lock-in. Each path is documented in
`docs/runbook-alerts.md` §5.

See `data/w890-15-uptime.json` for the audit shape.

## 5. Metrics catalog

The `/metrics` endpoint (Prometheus text format) is mounted in
`src/router.js` BEFORE authMiddleware so Prometheus scrapers do not need
an API key. Production deployments gate the endpoint with
`KOLM_METRICS_BEARER`.

Six W890-15 metrics are pre-registered at module load so the first scrape
after boot is in the canonical empty-state shape:

| Name                       | Type      | Labels                       |
|----------------------------|-----------|------------------------------|
| `gateway_requests_total`   | counter   | route, tenant, status        |
| `gateway_latency_p50`      | gauge     | route                        |
| `gateway_errors_total`     | counter   | route, tenant, error_class   |
| `captures_total`           | counter   | tenant, namespace            |
| `artifacts_compiled_total` | counter   | target, tenant               |
| `devices_online`           | gauge     | device_class                 |

The `kolm_*` siblings (`kolm_capture_total`, `kolm_load_queue_depth`,
`kolm_runtime_gpu_memory_bytes`, etc.) remain registered for internal
infrastructure signal; both sets co-exist on `/metrics` scrapes.

See `data/w890-15-metrics.json` for the audit shape.

## 6. Dashboards to build

Grafana panels recommended (not shipped — operator-side):

- **Gateway overview**: requests/sec, error rate %, p50 + p95 latency,
  faceted by route.
- **Capture pipeline**: captures/sec, hash chain depth, capture store
  reachability.
- **Artifact production**: compiles/hour, by target format.
- **Devices**: online devices by class (jetson / iphone / browser-wasm /
  linux-x86 / linux-arm).
- **Errors**: 500-rate over time, top error_id tag clusters from Sentry.

## 7. Error-id chain

Every 500 response carries an opaque `error_id` (12 hex chars from a
timestamped random source) on three surfaces:

1. `X-Kolm-Error-Id` response header (operator-greppable).
2. `error_id` field in the JSON body (user-reportable).
3. `error_id` tag on the Sentry event (correlatable).

The chain lets an operator follow a single user report from "I got
error_id e_abc_xyz" through Sentry to the log line that emitted it.

See `data/w890-15-error-id-chain.json` for the audit shape.

## 8. Logging vs metrics vs traces

Three observability legs, distinct contracts:

- **Logs** (`src/log.js`): structured JSON when `KOLM_LOG_STRUCTURED=1`,
  human-readable otherwise. See `docs/reference/logging-policy.md`.
- **Metrics** (`src/prometheus-exporter.js`): Prometheus text format on
  `/metrics`. See §5 above.
- **Traces** (`src/otel.js`): OpenTelemetry exporter, opt-in via
  `OTEL_EXPORTER_*` env vars. Spans wrap each HTTP route.

The legs do not duplicate. Logs are for narrative + replay; metrics for
aggregation + alerting; traces for cross-service latency attribution.

## 9. Provider-side action list (deferred)

These steps live in the operator's provider console, not in the repo. The
spec is "set them up before V1 launch"; the runbook documents the
contract so the setup is mechanical:

- [ ] Provision Sentry org/project; set `SENTRY_DSN` in deploy env.
- [ ] Configure external uptime monitor (Betterstack/Pingdom/Datadog) at
      `https://api.kolm.ai/health` with 60s interval.
- [ ] Wire PagerDuty escalation policy + Slack `#ops-alerts` channel.
- [ ] Stand up Grafana scraping `/metrics` with `KOLM_METRICS_BEARER`.
- [ ] Build the dashboards in §6.
- [ ] Run the validation suite in §10.

## 10. Validation suite

Before flipping V1 live, the operator runs five smoke checks:

1. Trigger a forced 500 in staging; verify `X-Kolm-Error-Id` header is
   present in the response and the matching Sentry event has the
   `error_id` tag.
2. Stop the staging process abruptly; verify the external uptime monitor
   pages within 2 consecutive 60s intervals (~2 min).
3. Hammer the gateway with 100 requests/sec for 5 minutes; verify the
   p95 latency stays under 2s and the 5% error-rate alert does NOT trip.
4. Fill the staging disk to 91%; verify the disk-90% alert trips within
   5 minutes.
5. Stop the staging capture store; verify the capture-unreachable alert
   trips within 3 minutes.

## 11. On-call rotation template

Two-tier rotation. Primary owns the pager 24/7 for one week; secondary
backs up + handles weekday business hours. Handover Mondays 09:00 local.

| Tier      | Ack SLA  | Escalation                 |
|-----------|----------|----------------------------|
| Primary   | 5 min    | secondary after 15 min     |
| Secondary | 15 min   | engineering lead after 30  |

Postmortem owner is the primary on the day the page fired. Postmortem
template lives at `docs/incident-template.md` (to be authored).

## 12. References

- `data/w890-15-sentry-coverage.json`
- `data/w890-15-status-page.json`
- `data/w890-15-alerts.json`
- `data/w890-15-uptime.json`
- `data/w890-15-metrics.json`
- `data/w890-15-error-id-chain.json`
- `data/w890-15-ship-gate-snapshot.json`
- `docs/runbook-alerts.md` (companion runbook)
- `scripts/w890-15-monitoring-audit.cjs` (this audit driver)
- `tests/wave890-15-monitoring.test.js` (lock-in tests)
