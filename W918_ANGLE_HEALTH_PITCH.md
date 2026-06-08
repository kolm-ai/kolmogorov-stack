# kolm × Angle Health — Pilot proposal

**Drafted:** 2026-05-28
**Audience:** Angle Health AI/ML or Engineering leadership
**Status:** Internal draft. Standalone document — not part of the public website push. Do not stage to the public repo.

---

## 1. One-paragraph pitch

Angle Health runs on a small set of recurring conversational workflows — eligibility lookups, plan explanations, claims-status disambiguation, prior-auth Q&A, broker triage. Each of those workflows currently routes to a frontier model (OpenAI / Anthropic) through your gateway. Each call costs inference dollars, leaves PHI on a third-party log surface, and gives you no portable audit lineage when a regulator or a customer asks "what model said that, on what data, and when?". kolm is the open-source distillation stack that takes the captures you already have, distills them into a small specialist model that you own and run on your own GPU (or any cloud GPU under your BAA), and emits a signed Ed25519 receipt for every distill, eval, and inference call. The pilot below replaces one Angle Health workflow with a distilled kolm model and proves out the receipt chain end-to-end, on infrastructure that doesn't share data with model vendors.

---

## 2. Why kolm fits Angle Health specifically

| Constraint Angle Health faces | How kolm answers it |
|---|---|
| **PHI cannot leave HIPAA boundary** | All distillation runs locally or in your own VPC. Captures are redacted PHI-fail-closed before they leave the laptop / pod. No kolm-hosted training. |
| **BAA required for any vendor touching member data** | kolm is open-source (Apache 2.0). The stack runs on your hardware. No BAA needed for the OSS — we sign a BAA only on the optional managed gateway, which you don't have to use. |
| **Audit lineage for every model decision** | Every distill, eval, and inference call emits a signed Ed25519 receipt: input hash, model hash, output hash, model lineage hash. Verifiable from `kolm verify <cid>` or from `/v1/verify/<cid>` on a self-hosted gateway. |
| **Cost pressure on per-call frontier inference** | Distilled 7B / 8B specialists run at $0.05–$0.15/M tokens on a single L40S or A100, vs $2.50–$15/M tokens for frontier APIs. Break-even at very modest call volume. |
| **Drift detection / retraining cadence** | Capture surface continuously logs prod inputs; weekly distill refresh is a one-command job. Drift signal published as `kolm fleet drift` and on the Govern surface dashboard. |
| **Regulatory posture (state insurance commissioners, ACA, HIPAA, CMS)** | Signed lineage is the artifact you hand to an auditor. Receipt → model card → distill spec → training pairs hashes → teacher slug. All open-source-verifiable. |

---

## 3. Proposed pilot scope

### 3.1 Workflow under pilot
**Recommended:** Plan explanation / SOA Q&A (member asks "is this covered", "what's my deductible", "why is this denied"). Reasons:

1. High call volume → fast cost ROI signal.
2. Well-bounded language (plan documents + claims schema).
3. Existing OpenAI / Anthropic logs already capture the prompt/response pairs you'd need.
4. Low blast radius if the distilled model needs a fallback (route low-confidence to a human, or back to the frontier model).

Alternatives if member-facing is politically harder: **broker triage** (broker asks a question, agent answers from internal docs) or **prior-auth Q&A** (clinical staff asks status questions).

### 3.2 Pilot stages (12 weeks)

| Week | Stage | Deliverable | Angle owns | kolm owns |
|---|---|---|---|---|
| 1 | Kickoff | Signed pilot SOW. BAA in place if managed gateway used. | Legal review, environment access, sample of 5–10k redacted captures. | SOW, BAA template, technical onboarding. |
| 2–3 | Capture import | Convert Angle's existing gateway logs (OpenAI ft format or Portkey/Helicone/LiteLLM export) to kolm capture format. | Hand over logs. Confirm PHI redaction rules. | `kolm import --from <gateway>` runs end-to-end. PHI redactor configured. |
| 4–5 | Distill spec | Draft 3-teacher council spec (Claude + GPT-4o + Cerebras Llama-3.3-70B). Base = Qwen2.5-7B-Instruct or Llama-3.1-8B. | Approve teachers / base choice. | Distill spec.json, eval set, holdout split. |
| 6–7 | Collection + train | Run distill collection (~2000 pairs) on Angle's GPU(s). Train QLoRA on 1× L40S or 1× A100. | Provision GPU pod. | Training scripts, monitoring, receipt emission. |
| 8 | Evaluation | A/B test distilled model vs frontier baseline on 500-prompt holdout. Report agreement rate, latency p50/p99, cost/1k tokens, escalation rate. | Help define accept/reject thresholds. | Eval harness, side-by-side report, signed receipts. |
| 9–10 | Shadow deploy | Distilled model serves shadow traffic (response generated but not shown to member). Capture divergences. | Wire shadow tap into your gateway. | Deploy artifacts (vLLM / Ollama / TGI), drift detection. |
| 11 | Cutover (small %) | 5% → 25% → 50% → 100% of pilot workflow routes to distilled model with fallback. | Operate the cutover. | On-call support for cutover week. |
| 12 | Retro + decide | Pilot report: cost saved, latency delta, agreement rate, audit-trail demo. Decide expand vs roll back. | Pilot signoff. | Final report, signed receipts for every step. |

