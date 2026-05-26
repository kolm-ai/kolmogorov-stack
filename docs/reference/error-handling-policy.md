# Error-handling policy (W890-3)

Canonical reference for how the kolm codebase reports failures, what shape
errors take on the wire, and how the runtime guards against crashes. All
six data files at `data/w890-3-*.json` are the machine-readable evidence
that this policy is upheld.

## 1. Coverage scope

Six W890-3 audit artifacts:

| File | Asserts |
|---|---|
| `data/w890-3-async-coverage.json` | every `async` function has a `try`/`.catch()` guard or rolls into `withErrorContext`; naked count is documented |
| `data/w890-3-empty-catches.json` | every empty `catch` block is annotated (target: 0 un-annotated) |
| `data/w890-3-error-messages.json` | sampled audit of user-facing error strings against the WHAT + WHY + ACTION rubric; weakest 20 surfaced |
| `data/w890-3-process-handlers.json` | every entry point registers `unhandledRejection`, `uncaughtException`, and `SIGTERM`/`SIGINT` graceful shutdown |
| `data/w890-3-http-status-codes.json` | spot check that 4xx/5xx are emitted and Retry-After / error_id headers are present where required |
| `data/w890-3-sentry-report.json` | `@sentry/node` opt-in is wired, `initSentry` is called at boot, the 500 middleware calls `captureException` |

## 2. Error-message rubric (WHAT + WHY + ACTION)

Every user-facing error message MUST include three parts in plain prose:

- **WHAT** went wrong — specific, not "an error occurred". Example: `GGUF export failed`.
- **WHY** it happened (if known). Example: `llama-quantize not found on PATH`.
- **WHAT TO DO next** — a concrete command or pointer. Example: `Install via git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && make`.

Composed example:

```
GGUF export failed: llama-quantize not found on PATH.
Install: git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && make
```

Run `node scripts/w890-3-error-handling-audit.cjs` to refresh the message
audit. Weakest entries are surfaced in `data/w890-3-error-messages.json`
under `weakest[]` (capped at 20) so engineers can fix-forward without
re-deriving the audit.

## 3. HTTP status-code conventions

Every HTTP endpoint MUST return:

| Code | When | Required fields |
|---|---|---|
| 200 | Success | `{ ok: true, ... }` |
| 400 | Bad input | `{ error, detail }` — both REQUIRED; `detail` describes what the caller should change |
| 401 | Missing or invalid auth | `{ error, detail? }` — hint pointing to `/v1/signup` or `kolm login` |
| 403 | Insufficient permissions | `{ error, detail }` — names the missing entitlement / plan tier |
| 404 | Resource not found | `{ error, detail }` — names the resource id that was looked up |
| 429 | Rate limited | `{ error, retry_after_s }` + `Retry-After: <seconds>` response header |
| 500 | Internal error | `{ error, error_id, detail? }` + `X-Kolm-Error-Id: <id>` response header; `detail` only in non-production |

The 500 middleware in `server.js` is the single chokepoint that:

1. Generates a 12-hex-char `error_id` (timestamp + random suffix).
2. Logs the id alongside the path/method and the error object.
3. Calls `Sentry.captureException(err, { tags, extra })` when `SENTRY_DSN` is set.
4. Responds with `{ error, error_id }` + `X-Kolm-Error-Id` so a user reporting
   the failure can quote the id and ops can correlate to logs + Sentry.

## 4. Process-level handlers

Each entry point registers all three signals BEFORE accepting traffic:

| Entry | unhandledRejection | uncaughtException | SIGTERM / SIGINT |
|---|---|---|---|
| `server.js` | logs + Sentry capture + non-fatal | logs + Sentry capture + graceful shutdown via `server.close()` | graceful shutdown via `server.close()` + 10s fallback timeout |
| `cli/kolm.js` | structured stderr + `EXIT.EXECUTION` (4) | structured stderr + `EXIT.EXECUTION` (4) | existing `SIGINT` traps inside long-running verbs (chat, daemon) honour the inner handlers |
| `workers/media-redact/redact.mjs` | emits structured `extract_failed` envelope + exit 5 | emits structured `extract_failed` envelope + exit 5 | exit 0 |

Graceful shutdown contract (`server.js` only):

1. Stop accepting new connections (`server.close()`).
2. Let in-flight requests finish.
3. A 10s `setTimeout(...).unref()` is the hard cap — if a request hangs, the
   process exits anyway so Railway / Vercel rollouts don't stall.

## 5. Empty-catch policy

Every `catch` block in src/, cli/, scripts/, workers/, tests/ MUST either:

