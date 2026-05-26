# Gateway Load Testing

Operator runbook for the load-test scaffold at `scripts/load-test.cjs`.

The scaffold is pure Node 20 stdlib (no autocannon, k6, or wrk). It is
intentionally small. Once we need higher fanout (>1000 RPS sustained) the
operator should swap in k6 or vegeta and reuse the scenario assertions
below as the acceptance contract.

## When to run

| Trigger                                  | Scenario set            |
| ---------------------------------------- | ----------------------- |
| Before a launch announcement (HN, X)     | `--scenario all`        |
| After a major gateway deploy             | `--scenario all`        |
| Monthly health check                     | `--scenario all`        |
| After changing a provider adapter        | `--scenario all-providers-down` |
| Pre-customer demo (smoke only)           | `--scenario concurrent-100` |

Do NOT run any scenario at launch-day peak — pre-stage at off-peak (typically
03:00 UTC weekday) so a failure does not coincide with real user load.

## Constraints

- Default mode is `--dry-run`. The operator must pass `--no-dry-run` to
  send actual traffic. This is a guard against accidental execution.
- The scaffold respects `--rpm` as a ceiling, not a target. It does not
  smooth across the duration — a 100-concurrent burst is a burst.
- Every request carries the bearer token from `--bearer` or `$KOLM_API_KEY`.
  The token must belong to a tenant whose quota can absorb the burst (the
  `concurrent-100` scenario fires 100 requests in roughly one wall-clock
  second; a 60 RPM tenant quota will surface as 429s, which the scenario
  records but does NOT count as success).

## How to run

Each scenario can be invoked by name. The commands below are the exact
operator commands for a real run (not dry-run). Replace `$KEY` with a tenant
API key that has headroom.

### Concurrent 100 users

100 parallel POSTs to `/v1/gateway/dispatch` with a one-token ping.

    node scripts/load-test.cjs \
      --scenario concurrent-100 \
      --base https://kolm.ai \
      --bearer $KEY \
      --no-dry-run \
      --json

Acceptance:
- success_rate >= 95 %
- p95 latency <= 3000 ms

If success_rate falls below 95 % see "When a scenario fails" below.

### Long context (128K tokens)

One request with a ~500 KB prompt (rough 128K-token equivalent at 4 bytes
per token).

    node scripts/load-test.cjs \
      --scenario long-context-128k \
      --base https://kolm.ai \
      --bearer $KEY \
      --no-dry-run \
      --json

Acceptance:
- response received within 60 s, AND
- HTTP 2xx, OR HTTP 413/422 with `context_too_large` envelope (graceful
  reject is a PASS — the gateway is allowed to refuse oversize prompts so
  long as it does so cleanly).

### All providers down

Asserts the gateway degrades to a queued receipt or a clean 503 when every
upstream is unreachable.

    node scripts/load-test.cjs \
      --scenario all-providers-down \
      --base https://kolm.ai \
      --bearer $KEY \
      --no-dry-run \
      --json

Acceptance:
- 2xx response with `capture_eligible: true`, OR
- 503 response with `{ error_code: 'all_providers_down', retry_after: <int> }`

By default this scenario SKIPS on a production target (`kolm.ai`) because
the gateway-side hook may not yet be wired. Once the gateway honors the
`X-Kolm-Test-Force-Provider-Outage` header in test-only environments AND we
have confirmed it cannot be triggered from a production tenant, the operator
can override with:

    KOLM_FORCE_PROVIDER_OUTAGE_ON_PROD=true \
      node scripts/load-test.cjs \
        --scenario all-providers-down \
        --base https://kolm.ai \
        --bearer $KEY \
        --no-dry-run \
        --json

### All scenarios in sequence

    node scripts/load-test.cjs \
      --scenario all \
      --base https://kolm.ai \
      --bearer $KEY \
      --no-dry-run \
      --json

Exit code is 0 only if every non-skipped scenario passes its acceptance
assertions.

## Gateway TODO: X-Kolm-Test-Force-Provider-Outage hook

For `all-providers-down` to run against any non-trivial target, the gateway
must honor a test header AND must guarantee that header is not exploitable
in production. The scaffold does NOT implement this hook — it only sends
the header. The gateway-side work is a separate follow-up:

1. In `src/router.js` (or wherever `/v1/gateway/dispatch` resolves the
   upstream chain), detect the `X-Kolm-Test-Force-Provider-Outage: true`
   request header.
2. Honor it ONLY when `process.env.KOLM_ENV` is one of
   `test`, `dev`, `staging`. In production, ignore the header silently.
3. When honored, short-circuit every provider adapter to throw a synthetic
   `provider_unreachable` error before any real network call.
4. The existing graceful-degradation path should then produce either a
   queued receipt (`capture_eligible: true`) or a 503 with
   `{ error_code: 'all_providers_down', retry_after: <int> }`.
5. Pin the production-rejection behavior with a lock-in test in
   `tests/` so a future refactor cannot accidentally honor the header
   in prod.

Until step 5 lands, `all-providers-down` against `kolm.ai` will SKIP.

## When a scenario fails

| Symptom                                         | First action |
| ----------------------------------------------- | ------------ |
| `concurrent-100` success_rate < 95 %, mostly 429 | Tenant quota too low for burst. Bump the test tenant's quota; do NOT lower the assertion. |
| `concurrent-100` p95 > 3000 ms                  | Check provider adapter latency; investigate before launch. |
| `concurrent-100` 5xx > 0                        | Block launch. Pull last deploy if recent. |
| `long-context-128k` total_ms > 60 s             | Likely upstream timeout. Confirm the gateway returns a clean 504, then file a follow-up to enforce a server-side cap. |
| `long-context-128k` 500-class with no envelope  | Block launch. The gateway is supposed to return `context_too_large` cleanly. |
| `all-providers-down` 500-class                  | Block launch. The graceful-degradation path is broken. |
| `all-providers-down` 200 but no `capture_eligible` | Capture queue is not catching the request — verify capture pipeline is enabled for that tenant namespace. |

## Limitations

- Latency is wall-clock from the load-test box. Network egress from your
  machine is included; for a cleaner number run from a cloud box in the
  same region as the gateway.
- `ttft_ms` in `long-context-128k` is approximated as time-to-first-data
  on the response stream; for non-streaming endpoints it is close to
  total_ms.
- The 128K-token figure is a byte-count proxy (~4 bytes/token English).
  It is not tokenizer-exact; the goal is to push past the typical 128K
  context window, not to land precisely on it.
- Concurrency is `Promise.all(100)`; the kernel may smear actual TCP
  connects across a few ms. For sub-millisecond fanout precision the
  operator should swap in k6.
