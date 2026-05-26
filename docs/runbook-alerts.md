# Alerts Runbook

Canonical runbook for the five W890-15 alert conditions. Lists threshold
rationale, recommended providers, probe targets, and escalation steps.
Companion document: `docs/reference/monitoring-policy.md`.

Cross-references:

- `docs/reference/monitoring-policy.md` (W890-15)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/logging-policy.md` (W890-4)
- `data/w890-15-alerts.json` (audit shape)
- `data/w890-15-uptime.json` (uptime audit shape)

## 1. Alert conditions (verbatim from KOLM_W888 Part K-1)

| Id                          | Condition                       | Threshold rationale |
|-----------------------------|---------------------------------|---------------------|
| `server_crash`              | server crash                    | Any `process.exit` outside SIGTERM/SIGINT graceful shutdown is unrecoverable; page on-call immediately. |
| `error_rate_5pct`           | error rate >5%                  | Background HTTP 5xx rate on the gateway above 5% for 5 consecutive minutes. Below this rate, single-provider hiccups are expected and the gateway's W731 failover absorbs them. |
| `latency_p95_2s`            | latency p95 >2s                 | End-to-end gateway latency p95 above 2s for 5 minutes. Above this, the wrapper-tax SLO (W887 measured +40% end-to-end) is broken; investigate provider latency or queue depth. |
| `disk_90pct`                | disk >90%                       | Capture store + artifact registry both write to local disk. At 90% the W890-8 retention sweep has fallen behind; alert before write failures cascade. |
| `capture_store_unreachable` | capture store unreachable       | `/v1/capture/health` returns non-2xx for 3 consecutive minutes. Capture is the audit trail; loss is unrecoverable. |

## 2. Recommended providers

External uptime + alerting providers. Pick one; the runbook does not lock you
into a specific vendor. Each provider can hit `/health` every 60s, page on
non-2xx, and forward to PagerDuty/Slack/email.

- **Betterstack** (formerly Better Uptime) — 30s minimum interval, generous
  free tier, native incident timeline.
- **Pingdom** — 60s interval on the entry plan, mature transaction recorder,
  pairs well with New Relic.
- **Datadog Synthetics** — 60s interval, deepest correlation with metrics
  scrape (the `/metrics` exporter feeds the same dashboard).

Self-hosted alternative: a cron'd `curl -fsS https://api.kolm.ai/health`
piped to a Slack webhook is acceptable for self-hosters; the spec is "ping
every 60s and page on red", not a specific vendor.

## 3. Probe targets

| Path             | Auth     | Use                                                                |
|------------------|----------|--------------------------------------------------------------------|
| `/health`        | public   | Liveness signal; 60s external ping target.                         |
| `/ready`         | public   | Readiness gate; fail-closed when critical config is missing.       |
| `/v1/health`     | admin    | Deep snapshot incl. provider availability + feature flags.         |
| `/status`        | public   | Human-readable status board; fetches `/health` client-side.        |
| `/metrics`       | bearer*  | Prometheus scrape target. *Open if `KOLM_METRICS_BEARER` unset.    |

## 4. Escalation

1. **Pager goes off** — on-call ack within 5 minutes. If no ack within 15
   minutes, page secondary.
2. **First five minutes** — open `/status`, check the dashboard for the
   tripping condition (error rate / latency / disk / capture).
3. **Mitigate before debugging** — if error rate or latency is the trip,
   flip the gateway W731 failover to fallback provider. If disk, trigger
   the W890-8 retention sweep. If capture, check the connection pool.
4. **Postmortem** — every page generates a blameless postmortem; the
   error_id chain (X-Kolm-Error-Id header + body + Sentry tag) gives the
   tracing thread. Lift into `data/incidents/` within 24 hours.

## 5. Uptime monitoring (the actual setup)

External ping every 60s is required per the W890-15 scope. The setup itself
runs in the provider console; the runbook documents the contract:

- **Probe URL:** `https://api.kolm.ai/health`
- **Probe method:** GET, no auth, no body
- **Interval:** 60s (matches the W888 K-1 spec)
- **Pass criterion:** HTTP 200 + JSON body with `ok:true`
- **Fail criterion:** non-2xx, timeout >5s, or JSON parse failure
- **Page after:** 2 consecutive failures (avoid single-flake pages)
- **Page channel:** PagerDuty primary; Slack `#ops-alerts` secondary

Documented threshold rationale: a single missed probe is allowable
(network blip); two consecutive at the 60s interval means a 2-minute
outage minimum, which crosses the SLO.

## 6. Threshold rationale (longer form)

Every threshold above traces to a measurement:

- **5% error rate / 5 min window.** Background single-provider transient
  rate is ~0.5-1%; the W731 failover hides the rest. >5% means failover
  is also failing or both providers are degraded.
- **2s p95 latency / 5 min window.** W887 prod benchmark measured 2478ms
  gateway mean over 10 calls. p95 at 2s is the SLO; spikes above
  consistently mean a downstream slowdown.
- **90% disk / 5 min window.** Capture + artifact stores are append-mostly
  with a retention sweep (W890-8). The sweep targets 70% steady-state;
  90% means the sweep has fallen >3 days behind.
- **3 minute capture-store unreachable.** Loss of the capture pipeline is
  the only condition in the list that's unrecoverable (no replay). Page
  hard.

## 7. Provider-side TODOs (deferred)

These steps live in the operator's provider console, not in the repo:

- [ ] Create Betterstack/Pingdom/Datadog monitor pointing at `/health`
- [ ] Configure PagerDuty escalation policy with primary + secondary
- [ ] Wire Slack `#ops-alerts` webhook
- [ ] Set up Grafana dashboard scraping `/metrics` (six W890-15 metrics)
- [ ] Sentry organisation + project + DSN; set `SENTRY_DSN` in deploy env
- [ ] Verify `X-Kolm-Error-Id` propagation: trigger a 500 in staging,
      grep the Sentry event for the matching `error_id` tag

## 8. References

- `data/w890-15-sentry-coverage.json` — Sentry path coverage audit
- `data/w890-15-status-page.json` — /status dynamic-fetch audit
- `data/w890-15-alerts.json` — alert condition + provider audit
- `data/w890-15-uptime.json` — external uptime probe audit
- `data/w890-15-metrics.json` — /metrics endpoint + six-name audit
- `data/w890-15-error-id-chain.json` — error-id chain audit
- `data/w890-15-ship-gate-snapshot.json` — ship-gate 52/52 snapshot
- `docs/reference/monitoring-policy.md` — canonical 12-section policy
