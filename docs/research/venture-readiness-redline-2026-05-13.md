# Kolm Venture Readiness Redline

Last updated: 2026-05-13

Status: research memo. This is a product and diligence redline, not legal advice.

## Bottom Line

Kolm should stop positioning as another on-device runtime. Apple, Google, Microsoft, Meta, and open source are making raw execution cheaper, native, and bundled. Kolm's fundable wedge is the compiler cache for intelligence:

1. task evidence and examples come in,
2. a portable `.kolm` artifact comes out,
3. the artifact is tied to target runtimes, eval packs, K-score history, receipts, provenance, and release policy,
4. the registry becomes the trusted distribution and governance surface.

The runtime is a supplier. The artifact control plane is the product.

## Revised Venture Readiness

Current score: 5.5 / 10.

Path to 7+: publish target benchmarks, document personalization mechanics, make artifact contents explicit, seed registry evidence, and choose a single vertical design-partner wedge.

## What Is Genuinely Right

### 1. The problem is real

Developers want AI behavior in their apps without moving sensitive user context into a remote inference loop by default. The pressure is strongest in regulated and enterprise workflows where legal, data-governance, latency, and cost concerns are blocking product teams.

### 2. The abstraction is right

The valuable abstraction is not a runtime API. It is:

`task intent -> evidence pack -> compiled artifact -> target profile -> eval proof -> release receipt`

This is the developer experience gap between a prompt and a shippable feature.

### 3. The artifact model can become a moat

Recipe, adapter, specialist, and bundle tiers make sense only if the artifact declares exactly what is inside it and which target classes it supports. The tier model should become a trust contract, not a marketing taxonomy.

### 4. K-score can become a release primitive

K-score is defensible if it is reproducible, versioned, device-aware, and correlated with real task outcomes. It is weak if it is an opaque number written into HTML or receipt metadata.

### 5. Personalization is the sharpest technical claim

Local personalization is compelling because it can turn private customer context into durable local behavior. It is also the claim that needs the most technical proof: method, storage, deletion, hardware requirements, battery behavior, eval impact, and App Store / Play Store review posture.

## What Is Still Wrong

### 1. Moat is still under-specified

The key diligence question is unchanged:

Why would a developer use kolm instead of Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp, or MLC directly?

The answer must be:

- cross-runtime compile workflow,
- artifact evidence and release governance,
- reproducible evals,
- private and public registry,
- policy-aware personalization,
- source-backed compliance posture.

Anything else sounds like a wrapper around free infrastructure.

### 2. Benchmarks are not optional

Every platform claim needs a benchmark against the native path:

- Core ML baseline on iPhone / Apple silicon,
- LiteRT baseline on Android,
- ONNX Runtime baseline on iOS / Android / server,
- ExecuTorch baseline for PyTorch-origin models,
- llama.cpp / MLC baseline for local LLM cases,
- browser target baseline where supported.

Metrics:

- p50 and p95 latency,
- artifact size,
- app binary impact,
- memory peak,
- energy proxy or battery drain proxy,
- target fallback behavior,
- K-score,
- eval pass rate,
- receipt verification cost.

### 3. Artifact contents need truth labels

Each artifact must declare:

- tier,
- payload type,
- model-bearing or pointer-only,
- target runtime,
- eval set hash,
- recipe/spec hash,
- receipt mode,
- personalization mode,
- network/runtime policy,
- unsupported targets.

This prevents sales copy from outrunning the shipped product.

### 4. Compliance claims need an evidence map

Regulated buyers ask for evidence, not adjectives. The required pack:

- BAA status,
- DPA status,
- subprocessor list,
- data lifecycle and deletion policy,
- audit log fields,
- encryption posture,
- receipt retention policy,
- support access policy,
- incident response owner,
- limitation notes,
- last legal/security review date.

### 5. Registry is under-marketed

The registry should be framed as the App Store for local AI artifacts:

- curated public artifacts,
- private enterprise namespaces,
- K-score history,
- target profiles,
- source provenance,
- revocation,
- license and risk labels,
- receipts,
- benchmark reports,
- artifact diffing.

That is a stronger recurring product than a cheap compile tier.

## Source-Backed Threat Map

