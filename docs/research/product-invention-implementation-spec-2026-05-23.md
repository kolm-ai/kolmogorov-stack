# Product Invention Implementation Spec

Date: 2026-05-23

Status: implementation-grade backend/product invention packet. This is not a
marketing claim and not proof that the inventions are shipped. It is the build
spec that implementation agents should use after the current local gates pass.

Source of truth:

- Machine-readable spec: `docs/product-invention-implementation-spec.json`
- Portfolio smoke: `scripts/simulate-invention-portfolio.cjs`
- Implementation smoke: `scripts/simulate-invention-implementation-spec.cjs`
- Product graph: `public/product-graph.json`
- Readiness ledger: `docs/product-sota-readiness.json`

Fresh provider constraint:

- OpenAI's current supervised fine-tuning docs say the fine-tuning platform is
  winding down for new users. Kolm must therefore treat OpenAI fine-tuning as
  one possible teacher/optimization backend, not the default product center.
- Anthropic's prompt caching docs document exact-prefix matching, cache TTLs,
  workspace/org isolation, and cache diagnostics. Kolm should model Claude as a
  first-class runtime/capture provider and a cache-aware teacher source, not as
  an afterthought behind OpenAI.

## Design Rule

Kolm's moat is not "fine tuning" or "local models" alone. The moat is a
verified loop:

```txt
capture -> privacy policy -> dataset -> eval -> build decision -> artifact -> runtime -> receipt -> governance export
```

Every invention below strengthens that loop and names:

- the metric lift it targets
- the current product journeys it touches
- the readiness gates it closes or supports
- the math core
- the build phases
- the files an implementation agent should own
- the smoke simulation
- the acceptance tests
- the failure modes that must be handled before production copy can claim it

## Invention Waves

### W593 Kolm-Q Max

Build the quantizer as a constrained compiler. Use GPTQ-style second-order
sensitivity, SmoothQuant/AWQ activation outlier statistics, rotation candidates,
and KV-cache compression candidates. The solver chooses a per-layer plan that
meets K-score, memory, runtime-kernel, privacy, and latency constraints.

Primary files:

- `src/quantization-planner.js`
- `src/quantization-receipt.js`
- `src/quantization-oracle.js`
- `src/compile-pipeline.js`
- `src/model-registry.js`
- `src/compute/registry.json`
- `cli/kolm.js`

Acceptance bar:

- deterministic for fixed calibration hashes
- no holdout-only rows used for training or calibration leakage
- receipt fails on changed layer bit map, calibration hash, or K-score delta
- CLI explains the Pareto frontier and recommended plan

### W593 KolmIR AutoTarget

Build the compiler around product proof, not tensor ops first. The IR should
represent data, eval, model, transform, runtime, policy, receipt, and deploy
nodes, then lower into GGUF, ONNX, CoreML, MLX, ExecuTorch, TensorRT-LLM,
vLLM/SGLang, WASM, and edge targets while preserving proof parity.

Primary files:

- `src/compile-ir.js`
- `src/trace-compile.js`
- `src/export-provenance.js`
- `src/runtime-policy.js`
- `src/compile-targets.js`
- `src/artifact.js`
- `docs/kolm-format-v1.md`

Acceptance bar:

- two target lowerings preserve dataset/eval/K-score/receipt hashes
- unsupported target features fail with actionable diagnostics
- target preview does not leak secrets
- `kolm compile --target auto --explain` names the target-choice rationale

### W593 Distill Forge Max

Build distillation as expected K-score lift per dollar, not as "always fine
tune." The planner chooses no-train, rules, cache, RAG, SFT, KD, rationale SFT,
preference, rejection, or on-policy paths from evidence.

Primary files:

- `src/distill-strategy.js`
- `src/distill-pipeline.js`
- `src/distill-onpolicy.js`
- `src/distill-preference.js`
- `src/seeds-active.js`
- `src/quality-calibration.js`
- `src/cloud-compute-broker.js`

