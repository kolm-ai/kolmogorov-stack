# Claims Ledger — what the website may feature (verified safe)

Every above-the-fold claim must trace to a row here. "Status: SAFE" = checked-in artifact or true live number. Never feature a claim not on this list.

## Proof endpoints (verified live in prod 2026-05-30)
- `https://kolm.ai/verify` → HTTP 200 — SAFE to link "verify a receipt"
- `https://kolm.ai/benchmarks/trinity-500-benchmark.json` → HTTP 200 — SAFE to feature the JSON
- `https://kolm.ai/health` → ok:true, signing_key:loaded — SAFE: "signed provenance is live"

## Headline proof (Trinity-500, public/benchmarks/trinity-500-benchmark.json)
- **SAFE:** "A 7B (Qwen2.5-7B council-distill) asks the right clarifying question 96.5% of the time — vs claude-haiku-4-5 64.9% and base Qwen 84.2%, matching gpt-4o-mini (96.5%) at ~1/30th active params." (57-prompt holdout, RTX 5090, INT4 NF4.)
- Precision: this is the **support-clarification** task; do not generalize to "beats frontier at everything."

## Pipeline / moat (verified shipped this session, src/*)
- **SAFE:** distill → quantize (INT4/GGUF) → SIGN (Ed25519) → serve → govern, one tool. (src/ed25519.js, ensure-signing-key.js, gateway-receipt.js)
- **SAFE:** "Signed receipt on every gateway call" — 19-field kolm-audit receipt, offline-verifiable. (gateway-receipt.js)
- **SAFE:** Enterprise control plane: SSO (SAML ACS), SCIM provision+deprovision, RBAC (4 roles), spend-caps, model-entitlements, data-residency (9 regions), BYOC (5 targets), audit. (src/saml-acs.js, scim-provisioning.js, rbac.js, spend-caps.js, model-entitlements.js, data-residency.js, byoc.js, audit-export.js)
- **SAFE:** Export to R2 / HuggingFace / Ollama / GitHub / custom. (src/model-export.js)
- **SAFE:** MCP server + webhooks + connectors (Zapier/n8n/LangChain) + OpenAI-compatible gateway. (src/mcp-server.js, webhooks.js, connectors.js)
- **SAFE:** 6-tier pricing (Free/Indie/Pro/Team/Business/Enterprise) live via Stripe payment links. (src/plan-catalog.js, billing-activation.js — billing/ready=true)

## Quantization (verified earlier, src + memory)
- **SAFE (precise):** "Run a 32B reasoning model in INT4 on one consumer GPU" = **INT4 inference** (DeepSeek-R1-32B → ~17.9GB). Training a 32B needs an H100 (proven this session). NEVER imply 32B *training* on a 5090.

## MUST NOT claim (would fail diligence)
- ❌ SOC2 Type II "achieved" — say "Type I; Type II in progress" only.
- ❌ "Per-token bill goes to zero" without the assumptions panel (wrapper-tax + compile-cost + breakeven shown).
- ❌ Any traction number (GitHub stars, models compiled, Discord N) until pulled from a real source. Omit if not real.
- ❌ Customer logos / case studies that aren't real engagements.
- ❌ "Beats frontier models" unqualified — only the specific Trinity-500 support-clarification result.

## TODO before featuring (traction surface)
- Pull true GitHub stars / models-compiled count / community size from real sources; only then add to `/proof` + homepage proof band.
