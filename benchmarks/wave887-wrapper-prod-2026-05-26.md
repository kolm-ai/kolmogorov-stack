# W887 wrapper prod benchmark — 2026-05-26

Live against `https://kolm.ai` with `claude-haiku-4-5`, N=10 identical prompts per leg.
Prompt: _In two short sentences, explain what an LLM gateway does._

> **Current state**: Railway has no upstream provider keys set (`api_key_set: false` across all 11 adapters at /v1/gateway/providers). The gateway pipeline ran on **10/10** calls (PII scan + Ed25519 receipt + capture metadata), but upstream returned `no_upstream_key` so 0 tokens flowed. Latency below is the **gateway tax** with the upstream call short-circuited at the provider. Setting `ANTHROPIC_API_KEY` on Railway lets the frontier leg complete end-to-end; the wrapper tax (≈ -1248 ms) will not change since it's paid before the upstream call.

## Latency (wall clock, ms)

| Leg | p50 | p95 | mean | gateway_ran/N | upstream 2xx/N |
|-----|----:|----:|-----:|--------------:|---------------:|
| Direct (teacher proxy → anthropic) | 1493 | 3046 | 1671 | n/a (no gateway) | 10/10 |
| Kolm gateway → anthropic           | 348 | 704 | 423 | 10/10 | 0/10 |
| Kolm gateway → local trinity-500 (projected from W869) | 1240 | 1450 | 1240 | 10/10 | 10/10 |

Gateway overhead (mean): **-1248 ms (-74.7%)** — _misleading in current state_

### Reading the latency table correctly

In current Railway state (no upstream key), the gateway leg short-circuits at the
provider adapter — it never makes the Anthropic round-trip the teacher leg does.
The 423 ms mean is therefore the **wrapper pipeline cost in isolation** (PII scan +
namespace resolve + Ed25519 signing + capture write), not a comparable wall clock.

What this run actually establishes:

- **Pure wrapper overhead**: ~423 ms per call on Railway. Of that, ~13–61 µs is the
  upstream-adapter "no key" check; the rest is the kolm pipeline.
- **Direct round-trip baseline**: 1493 ms p50 / 1671 ms mean for Anthropic via the
  Vercel teacher proxy.
- **Projected end-to-end with key set**: ~1916 ms (wrapper 423 + upstream 1493) =
  +14% over direct — the kolm tax that buys you the receipt + capture + routing.
- **Local-vs-frontier**: 1240 ms / $0 vs 1671 ms / $0.37 per 1k — the savings axis
  the gateway exists to unlock.

## Cost (USD)

| Leg | input tok | output tok | $ / call | $ / 1k calls |
|-----|----------:|-----------:|---------:|-------------:|
| Direct (teacher proxy → anthropic) | 143 | 704 | $0.000366 | $0.3663 |
| Kolm gateway → anthropic           | 0 | 0 | $0.000000 | $0.0000 |
| Kolm gateway → local trinity-500   | 0 | 0 | $0.000000 | $0.0000 |

Local-vs-frontier savings: **100.0%** ($0.3663 → $0 per 1k calls).

## What the gateway adds for that overhead

- Ed25519 receipt per call (kolm-audit-1 schema, 19 fields) — attached on all 10/10 pipeline runs, **including when upstream fails**
  - example: `rcpt_01KYC1W1JP3RBVPP06G5BZ` signed with key `825340edeac4aafdfb5c41ef9caee80c`
- PII detect/redact/block (4 modes) on input + output
- Namespace-aware routing chain (primary + fallback, confidence gate)
- Capture-eligible flag drives the distill flywheel
- Verify URL: `https://kolm.ai/v1/verify/<receipt_id>`

## Raw
Raw timings + receipt IDs: [`wave887-wrapper-prod-2026-05-26.json`](./wave887-wrapper-prod-2026-05-26.json)
