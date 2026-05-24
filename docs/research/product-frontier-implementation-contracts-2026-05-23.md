# Product Frontier Implementation Contracts - W603

Date: 2026-05-23

Scope: backend implementation handoff for the W601 frontier lab. This is not a
claim that external package publication, runtime adoption, public benchmark
data, or live certification are finished. It is a contract layer that tells an
implementation agent exactly what to build next and how to prove each local
piece.

## Why This Wave Exists

W601 defined the inventions. W602 exposed the frontier lab through a
secret-safe product contract in code, API, and CLI. W603 turns each invention
into implementation work that can be picked up without interpretation:

- exact owner modules and proposed files,
- function entrypoints with input and output contracts,
- data schemas to add,
- API and CLI surfaces to wire,
- smoke fixtures with expected behavior,
- rollout phases,
- evidence gates,
- failure modes,
- verification commands.

The result is a practical build plan, not a strategy note.

## Additional Implementation Research

The machine-readable source list lives in
`docs/product-frontier-implementation-contracts.json`. It adds implementation
patterns from:

- MLIR dialect conversion for legal target declarations, rewrite patterns, and
  target lowering.
- TVM Relax for graph-level ML optimization and cross-level transformations.
- IREE for MLIR-based compiler/runtime deployment from datacenter to edge.
- ONNX Runtime GenAI for generation loops, logits processing, KV cache,
  chat templates, and structured output capability.
- MLC LLM for compiler-accelerated native LLM deployment.
- NVIDIA Dynamo KV routing and KV offload for distributed cache-aware serving.
- KServe, Ray Serve LLM, and Ray autoscaling for production cloud serving and
  Kubernetes/Ray deployment targets.
- OpenAI Evals and Inspect for reproducible model/system evaluation contracts.

## Contract Set

### KV Memory Controller

Build `planKvMemoryPolicy(input)` and `explainKvMemoryReceipt(policy)`.
The implementation must select cache policy from task, context, retrieval
density, device memory, runtime target, and privacy mode. It must output cache
tiers, retained-span rules, latency estimates, and a receipt fragment.

### Context Extension Compiler

Build `planContextExtension(input)` and
`recordContextExtensionManifest(plan)`. The implementation must distinguish
exact distributed attention, sparse prefill, and positional tuning. It must
require short-context regression proof before any context-extension claim.

### Structured Decode Contracts

Build `compileDecodeContract(schema)` and `testDecodeContract(contract)`.
The implementation must normalize JSON Schema, regex, EBNF, and tool schema
constraints, then choose native constrained decoding, validation repair, or an
unsupported result with reason codes.

### Data Curation Engine

Build `scoreDatasetRows(rows)` and `promoteTrainingRows(plan)`. The system
must rank rows by quality, novelty, privacy risk, uncertainty, and expected
K-score lift per dollar, then generate promotion receipts that keep train and
holdout rows separate.

### MoE Serving Orchestrator

Build `planMoeServingTopology(model, workload)` and
`scoreMoeServingEvidence(run)`. The implementation must model expert count,
active experts, GPU count, placement, expert utilization, queue depth, and
autoscaling policy instead of using a generic GPU estimate.

### Multimodal Edge Packager

Build `planEdgeBundle(target)` and `emitEdgePackageManifest(plan)`. The
implementation must generate device/runtime-aware manifests across mobile,
browser, and embedded targets, including fallback behavior when a device lacks
the requested accelerator or model service.

### Confidential Compute Runbook

Build `planConfidentialJob(input)` and
`verifyConfidentialEvidence(evidence)`. The implementation must bind secrets to
attested workload measurements and include advisory freshness before claiming
confidential training or distillation.

### Runtime Target Matrix

Build `getRuntimeTargetMatrix()` and `selectRuntimeTarget(requirements)`.
The matrix must be the source of truth for dense/MoE, structured output,
long-context, multimodal, browser, mobile, confidential compute, signing,
telemetry, and package status.

### Benchmark Governor

Build `classifyClaimEvidence(claim)` and `runBenchmarkGovernor(plan)`.
The governor must block public performance claims unless a reproducer,
dataset card, model ID, hardware record, confidence interval, and red-team
result exist.

### Privacy Data Quality Loop

Build `scorePrivacyUtilityTradeoff(rows)` and
`emitPrivacyUtilityReceipt(result)`. The product must optimize redaction,
zero-retention, differential privacy, and training utility together, with
receipts showing both privacy and utility.

### Cloud Train Autopilot

Build `planTrainAutopilot(input)` and `emitRemoteJobManifest(plan)`.
Users without GPUs should receive a secret-safe plan covering no-train,
teacher distill, LoRA, quantization, cloud GPU, storage, logs, import, and
receipt generation.

### Attested Receipt Chain

Build `appendReceiptEdge(edge)` and `verifyReceiptChain(chain)`. The verifier
must work offline and must catch tampering across capture, redaction, split,
train, quantize, compile, publish, deploy, and run stages.

### Package Adoption Rail

Build `buildPackageAdoptionRail()` and `validatePackageClaim(surface)`.
Local build proof, signed release artifact, registry URL, and external
adoption proof must be separate states so install copy cannot outrun evidence.

### Codegraph Test Miner

Build `mineSurfaceOwnership(graph)` and
`emitImplementationWorkOrders(mined)`. The miner should link routes, CLI verbs,
TUI views, docs, public claims, tests, owner files, and readiness gates into
deterministic work orders.

### Quantization Memory Joint Planner

Build `planQuantMemoryJoint(input)` and
`scoreQuantMemoryCandidate(candidate)`. The planner must consider weight
precision, activation precision, KV precision, cache policy, runtime support,
memory pressure, holdout quality, and fallback together.

## Implementation Rule

1. Start from `docs/product-frontier-implementation-contracts.json`.
2. Pick one contract and run its focused simulator command.
3. Implement only the owner/proposed files named by that contract.
4. Add the named data schemas and entrypoints.
5. Add the focused test named by the contract.
6. Run the contract's verification commands.
7. Do not promote external/package/public-benchmark/certification status until
   the evidence gate named by the contract exists.

## Verification

Primary command:

```bash
npm run verify:frontier-contracts
```

Depth inclusion:

```bash
npm run verify:inventions
npm run verify:depth
```

Focused examples:

```bash
node scripts/simulate-product-frontier-implementation-contracts.cjs --contract=w603-cloud-train-autopilot-contract --summary
node scripts/simulate-product-frontier-implementation-contracts.cjs --category=structured-decoding --summary
node scripts/simulate-product-frontier-implementation-contracts.cjs --source=mlir-dialect-conversion --summary
node scripts/simulate-product-frontier-implementation-contracts.cjs --metric=security --summary
```