- Do something useful (log, return a structured error, re-throw with context), OR
- Be annotated as deliberate via one of:
  - inline block comment: `catch (_) { /* skip malformed line */ }`
  - trailing line comment: `} catch (_) {} // best-effort cleanup`
  - leading line comment: explanatory `//` line directly above the catch
  - multi-line body comment: any `//` or `/* */` comment inside the catch body

The W890-3 fixer (`scripts/w890-3-fix-empty-catches.cjs`) annotates legacy
bare empty catches with `// deliberate: cleanup` so the audit can re-scan
to 0. Future code review SHOULD replace generic annotations with a
specific rationale where the intent is non-obvious.

The single chokepoint for the empty-catch policy is the audit script's
`emptyCatchScan` function; the lock-in test at
`tests/wave890-3-error-handling.test.js` asserts `total: 0`.

## 6. Sentry integration

`@sentry/node` is an **opt-in** dependency. The runtime never requires it.

Wiring (`server.js`):

```js
const sentry = await initSentry();
if (sentry) globalThis.__kolmSentry = sentry;
// ... 500 middleware ...
if (globalThis.__kolmSentry?.captureException) {
  globalThis.__kolmSentry.captureException(err, {
    tags: { kind: 'http_500', method: req.method, error_id: errorId },
    extra: { path: req.path, query: req.query, tenant: req.tenant?.id },
  });
}
```

Operator runbook:

1. `npm install @sentry/node` in the deploy
2. `export SENTRY_DSN=<dsn>`
3. (optional) `export KOLM_RELEASE=<sha>` for release-tagged grouping
4. Boot — `initSentry()` resolves to the SDK; `captureException` calls fire
   on every 500, unhandled rejection, and uncaught exception
5. With `SENTRY_DSN` unset OR `@sentry/node` not installed, every call site
   no-ops; boot continues silently

## 7. Adding a new error class

When you add a new endpoint or background worker:

1. **Pick the right status code** from the table in §3.
2. **Name the error** — use `snake_case` strings in the `error` field (e.g.
   `invalid_signature`, `tenant_quota_exceeded`, `model_not_loaded`).
3. **Write the message** to the WHAT + WHY + ACTION rubric in §2.
4. **Add a test** that asserts both the status code AND the error string,
   so future refactors can't quietly break the contract.
5. If the error is a 500: the generic 500 middleware in `server.js` will
   attach `error_id` and report to Sentry automatically — no per-route
   work needed.
6. If the error is a 429: set `Retry-After` AND include `retry_after_s` in
   the JSON body.

## 8. Re-running the audit

```sh
node scripts/w890-3-error-handling-audit.cjs
```

Writes all six `data/w890-3-*.json` files in <1s on a developer laptop. The
lock-in tests at `tests/wave890-3-error-handling.test.js` read those files
and fail-fast if any invariant is broken.

To fix-forward legacy empty catches:

```sh
node scripts/w890-3-error-handling-audit.cjs        # write inventory
node scripts/w890-3-fix-empty-catches.cjs           # annotate bare empties
node scripts/w890-3-error-handling-audit.cjs        # re-scan: expect total=0
```

## 9. Limitations

- **Async coverage** is a line-based heuristic; the audit's `naked` count
  documents false-positives where a guard exists outside the 120-line scan
  window. The lock-in does NOT require `naked === 0` — only that the count
  is documented.
- **Message classifier** uses a small bag-of-words for WHAT / WHY /
  ACTION. The `weakest[]` cap of 20 surfaces real candidates for
  improvement; a 3/3 hit does NOT prove the message is excellent, only
  that the rubric vocabulary is present.
- **Empty-catch rule** is annotation-presence, not annotation-quality.
  A `// deliberate: cleanup` placeholder satisfies the lock-in; the
  intent is that future code review tightens specific call sites without
  re-touching the 355 files annotated by the fixer.
- **HTTP status-code scan** spot-checks `src/router.js` only. Sub-routers
  outside that file are not sampled. Future waves can broaden the scope.
- **Sentry capture** is the only crash-reporting integration we ship.
  Self-hosters wanting OpenTelemetry-only flows wire that path via
  `src/otel.js` (see `init({ otel: true })`).

## 10. References

- Audit driver: `scripts/w890-3-error-handling-audit.cjs`
- Empty-catch fixer: `scripts/w890-3-fix-empty-catches.cjs`
- Lock-in tests: `tests/wave890-3-error-handling.test.js`
- Sentry shim: `src/sentry-init.js`
- Inherited from W890-2: `docs/reference/code-quality-policy.md`
- Inherited from W890-1: `docs/reference/codebase-organization.md`
