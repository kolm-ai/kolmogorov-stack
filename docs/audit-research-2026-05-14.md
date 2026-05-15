# kolm research + blog audit — 2026-05-14

Reference output from the research/blog audit agent. Drives the v10b research fix wave.

## Inventory

| File | Title | Type | Date | Grade |
|---|---|---|---|---|
| research.html | Compiling intelligence | Index | May 2026 | A |
| whitepaper.html | RS-1 Specification | Primary | May 8 | A |
| manifesto.html | The closed-API tax | Marketing/Econ | May 9 | A |
| why-now.html | Three lines crossed | Market | May 2026 | A |
| articles/why-we-built-kolm | Why we built .kolm | Manifesto | May 9 | A |
| articles/ai-compiler | Compile GPT-5 into 4GB | Tutorial | May 7 | B+ |
| articles/distillation-vs-fine-tuning-vs-rag | Decision tree | Explainer | May 9 | A |
| articles/running-our-marketing | 4 distilled models | Case study | May 9 | B+ |
| articles/how-we-benchmark | Benchmark methodology | Primary | May 9 | A |
| articles/rent-vs-buy-compute | Rent vs buy | Econ | May 9 | A |
| articles/k-sample-verified-inference | K-sample verified inference | Primary | May 7 | A |
| articles/kolm-file-format | .kolm format spec | Technical | May 7 | A |
| articles/hipaa-on-device | HIPAA on device | Vertical | May 7 | B |
| articles/speculative-decoding-recipes | Spec decoding | Inference | May 7 | B+ |
| cookbook/* | 33 templates | How-to | May 2026 | B |

## Keep + sharpen (top 10)

1. **RS-1 spec** — Clear up threat model (§10 is dense). Add manifest-structure diagrams.
2. **Distillation vs fine-tuning vs RAG** — Add 2026-Q3 cost comparison; payback math.
3. **Closed-API tax** — Cite "three design partners" 47-81% claim; cite $160k/yr example.
4. **K-sample verified inference** — Diagram the receipt chain. Link to Rekor.
5. **Rent vs buy compute** — Frame as LLM OpEx, not raw cloud. Add payback calculator.
6. **Why we built .kolm** — Strengthen Webpack/Docker analogy.
7. **Compile GPT-5 into 4GB** — Flag "recipe-mode preview" status. Add native-load latency table.
8. **HIPAA on device** — Add NIST RMF cross-reference. Mention EU AI Act Art 50 provenance.
9. **How we benchmark** — Link to live SWE-bench Lite harness. Pass-rate digest by base + quant.
10. **Running our marketing** — Show real feature names + K-score per artifact.

## Cuts / merges

- `speculative-decoding-recipes` — expand or merge into whitepaper appendix.
- Cookbook — audit overlap; keep templates that map to top-5 use cases (healthcare, finance, legal, edge, support).

## New articles to add (12 — SEO + credibility)

1. Compiled models vs RAG: latency / cost / accuracy benchmarks across 5 tasks.
2. Quantization strategies for compiled models: INT4 vs INT8 vs FP16 on edge hardware.
3. Model drift and recompilation workflows.
4. Security and supply-chain provenance: .kolm receipt chains vs SLSA / in-toto / VCS code-signing.
5. Multi-task and multi-modal compilation: bundling 3+ specialists in one artifact.
6. Compiling open-source vs proprietary models: licensing + reproducibility + audit trails.
7. LoRA composition and adapter ensembling.
8. From benchmark lab to production: K-score gates on real-world drift.
9. Compiled models for agentic workloads.
10. Offline receipt verification: validating .kolm provenance without registry access.
11. Cost modeling for compiled AI: build vs rent ROI (interactive calculator).
12. Regulatory compliance by artifact: HIPAA, SOC-2, ISO 42001 mapped to manifest fields.

## Citation gaps

| File | Claim | Status |
|---|---|---|
| manifesto.html | "Three design partners audited; 47-81% compile-eligible" | UNCITED |
| manifesto.html | "$160k/yr at $0.04/call" | NEEDS 2026-Q2 API pricing table |
| why-now.html | "Qwen2.5, Llama-3, Hermes-3, Phi-3 parity" | NEEDS HELM/MTEB/Big-Bench links |
| ai-compiler.html | "4GB artifact" | VAGUE — clarify quant + LoRA + index inclusion |
| K-sample.html | K-sample success rate | MISSING — % of calls passing verifier, by task |
| whitepaper.html | 12 FM codes documented | NEEDS — which are observed in production? |

## SEO opportunities (rank #1 targets)

1. **"compile AI feature into local model"** — uncrowded; "compiled models" + "edge AI" overlap.
2. **"when to use fine-tuning vs RAG"** — already strong; backlink push.
3. **"K-score AI model evaluation"** — own the term. Cross-ref HELM / Big-Bench.
4. **"speculative decoding deterministic drafts"** — sparse web content; expand benchmark angle.
5. **"LLM cost per token unit economics"** — add live monthly pricing snapshot.
6. **"HIPAA-compliant AI without cloud"** — low competition, high intent. Expand FedRAMP / BAA / audit-log templates.

## Internal linking — additions

- `distillation-vs-fine-tuning` → `rent-vs-buy-compute` + `k-sample-verified-inference`
- `ai-compiler` (tutorial) → `why-we-built-kolm` + `how-we-benchmark`
- `hipaa-on-device` → `manifesto` + `rent-vs-buy-compute`
- `whitepaper` → each section in research.html feed
- `how-we-benchmark` → `running-our-marketing` + `/benchmarks`

## Summary

Research surface is A-/B+ across the board. The 11 articles + manifesto + whitepaper form a tight narrative. Gaps: secondary citations for economic claims, production data on failure modes, and native-model device benchmarks. Adding 8-12 of the proposed articles in a 2-3 month cadence locks in SEO leadership.