Acceptance bar:

- recommends no-train when cache/rules/RAG beats fine-tune expected value
- supports OpenAI and Anthropic teacher plans without OpenAI-only assumptions
- refuses synthetic-only promotion without real holdout evidence
- outputs example acquisition plan and expected K-score lift range

### W593 Active K-Lift

Build the dataset workbench as an active curriculum. Every candidate row gets
expected K-score lift, privacy risk, label cost, duplicate risk, and coverage
value before it can become train or holdout data.

Primary files:

- `src/seeds-active.js`
- `src/label-queue.js`
- `src/lake.js`
- `src/dataset-workbench.js`
- `src/seeds.js`
- `src/privacy-membrane.js`

Acceptance bar:

- semantic train/holdout overlap is rejected
- privacy-denied rows cannot be sent to teachers
- row ranking is deterministic for a fixed lake snapshot
- dataset receipt explains selected and rejected rows

### W593 SpecCache Runtime

Build a request-time planner that chooses exact cache, semantic cache, prompt
compression, speculative decoding, fallback routing, local artifact, or provider
call per request.

Primary files:

- `src/runtime-policy.js`
- `src/cache.js`
- `src/model-routing.js`
- `src/streaming-contract.js`
- `src/otel.js`
- `src/artifact-runner.js`

Acceptance bar:

- cache hit receipt does not claim model inference
- fallback preserves tenant policy and token budget
- streaming normalization is identical across provider/local/fallback paths
- explain output names why cheaper routes were rejected

### W593 Adapter Fabric

Build shared-base multi-adapter serving for private registries. A single base
runtime should serve many tenant adapters with fairness, quotas, proof receipts,
and dependency graphs.

Primary files:

- `src/model-registry.js`
- `src/artifact-dependency-graph.js`
- `src/runtime-policy.js`
- `src/usage-analytics.js`
- `src/registry.js`
- `src/team.js`

Acceptance bar:

- tenants sharing a base cannot see each other's adapters
- tokenizer/base mismatch refuses admission
- cost report separates base amortization and adapter usage
- receipt verifier detects swapped adapter hash

### W593 Adaptive Eval Fuzzer

Build K-score as an adversarial, calibrated, task-typed contract. Static
holdouts are not enough; the eval system should search for failures and report
confidence intervals and false-accept rates.

Primary files:

- `src/quality-calibration.js`
- `src/benchmark-evidence.js`
- `src/production-ready.js`
- `scripts/benchmark-evidence.mjs`
- `scripts/bench-quality-calibration.mjs`
- `scripts/bench-redaction-fixtures.mjs`

Acceptance bar:

- adversarial failure blocks production promotion
- benchmark validator rejects raw prompts, outputs, and secrets
- K-score API returns calibration context
- public claim readiness stays false until public raw reports exist

### W593 Privacy Membrane Max

Compile privacy as a policy graph across capture, redaction, zero retention,
differential privacy, teacher calls, training exports, artifacts, and compliance
exports.

Primary files:

- `src/privacy-membrane.js`
- `src/phi-redactor.js`
- `src/lake.js`
- `src/team-capture-rbac.js`
- `src/compliance-certification-packet.js`
- `scripts/bench-redaction-fixtures.mjs`

Acceptance bar:

- zero-retention calls leave no rows
- privacy-denied data cannot leave to teacher/training/export paths
- DP budget composes by tenant and namespace
- policy receipt verifier detects tampered movement path

### W593 Constraint Cloud Broker

Build compute as a constraint solver. Users choose deadline, privacy boundary,
budget, residency, and target. Kolm chooses local, SSH, RunPod, Modal, AWS,
Together, BYOC, edge, or object-storage backed execution.

Primary files:

