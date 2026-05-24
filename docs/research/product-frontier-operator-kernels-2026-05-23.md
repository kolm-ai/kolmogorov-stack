# Product Frontier Operator Kernels

Date: 2026-05-23

This is the W605 implementation-agent handoff. W601 defined research-backed
experiments. W603 defined implementation contracts. W605 goes one level lower:
the exact operator kernels that should be built so Kolm can improve quality,
latency, cost, portability, proof, security, enterprise readiness, developer
experience, and conversion at the same time.

The source of truth is `docs/product-frontier-operator-kernels.json`; verify it
with:

```bash
npm run verify:operator-kernels
```

## What To Build

1. **HoloQuant Joint Weight, Activation, And KV Planner**

   Build `src/holoquant-memory-kernel.js` and a worker path that jointly ranks
   weight quantization, activation policy, KV-cache precision, corrective
   adapters, and runtime kernel availability. The first implementation should
   use existing `src/quantization-oracle.js`, `src/platform-capabilities.js`,
   and `src/build-strategy-brain.js`, then add a proof object that records
   model hash, calibration hash, selected method, KV policy, memory estimate,
   expected quality, and holdout requirements.

2. **KolmIR Legalization And Autotarget Kernel**

   Build `src/kolmir-autotarget-kernel.js`. The key abstraction is not a new
   model format; it is a legality graph. For each artifact, list which behavior
   nodes can lower into ONNX Runtime GenAI, IREE, MLC, TensorRT-LLM, WASM, JS,
   or local runtime, and return explicit blocked-op reasons when a target fails.

3. **Experiential On-Policy Distillation Kernel**

   Build `src/experiential-distill-kernel.js` and a worker loop that combines
   GKD-style student replay with X-KD-style reward imitation. The route should
   refuse low-data distillation, keep train/holdout disjoint, record teacher
   provider/model/version hashes, and emit a cost forecast before making teacher
   calls.

4. **Speculative Structured Serving Kernel**

   Build `src/spec-structured-serving-kernel.js`. It should read an artifact's
   schema/eval contract and choose guided decoding, prefix cache, speculative
   decoding, continuous batching, and runtime fallback policy under a latency
   SLO. Structured extraction artifacts must never silently fall back to
   unsafe freeform decoding.

5. **Judge Interval Proof Kernel**

   Build `src/judge-interval-proof-kernel.js`. K-score needs intervals, not just
   a scalar. The kernel should combine deterministic scores, judge scores,
   conformal prediction intervals, abstention thresholds, and export packs for
   OpenAI Evals and Inspect AI. Promotion should block when intervals cross the
   risk threshold.

6. **OWASP Red-Team Compiler Kernel**

   Build `src/owasp-redteam-kernel.js`. It maps artifact tools, data classes,
   and deployment mode to OWASP LLM risks, then generates garak and PyRIT plans.
   High-severity failures should block promotion and attach replayable attack
   traces to the artifact evidence ledger.

7. **Capture-To-Curriculum Data Mixture Kernel**

   Build `src/data-mixture-kernel.js`. The capture lake should rank rows by
   novelty, privacy risk, label uncertainty, expected eval lift, and duplication
   before spending label or teacher budget. Holdout-only rows must never enter
   train plans.

8. **RAG-To-Artifact Retrieval Compiler Kernel**

   Build `src/rag-compiler-kernel.js`. Before distillation or training, Kolm
   should decide whether the task is solved by prompt optimization, lexical
   retrieval, dense retrieval, late interaction, graph retrieval, or no-train
   policy. The selected index and retrieval policy must be hash-bound into the
   artifact manifest.

9. **Device-Native Artifact Packaging Kernel**

   Build `src/edge-packaging-kernel.js`. The kernel chooses native runtime
   packaging for ONNX Runtime GenAI, MLC, IREE-style targets, browser/WASM, or
   JS fallback based on target OS, accelerator, memory, runtime-loop features,
   offline requirement, and bundle-size budget.

10. **Cloud Train And Serve Orchestrator Kernel**

    Build `src/cloud-orchestrator-kernel.js`. This is the path for users who do
    not have GPUs. It ranks local, SSH, hosted GPU, managed train, KServe, Ray
    Serve, TensorRT-LLM, and vLLM lanes. It must require durable storage before
    remote training and must never print secret values.

11. **Artifact Governance And Attestation Kernel**

    Build `src/artifact-governance-kernel.js`. It should normalize local proof
    packets into an evidence DAG and keep local implementation state separate
    from external gates such as package release, runtime adoption, public
    benchmark data, partner adoption, and live certifications.

12. **Agent Implementation Router Kernel**

    Build `src/agent-implementation-router-kernel.js`. It converts W603/W605
    contracts into non-overlapping implementation tasks by reading codegraph,
    owner files, proposed files, dirty-file state, test impact, and conflict
    risk. This is the kernel that keeps multiple backend agents from writing
    the same file without coordination.

## Implementation Order

P0 should be HoloQuant, Experiential Distill, Judge Interval Proof, OWASP
Red-Team, and Cloud Orchestrator. Those five directly close the most important
user concerns: better quantization, real distillation, honest quality proof,
security/compliance confidence, and GPU-less training.

P1 should be KolmIR Autotarget, Speculative Structured Serving, Data Mixture,
RAG Compiler, and Device-Native Packaging. Those convert Kolm from a set of
good surfaces into an actual compiler/runtime platform.

P2 should be Artifact Governance and Agent Implementation Router. They are
force multipliers: once they exist, implementation waves become safer and
external-proof claims become harder to overstate.

## Smoke Evidence

The simulator validates that the W605 kernel set covers:

- 12 operator kernels
- 23 research sources
- 12 backend categories
- all 12 product journeys
- all 8 customization dimensions
- all 8 open readiness gates
- all 9 tracked metrics
- all 12 product invention portfolio ids

The simulator is intentionally synthetic. It proves that the plans are
implementation-grade and internally mapped; it does not claim external package
publication, live certification, external adoption, or public benchmark wins.
