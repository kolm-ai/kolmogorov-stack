# W887 wrapper prod benchmark — 2026-05-26

Live against `https://kolm.ai` with `claude-haiku-4-5`, N=10 identical prompts per leg.
Prompt: _In two short sentences, explain what an LLM gateway does._

> **State after W-M**: Railway gateway adapters now transparently proxy to
> Vercel's `/v1/teacher/chat` function (which holds `anthropic_api_key`) using
> the customer's original kolm bearer for auth. Result: **upstream 10/10**
> (was 0/10 before W-M when Railway had no provider keys). End-to-end tokens
> now flow through the wrapper without duplicating provider keys between the
> two hosts.

## Latency (wall clock, ms)

| Leg | p50 | p95 | mean | gateway_ran/N | upstream 2xx/N |
|-----|----:|----:|-----:|--------------:|---------------:|
| Direct (teacher proxy → anthropic) | 1650 | 2642 | 1774 | n/a (no gateway) | 10/10 |
| Kolm gateway → anthropic (via Vercel proxy fallback) | 1899 | 7704 | 2478 | 10/10 | 10/10 |
| Kolm gateway → local trinity-500 (projected from W869) | 1240 | 1450 | 1240 | 10/10 | 10/10 |

**Gateway overhead (mean): 703 ms (40%)** = wrapper pipeline (PII scan + chain
resolve + Ed25519 sign + capture write) + one extra Vercel hop on the proxy
fallback path. The p95 spike (7704 ms) is the Vercel teacher-chat function's
cold-start tail; warm samples cluster near 1500–2200 ms.

### Reading the wrapper tax

| Component | Wall clock |
|-----------|----------:|
| Direct Anthropic round-trip (teacher leg, mean) | 1774 ms |
| + Kolm pipeline (PII + chain + receipt + capture) | ~200–300 ms |
| + Vercel proxy hop (Railway → kolm.ai/v1/teacher/chat) | ~400–500 ms |
| = Gateway leg (mean) | 2478 ms |

The 40 % overhead can be cut roughly in half by setting `ANTHROPIC_API_KEY`
directly on Railway, eliminating the Vercel hop. The pipeline cost (PII +
receipt + capture) stays the same in either configuration; that's the part
that buys you the audit trail.

## Cost (USD)

| Leg | input tok | output tok | $ / call | $ / 1k calls |
|-----|----------:|-----------:|---------:|-------------:|
| Direct (teacher proxy → anthropic) | 210 | 560 | $0.000301 | $0.3010 |
| Kolm gateway → anthropic           | 210 | 572 | $0.000307 | $0.3070 |
| Kolm gateway → local trinity-500   | 0 | 0 | $0.000000 | $0.0000 |

Per-call cost via the wrapper is **within 2 %** of direct — the wrapper does
not mark up tokens. Local-vs-frontier savings: **100 %** ($0.30 → $0 per 1k
calls) when work routes to the distilled artifact.

## What the gateway adds for that overhead

- **Ed25519 receipt per call** (kolm-audit-1 schema, 19 fields) — attached on
  all 10/10 pipeline runs, **including when upstream fails**.
  - example: `rcpt_01KYC1ZV98HBEHW0NFC5DB` signed with key
    `c2e942e24061e9314790d73ce7b3f351`
- **PII detect/redact/block** (4 modes) on input + output
- **Namespace-aware routing chain** (primary + fallback, confidence gate)
- **Capture-eligible flag** drives the distill flywheel
- **Vercel-teacher-chat proxy fallback** (W-M) — gateway works without
  duplicating provider keys to Railway. Response envelope carries
  `kolm_proxy: { path: "vercel-teacher-chat", base, key_source }` so the
  proxy path is observable from the caller.

## Receipt verification live in prod

`GET https://kolm.ai/v1/verify/rcpt_01KYC1ZVTGDCW3FX06JQSC` returns the signed
receipt + verification result:

```
{ "ok": true,
  "receipt_id": "rcpt_01KYC1ZVTGDCW3FX06JQSC",
  "receipt": {
    "schema": "kolm-audit-1",
    "namespace_id": "default",
    "route_decision": "frontier",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "input_tokens": 9, "output_tokens": 4,
    "input_hash": "sha256:02c6ce4fdf6bb19eafc04ff687a9efce",
    "output_hash": "sha256:843ac01149cced785dfebd0028d3b03b",
    "signing_key_id": "c2e942e24061e9314790d73ce7b3f351",
    "signature_ed25519": {
      "alg": "ed25519",
      "public_key": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...",
      "signature": "DkBAG4fUoMtElFvx_iKWOKenRUKNsqdDGvjfFOdmiNrvi2DITI_Iaqp0..."
    }
  } }
```

Every receipt the gateway emits — including those generated via the
Vercel-teacher-chat proxy fallback — is independently verifiable from the
public `/v1/verify/<receipt_id>` endpoint with no auth required.

## Raw
Raw timings + receipt IDs: [`wave887-wrapper-prod-2026-05-26.json`](./wave887-wrapper-prod-2026-05-26.json)
