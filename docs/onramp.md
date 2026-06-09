# Onramp: get your agent logs into kolm from wherever they already run

The Agent Security-Review scan turns a batch of agent logs into an Ed25519-signed,
offline-verifiable readiness report. The onramp is how you feed it without
re-plumbing your stack: point the logs you already have at kolm, on the cadence
that suits you, and each run produces a fresh signed report.

You already emit agent traces somewhere - an OpenTelemetry collector, Datadog LLM
Observability, LangSmith, a gateway like LiteLLM or Helicone, or a JSONL file.
This document maps every one of those onto the same scan and signing path, with
copy-paste snippets.

All you need is a kolm API key (`ks_...`). Questions go to dev@kolm.ai.

---

## Integration matrix

| Where your logs live            | Use this onramp                       | Best for                                  |
| ------------------------------- | ------------------------------------- | ----------------------------------------- |
| A CI pipeline (every PR/deploy) | The `kolm-agent-audit` GitHub Action  | Gating a merge or a release on readiness  |
| Datadog LLM Observability       | The `datadog` connector               | Teams already on Datadog LLM Observability |
| LangSmith                       | The `langsmith` connector             | LangChain / LangGraph agents              |
| OpenTelemetry (gen_ai + http)   | The `otel` connector                  | Any OTel-instrumented agent               |
| LiteLLM / Helicone / Portkey / OpenRouter | `POST /v1/audit/scan` or `/v1/audit/import` (native) | Gateway users (kolm ingests these directly) |
| A JSONL file or your own API    | The sidecar + `POST /v1/audit/import` | A scheduled refresh you drive yourself    |
| A signed report in a reviewer's hands | The offline verifier at `/verify` (and language SDKs) | A buyer checking the signature, no account |

Every path lands on the same deterministic scan, so the report is identical in
shape and verifiable offline no matter how the logs arrived.

---

## 1. CI: the `kolm-agent-audit` GitHub Action

Gate a merge or a deploy on your agent's security posture. The Action reads your
logs, auto-detects the platform (Datadog / LangSmith / OpenTelemetry) or passes
provider-native logs straight through, scans them, prints a readiness and
blocking summary, and fails the job when the result is below your policy.

```yaml
# .github/workflows/agent-security.yml
name: agent security
on: [pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kolm-ai/kolm/.github/actions/kolm-agent-audit@main
        with:
          logs: ./agent-traces            # a file or a directory of log files
          api-key: ${{ secrets.KOLM_API_KEY }}
          min-readiness: "85"             # fail the job under 85 percent
          fail-on-blocking: "true"        # fail on any blocking finding
```

### Inputs

| Input              | Default              | Notes                                                             |
| ------------------ | -------------------- | ----------------------------------------------------------------- |
| `logs`             | (stdin)              | Path to a file or a directory of files. Empty reads stdin.        |
| `api-key`          | (required)           | Your `ks_...` key, from a CI secret.                              |
| `api-url`          | `https://kolm.ai`    | Base URL of the kolm API.                                         |
| `source`           | `auto`               | `auto`, `datadog`, `langsmith`, `otel`, or `raw` (passthrough).  |
| `subject`          | `Agent fleet`        | What the report is about.                                         |
| `min-readiness`    | `80`                 | Fail under this readiness percent.                                |
| `fail-on-blocking` | `true`               | Fail when any blocking finding is present.                        |
| `sign`             | `true`               | Ask for a signed report; falls back to an unsigned gate scan.     |
| `retention-days`   | (none)               | Optional declared retention window, mapped into the report.       |

### Outputs

`readiness`, `blocking-count`, `report-id`, `trust-url` (present only for a
purchased or Continuous report), `verify-url`, and `passed`.

### Running the same gate outside GitHub

The Action is a thin wrapper over `scripts/kolm-audit-ci.mjs`, which reads the
same configuration from the environment. Run it from any CI or a shell:

```bash
export KOLM_API_KEY=ks_xxx
export KOLM_AUDIT_MIN_READINESS=85
node scripts/kolm-audit-ci.mjs ./agent-traces
# or pipe logs in:  cat traces.jsonl | node scripts/kolm-audit-ci.mjs
```

It prints the summary, sets the gate exit code (non-zero on a policy violation),
and needs nothing beyond Node 18+ (it uses global `fetch`).

---

## 2. Connectors: Datadog, LangSmith, OpenTelemetry

Each connector turns a platform's agent trace export into the canonical
AuditEvents kolm analyzes - pulling the tool that was called, the model, the
egress host, the credential and agent identity, and any sensitive or redacted
hints the platform records. The connectors live in `src/connectors/` and are
used automatically by the CI Action and the CLI script (`source: auto`), or
programmatically:

```js
import { detectConnector, normalizeWith, normalizeAuto } from "kolm/src/connectors/index.js";

const raw = /* your Datadog / LangSmith / OTel export, as a string or object */;
const { source, events } = normalizeAuto(raw);   // source: 'datadog' | 'langsmith' | 'otel' | null
// events are canonical AuditEvents; POST them to /v1/audit/scan as { logs: events }.
```

