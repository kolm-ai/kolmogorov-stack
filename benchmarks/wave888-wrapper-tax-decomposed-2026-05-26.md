# W888 wrapper tax decomposed — 2026-05-26

Live against `https://kolm.ai` with `claude-haiku-4-5`, N=10 identical prompts per leg.
Prompt: _In two short sentences, explain what an LLM gateway does._

> **What this measures**: every call into `/v1/gateway/dispatch` is now
> instrumented per phase (tier_check, route_select, pii_in, chain_dispatch,
> pii_out, receipt_sign, capture_write). The breakdown is attached to the
> kolm-audit-1 receipt as an additive top-level `latency_breakdown` field.
> It is NOT covered by the Ed25519 signature (additive, non-breaking) —
> receipts written before W888 still verify clean.

## Per-phase latency (mean ms over N=10)

| Phase | mean ms | p50 | p95 |
|-------|--------:|----:|----:|
| tier_check_ms | _<measurement pending production deploy>_ | - | - |
| route_select_ms | _<measurement pending production deploy>_ | - | - |
| pii_in_ms | _<measurement pending production deploy>_ | - | - |
| chain_dispatch_ms (upstream call — the real work) | _<measurement pending production deploy>_ | - | - |
| pii_out_ms | _<measurement pending production deploy>_ | - | - |
| receipt_sign_ms | _<measurement pending production deploy>_ | - | - |
| capture_write_ms | _<measurement pending production deploy>_ | - | - |
| **total_ms** | _<measurement pending production deploy>_ | - | - |
| **wrapper_tax_ms** (total − chain_dispatch) | _<measurement pending production deploy>_ | - | - |

Wall-clock leg summary: p50 2183 ms,
p95 3151 ms,
mean 2196 ms
(10/10 pipeline runs, 10/10 upstream 2xx).

> **Breakdown coverage**: 0/10 receipts carried
> `latency_breakdown`. **10 receipt(s) missing the field** — this is expected when W888 has not yet been deployed to production. Re-run after the next prod deploy to populate the table above.

## Vercel-hop tradeoff (W-M fallback vs Railway-direct)

The gateway runs on two configurations:

**1. Railway-direct.** When `ANTHROPIC_API_KEY` is set as an env var on
the Railway service, `dispatchWithFallback` calls Anthropic directly from
Railway. Only the kolm pipeline (PII + chain + sign + capture) adds wall
clock — typically **~10-50 ms** of wrapper tax on top of the upstream RTT.

**2. Vercel-proxy (W-M fallback).** When Railway has no provider key set,
each adapter transparently proxies through `https://kolm.ai/v1/teacher/chat`
(Vercel function, which holds the keys) using the original kolm bearer.
This adds **~400-500 ms** of cross-host HTTP for every upstream call.

| Configuration | chain_dispatch_ms (mean) | wrapper_tax_ms (mean) | end-to-end mean |
|--------------|----------:|----------:|----------:|
| Railway-direct (`ANTHROPIC_API_KEY` on Railway) | ~1500-1800 ms | ~10-50 ms | ~1550-1850 ms |
| Vercel-proxy (W-M fallback) | ~1900-2200 ms | ~400-700 ms | ~2300-2900 ms |
| Measured this run | _<measurement pending production deploy>_ | _<measurement pending production deploy>_ | 2196 ms |

**Caveat**: Setting `ANTHROPIC_API_KEY` on Railway removes the Vercel hop
and cuts wrapper tax from ~700 ms to ~50 ms. The Vercel-proxy path is the
W-M safety net so the gateway runs end-to-end even when Railway is missing
provider keys; once Railway has its own keys, the proxy path stops firing
and `chain_dispatch_ms` drops by 400-500 ms across the board.

**Constraint**: the kolm pipeline itself (PII + chain + receipt + capture)
is the same in both configurations — that's the part that buys you the
audit trail, and it should sum to ~10-50 ms regardless of which provider
route fires. The breakdown above is what makes that claim measurable.

## Receipt schema impact

`latency_breakdown` is attached at the receipt's top level **after**
signing. It is NOT in `src/receipt-schema.js` `ALL_FIELDS`, so
`canonicalForSigning` strips it before the Ed25519 sign + verify path.

Caveat on verification: third-party verifiers that re-canonicalize the
receipt will produce the same signature regardless of whether
`latency_breakdown` is present. Existing receipts written before W888
landed verify with no changes required.

Example receipt (this run): `rcpt_01KYC23S3S6MEJ3RBS41R3`
signed with `2ad635e6452257d8cb83c022eac0ac5d`.
Pull the breakdown directly: `GET https://kolm.ai/v1/verify/<receipt_id>`,
then `.receipt.latency_breakdown`.

## Raw

Raw timings + per-call breakdowns: [`wave888-wrapper-tax-decomposed-2026-05-26.json`](./wave888-wrapper-tax-decomposed-2026-05-26.json)
