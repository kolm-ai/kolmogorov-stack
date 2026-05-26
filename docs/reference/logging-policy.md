# Logging Policy

Scope: every JavaScript file under `src/`, `cli/`, `workers/`. This policy is
the canonical reference enforced by the W890-4 sub-wave audit (ledger row in
`KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md` Part K-3) and the lock-in tests in
`tests/wave890-4-logging.test.js`.

## What writes a log line

### Canonical logger — `src/log.js`

The `src/log.js` module is the only structured-logging wrapper in the
codebase. It is a thin wrapper around `console.{log,warn,error}` that adds:

- a tag-prefixed wire shape (`[<tag>] <message>`);
- `sanitizeFields()` redaction of every value passed in the `fields` arg;
- a key-name blanket redaction for fields named `api_key`, `secret`,
  `password`, `token`, `authorization`, `cookie`, `jwt`, `bearer`;
- an opt-in mirrored emission to the event-store lake when
  `KOLM_LOG_STRUCTURED=1` (the event-store row carries
  `{level, tag, msg, fields}` JSON in the `feedback` column).

Public surface:

```js
import { log, getLogger, Log, sanitizeFields } from 'src/log.js';

log.info('boot', 'service ready', { version, port });
const lg = getLogger('lead/enterprise');
lg.warn('email skipped', { lead_id, recipient_hash });
```

Inventory:

- Module path: `src/log.js`
- Exports: `log`, `Log`, `getLogger`, `sanitizeFields`, `LOG_LEVELS`,
  `_resetForTests`
- External dependency: **none** (no pino, no winston).
- `logger_in_use`: `custom`. See [`data/w890-4-logger-inventory.json`](../../data/w890-4-logger-inventory.json).

### Why a custom wrapper, not pino or winston

Constraint from `KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md`: introduce no new
runtime dependencies in the W890 audit waves. The `src/log.js` wrapper has
been in the codebase since the W-C06 wave (2026-02 timeframe) and is
test-covered by `tests/wave-wc06-log.test.js`. Migration to pino-compatible
sinks is deferred to a post-V1 sub-wave (the wrapper API is intentionally
shaped like pino's `{level, msg, ...fields}` model so a sink switch is
mechanical).

## JSON log shape (the structured emission contract)

Every telemetry-grade log line writes one row to the operator stream:

```
[<tag>] <message>      ← stdout wire shape (always)
```

When `KOLM_LOG_STRUCTURED=1`, the same line also appends to the event-store:

```json
{
  "level": "info" | "warn" | "error",
  "tag":   "<short-namespace>",
  "msg":   "<message>",
  "fields": { ...sanitised key-value context... }
}
```

The event-store wrapping adds (`src/event-store.js`):

```json
{
  "timestamp": "<RFC3339>",
  "tenant_id": "<from-env-or-'log'>",
  "namespace": "log_emission",
  "provider":  "<tag>",
  "status":    "ok" | "error",
  "feedback":  "<json-of-above-payload>",
  "source_type": "simulated"
}
```