`detectConnector(raw)` sniffs the platform, `normalizeWith(source, raw)` forces a
connector, and every entry point is defensive: an unknown or malformed shape
returns `[]` rather than throwing.

### Datadog LLM Observability

Maps each LLM Observability span by kind: `llm` spans become model events (model
and provider host from `meta.metadata`), `tool` spans become tool events (the
destination host is read from the tool input), and any `tool_calls` the model
emitted in an `llm` span output become their own tool events. Identity comes from
`ml_app`, the `agent:` / `service:` tags, and an `api_key_id:` tag when present.

```bash
# Export your spans (Datadog LLM Observability), then gate on them:
node scripts/kolm-audit-ci.mjs ./datadog-spans.json
```

### LangSmith

Flattens the run tree (including `child_runs`). `llm` / `chat_model` runs become
model events with the tool allow-list from `extra.invocation_params.tools` (so
over-permission is measurable), and the tool calls inside `outputs.generations`
become tool events. `tool` runs become tool events; `retriever` runs feed the
retrieval-integrity checks. Identity comes from `extra.metadata.user_id` and the
api key id when LangSmith records it.

```bash
node scripts/kolm-audit-ci.mjs ./langsmith-runs.json
```

### OpenTelemetry

Reads OTLP/JSON (`resourceSpans` -> `scopeSpans` -> `spans`, attributes as
`[{key,value}]`) and a flattened span list. GenAI spans (`gen_ai.*`) become model
events (model from `gen_ai.request.model`, host from `gen_ai.system` or
`server.address`), `execute_tool` spans become tool events, and HTTP spans
(`http.*` / `url.*`) become api events with method, host, and path. Identity
comes from `enduser.id` / `user.id` / `service.name`.

```bash
# Works with an OTLP/JSON file straight off your collector:
cat otel-spans.json | node scripts/kolm-audit-ci.mjs
```

---

## 3. `POST /v1/audit/scan` and `POST /v1/audit/import`

Both endpoints run the SAME analysis and signing path. Use `scan` when you have
the logs in hand; use `import` when you want kolm to pull them from a URL you
control, or to keep a clean inline transport for a sidecar.

`POST /v1/audit/scan` body: `{ logs, subject?, source?, retention_days?, sign?, persist? }`.
`logs` is JSONL text, a JSON array of records, a wrapper with a
`data`/`rows`/`events`/`generations` array, or the canonical AuditEvents a
connector produced.

```bash
curl -sS https://kolm.ai/v1/audit/scan \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "Support agent fleet", "logs": [ { "request_id": "r1", "timestamp": "2026-06-09T00:00:00Z", "model": "openai/gpt-4o", "user": "support-1", "tools": [{"type":"function","function":{"name":"read_doc"}}], "messages": [{"role":"assistant","tool_calls":[{"function":{"name":"read_doc","arguments":"{}"}}]}] } ] }'
```

### `POST /v1/audit/import`

Auth-gated (send `Authorization: Bearer ks_...`). Tenant-fenced: the report is
always written to the calling key's tenant, never to a value from the body. Size
capped. It never throws: every failure is a JSON `{ ok: false, error, detail }`
with a clean HTTP status.

#### Body

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

#### Inline example

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

#### URL example

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

#### Response

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

#### Limits and safety

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

## 4. The sidecar pattern

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

## 5. Verifying the report (the reviewer side)

A signed report verifies offline, with no kolm account, two ways:

- In a browser at `https://kolm.ai/verify` - paste the report envelope.
- Programmatically against `POST /v1/audit/report/verify` (public), or with a
  language SDK that checks the Ed25519 signature byte-for-byte.

Verification is two-tier: tier 1 confirms the report was signed by the holder of
the embedded key and is untampered; tier 2 confirms that key is one kolm
publishes (the live signer or a key in `public/keys/kolm-issuers.json`). A
consumer should require BOTH (the `trusted` flag), so a rogue-signed copy is
refused. Ask dev@kolm.ai for the offline verify SDKs.

---

## 6. Relationship to the Continuous tiers

The onramp is the manual or self-scheduled way to refresh evidence. The Continuous
subscription tiers do the same refresh on kolm's schedule and keep a single stable
Trust link always-current:

- Continuous Starter and Growth re-attest on a weekly or per-deploy cadence and
  expose one Trust link your buyer pins.
- The deploy hook `POST /v1/audit/continuous/deploy-hook` (auth-gated by your key)
  forces an immediate re-attestation, for example from CI after you ship. The
  `kolm-agent-audit` Action pairs naturally with it: gate on the scan in a PR,
  then refresh the Trust link on the deploy.

Use the import endpoint and a sidecar when you want to drive the cadence yourself,
or to seed a first report before subscribing. Use a Continuous subscription when
you want kolm to hold the schedule and the always-current link.

Questions: dev@kolm.ai
