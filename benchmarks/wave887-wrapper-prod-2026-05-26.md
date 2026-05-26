# W887 wrapper prod benchmark — 2026-05-26

Live against `https://kolm.ai` with `claude-haiku-4-5`, N=10 identical prompts per leg.
Prompt: _In two short sentences, explain what an LLM gateway does._

## Latency (wall clock, ms)

| Leg | p50 | p95 | mean | gateway_ran/N | upstream 2xx/N |
|-----|----:|----:|-----:|--------------:|---------------:|
| Direct (teacher proxy → anthropic) | 1717 | 2177 | 1718 | n/a (no gateway) | 10/10 |
| Kolm gateway → anthropic           | 2062 | 3991 | 2204 | 10/10 | 10/10 |
| Kolm gateway → local trinity-500 (projected from W869) | 1240 | 1450 | 1240 | 10/10 | 10/10 |

Gateway overhead (mean): **486 ms (28.3%)**

## Cost (USD)

| Leg | input tok | output tok | $ / call | $ / 1k calls |
|-----|----------:|-----------:|---------:|-------------:|
| Direct (teacher proxy → anthropic) | 210 | 569 | $0.000305 | $0.3055 |
| Kolm gateway → anthropic           | 210 | 560 | $0.000301 | $0.3010 |
| Kolm gateway → local trinity-500   | 0 | 0 | $0.000000 | $0.0000 |

Local-vs-frontier savings: **100.0%** ($0.3055 → $0 per 1k calls).

## What the gateway adds for that overhead

- Ed25519 receipt per call (kolm-audit-1 schema, 19 fields) — attached on all 10/10 pipeline runs, **including when upstream fails**
  - example: `rcpt_01KYC3VWSCX901HBDASAQS` signed with key `d9332aa538097ece3d195c6bb20650c6`
- PII detect/redact/block (4 modes) on input + output
- Namespace-aware routing chain (primary + fallback, confidence gate)
- Capture-eligible flag drives the distill flywheel
- Verify URL: `https://kolm.ai/v1/verify/<receipt_id>`

## Raw
Raw timings + receipt IDs: [`wave887-wrapper-prod-2026-05-26.json`](./wave887-wrapper-prod-2026-05-26.json)