Receipt and request flow logs are NOT emitted through `src/log.js`; they are
written to the receipt store via `src/gateway-receipt.js` and the
observations table via `src/router.js`. See [Request-ID flow](#request-id-flow).

## Log levels

`src/log.js` exposes exactly three levels:

| level | when to use | wire sink |
| --- | --- | --- |
| `info` | normal lifecycle, non-error completion, audit-grade signal | `console.log` |
| `warn` | recoverable degradation (e.g., upstream skipped via config) | `console.warn` |
| `error` | failed operation; caller will get a non-2xx response or null result | `console.error` |

There is **no `debug` level**. If you need a debug signal, use
`log.info(tag, msg, { debug: true, ... })` and let the operator filter on the
`debug` field in the event-store. This keeps prod logs from being silently
disabled by an environment knob.

Sentinel-check: any `log.debug(` / `wclog.debug(` / `logger.debug(` /
`console.debug(` occurrence in `src/` is a pretty-violation tracked in
[`data/w890-4-log-levels.json`](../../data/w890-4-log-levels.json). Current
count: `0`.

## Sensitive-data redaction

`sanitizeFields()` (the fields-arg cleaner) redacts:

| pattern | examples | replacement |
| --- | --- | --- |
| email regex | `attacker@evil.com` | `[REDACTED]` |
| api-key shape | `ks_…`, `sk_…`, `pk_…`, `rk_…` (16+ chars after prefix) | `[REDACTED]` |
| JWT shape | `eyJ…\.eyJ…\.<sig>` | `[REDACTED]` |
| Bearer prefix | `Bearer <token>` | `[REDACTED]` |
| key-name match | `api_key`, `secret`, `password`, `token`, `authorization`, `cookie`, `jwt`, `bearer` | `[REDACTED]` |

Additional caveats:

- The **message** argument (positional #2) is NOT sanitised. Callers must not
  template-interpolate a token / email / prompt into the message; pass it in
  the fields arg so the redactor sees it. The W890-4 audit scans `src/` for
  message-arg bypass sites; see [`data/w890-4-sensitive-data-scan.json`](../../data/w890-4-sensitive-data-scan.json).
  Current find counts: `api_key_in_log_args=0`, `user_content_in_log_args=0`,
  `pii_pattern_in_log_args=0`.
- Receipt IDs (`rcpt_<22-char-base32>`), artifact CIDs (`bafy…`), and
  signing-key fingerprints (`fp:<8-hex>`) are explicitly allowed in logs.
  They are public-by-design identifiers the operator pastes into
  `/v1/verify/<rcpt-id>` and `/api/artifact/<cid>`.
- Receipt-recipient hashes (`sha256(email).slice(0, 12)`) replace the raw
  recipient in lead-flow audit logs (see `src/router.js:12856`).

## Request-ID flow

The kolm pipeline uses two correlation identifiers; the audit covers the
primary one because it spans the entire request → response chain.

| step | file | symbol | notes |
| --- | --- | --- | --- |
| 1. gateway   | `src/router.js`        | `receipt_id` | `/v1/dispatch` handler calls `grec.buildAndSignReceipt(receiptInputs)` |
| 2. provider  | `src/gateway-router.js` | `receipt_id` | per-provider `attempts` array attaches to the observation row keyed by `receipt.receipt_id` |
| 3. capture   | `src/router.js`        | `receipt_id` | `store.insert('observations', { id: receipt.receipt_id, ... })` |
| 4. receipt   | `src/gateway-receipt.js` | `receipt_id` | `newReceiptId()` mints Crockford base32, 22 chars, time-prefixed-sortable |
| 5. response  | `src/router.js`        | `receipt_id` + `verify_url` | dispatch JSON returns the signed receipt and the `/v1/verify/<id>` URL |

`missing_links` in [`data/w890-4-request-id-trace.json`](../../data/w890-4-request-id-trace.json):
empty.

The secondary correlation id, `trace_id` (W3C 32-hex; see
`src/trace-capture.js`), is a span-level identifier for replay/debug — it is
deliberately separate from `receipt_id` because the receipt is an
audit-grade signed artifact and the trace is operator-side instrumentation.

## Log rotation

| field | value |
| --- | --- |
| `rotation_configured` | `false` (at the application layer) |
| `mechanism`           | `deferred-to-deploy` |
| `max_size`            | platform-managed (Railway / Vercel stdout retention) |
| `max_age`             | platform-managed (Railway 7d default; Vercel hobby 1d / pro unlimited) |
| `deferred_to`         | W890-13 (deployment / release sub-wave) |

Rationale: the application writes only to `process.stdout` (and to the
event-store lake when `KOLM_LOG_STRUCTURED=1`). Neither sink is a local
file the application process owns, so an application-side rotation mechanism
would be a no-op. The deploy targets (Railway, Vercel) retain stdout
streams centrally; for self-hosted bare-Node operators, the system-level
rotation tool (`logrotate` on Linux, Windows Event Log on Windows) is the
right layer. The deploy-time rotation contract is tracked in W890-13.

See [`data/w890-4-rotation.json`](../../data/w890-4-rotation.json) for the
runtime probe.

## When to add a structured log call

- The call writes to an audit-grade trail an operator will need at 3am.
- The call replaces an existing `console.error(<full-error-object>)` that
  could serialise a request/response body containing secrets.
- The call records a recoverable degradation (a fallback, a skipped
  notification, a retry) that does not surface to the caller.

When NOT to use `src/log.js`:

- CLI command output (`cli/kolm.js` `console.log` is correct — users parse
  the stdout).
- Server lifecycle banners (`[proxy] listening on …`) — these are tag-
  conformant but emit static port/version/signal payloads with no
  user-content path, so the W890-2 inventory classifies them
  `service_lifecycle` and they remain on raw `console.log`.

## Banned vocabulary

This file and every `data/w890-4-*.json` deliverable is verified at lock-in
time against the W890-* banned word. See lock-in 8 in
`tests/wave890-4-logging.test.js`.

## Inventory

| file | what it counts | gate |
| --- | --- | --- |
| `data/w890-4-logger-inventory.json` | logger modules, exports, used-by count | `logger_in_use !== 'none'` |
| `data/w890-4-structured-logging.json` | structured vs freeform call sites | ratio `>= 0.7` |
| `data/w890-4-log-levels.json` | per-file level counts; pretty-violation list | `pretty_violations.length === 0` |
| `data/w890-4-sensitive-data-scan.json` | message-arg bypass sites by category | all three lists empty |
| `data/w890-4-request-id-trace.json` | per-step propagation chain | `missing_links.length === 0` |
| `data/w890-4-rotation.json` | rotation mechanism + max-size / max-age | `rotation_configured === true` OR `mechanism === 'deferred-to-deploy'` |

Run the audit:

```
node scripts/w890-4-logging-audit.cjs
```

Run the lock-ins:

```
node --test tests/wave890-4-logging.test.js
```
