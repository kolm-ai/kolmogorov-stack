# kolm → Fully-Finished SOTA Product Roadmap
_Synthesized from the SOTA research workflow (competitive analysis + 6 grounded lanes + adversarial verify), 2026-05-30._
_Caveat: the Grok lane 401'd (the key was wiped mid-deploy when it ran), so the competitive read is from the research agent's knowledge, not Grok — re-runnable now that persistence is fixed._

## Headline
kolm spans the entire **distill → quantize → sign → serve → govern** arc that **no single competitor owns end-to-end** (OpenPipe/Predibase own slices of distill+serve; Fireworks/Together/Modal/Baseten own inference; Ollama/LM Studio own local DX; Unsloth owns training kernels; HF owns distribution). The finish-line work is **depth + trust-hardening**, not new surface area. The durable moat is the **signed-receipt / provenance** layer + the single CLI spanning all five surfaces.

## P0 — Foundation (trust + persistence) — must be bulletproof
- **[DONE] Persist + harden the data volume across deploys.** Dockerfile entrypoint chowns the mounted volume → app-owned → tenants/events/conversations/keys now persist (was silently wiped every deploy). Verified `data_dir_writable: true` + conversation save works.
- **[NEXT] Trust/provenance always-on.** `signing_key: missing` on prod = artifacts could ship **unsigned** (this is the moat). Fix: auto-provision an ed25519 signing key on boot (fail-closed if absent), persist to the volume, ship `kolm verify <receipt>` + a gateway attestation header binding every token to a signed artifact + teacher lineage.
- **[NEXT] Drop server back to non-root** (currently runs as root after the volume fix) — entrypoint `su-exec` to `node`.

## P1 — Depth + the enterprise/employee product
- **Inference economics** — vLLM/TensorRT-LLM backend, continuous batching, speculative decoding (the distilled student is its own teacher's draft model), multi-LoRA hot-swap. Publish a signed benchmark vs Fireworks/Together. (L)
- **Enterprise control plane** — VPC/BYOC one-click (Helm/Terraform), full RBAC + org/teams, audit logs, SOC2 Type II, data residency, private model registry. (BYOC is kolm's natural wedge vs managed-only rivals.) (L)
- **Employee model access + updates (first-class)** — governed internal catalog, per-group entitlements, **signed self-update channel with rollback**, usage metering + cost attribution, admin console. A category nobody owns cleanly. (L)
- **On-device DX that beats Ollama/LM Studio** — polished local daemon/app, one-click pull of **signed** artifacts, hardware-aware quant auto-select, Metal/ROCm/CPU + mobile/edge runtime, **offline** provenance verify. (L)
- **Eval + regression gate in the compile pipeline** — task suites, student-vs-teacher A/B, drift detection on prod traffic, a release gate that **blocks** promotion unless thresholds clear, eval result written into the receipt. (M)
- **Close the data-engine loop** — capture→curate→augment→train→evaluate→feedback automated, `kolm compile --auto` on a schedule + Data Health dashboard (the OpenPipe-style stickiness flywheel). (L)

## P2 — Breadth + scale
- **Integrations/automations** — MCP server, Zapier/n8n/Make connectors, webhooks, LangChain/LlamaIndex, batch API, official SDKs. (M)
- **Training scale** — Unsloth/Liger kernels + multi-node FSDP/DeepSpeed for >32B + full-finetune (the "most ambitious OSS training" persona; current proven ceiling is 32B INT4). (L)
- **Speculative decoding + multi-LoRA serving productized** (one GPU serves many fine-tunes). (M)
- **Billing + usage metering** — per-model + per-tenant + storage GB-month, passthrough+margin, receipts viewer (powers the storage tiers). (M)

## P3 — Polish + credibility
- **PWA + push** for the chat (installable, "training done" alerts), multimodal/voice chat. (M)
- **Public signed benchmark matrix** vs Fireworks/Together/Predibase. (S)

## Flagship models to train (frontier persona)
(From this + the earlier frontier-research workflow — verified picks:)
- **kolm-clarify-4B-v2** (Qwen3.5-4B, council-distill + ROPD + DPO; multimodal) — surest flagship, ~$200-420, beats frontier-mini on a published support rubric.
- **Function-calling on Qwen3.5-9B** — distill the FC skill into the best-on-5090 base so the strongest local model also tool-calls.
- A frontier **agentic/reasoning** distill once the eval gate + Unsloth/multi-node land (the ambitious-but-honest version, not the SWE-bench-fantasy one the verifier killed).

## Biggest risks
Being a mile wide and an inch deep vs specialists; the trust layer (the moat) must hold in prod (it didn't — signing_key was missing); inference economics must reach striking distance of Fireworks/Together or the gateway is a liability.

## Definition of done
A non-expert can `kolm login`, make/pick a model, and reach it privately from any device with history + tools + **verifiable provenance**; a team/enterprise gets governed employee access, signed self-updates, BYOC, audit, eval-gated rollout, and metered billing — every artifact signed and every token attestable.
