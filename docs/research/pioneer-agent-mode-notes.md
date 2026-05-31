# Pioneer / Fastino Agent Mode — internal notes
<!--
INTERNAL RESEARCH. NOT FOR PUSH. NOT FOR /docs/. NOT FOR /research/ (the user-facing one).
Lives in docs/research/ which is in the never-stage list per W918 §8.
Drafted from training-cutoff knowledge only. No web fetch was used.
Every claim below is labelled Verified / Likely / Unknown — do not promote any
"Likely" or "Unknown" line into customer copy without secondary confirmation.
-->

## 1. What Pioneer Agent Mode publicly does

Pioneer is a brand recently associated with Fastino (a small-model / task-specific
language model company). "Agent Mode" is, as best we can characterize from
training-cutoff exposure, a product surface that promises to take a customer's
agentic workload (tool-using LLM calls) and produce a smaller, faster, cheaper
model that approximates the larger teacher's behavior on that exact workload.
The framing is "specialize a small model on your agent traces" rather than
"general-purpose distillation." **Confidence: Likely** — the brand and category
match what was publicly discussed; the specific product surface naming is
**Unknown — verify on pioneer.com / the Fastino blog**.

The intake path, again **Likely** based on category norms, is some combination of
(a) point the product at your existing agent's logs or replay traces, (b) the
product runs a distillation/specialization pass against a teacher (their hosted
or yours), and (c) you get back a smaller deployable model plus an evaluation
report on tool-call fidelity. Specific knobs (LoRA vs full-finetune, base model
choice, on-policy vs off-policy traces) are **Unknown — verify from their docs**.

Deployment story is **Unknown**. Whether the artifact is HuggingFace-portable, GGUF,
Ollama-importable, or only runnable inside Pioneer/Fastino's own hosted inference
is a critical commercial question we cannot answer from training data. **Verify
on their pricing or deploy docs.**

Trace ingestion format is **Unknown — verify**. Whether they accept OpenAI-style
chat-completions traces with `tool_calls`, Anthropic-style tool_use blocks,
LangGraph traces, raw JSONL, or a proprietary schema matters because it determines
the friction of bringing existing agent logs in.

Evaluation harness — whether they ship a tool-call accuracy / argument-shape
diff / hallucinated-tool-name eval out of the box — is **Unknown — verify on
their eval docs page if one exists**.

## 2. Their reported wedge

Positioning, as best understood, is "task-specific small models beat general
frontier models on your task, at a fraction of the cost and latency."
**Confidence: Verified** at the category level — this matches Fastino's broader
public messaging — though the precise wording for "Agent Mode" specifically is
**Unknown — verify on their landing page**.

Pricing model is **Unknown**. Whether usage-based (per training run / per token
of trace), seat-based, or enterprise-contract is **Unknown — verify on
pioneer.com/pricing or via outreach**.

Target audience appears to be teams already running an agent in production
that's expensive or slow on a frontier model, who want a cheaper drop-in.
**Confidence: Likely**, again from category norms rather than verified copy.

GTM motion is **Unknown — verify**. Self-serve sign-up vs sales-led pilot,
free tier presence, and whether they have an open-source component are all
**Unknown**.

## 3. Their public technical claims

Latency numbers: **Unknown — verify**. The category typically claims 5-50x
inference speedup vs frontier teacher; whether Pioneer publishes a specific
number for Agent Mode is **Unknown**.

Accuracy / tool-call fidelity claims: **Unknown — verify**. The category usually
claims "≥95% match to teacher on the held-out trace eval" or similar; Pioneer's
specific number is **Unknown — do not quote any specific percentage in our
materials**.

Model sizes: Fastino's brand has been associated with sub-1B to mid-single-digit-B
parameter models. Whether Agent Mode produces a fixed-size student or lets the
caller pick is **Unknown — verify**.

Training time: **Unknown — verify**. Category typical is "minutes to hours."

Base model choice: **Unknown — verify**. Whether they use Llama, Qwen, Mistral,
or a proprietary base is **Unknown**.

License of produced artifacts: **Unknown — verify**. Critical for enterprise
buyers; do not assume permissive.

## 4. Parity matrix vs kolm

| Feature | Pioneer Agent Mode | kolm (W918 Wave 2) | Status |
|---|---|---|---|
| Tool-call trajectory distill | Unknown — verify | Yes — `src/distill/agent-trajectory.js` + `kolm distill --mode=agent` | parity (assumed) |
| Multi-teacher council | Unknown — verify | Yes — Claude 4.7 + GPT-4o + Cerebras Llama-3.3-70B + DeepSeek | likely leapfrog |
| Signed receipts per tool call | Unknown — verify | Yes — Ed25519, `/docs/receipts` | likely leapfrog |
| Portable artifacts (HF/GGUF/Ollama) | Unknown — verify | Yes — HF + GGUF Q4_K_M/Q5_K_M/Q8_0/IQ4_XS + Ollama Modelfile | likely leapfrog |
| Open-source core | Unknown — verify | Yes — Apache-2.0 | likely leapfrog |
| BYOC / on-prem deploy | Unknown — verify | Yes — `/edge`, `/government`, on-prem CLI | likely leapfrog |
| Eval harness (tool-call accuracy + arg-shape) | Unknown — verify | Yes — `/docs/eval-harness` (planned for Wave 2) | parity (assumed) |
| Federated distill | Unknown — verify | Roadmap — not in Wave 2 | gap (likely) |
| Multimodal agent traces | Unknown — verify | Roadmap — not in Wave 2 | gap (likely) |
| Free tier | Unknown — verify | Yes — `/hobbyist` | unknown |
| Sub-1GB edge deploy | Unknown — verify | Yes — `/edge`, NF4/INT4 path | parity (assumed) |
| FedRAMP / BAA posture | Unknown — verify | Yes — `/government` BAA pill, `/healthcare` | unknown |
| Trace-format ingestion (OpenAI/Anthropic/LangGraph) | Unknown — verify | Partial — verify Wave 2 scope | possible gap |
| Per-tool-call confidence routing | Unknown — verify | Yes — W708/W709 confidence-routing wave | likely leapfrog |
| Cost-per-1k receipt audit | Unknown — verify | Yes — `/v1/verify/rcpt_*` | likely leapfrog |
| Hardware-aware quant selection | Unknown — verify | Yes — W866 quant ladder (GGUF/EXL2/GPTQ/AWQ/NVFP4/FP8/HQQ) | likely leapfrog |
| Cerebras teacher option | Unknown — verify | Yes — added W918 | likely leapfrog |
| Train-once, deploy-many (HF + Modal + RunPod + Colab) | Unknown — verify | Yes — W869 T3 | parity (assumed) |