| Threat | Source Signal | Kolm Risk | Required Response |
| --- | --- | --- | --- |
| Apple Core ML | Optimized on-device execution, conversion, compression, Xcode performance reports, Apple silicon integration. | iOS teams already have a native path. | Target Core ML and publish native-vs-kolm evidence. |
| Apple Foundation Models | On-device language model access for generation, structured output, and tool calling. | Simple Apple-only text features may not need kolm. | Focus on cross-platform task artifacts and governed release history. |
| Google LiteRT | High-performance on-device AI, conversion, optimization, hardware acceleration, multiple platforms. | Android and edge teams can stay in Google tooling. | Use LiteRT as a backend target and own artifact evidence above it. |
| MediaPipe | Ready-made cross-platform tasks, models, customization, and evaluation. | Common perception and LLM tasks may be bundled. | Win custom business tasks with evidence and registry governance. |
| ONNX Runtime Mobile | Mobile deployment, execution providers, binary size, latency, power, and model-size guidance. | Mature framework-neutral route. | Compile to ONNX/ORT where useful and publish reproducible measurements. |
| ExecuTorch | PyTorch-native mobile and edge inference stack. | PyTorch teams have a natural path. | Import PyTorch workflows and sell artifact promotion, not replacement. |
| llama.cpp / MLC | Strong local LLM and browser-local inference ecosystem. | Offline LLM inference alone is not valuable enough. | Focus on small task artifacts, eval packs, and governance. |
| EU AI Act / HIPAA Security Rule | Risk, governance, safeguards, and documentation pressure. | Bad compliance wording creates buyer distrust. | Maintain a dated evidence map with limitations. |
| Qualcomm + Edge Impulse | Edge AI tooling consolidation and developer ecosystem acquisition. | Full-stack edge platforms are being acquired and bundled. | Build registry and compiler evidence as acquisition-grade assets. |

## Redline Requests

### P0. Runtime target matrix

Required output: `docs/research/runtime-target-matrix-YYYY-MM-DD.csv` plus public summary.

Fields:

- target_id,
- runtime,
- platform,
- device,
- OS,
- model/task family,
- support status,
- artifact tier,
- benchmark command,
- unsupported reason,
- fallback path,
- owner.

### P0. Native benchmark pack

Required output: `/benchmarks` source-backed update and raw logs.

Minimum scenarios:

- text classifier,
- structured extractor,
- redaction task,
- small local LLM task,
- personalization task if implemented.

### P0. Personalization mechanics spec

Required output: `personalization-mechanics-YYYY-MM-DD.md`.

Must answer:

- retrieval or training,
- where local data is stored,
- whether adapters are generated,
- whether gradients are used,
- encryption at rest,
- deletion semantics,
- memory and battery envelope,
- eval impact,
- user consent UX,
- App Store / Play Store risk.

### P0. Artifact contents proof

Required output: `kolm inspect --json` fixtures for each tier.

Must show:

- manifest,
- payload inventory,
- eval hashes,
- receipt mode,
- signature mode,
- target profile,
- policy profile,
- unsupported target list.

### P1. K-score correlation study

Required output: score movement vs task success across at least three task families.

The study should treat K-score as a product release gate. If it does not correlate with outcomes, it is branding, not infrastructure.

### P1. Compliance evidence pack

Required output: sales-safe evidence folder and public posture page.

The pack should avoid blanket claims and instead show implementation status, owner, review date, limitation, and customer action needed.

### P1. Registry moat demo

Required output: 8 to 12 seeded artifacts with public pages.

Each artifact page needs:

- target profile,
- eval pack,
- K-score history,
- receipt sample,
- provenance,
- license,
- review status,
- revocation policy.

### P1. ICP and design partner wedge

Required output: one 90-day wedge with a pilot offer.

Recommended wedge choices:

- healthcare workflow apps with ePHI handling,
- fintech mobile teams with PII and audit constraints,
- enterprise mobile teams blocked by cloud AI data policy.

Pick one. Do not average the copy across all three.

## 30-60-90 Day Plan

### 0 to 30 days

- Publish `/research`.
- Add source register to docs.
- Build runtime target matrix.
- Ship first native benchmark pack.
- Replace broad compliance copy with evidence-map language.
- Create first registry artifact detail template.

### 31 to 60 days

- Seed registry with 8 to 12 artifacts.
- Publish personalization mechanics spec.
- Add `kolm inspect --json` artifact truth fixtures.
- Start 10 design-partner conversations in one vertical.
- Convert top redlines into test gates.

### 61 to 90 days

- Land 2 to 5 design partners.
- Publish benchmark refresh with real hardware deltas.
- Add private registry pilot controls.
- Create enterprise evidence pack.
- Turn design partner results into case-study proof or remove unsupported claims.

## Decabillion-Dollar Plan

The 10-year plan is not "another SDK."

It is a trusted artifact economy for AI behavior:

1. Developers compile tasks into portable artifacts.
2. Enterprises govern artifacts like software releases.
3. Registry artifacts become reusable business primitives.
4. K-score and receipts become release evidence.
5. Runtime vendors remain suppliers.
6. Kolm becomes the system of record for what AI behavior was shipped, why it passed, which device target it supports, and how it can be revoked.

That is a platform story investors can underwrite if the evidence catches up.