### 3.3 Success criteria (proposed — refine in week 1)

- **Agreement rate** with frontier baseline on holdout: ≥ 92%.
- **Latency p50** under frontier baseline (target ≥ 30% improvement).
- **Cost per 1k tokens** under frontier baseline (target ≥ 60% reduction at pilot volume).
- **Signed receipt** retrievable for 100% of inference calls in the pilot.
- **Zero PHI** in any artifact that leaves Angle Health's HIPAA boundary.
- **Audit demo**: pick a random pilot inference call → show full lineage from receipt → model → distill spec → training-pair hashes → teacher slug.

---

## 4. Technical architecture (one diagram in words)

```
Angle Health VPC / on-prem
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Member chat / broker portal                               │
│       │                                                     │
│       ▼                                                     │
│   Existing gateway (Portkey / Helicone / LiteLLM / custom) │
│       │                                                     │
│       ├──► (current) Frontier API (OpenAI / Anthropic)      │
│       │                                                     │
│       └──► (pilot)  kolm gateway → distilled 7B/8B on L40S  │
│                          │                                  │
│                          ▼                                  │
│                     Signed receipt (Ed25519)                │
│                          │                                  │
│                          ▼                                  │
│                  Angle's audit log / SIEM                   │
│                                                             │
│   Distill pipeline (offline, on Angle GPU pod)              │
│   ┌─────────────────────────────────────────────────┐       │
│   │ captures.jsonl → kolm import → kolm distill →   │       │
│   │ QLoRA → merged HF → GGUF → vLLM serve           │       │
│   │ Every step emits a signed receipt.              │       │
│   └─────────────────────────────────────────────────┘       │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Outside Angle's boundary (only during distill collection, optional):
   Teachers: Anthropic, OpenAI, Cerebras
   — receive REDACTED prompts only
   — never receive raw PHI
   — kolm PHI redactor runs fail-closed before any teacher call
```

### 4.1 PHI handling

