# Continuous onramp: keep your signed evidence current from logs you already have

The Agent Security-Review scan turns a batch of agent logs into an Ed25519-signed,
offline-verifiable readiness report. The onramp is how you keep that evidence
current without a person re-uploading a file every week: point your existing logs
at one endpoint on a schedule, and each run produces a fresh signed report.

This document covers:

1. `POST /v1/audit/import` - the single onramp endpoint.
2. The sidecar pattern - a tiny proxy that tees your agent logs to the endpoint on
   a schedule.
3. How the onramp relates to the Continuous subscription tiers.

All you need is a kolm API key (`ks_...`). Questions go to dev@kolm.ai.

---

## 1. `POST /v1/audit/import`

Auth-gated (send `Authorization: Bearer ks_...`). Tenant-fenced: the report is
always written to the calling key's tenant, never to a value from the body. Size
capped. It never throws: every failure is a JSON `{ ok: false, error, detail }`
with a clean HTTP status.

It accepts logs two ways and runs them through the SAME analysis and signing path
as `POST /v1/audit/scan`, so the report you get back is identical in shape and is
verifiable offline.

### Body

| Field           | Type                    | Notes                                                                 |
| --------------- | ----------------------- | --------------------------------------------------------------------- |
| `source`        | `"inline"` or `"url"`   | Optional. Inferred: `url` if a `url` is present, else `inline`.       |
| `logs`          | string, array, object   | Inline source. JSONL text, a JSON array of records, or a wrapper with a `data`/`rows`/`events`/`generations` array. |
| `url`           | string                  | URL source. An `http(s)` endpoint that returns your logs (JSONL or JSON). |
| `headers`       | object                  | URL source. Headers sent with the fetch, for example a bearer for your log API. |
| `subject`       | string                  | Optional. What the report is about. Defaults to `Agent fleet`.        |
| `source_label`  | string                  | Optional. A short label recorded on the report (for example `langfuse`). |
| `retention_days`| number                  | Optional. Your declared log retention window, mapped into the report. |
| `sign`          | boolean                 | Optional, default `true`. When `false`, runs the analysis without signing. |
| `persist`       | boolean                 | Optional, default `true`. When `false`, returns the report inline without storing a row. |

### Inline example

```bash
curl -sS https://kolm.ai/v1/audit/import \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "inline",
    "subject": "Support agent fleet",
    "logs": [
      { "ts": "2026-06-09T00:00:00Z", "agent": "support-1", "tool": "db.read", "action": "call", "actor": "support-1", "event_id": "e1", "grants": ["db.read"] }
    ]
  }'
```

### URL example

The URL source pulls logs from an endpoint you control. Useful when your logs
already sit behind an internal API.

```bash
curl -sS https://kolm.ai/v1/audit/import \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "url",
    "subject": "Support agent fleet",
    "source_label": "internal-log-api",
    "url": "https://logs.example.com/export/agents.jsonl",
    "headers": { "Authorization": "Bearer YOUR_LOG_API_TOKEN" }
  }'
```

### Response

```json
{
  "ok": true,
  "id": "audses_...",
  "source": "url",
  "bytes": 20480,
  "report_id": "rpt_...",
  "signed": true,
  "key_fingerprint": "fa562154...",
  "summary": { "readiness_pct": 86, "blocking_count": 1 },
  "report": { "...signed envelope..." },
  "verify_url": "https://kolm.ai/verify"
}
```

Hand `verify_url` and the `report` envelope to a reviewer; they verify the
signature offline with no kolm account.

### Limits and safety

- Size cap: a single import holds at most 24 MiB of logs and 20000 records.
  Split larger exports across calls, or run a `POST /v1/audit/sessions` session
  and ingest in chunks.
- URL source: the fetch is bounded by a 15 second timeout and the same byte cap.
  Private and loopback hosts (localhost, link-local, RFC1918) are refused so the
  endpoint cannot be turned into a server-side request forgery probe. A self
  hosted runner that legitimately needs a private target sets
  `KOLM_IMPORT_ALLOW_PRIVATE=1` on its own deployment.
- Error statuses: `400` bad input (no records, missing or refused url), `413` too
  large, `422` the logs could not be analyzed, `502` the remote url failed, `503`
  no signer configured on this deployment.

---

## 2. The sidecar pattern

You usually do not want to re-upload a file by hand every week. The sidecar is a
tiny process that tees a copy of your recent agent logs to `/v1/audit/import` on a
schedule. It holds no state of its own: it reads from wherever your logs already
live and posts them.

The shape of a sidecar:

1. On a schedule (cron, a Kubernetes CronJob, a GitHub Actions schedule, a cloud
   scheduler), collect the window of agent logs you want attested (for example the
   last 7 days).
2. POST them to `/v1/audit/import` with your kolm API key.
3. Optionally record the returned `report_id` and Trust link.

A minimal Node sidecar that reads a JSONL file and tees it:

```js
// sidecar.mjs - run on a schedule (cron / CronJob / scheduled CI job).
import fs from "node:fs";

const KOLM_API_KEY = process.env.KOLM_API_KEY;          // ks_...
const LOG_FILE = process.env.AGENT_LOG_FILE || "./agent-logs.jsonl";
const SUBJECT = process.env.ASR_SUBJECT || "Agent fleet";

const logs = fs.readFileSync(LOG_FILE, "utf8");          // JSONL your agents emit

const res = await fetch("https://kolm.ai/v1/audit/import", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${KOLM_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ source: "inline", subject: SUBJECT, logs }),
});

const out = await res.json();
if (!out.ok) {
  console.error("import failed:", out.error, out.detail || "");
  process.exit(1);
}
console.log("signed report", out.report_id, "readiness", out.summary.readiness_pct + "%");
```

Run it from cron, once a day:

```cron
# m h dom mon dow
0 6 * * *  KOLM_API_KEY=ks_xxx AGENT_LOG_FILE=/var/log/agents.jsonl node /opt/kolm/sidecar.mjs
```

Or as a Kubernetes CronJob, mount the API key from a secret and the schedule from
the spec. The same body works whether the logs are on disk, in object storage, or
behind your own API (use the `url` source for the last one).

### Pull instead of push

If your logs sit behind an internal API, skip the file step and let kolm pull:

```js
const res = await fetch("https://kolm.ai/v1/audit/import", {
  method: "POST",
  headers: { "Authorization": `Bearer ${KOLM_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    source: "url",
    subject: SUBJECT,
    url: "https://logs.internal.example.com/agents/recent.jsonl",
    headers: { "Authorization": "Bearer YOUR_LOG_API_TOKEN" },
  }),
});
```

---

## 3. Relationship to the Continuous tiers

The onramp is the manual or self-scheduled way to refresh evidence. The Continuous
subscription tiers do the same refresh on kolm's schedule and keep a single stable
Trust link always-current:

- Continuous Starter and Growth re-attest on a weekly or per-deploy cadence and
  expose one Trust link your buyer pins.
- The deploy hook `POST /v1/audit/continuous/deploy-hook` (auth-gated by your key)
  forces an immediate re-attestation, for example from CI after you ship.

Use the import endpoint and a sidecar when you want to drive the cadence yourself,
or to seed a first report before subscribing. Use a Continuous subscription when
you want kolm to hold the schedule and the always-current link.

Questions: dev@kolm.ai
