# Product Frontier Lab - W601

Date: 2026-05-23

Scope: backend/product architecture only. This document converts current
frontier research into executable experiments for the Kolm product stack. It
does not claim package publication, external runtime adoption, public benchmark
data, or live certification; those remain explicit readiness gates until the
named evidence exists.

## Why This Wave Exists

W596-W600 covered quantization, distillation, retrieval compilers, runtime
policy, security red-team gates, and research-backed build programs. The next
real backend holes are more specific:

- Long-context work is not just "bigger context"; it needs KV cache policy,
  prefill policy, memory receipts, and short-context regression proof.
- Structured outputs are not just prompt copy; production systems need
  decode-time constraints, semantic validation, and runtime capability routing.
- Frontier sparse/MoE models are not generic GPU jobs; they need expert
  parallel topology, load-balance telemetry, and runtime-specific flags.
- Edge AI is not one local binary; mobile/browser bundles need ExecuTorch,
  MediaPipe, LiteRT, ONNX, WebGPU, and WebNN capability checks.
- Confidential compute is not a checkbox; it needs attestation-bound key
  release, provider-specific measurement records, and firmware/advisory status.
- Package, runtime, foundation, benchmark, and certification gates need a
  shared release/adoption rail so "done" does not drift into overclaiming.

## Sources Incorporated

The machine-readable source list lives in
`docs/product-frontier-lab.json`. It includes primary or official sources for:

- StreamingLLM, H2O, SnapKV, PyramidKV, InfLLM, MInference, Ring Attention,
  and LongRoPE for long-context inference/training.
- vLLM structured outputs, SGLang structured outputs, XGrammar docs, and the
  XGrammar paper for constrained decoding.
- DataComp-LM, SemDeDup, DataTrove, and NeMo semantic deduplication for data
  curation.
- DeepSpeed-MoE, vLLM expert parallel, SGLang expert parallel, and
  TensorRT-LLM expert parallelism for sparse/MoE serving.
- ExecuTorch, MediaPipe LLM Inference, LiteRT, ONNX Runtime NNAPI, and Chrome
  AI platform docs for edge/browser/mobile runtimes.
- AWS Nitro Enclaves, AWS KMS attestation, Google Confidential VM, Azure
  Confidential VM, NVIDIA Attestation, and AMD SB-3034 for confidential compute.
- OpenTelemetry GenAI, SLSA, Sigstore, and OWASP LLM Top 10 for proof,
  supply-chain, observability, and benchmark controls.
- Codegraph-style repository mapping for turning code relationships into
  implementation ownership, test, and claim-planning edges.

## Experiments

### KV Memory Controller

Compile a long-context memory policy instead of relying on naive truncation.
The controller chooses attention-sink, heavy-hitter, observation-window, or
layer-pyramid KV policy from workload and device constraints. The receipt must
explain retained spans, evicted spans, protected spans, prefill cost, decode
cost, memory pressure, and quality delta.

### Context Extension Compiler

Treat long-context model changes as compiler targets. Exact distributed
attention, sparse prefill, and positional interpolation require short-context
regression proof before any public claim. This avoids shipping a model that can
pass a needle test while failing normal short prompts.

### Structured Decode Contracts

Compile JSON schema, regex, EBNF, and tool-call contracts into runtime policy.
If a runtime supports constrained decoding, use it. If it does not, the product
must fall back to validation/repair with explicit lower confidence. Syntactic
schema validity and semantic K-score are separate gates.

### Data Curation Engine

Make capture-to-dataset promotion measurable: filter, mix, dedupe, attribute,
label, and promote rows by expected K-score lift per dollar. The key insight is
that cleaner rows beat more rows, and the data pipeline needs proof before it
spends user money on training.

### MoE Serving Orchestrator

Sparse models need expert-parallel planning and imbalance telemetry. The
orchestrator should pick DeepSpeed, vLLM, SGLang, or TensorRT-LLM based on
model topology, GPU count, budget, and latency target, then prove expert
utilization under skewed prompts.

### Multimodal Edge Packager

Compile target-specific bundles for text, image, audio, and tool-routing
artifacts across mobile, browser, and embedded runtimes. Device-fit planning
must distinguish Android AICore/MediaPipe/LiteRT/ONNX/ExecuTorch/WebGPU/WebNN
instead of claiming that one runtime "runs everywhere."

### Confidential Compute Runbook

Generate provider-specific runbooks for Nitro Enclaves, AWS KMS attestation,
GCP Confidential VM, Azure Confidential VM, and NVIDIA confidential GPU. Secrets
must be released only to measured workloads, and firmware/advisory status must
be part of the evidence packet.

### Runtime Target Matrix

Convert runtime capabilities into data. Each target should declare support for
dense models, MoE, structured decoding, long context, multimodal, browser,
mobile, confidential compute, signing, telemetry, and LTS status. Public copy,
CLI, API, account, and docs should be generated from the same truth.

### Benchmark Governor

Every public claim must have an evidence class: local smoke, synthetic
simulation, private eval, public benchmark, or external certification. The
governor prevents synthetic green tests from becoming public 7x/11.6x claims
without reproducer, model, hardware, dataset, and confidence interval.

### Privacy Data Quality Loop

Optimize privacy and utility together. Redaction, zero-retention, differential
privacy, semantic dedupe, and dataset quality should be measured jointly so the
privacy layer does not destroy the signal needed for successful distillation.

### Cloud Train Autopilot

Users without GPUs need a real path: quote, dry-run, remote job manifest,
secret-safe provider plan, object storage, logs, import, verify, and receipt.
The plan must choose no-train, teacher distill, LoRA, quantization, local,
cloud, or confidential cloud from constraints rather than pushing every user to
training.

### Attested Receipt Chain

Bind capture, redaction, split, train, quantize, compile, publish, deploy, and
run events into one verifiable receipt chain. The verifier must work without
the hosted service. Enterprise buyers need continuity from raw call to deployed
artifact.

### Package Adoption Rail

Treat runtime package, SDK package, one-line install, marketplace, and
foundation-standardization gates as one release/adoption system. Local pack
proof is not registry publication; registry publication is not ecosystem
adoption. Each state needs a separate evidence slot.

### Codegraph Test Miner

Mine routes, CLI verbs, TUI views, docs, public claims, tests, and source files
into implementation work units. This is how the backend stops relying on human
memory for "100 percent complete": every surface needs an owner, a smoke path,
a readiness gate, and a claim source.

### Quantization Memory Joint Planner

Plan weight precision, activation precision, KV precision, cache eviction, and
runtime target together. Low-bit weights do not solve long-context KV memory,
and cache eviction can erase the quality recovered by quantization-aware
distillation.

## Implementation Rule

For every item marked partial, external, package, benchmark, or certification:

1. Build the local contract now if it can be implemented locally.
2. Keep the external gate explicit when it needs a registry, partner, public
   benchmark, or live auditor.
3. Add a simulator/test that proves the gate is covered and cannot disappear.
4. Scope public copy to the strongest evidence class that actually exists.
5. Re-run the focused simulator filter for the relevant category, source,
   metric, and experiment.

## Verification

Primary command:

```bash
npm run verify:frontier-lab
```

Depth inclusion:

```bash
npm run verify:inventions
npm run verify:depth
```

Focused examples:

```bash
node scripts/simulate-product-frontier-lab.cjs --category=structured-decoding --summary
node scripts/simulate-product-frontier-lab.cjs --source=amd-sb-3034 --summary
node scripts/simulate-product-frontier-lab.cjs --experiment=w601-cloud-train-autopilot --summary
```