- kolm ships a fail-closed PHI redactor (`workers/media-redact`). Any row that fails PHI scrub is skipped at collection time, not silently sent.
- Teacher calls (Claude / GPT-4o / Cerebras Llama) only see redacted prompts. Raw PHI never leaves Angle's environment.
- All training and inference can run fully offline (local teacher option: DeepSeek-R1-Distill-Qwen-32B INT4 served on Angle's hardware) for air-gap deployments.

### 4.2 Receipts

Every receipt is a JSON envelope signed with Angle's Ed25519 key:

```json
{
  "rcpt_id": "rcpt_01XXXXX",
  "kind": "inference",
  "ts": "2026-05-28T12:00:00Z",
  "tenant": "tenant_anglehealth",
  "input_hash": "sha256:...",
  "output_hash": "sha256:...",
  "model_hash": "sha256:...",
  "model_lineage": ["distill_spec_hash", "teacher_pair_hashes", "base_model_hash"],
  "sig": "ed25519:..."
}
```

Verifiable offline (`kolm verify <cid>`) or via `/v1/verify/<cid>` on Angle's self-hosted gateway. No call back to kolm servers required.

---

## 5. Commercials

The OSS stack is free (Apache 2.0). What Angle pays for is the pilot engagement, optional support, and optional managed surfaces. Three options:

### Option A — Self-serve OSS pilot (Angle drives, kolm advises)
- $0 software cost.
- 12 hours of office hours over 12 weeks ($6,000 flat).
- Total: **$6,000**.

### Option B — Co-piloted pilot (recommended)
- $0 software cost.
- 1 kolm engineer embedded ~25% (3 days/wk × 12 weeks) — distill spec design, eval harness, deploy.
- Total: **$45,000** flat, success-aligned (50% on signed retro, 50% on cutover to 100%).

### Option C — Managed pilot (kolm-hosted under BAA)
- Same engineering as Option B.
- kolm-hosted gateway in Angle's GCP/AWS account under BAA.
- Total: **$75,000** flat + GPU pass-through.

All options include: full open-source code, signed receipts on every call, no lock-in, full data ownership, BYOC.

### Post-pilot pricing (if expansion)
- Open-source forever for self-host.
- Optional managed surface (Govern / receipts / fleet drift dashboard) priced per workflow per month — happy to size after pilot data.

---

## 6. Timeline

- **Week 0** — kickoff call, NDA, share this doc + roadmap (today).
- **Week 1** — pilot SOW signed.
- **Week 4** — distill spec approved.
- **Week 8** — eval report delivered.
- **Week 11** — cutover to 100% of pilot workflow.
- **Week 12** — retro + expansion decision.

---

## 7. What kolm needs from Angle Health

1. **Pilot SOW signoff** (week 1).
2. **5–10k captures** in OpenAI ft / Portkey / Helicone / LiteLLM JSONL format from the pilot workflow.
3. **One L40S or A100 GPU pod** (Angle-provisioned or kolm-recommended provider like RunPod/Modal under Angle's account).
4. **Eval threshold input** — what's the minimum agreement rate Angle would accept to cut traffic over?
5. **Cutover playbook owner** — Angle SME who owns the workflow.
6. **Auditor stakeholder** — one person from compliance/legal to validate the receipt demo in week 8.

---

## 8. What kolm provides

- **Pilot SOW** (we send week 1).
- **BAA template** if Option C.
- **`kolm import`** verbs for whichever gateway format Angle uses.
- **Distill spec** (council teachers + base model + hyperparameters).
- **Eval harness** with 500-prompt holdout.
- **Receipt verification CLI + web endpoint**.
- **Deploy artifacts** (vLLM, Ollama, GGUF, TGI options).
- **On-call kolm engineer** during cutover week.
- **Pilot retro report** in week 12.

---

## 9. Open questions to answer in kickoff call

1. Which workflow does Angle pick for the pilot?
2. What's Angle's preferred hosting target (on-prem, GCP, AWS, RunPod, Modal)?
3. What's the current gateway / capture format?
4. Who owns BAA negotiation if Option C?
5. Who owns the cutover playbook?
6. What's the regulatory audience for the receipt demo (internal compliance, state insurance commissioner, CMS)?

---

## 10. Appendix — kolm capabilities relevant to healthcare AI

### A. Council distillation
Multi-teacher distillation (Claude + GPT-4o + Cerebras Llama + optional local DeepSeek-R1-32B). Reduces single-teacher bias. Sierra-style τ²-bench eval methodology. Proven recipe: Trinity-500 (96.5% asks-1Q on customer support, beat Claude-Haiku and GPT-4o-mini at half the chars).

### B. PHI-fail-closed capture
Built-in `workers/media-redact` runs on every capture row before it leaves the laptop. Any row failing PHI scrub is skipped, not sanitized-and-forwarded. Lock-in test enforces fail-closed behavior.

### C. Portable artifacts
Distilled model exports to HuggingFace safetensors, GGUF (Q4_K_M / Q5_K_M / Q8_0 / IQ4_XS), Ollama Modelfile, vLLM model directory, TGI weights, TRT-LLM engines, single-binary edge runtime. No vendor lock-in.

### D. Signed receipts (Ed25519)
Every distill, eval, deploy, and inference call signs a JSON envelope. Verifiable offline with `kolm verify`. Chain-of-custody from training data hashes → distill spec → model hash → inference output hash.

### E. Fleet drift detection
`kolm fleet drift` compares production input distribution week-over-week. Surface dashboard at `/account/drift`. Triggers retraining suggestion when drift exceeds configurable threshold.

### F. Eval harness
500-prompt holdout, agreement-rate metric vs frontier baseline, latency p50/p99, cost/1k tokens, escalation rate. Used in W869 Trinity-500 benchmark — same harness, same code, same receipts.

### G. Air-gap deploy
Full pipeline (collection → train → deploy) can run with zero network egress. Local teacher option: DeepSeek-R1-Distill-Qwen-32B INT4 served on a single 5090 / L40S. Proven runtime: 17.9 GB VRAM, 11.5 tok/s, correct chain-of-thought.

### H. Open-source guarantee
Apache 2.0. Source on GitHub. No closed-source dependency on the training/inference path. Optional managed surfaces are clearly fenced — Angle can replicate all of them in-house from the same code.

---

## 11. Where this document lives

`W918_ANGLE_HEALTH_PITCH.md` at repo root. Not staged. Not committed. Not pushed. Hand to Angle Health directly (PDF export or paste into a deck or send as-is). Update freely as the pilot conversation evolves.