- `src/cloud-compute-broker.js`
- `src/remote-compute.js`
- `src/object-storage.js`
- `src/deployment-plans.js`
- `src/platform-capabilities.js`
- `src/usage-analytics.js`
- `scripts/cloud-compute-broker.mjs`

Acceptance bar:

- dry-run never launches spend
- missing credentials produce setup hints
- import fails on output hash mismatch
- BYOC jobs keep secrets out of artifacts

### W593 Device Fit Autopilot

Build export selection from actual device fit: RAM, runtime kernels, browser
support, NPU availability, p95 latency, battery/thermal risk, privacy mode, and
fallback.

Primary files:

- `src/device-capabilities.js`
- `src/models.js`
- `src/model-registry.js`
- `src/runtime-policy.js`
- `src/compute/registry.json`
- `packages/sdk-swift`
- `packages/sdk-kotlin`
- `packages/sdk-rn`

Acceptance bar:

- low-memory devices get smaller artifact or cloud fallback recommendations
- unsupported NPU runtime is never advertised as available
- telemetry import is opt-in and content-free
- account and CLI show the same fit result

### W593 Signed Agent Tool Compiler

Compile repeated agent behavior into signed MCP/local tools with minimized
permission receipts, dependency graphs, and replay evals.

Primary files:

- `services/mcp/server.js`
- `src/agent-blueprint.js`
- `src/agent-telemetry.js`
- `src/artifact-dependency-graph.js`
- `src/team-capture-rbac.js`
- `src/streaming-contract.js`
- `cli/kolm.js`

Acceptance bar:

- compiled tools cannot request permissions absent from receipt
- replay eval fails on changed output schema
- installer writes project-local config unless approved
- dependency graph shows every external tool/resource

### W593 ReceiptOS Max

Unify every evidence event into a signed receipt graph: capture, split, label,
distill, compile, quant, runtime, fallback, deploy, billing, and compliance.

Primary files:

- `src/artifact.js`
- `src/audit.js`
- `src/event-schema.js`
- `src/otel.js`
- `src/compliance-certification-packet.js`
- `src/sigstore.js`
- `src/secrets-vault.js`

Acceptance bar:

- verifier fails if any required receipt edge is missing
- public projection has no prompt/output/secret content
- key rotation preserves old verification
- compliance export links receipts instead of raw data

### W593 Verified Artifact Market Maker

Rank artifacts by verified utility: task fit, runtime fit, license fit, evidence
depth, publisher trust, dependency risk, freshness, and enterprise policy.

Primary files:

- `src/registry.js`
- `src/marketplace.js`
- `src/artifact-dependency-graph.js`
- `src/publisher-verification.js`
- `src/site-license.js`
- `src/deployment-plans.js`

Acceptance bar:

- unverified artifacts cannot outrank verified artifacts under regulated filters
- diff separates model/data/policy/proof changes
- private registry blocks cross-tenant pulls
- deploy button disables unsupported targets

### W593 CodeGraph Product Autopilot

Bind source symbols, routes, docs, tests, readiness ids, CLI verbs, and UI links
into a local graph so agents can implement from requirements to exact files and
verification gates.

Primary files:

- `src/repo-codegraph.js`
- `scripts/build-codegraph.mjs`
- `src/product-experience.js`
- `docs/product-journeys.json`
- `docs/product-sota-readiness.json`
- `cli/kolm.js`

Acceptance bar:

- every non-stub route maps to product surface and OpenAPI operation
- every open readiness gate maps to closeout evidence and owner files
- CLI explains stale generated artifacts
- agent packet includes disjoint edit scope and tests

## Simulation

Run:

```bash
npm run verify:invention-spec
```

The simulator checks that the spec covers every tracked metric, every product
journey, every customization dimension, every open readiness gate, and every
portfolio invention it claims to implement. It also computes a synthetic metric
lift. That simulation is prioritization evidence only; production claims still
require the real benchmark, package, partner, and certification artifacts named
in readiness closeout.