## 5. Open questions for verification

- What is the canonical product URL? Is it `pioneer.com/agent-mode`, a sub-page of
  fastino.com, or a separately branded site? (verify in browser)
- What trace formats do they accept on input? OpenAI chat-completions with
  `tool_calls`? Anthropic `tool_use` blocks? Their own schema? (verify in their
  docs/quickstart)
- What is the produced artifact format? Is it downloadable / portable, or
  hosted-only? (verify on their deploy docs)
- What is the pricing model and any free-tier ceiling? (verify on /pricing)
- Do they publish a specific tool-call accuracy benchmark with a named eval set
  (e.g. ToolBench, tau-bench, BFCL)? (verify on their benchmarks page)
- Do they have an open-source SDK or CLI, or is it API-only? (verify on GitHub)
- What is the typical training time and cost they cite for a "production-ready"
  agent distill? (verify on case studies / blog)
- Do they offer BYOC / VPC / on-prem deployment? (verify on enterprise page)
- Do they retain customer traces for retraining, and what is the data-handling
  policy? (verify on /security or /privacy)
- Is there a named flagship customer they cite for Agent Mode specifically?
  (verify on /customers)

## 6. Our public messaging implications

The `/agents` landing page (W918 P2.4, "Agent R" in the wave plan) and the
2026-06-02 blog post (W918 "Agent S") must not name Pioneer or Fastino in a
negative comparison. We do not have verified citations for any specific claim
they make, and the worst possible outcome of W918 P2 would be a defamation-
or trade-disparagement-shaped complaint over a claim we couldn't substantiate.
**Rule: position by feature, not by competitor name.**

The factual angle that holds up is feature-by-feature: "kolm ships signed
receipts per tool call," "kolm ships portable artifacts in HF + GGUF + Ollama
formats," "kolm is Apache-2.0," "kolm supports multi-teacher council distill
including Cerebras." Each of those is a verifiable statement about our own
product. None of them require us to assert what Pioneer does or does not do.

If a customer asks in a sales conversation "how do you compare to Pioneer?",
the answer is feature-mapped: walk the matrix in section 4 with verified rows
on our side and "we'd recommend you verify against their current docs" on
theirs. Do not let the matrix's "likely leapfrog" labels leak into customer
copy until the corresponding Pioneer row is verified.

The blog post should lead with the user-visible artifact (a portable, signed,
auditable agent model) and the kolm-specific moats (multi-teacher council,
Ed25519 receipts, hardware-aware quant, open-source core). Pioneer can be
mentioned in passing if and only if we have at the time of publication a
verified citation we can footnote. Without that citation, do not name them.

**Confirm before P2.4 ships:** the `/agents` page contains no named-competitor
comparison. The Wave 2 blog post body contains no named-competitor comparison
without footnoted verification.

## 7. Wave-3+ backlog from this analysis

- **Federated distill across customer tenants** (likely Pioneer gap as well —
  could be a co-leapfrog if we ship first). Feasibility: medium-high; needs a
  privacy-preserving gradient-aggregation story and probably a paper before
  enterprise will buy.
- **Multimodal agent traces** (screenshot + tool call + text). Feasibility:
  high once we have a multimodal teacher in the council; the trace format
  changes are small.
- **Native LangGraph trace import** (and CrewAI, AutoGen, OpenAI Assistants).
  Feasibility: high; mostly an adapter library in `src/distill/`.
- **In-product trace replay / debugger UI** (watch the student behave on a
  trace, see where it diverges from the teacher). Feasibility: medium;
  significant front-end lift but very demoable.
- **Tool-call accuracy benchmark publication on tau-bench or BFCL** with a
  reproducible script in `scripts/`. Feasibility: high; aligns with kolm's
  existing benchmark publishing pattern (W869 T7 X04 claim-verify gate).
- **Per-tool-call cost / latency / accuracy budget enforcement** (e.g.
  "this tool call cost too much, route to a cheaper model"). Feasibility:
  medium; partially shipped in W708/W709 confidence-routing, needs to be
  surfaced as an agent-mode feature.
- **Continuous distill from production traces** (closed-loop: prod traces
  feed nightly retraining, with a gated promotion step). Feasibility: medium;
  needs a stable trace-store schema and a promotion-gate UX.
- **Agent-specific eval harness extensions:** hallucinated-tool-name rate,
  argument-shape diff, recoverable-vs-unrecoverable error classification.
  Feasibility: high; pure CLI/Node work.

---

Drafted 2026-05-28 from training-cutoff knowledge. NOT VERIFIED. Re-verify before any external use.
