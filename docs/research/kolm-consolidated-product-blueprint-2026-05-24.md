# Kolm Consolidated Product Blueprint

Date: 2026-05-24

Inputs reviewed:

- `docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md`
- Live `https://kolm.ai/` homepage, docs, pricing, quickstart, compile, K-score, and legal pages
- Local `public/*.html` site inventory: 139 public HTML routes
- Local product truth artifacts: `docs/product-surfaces.json`, `docs/product-journeys.json`, `public/product-graph.json`, `public/product-readiness-closeout.json`

Purpose:

- Collapse the huge research corpus into the useful product truth.
- Separate durable inventions from noisy expansion.
- Give frontend, backend, research, and GTM agents one coherent product blueprint.
- Make the website explain Kolm from first principles across all product surfaces, not just one surface.

## Executive Decision

Kolm should not position itself as only:

- an AI API wrapper;
- a distillation tool;
- a fine-tuning alternative;
- an on-device model exporter;
- a compliance dashboard;
- a generic AI compiler.

The strongest category is:

> Kolm is the evidence-to-artifact compiler for production AI.

Expanded:

> Kolm captures approved production AI behavior, distills repeatable work into signed `.kolm` artifacts, and runs those artifacts across your cloud, devices, and governed environments with K-score, receipts, and rollback evidence attached.

Short version:

> Compile your AI workload into a model you own.

Website-ready hero:

> Compile your AI workload into a model you own.
>
> Kolm captures approved frontier calls, distills repeatable work into signed `.kolm` artifacts, and runs them across your cloud, browser, phone, or air-gapped environment with K-score and receipts.

Do not use this as the standalone hero:

> Turn model traffic into owned AI.

Reason: it is internally meaningful but externally abstract. It does not tell a new visitor what Kolm does, who it serves, or what outcome they get.

## The Three Product Surfaces

The research and the site only become coherent when Kolm is framed as one platform with three jobs.

### Surface 1: Route And Capture

Buyer question:

- "Can I put one reliable layer in front of OpenAI, Anthropic, Gemini, Bedrock, vLLM, and open models without rewriting my app?"

Kolm answer:

- OpenAI-compatible gateway.
- Provider routing, fallback, redaction, audit receipts.
- Approved calls become a tenant-owned training and evaluation lake.
- The gateway is not the product endpoint; it is the data engine for owned AI.

Outcome copy:

> Keep shipping with your current SDK. Every approved call becomes signed training evidence for the model you will own next.

Useful research retained:

- confidence-aware adaptive routing;
- provider fallback with quality/cost/latency control;
- capture poisoning detection;
- privacy membrane and redaction benchmarks;
- OpenTelemetry GenAI conventions;
- namespace-level data contracts;
- event-lake lineage;
- selective capture with consent and policy filters.

Primary metrics:

- gateway p50/p95 latency;
- provider fallback success;
- redaction precision/recall;
- capture approval rate;
- poisoned-row detection rate;
- usable examples per 1,000 calls;
- cost per captured high-quality example;
- downstream K-score lift per capture cohort.

### Surface 2: Distill And Compile

Buyer question:

- "Can I turn repeated frontier-model work into a smaller specialist that is good enough, cheaper, and portable?"

Kolm answer:

- Teacher traces, synthetic augmentation, active learning, LoRA/QLoRA/full fine-tune paths.
- Task-adaptive student selection.
- Distillation-aware quantization.
- K-score gates before artifact promotion.
- Signed `.kolm` artifact as the deliverable.

Outcome copy:

> Stop renting the same answer. Train a specialist on the work your app actually does, gate it against held-out evals, and ship only when it beats your threshold.

Useful research retained:

- Task-Adaptive Architecture Selection;
- Teacher Council multi-teacher blending;
- confidence-calibrated routing;
- importance-weighted distillation;
- progressive distillation with capability gates;
- reasoning-trace distillation;
- contrastive distillation and DPO-lite;
- cross-namespace transfer when evidence is compatible;
- active learning loop;
- K-score external calibration;
- structured output validation;
- capture poisoning detection;
- redaction benchmark gates.

Primary metrics:

- K-score by artifact and by task family;
- teacher-match rate;
- held-out accuracy;
- confidence calibration error;
- abstention quality;
- model size;
- latency per target device;
- cost per successful compile;
- compile success rate;
- regression refusal rate;
- data efficiency: K-score lift per labeled row.

### Surface 3: Run And Govern

Buyer question:

- "Can I run the resulting AI where my risk model requires, and prove what happened later?"

Kolm answer:

- `.kolm` artifact with manifest, model or recipe, evals, receipt chain, provenance, runtime profile, and policy.
- Runtime adapters for cloud, browser, local device, BYOC, air-gap, and enterprise control planes.
- Artifact verification, registry, audit logs, account controls, and compliance evidence.

Outcome copy:

> One signed artifact runs where you choose and carries the evidence your CI, security team, auditor, and customer need.

Useful research retained:

- proof-carrying artifact format;
- K-score passport;
- runtime profile and device fit passport;
- BYOC and sovereign deployment topology;
- assurance case compiler;
- compatibility contracts;
- artifact lifecycle and supersession chain;
- SRE reliability and incident contracts;
- accessibility, localization, sustainability, and adoption evidence.

Primary metrics:

- artifact verification success;
- runtime compatibility coverage;
- device-fit pass rate;
- offline verification latency;
- incident MTTR;
- deployment rollback time;
- audit export completeness;
- accessibility coverage;
- localization coverage;
- carbon estimate coverage;
- enterprise closeout gate count.

## Product Kernel

Kolm's kernel is not "model in, model out." It is:

```text
approved behavior + task contract + eval evidence + runtime target
  -> compile/distill/quantize
  -> signed artifact
  -> governed runtime
  -> receipts and improvement loop
```

Every page, API, CLI command, account screen, and sales story should map to one of these stages:

1. Route.
2. Capture.
3. Curate.
4. Distill.
5. Quantize.
6. Score.
7. Package.
8. Run.
9. Verify.
10. Improve.

If a feature does not strengthen one of those stages, it should be demoted from top-level product narrative.

## Current Site Review

### What The Live Site Does Well

Live `kolm.ai` has several strong ingredients:

- It shows a concrete artifact idea early: `.kolm`.
- It explains "one file you own" better than most adjacent AI infrastructure products.
- It has working-looking quickstart paths.
- It ties artifacts to K-score, receipts, offline execution, and owned runtime.
- It speaks directly to healthcare, finance, legal, devices, and coding agents.
- It correctly distinguishes local runtime from hosted frontier APIs.

### What The Live Site Gets Wrong

The live homepage still over-focuses on "classifier AI." That narrows Kolm to one use case and hides the larger product:

- route and capture production model calls;
- distill top models into specialists;
- compile and run owned artifacts on any device or enterprise topology;
- prove quality, provenance, and governance.

The live pricing page also appears to expose a plan taxonomy that differs from the local canonical pricing direction:

- live: Developer, Starter, Pro, Teams, Growth, Business, Enterprise;
- local site: Free, Pro, Team, Enterprise.

That difference matters because pricing is part of product trust. The consolidated position should use one canonical pricing model unless finance explicitly changes it.

### What The Local Site Does Better

The local `public/index.html` is closer to the right product:

- H1: "Frontier AI on your own infrastructure."
- It leads with capture, distill, quantize, run.
- It presents the gateway as a starting point, not the whole product.
- It includes Free, Pro, Team, Enterprise pricing.
- It makes `.kolm` a signed runtime artifact rather than a demo gimmick.

### What The Local Site Still Needs

The local site is broad but still fragmented:

- 139 public HTML routes create discoverability and consistency risk.
- Some pages say "two products"; the better frame is "one platform, three jobs."
- Some pages are strong individually but do not ladder into one buyer journey.
- Vertical pages should not all be top-level promises; they need evidence thresholds.
- The homepage should carry the three-surface product matrix above the fold.
- The account surface should mirror the product matrix, not only billing or usage.
- Docs should guide users by job-to-be-done, not route count.

## Website Information Architecture

The site should collapse into seven stable hubs.

### Hub 1: Product

Purpose:

- Explain the three product surfaces.

Primary pages:

- `/product`
- `/capture`
- `/distill`
- `/compile`
- `/run`
- `/k-score`
- `/verify-prod`

Top-level copy:

> One platform for production AI: route models today, distill the repeat work tomorrow, and run signed artifacts wherever your risk model allows.

### Hub 2: Developers

Purpose:

- Get a builder to a working artifact quickly.

Primary pages:

- `/quickstart`
- `/docs`
- `/api`
- `/sdks`
- `/spec`
- `/download`
- `/troubleshooting`

Top-level copy:

> Start with one SDK line, one CLI command, or one browser compile. End with a signed artifact and a receipt you can verify.

### Hub 3: Enterprise

Purpose:

- Show security, compliance, topology, and procurement proof.

Primary pages:

- `/enterprise`
- `/security`
- `/privacy`
- `/threat-model`
- `/subprocessors`
- `/soc2`
- `/slsa`
- `/baa`
- `/sla`
- `/byoc`
- `/airgap`

Top-level copy:

> Bring Kolm to your risk model: hosted, single-tenant, BYOC, on-prem, or air-gapped, with receipts and evidence exports attached.

### Hub 4: Use Cases

Purpose:

- Show specific jobs, not generic industries.

Primary pages:

- `/use-cases`
- `/healthcare`
- `/finance`
- `/legal`
- `/defense`
- `/gov`
- `/education`
- `/saas`
- `/sovereign-ai`

Top-level copy:

> The same artifact pattern applied to regulated workflows, AI products, agent tools, and edge deployments.

### Hub 5: Benchmarks And Research

Purpose:

- Earn technical credibility without overclaiming.

Primary pages:

- `/research`
- `/benchmarks`
- `/kscore-bench`
- `/k-score-calibration`
- `/whitepaper`
- `/frontier-stack`

Top-level copy:

> Every claimed improvement should map to a reproducible eval, benchmark, or artifact receipt.

### Hub 6: Ecosystem

Purpose:

- Create network effects.

Primary pages:

- `/registry`
- `/marketplace`
- `/hub`
- `/recipes`
- `/community`
- `/badge`
- `/integrations`

Top-level copy:

> Fork, verify, remix, and publish signed AI artifacts with provenance and licensing intact.

### Hub 7: Pricing

Purpose:

- Explain cost transition from rented tokens to owned artifacts.

Primary pages:

- `/pricing`
- `/roi`
- `/upgrade`

Top-level copy:

> Pay to capture and compile. Run owned artifacts without a per-token bill.

## Copy System

### Canonical One-Liner

> Kolm compiles production AI behavior into signed models you own.

### Canonical Two-Liner

> Keep your current model APIs while Kolm captures approved behavior. When a task repeats, Kolm distills it into a signed `.kolm` artifact that runs on your infrastructure with K-score, receipts, and rollback evidence.

### Canonical Long Description

> Kolm is an open-source AI workbench for teams that want to stop renting the same frontier-model call forever. It routes model traffic through one compatible API, captures approved examples into a tenant-owned evidence lake, distills repeatable work into small specialists, packages them as signed `.kolm` artifacts, and verifies every run with K-score and receipts. The same artifact can run in your cloud, your VPC, a browser, a phone, or an air-gapped environment.

### Above-The-Fold Page Formula

Every public page should answer:

1. What is this page for?
2. Who is this for?
3. What do they get in the first 10 minutes?
4. What proof exists?
5. What is not claimable yet?

### Words To Prefer

- compile;
- capture;
- distill;
- signed artifact;
- owned model;
- K-score;
- receipt;
- run anywhere;
- BYOC;
- local runtime;
- proof;
- regression gate.

### Words To Avoid As Headline Anchors

- owned AI, unless immediately explained;
- model traffic, unless speaking to infra buyers;
- AI compiler, unless the page defines it;
- state of the art, unless tied to benchmark evidence;
- forever, unless scoped to artifact portability and open runtime;
- HIPAA safe, unless legally scoped;
- certified, unless the certification exists.

## Useful Research To Keep

The raw research document is useful, but only if compressed into product primitives.

### Keep 1: K-Score As The Product Gate

K-score is the most important invented surface.

Keep:

- per-artifact score, not generic model score;
- decomposed axes;
- CI gate;
- external calibration dataset;
- human-preference correlation;
- calibration drift monitoring;
- public calculator;
- benchmark report provenance;
- refusal when no eval exists.

Turn into product:

- `/k-score` becomes the measurement contract.
- Account shows K-score over time for every artifact.
- Registry ranks artifacts only within comparable task/eval families.
- Sales claims cite K-score reports, not broad performance claims.

### Keep 2: Capture-To-Distill Flywheel

This is Kolm's data moat.

Keep:

- approval-only capture;
- namespace-level event lake;
- poison detection;
- privacy filters;
- example valuation;
- active learning;
- held-out eval construction;
- promote-to-distill threshold;
- regression refusal.

Turn into product:

- Account homepage should show "calls captured -> examples approved -> distill readiness -> candidate artifact -> deployed artifact."
- The gateway should always explain that capture is optional, scoped, and governed.

### Keep 3: Task-Adaptive Student Architecture Selection

This is a real differentiator if implemented.

Keep:

- select architecture by task evidence, target device, latency, and risk;
- not just "choose Qwen" or "choose Llama";
- include route fallback when local confidence is weak;
- record why a student was selected.

Turn into product:

- `kolm distill` outputs "why this student" report.
- Account displays candidate students on a Pareto frontier.
- Pricing can charge for deeper search.

### Keep 4: Distillation-Aware Quantization

This connects research to runtime economics.

Keep:

- activation distribution profiling;
- attention pattern profiling;
- confidence preservation;
- layer redundancy detection;
- target-device calibration;
- energy-aware tuning;
- runtime profile passport.

Turn into product:

- Device transfer page becomes a real "fit and risk" calculator.
- Runtime page shows the quantization method, expected quality loss, and fallback policy.

### Keep 5: Confidence-Aware Adaptive Routing

This unifies the gateway with owned artifacts.

Keep:

- local artifact first;
- route to frontier when confidence or coverage is insufficient;
- record fallback reason;
- feed fallback cases back into active learning;
- cost-aware and risk-aware routing policies.

Turn into product:

- "Use frontier only when the owned model should not answer."
- This is easier to understand than "hybrid inference."

### Keep 6: Structured Output Validation

This is valuable immediately.

Keep:

- JSON Schema / Zod / OpenAPI constrained outputs;
- parser-aware repair;
- refusal on invalid output;
- receipt names schema version;
- evals include schema conformance.

Turn into product:

- Compile page should let users paste a schema.
- K-score should include schema validity as a first-class component for structured tasks.

### Keep 7: Proof-Carrying Artifact

This is Kolm's durable category.

Keep:

- manifest;
- artifact hash;
- eval hash;
- teacher trace hash;
- runtime profile;
- model card;
- K-score report;
- receipt chain;
- policy gates;
- compatibility passport.

Turn into product:

- "Drop a `.kolm`, verify everything" is a flagship demo.
- Enterprise and docs should show the exact evidence tree.

### Keep 8: Artifact Lifecycle

An artifact is not finished at compile.

Keep:

- stale notification;
- drift detection;
- supersession chain;
- rollback;
- non-regression tests;
- compare two artifacts;
- sunset policy.

Turn into product:

- Account should have an artifact lifecycle timeline.
- Registry should show "current, superseded, stale, revoked."

### Keep 9: Runtime Profile And Device Passport

This makes "run anywhere" honest.

Keep:

- target device;
- backend;
- precision;
- memory;
- p50/p95 latency;
- energy estimate;
- fallback policy;
- known unsupported features.

Turn into product:

- Device transfer must be a product surface, not a static page.
- Runtime docs should be organized by target: cloud, browser, phone, laptop, edge, air-gap.

### Keep 10: Enterprise Evidence Graph

This makes regulated buyers move.

Keep:

- topology map;
- data-flow diagram;
- subprocessors;
- BAA/DPA/SLA;
- SOC/ISO/FedRAMP status scoped honestly;
- audit export;
- incident and SRE posture;
- retention and deletion contracts;
- third-party risk packet.

Turn into product:

- Enterprise page should be an evaluation packet.
- Account should export evidence per artifact, namespace, and tenant.

### Keep 11: Accessibility, Global, Sovereign, Sustainability, Adoption

These are not secondary polish.

Keep:

- accessibility evidence in artifacts and UI;
- localization and language equity;
- sovereign deployment;
- carbon and energy accounting;
- rollout and human adoption proof.

Turn into product:

- Enterprise and public sector pages should show these as deployment gates.
- Account readiness should expose what is implemented and what needs proof.

### Keep 12: Marketplace Network Effects

The marketplace should not be a generic model zoo.

Keep:

- signed artifacts;
- comparable K-score within task families;
- licensing and provenance;
- fork/remix lineage;
- royalty sharing;
- anti-gaming;
- trust badges;
- reproducible benchmarks.

Turn into product:

- Marketplace launches only when verification, licensing, and comparability are mature.

## Useful Research To Cut Or Demote

### Demote Raw Wave Volume

The research file has thousands of wave ideas. That is useful for exploration, but not for execution. The product should not expose raw wave count as proof.

Keep the wave system internally as an invention ledger. Do not let it define site IA.

### Demote Arbitrary Vertical Expansion

The raw research covers many verticals. Only elevate a vertical when Kolm has:

- a real workflow;
- a sample artifact;
- a K-score/eval packet;
- a compliance mapping;
- a buyer-specific ROI argument.

Until then, keep the vertical in a library, not the main nav.

### Cut Generic "Best" Claims

Avoid:

- best compiler;
- best quantization;
- state of the art;
- certified;
- HIPAA-safe;
- guaranteed savings;
- runs on every device.

Replace with:

- exact artifact;
- exact eval;
- exact runtime;
- exact certification status;
- exact savings assumptions.

### Cut Feature Lists Without Outcome

Do not lead with:

- Ed25519;
- ONNX;
- GGUF;
- TEE;
- SCIM;
- OpenTelemetry;
- LoRA;
- AWQ;
- GPTQ.

Lead with:

- verify the output later;
- run inside your VPC;
- ship to a phone;
- fail CI if quality regresses;
- prove PHI stayed inside boundary;
- use frontier only when needed.

Then name the technology as proof.

## Roadmap Consolidation

The roadmap should be represented as five execution tracks, not hundreds of waves.

### Track A: Trustworthy Gateway And Capture

Includes:

- W807 confidence-aware adaptive routing;
- W808 capture poisoning detection;
- privacy filters;
- provider readiness;
- structured telemetry;
- capture approval UX.

Definition of done:

- app can keep using OpenAI SDK;
- Kolm routes, redacts, logs, and signs approved calls;
- captured examples have quality labels and poison risk;
- low-confidence local artifacts fall back to frontier with receipt.

### Track B: Distillation Factory

Includes:

- W810 K-score external calibration;
- W815 active learning;
- W716 task-adaptive architecture search;
- W718 Teacher Council;
- W719 distillation-aware quantization;
- W827 DPO-lite;
- W828 reasoning trace distillation.

Definition of done:

- compile report explains data, teacher, student, eval, quant, and target;
- K-score is calibrated against public and private benchmarks;
- artifact ships only if gates pass;
- failure report tells the user what data to add next.

### Track C: Runtime And Device Forge

Includes:

- W721 TSAC sparse attention compiler;
- W722 ITKV importance-tiered KV cache;
- W826 memory-aware scheduling;
- W824 Kubernetes deployment;
- W818 ecosystem loaders;
- WebGPU/WebNN/MLX/llama.cpp/vLLM adapters.

Definition of done:

- one artifact has runtime passports for cloud, laptop, browser, phone, and edge where supported;
- unsupported targets fail honestly;
- memory, latency, energy, and K-score deltas are reported.

### Track D: Proof, Governance, And Enterprise

Includes:

- structured output validation;
- proof-carrying artifact;
- assurance case compiler;
- SOC/ISO/FedRAMP readiness;
- audit exports;
- SRE, incident, and continuity posture;
- accessibility/global/sovereign/sustainability/adoption contracts.

Definition of done:

- every artifact has a proof bundle;
- every open claim has a closeout state;
- enterprise buyer can export a review packet without a sales engineer rewriting the story.

### Track E: Ecosystem And Category Creation

Includes:

- `.kolm` format stewardship;
- SDKs and loaders;
- marketplace;
- certification program;
- benchmark leaderboard;
- university/research program;
- partner channels.

Definition of done:

- third parties can verify and run artifacts;
- artifacts can be shared, forked, licensed, and compared safely;
- Kolm defines the yardstick through K-score and artifact proof.

## Backend Product Requirements

The backend should expose product truth, not only endpoints.

Required contracts:

- `/v1/product/graph`: surfaces, journeys, routes, CLI, TUI, account links, readiness counts.
- `/v1/product/frontier-contracts`: implementation contracts from the invention portfolio.
- `/v1/storage/object-readiness`: storage provider readiness without secret leakage.
- `/v1/cloud/readiness`: cloud/GPU/teacher/observability/SSO readiness.
- `/v1/artifacts/:id/proof`: artifact passport, eval, runtime, provenance, K-score, policy.
- `/v1/namespaces/:id/distill-readiness`: capture volume, approval rate, poison risk, eval coverage.
- `/v1/routes/decision`: why a call used local artifact, teacher, fallback, or refusal.

Every response that affects a product claim should include:

- `ok`;
- `scope`;
- `evidence_paths` or evidence IDs;
- `readiness_status`;
- `missing_requirements`;
- `next_actions`;
- `secret_values_included: false` when relevant.

## Account Product Requirements

Post-auth account should not be a generic dashboard. It should be the operating console for the three product surfaces.

Required sections:

1. Route and capture health.
2. Distill readiness by namespace.
3. Artifact inventory and lifecycle.
4. Runtime targets and device fit.
5. K-score and regression history.
6. Cost transition: frontier spend avoided, compile spend, local runtime savings.
7. Trust evidence: receipts, audit export, compliance packets.
8. Readiness closeout: what is implemented, what is package/release/certification/external proof gated.
9. Team controls: roles, SSO, SCIM, keys, storage, billing.
10. Next best action: approve examples, run distill, fix eval gap, deploy artifact, rotate key, export evidence.

The account page should answer:

- What am I using today?
- What can I safely compile now?
- What should stay on frontier?
- What artifact is stale or risky?
- What evidence can I hand to a buyer, auditor, or customer?

## Docs Product Requirements

Docs should be organized by job:

1. Start: install, key, first artifact.
2. Route: OpenAI-compatible gateway.
3. Capture: event lake and approval.
4. Distill: build owned specialist.
5. Compile: package signed artifact.
6. Run: local, cloud, device, BYOC.
7. Verify: receipt, K-score, artifact proof.
8. Govern: team, audit, compliance, retention.
9. Extend: SDKs, loaders, marketplace, custom runtimes.

Every docs page should have:

- exact command;
- expected output;
- failure mode;
- proof artifact;
- claim scope;
- link to API reference;
- link to account UI surface if relevant.

## Website Rewrite Requirements

### Hero

Use:

> Compile your AI workload into a model you own.

Subhead:

> Keep your current model APIs. Kolm captures approved calls, distills repeatable work into signed `.kolm` artifacts, and runs them across your cloud, browser, phone, or air-gapped environment with K-score and receipts.

Proof rail:

- OpenAI-compatible gateway.
- Teacher-to-student distillation.
- Signed `.kolm` artifacts.
- K-score gate.
- Run local, BYOC, browser, device, air-gap.

Do not lead with:

- classifier AI;
- "model traffic" without explanation;
- broad "frontier AI" without artifact outcome;
- a video-only hero;
- abstract ownership language.

### Product Matrix

Above or immediately below hero:

| Start here | What Kolm does | What you get |
|---|---|---|
| You call model APIs today | route, redact, capture, sign | governed evidence lake |
| You repeat the same task | distill, quantize, K-score gate | owned specialist artifact |
| You need control | run, verify, export, rollback | proof-carrying runtime |

### Demo

The demo should show the full product loop:

1. Paste an OpenAI call or task.
2. Kolm captures the call and names the task.
3. User approves examples.
4. Kolm compiles a tiny `.kolm`.
5. UI shows K-score and receipt.
6. User runs the artifact locally or in-browser.
7. UI shows frontier fallback policy.

Do not show a generic animation as the main proof. The aha moment is receiving a real artifact and receipt.

### Pricing

Canonical pricing should be simple:

- Free;
- Pro;
- Team;
- Enterprise custom.

Pricing story:

> You pay while creating and managing artifacts. You do not pay Kolm per local run after compile.

Avoid plan drift across homepage, pricing, signup, docs, billing API, and CLI.

### Enterprise Page

Enterprise should be a review packet:

- topology options;
- data flow;
- auth and access;
- storage and secrets;
- compliance status;
- evidence exports;
- BAA/DPA/SLA;
- readiness closeout.

The page must distinguish:

- implemented controls;
- package-release gates;
- certification gates;
- external partner gates;
- public benchmark gates.

## Metrics That Matter

Kolm should track and improve these metrics.

### Technical Metrics

- K-score lift per compile.
- Held-out accuracy.
- Calibration error.
- Abstention quality.
- Structured output validity.
- Poison detection precision/recall.
- Redaction precision/recall.
- Artifact size.
- Runtime latency.
- Runtime memory.
- Runtime energy.
- Device-fit pass rate.

### Product Metrics

- time to first artifact;
- visitor-to-API-key conversion;
- API-key-to-first-capture conversion;
- capture-to-approved-example conversion;
- namespace-to-distill conversion;
- distill-to-deployed-artifact conversion;
- deployed-artifact retention;
- artifact verification events;
- account next-action completion;
- docs task completion.

### Business Metrics

- frontier spend displaced;
- gross margin by compile;
- cost per successful artifact;
- ARR by product surface;
- expansion from gateway to distill to runtime/governance;
- enterprise review packet completion;
- sales cycle time;
- support tickets per successful compile.

### Trust Metrics

- open readiness gates;
- time to close proof gaps;
- audit export completeness;
- incident MTTR;
- SLA attainment;
- accessibility coverage;
- localization coverage;
- certification evidence freshness.

## Claim Policy

Every public claim must map to one of four proof classes.

### Class 1: Shipped And Probed

Can say:

- "ships today";
- "available now";
- "run this command";
- "verified by this test or endpoint."

Requires:

- code path;
- test or smoke;
- docs;
- product surface link.

### Class 2: Implemented Locally, Needs Release

Can say:

- "available in source";
- "release packaging in progress";
- "not yet published to package channel."

Cannot say:

- "install anywhere";
- "available on npm/brew/marketplace" unless true.

### Class 3: External Proof Required

Can say:

- "designed for";
- "maps to";
- "supports evidence for."

Cannot say:

- "certified";
- "standard";
- "partner supported";
- "auditor approved" unless external evidence exists.

### Class 4: Research Direction

Can say:

- "research track";
- "prototype direction";
- "planned experiment."

Cannot say:

- "shipped";
- "guaranteed";
- "state of the art."

## Implementation Agent Handback

### P0: Product Truth

Build or verify:

- one canonical product graph;
- one pricing graph;
- one readiness graph;
- one claim gate;
- one account matrix;
- one docs IA;
- one hero narrative.

Acceptance:

- no surface says "two products" while another says three surfaces;
- no live pricing drift;
- no unscoped certification claim;
- no unsupported runtime target claim.

### P1: First Aha

Build or verify:

- paste OpenAI call;
- capture and classify task;
- generate or select eval;
- produce `.kolm` artifact or verified sample;
- show K-score;
- run it locally/in-browser;
- export receipt.

Acceptance:

- user understands Kolm in under 60 seconds by doing, not reading.

### P2: Distillation Moat

Build or verify:

- task-adaptive student selection;
- active learning;
- Teacher Council;
- DAQ;
- confidence-aware routing;
- structured output validation;
- K-score calibration.

Acceptance:

- artifact quality improves with evidence;
- failure report tells user the next best data action.

### P3: Enterprise Trust

Build or verify:

- evidence packet export;
- storage/cloud readiness;
- SSO/SCIM/RBAC visibility;
- audit logs;
- incident/SLA status;
- BAA/DPA/SOC/FedRAMP scoped truth.

Acceptance:

- enterprise buyer can self-serve a review packet before sales call.

### P4: Ecosystem

Build or verify:

- `.kolm` spec stewardship;
- SDKs;
- loaders;
- registry;
- marketplace;
- certification;
- benchmark leaderboard.

Acceptance:

- third parties can verify, run, fork, and compare artifacts safely.

## Consolidated Product Roadmap

### Now

- Make the website explain the three product surfaces.
- Keep all claims scoped by readiness evidence.
- Make the account console show route/capture, distill/compile, run/govern.
- Make demo produce an artifact or verified sample.
- Canonicalize pricing.

### Next

- Ship confidence-aware routing.
- Ship capture poisoning detection.
- Ship structured output validation.
- Publish K-score calibration methodology and calculator.
- Turn distill readiness into an account workflow.
- Add runtime passports to every artifact.

### Then

- External benchmark data.
- Package releases.
- Ecosystem loaders.
- Marketplace with licensing/provenance.
- Certification and partner programs.
- Sovereign and public-sector packets.

## Ultimate Design Matrix V2

This section turns the consolidated research into a buildable invention matrix. It is intentionally narrower than the raw wave ledger and deeper than the marketing blueprint.

The design standard:

- every invention must improve at least one tracked product metric;
- every invention must attach proof to the `.kolm` artifact or account graph;
- every invention must have a refusal mode;
- every invention must be explainable to a developer, buyer, auditor, and runtime operator;
- every invention must avoid unproven "best" claims.

### Design Axis 1: Proof-Carrying Artifact Passport

Core invention:

> Every `.kolm` becomes an AI-BOM plus assurance passport, not just a model bundle.

Why this matters:

- Software supply chains already use provenance, SBOM, attestation, and transparency logs.
- AI artifacts need the same treatment, but with task, eval, teacher, student, runtime, policy, and K-score evidence.
- Kolm can own this category because `.kolm` is already the natural envelope.

Build spec:

- `artifact.identity`: artifact id, semantic version, content hash, signing key, registry namespace.
- `artifact.formulation`: task contract, compile command, base model, teacher endpoints, distill method, quantization method.
- `artifact.inputs`: datasets, capture cohorts, eval sets, schemas, recall indexes, consent tags, license tags.
- `artifact.provenance`: build platform, source commit, resolved dependencies, model weights, adapters, tokenizer, runtime.
- `artifact.evaluation`: K-score, axis breakdown, confidence calibration, schema validity, safety refusals, redaction results.
- `artifact.runtime`: target matrix, memory, latency, energy, backend, unsupported operations, fallback policy.
- `artifact.governance`: retention, access policy, intended use, prohibited use, reviewer, approval workflow.
- `artifact.attestations`: local signature, optional Sigstore/Rekor entry, optional in-toto statement, optional SLSA-style provenance.
- `artifact.closeout`: which claims are shipped, implemented locally, package gated, certification gated, partner gated, or benchmark gated.

Proof required:

- offline verifier recomputes artifact hash;
- verifier checks signature and manifest schema;
- verifier checks K-score report hash;
- verifier checks eval set hash;
- verifier checks runtime passport hash;
- verifier reports missing external proof instead of hiding it.

Metric lift:

- artifact verification success;
- enterprise review completion;
- marketplace trust;
- support tickets per artifact;
- time to security approval.

Sources to align with:

- SLSA provenance: `https://slsa.dev/spec/v1.2/provenance`
- in-toto specs: `https://in-toto.io/docs/specs/`
- SPDX specifications: `https://spdx.dev/use/specifications/`
- CycloneDX specification overview: `https://cyclonedx.org/specification/overview/`
- Sigstore Rekor: `https://docs.sigstore.dev/logging/overview/`

### Design Axis 2: K-Score Metrology Lab

Core invention:

> K-score becomes a metrology system: calibrated, versioned, task-scoped, and auditable.

Why this matters:

- A single score is only defensible if the measurement process is visible.
- Kolm should not claim K-score is globally comparable across arbitrary tasks.
- Kolm should make K-score the best shipping gate for one artifact against one task contract.

Build spec:

- `kscore.version`: scoring spec version.
- `kscore.task_family`: extraction, classification, generation, tool-use, redaction, retrieval, multimodal.
- `kscore.axes`: accuracy, coverage, calibration, cost, latency, size, schema validity, safety, human preference if available.
- `kscore.weights`: default, vertical override, customer override, safety override.
- `kscore.baseline`: teacher model, frontier baseline, previous artifact, human-reviewed gold set.
- `kscore.confidence`: sample size, confidence interval, bootstrap interval, drift window.
- `kscore.calibration`: public calibration set id, private holdout id, quarterly calibration version.
- `kscore.refusal`: no eval, no score; incompatible eval, no comparison; insufficient sample size, provisional score only.

Product surface:

- `/k-score` explains per-artifact measurement.
- account shows score history and why score moved.
- registry prevents cross-task leaderboard misuse.
- sales claims cite artifact-specific reports only.

Metric lift:

- compile acceptance quality;
- regression detection;
- user trust;
- benchmark credibility;
- time to debug failed compile.

Ultimate standard:

> K-score is not "the best model wins." K-score is "this artifact is safe enough to ship for this task, on this eval, against this baseline."

### Design Axis 3: Distill Readiness Index

Core invention:

> Kolm should tell a user when their captured traffic is ready to become an owned artifact.

Why this matters:

- Most teams do not know when they have enough data.
- "Distill now" should not be a button; it should be a readiness verdict.

Build spec:

- input coverage by template, intent, language, customer segment, tool path, and risk class;
- output consistency across teachers and historical answers;
- poison risk;
- privacy and consent status;
- label confidence;
- eval split readiness;
- expected K-score lift;
- expected cost displacement;
- expected local fallback rate.

Verdicts:

- `not_ready`: missing coverage, risky data, no eval, or unstable output.
- `ready_for_recipe`: deterministic or rule-heavy task can compile without model distill.
- `ready_for_student`: enough examples for specialist distillation.
- `ready_for_hybrid`: local artifact plus frontier fallback.
- `ready_for_human_review`: high impact, needs approval before training.

Metric lift:

- compile success rate;
- wasted training spend;
- K-score lift per labeled row;
- user confidence;
- first successful distill.

Account requirement:

- every namespace shows readiness, blocker, next action, and expected economic upside.

### Design Axis 4: Task-Adaptive Student Architecture Search

Core invention:

> The student model should be selected by task evidence, not brand preference.

Search inputs:

- task type;
- output schema;
- context length;
- language;
- reasoning requirement;
- multimodal requirement;
- latency target;
- memory target;
- target hardware;
- allowed licenses;
- privacy tier;
- fallback tolerance;
- budget.

Search outputs:

- candidate students;
- expected K-score;
- expected runtime footprint;
- expected cost per compile;
- expected confidence/fallback curve;
- reasons rejected;
- final selected student with a signed selection report.

Algorithmic approach:

- cheap static filter for hard constraints;
- embedding and task geometry matching for likely families;
- small bakeoff on a stratified eval slice;
- Bayesian or bandit search for promising candidates;
- stop when Pareto frontier is stable;
- emit a "why this student" artifact passport entry.

Metric lift:

- K-score per compile dollar;
- latency and memory fit;
- model-size reduction;
- failed compile reduction;
- trust in automated distillation decisions.

Refusal:

- do not select a student if no candidate meets the minimum gate;
- keep frontier routing if the local specialist cannot cover the task safely.

### Design Axis 5: Distillation-Aware Quantization

Core invention:

> Quantization should be driven by the artifact's task distribution, not a generic quant preset.

Build spec:

- activation distribution probe;
- attention and KV-cache profile;
- outlier channel map;
- layer sensitivity profile;
- schema-validity sensitivity;
- calibration set from the artifact eval distribution;
- target-device memory and latency constraints;
- quality-loss budget from K-score threshold.

Quantization policies:

- aggressive for high-redundancy deterministic tasks;
- conservative for safety-critical extraction;
- mixed precision for schema and tool-call heads;
- fallback to larger precision when calibration uncertainty is high;
- route to frontier when quantized artifact confidence is insufficient.

Metric lift:

- artifact size;
- latency;
- memory;
- energy;
- device coverage;
- K-score retention after compression.

Runtime requirement:

- every quantized artifact carries `quality_delta`, `memory_delta`, `latency_delta`, and `unsupported_target_reason`.

### Design Axis 6: Confidence-Aware Hybrid Router

Core invention:

> Owned artifact first, frontier only when the owned artifact should not answer.

Decision inputs:

- artifact confidence;
- calibration band;
- schema validity;
- safety risk;
- novelty score;
- drift score;
- user tier;
- cost budget;
- latency budget;
- provider availability;
- data egress policy.

Decision outputs:

- local answer;
- local answer with warning;
- frontier fallback;
- human review;
- refusal;
- capture for active learning.

Receipt requirements:

- route chosen;
- confidence;
- fallback reason;
- provider if used;
- cost;
- policy version;
- whether the example is eligible for future training.

Metric lift:

- frontier spend displacement;
- answer quality;
- safety;
- user trust;
- active learning yield.

Website language:

> Use frontier models only for the cases your owned model should not handle yet.

### Design Axis 7: Structured Output Proof Engine

Core invention:

> A `.kolm` artifact should prove that it can produce the shape your workflow requires.

Build spec:

- schema ingestion: JSON Schema, OpenAPI, Zod, Pydantic, protobuf where practical;
- constrained decoding where runtime supports it;
- post-generation validator where constrained decoding is unavailable;
- repair loop with maximum attempts;
- refusal when schema cannot be satisfied;
- K-score axis for schema validity;
- receipt includes schema version and validation result.

Metric lift:

- workflow automation success;
- support tickets;
- hallucinated fields;
- integration time;
- enterprise trust.

Sources to align with:

- SGLang structured outputs: `https://docs.sglang.io/advanced_features/structured_outputs.html`

### Design Axis 8: Runtime Passport And Compiler IR Bridge

Core invention:

> `.kolm` should become a portable artifact with explicit runtime passports for each target.

Targets:

- local CPU;
- CUDA/TensorRT-LLM;
- vLLM;
- SGLang;
- llama.cpp/GGUF;
- ONNX Runtime GenAI;
- MLX/Core ML;
- WebGPU/WebNN/WASM;
- Kubernetes/BYOC;
- air-gap/offline.

Passport fields:

- supported;
- backend;
- model format;
- precision;
- memory;
- latency;
- throughput;
- energy;
- unsupported operators;
- required runtime version;
- expected K-score delta;
- fallback behavior.

Bridge strategy:

- use ONNX or GGUF where ecosystem compatibility matters;
- use TensorRT-LLM where NVIDIA throughput matters;
- use vLLM/SGLang where server throughput and scheduling matter;
- use IREE/MLIR-style lowering where many-device portability matters;
- use WebGPU/WebNN/WASM for browser and local no-install paths.

Metric lift:

- runtime coverage;
- device-fit pass rate;
- supportability;
- deployment speed;
- portability credibility.

Sources to align with:

- IREE: `https://github.com/iree-org/iree`
- ONNX Runtime GenAI: `https://onnxruntime.ai/docs/genai/`
- TensorRT-LLM: `https://docs.nvidia.com/tensorrt-llm/`
- vLLM PagedAttention reference: `https://arxiv.org/abs/2309.06180`
- SGLang documentation: `https://docs.sglang.io/`

### Design Axis 9: GenAI Observability Normalizer

Core invention:

> Kolm should normalize AI traces into standard observability vocabulary and add artifact-specific evidence.

Build spec:

- OpenTelemetry-compatible spans for model calls, agent steps, tool calls, retrieval, compile jobs, distill jobs, eval runs, artifact verification, and fallback.
- Kolm-specific attributes for artifact id, K-score version, eval id, route decision, capture eligibility, redaction result, and policy version.
- PII-safe event storage by default.
- Account UI maps traces to product stages, not raw logs.

Metric lift:

- incident diagnosis;
- customer debugging;
- provider comparison;
- drift detection;
- enterprise observability adoption.

Source to align with:

- OpenTelemetry GenAI semantic conventions: `https://opentelemetry.io/docs/specs/semconv/gen-ai/`

### Design Axis 10: Assurance Case Compiler

Core invention:

> Every regulated artifact gets a machine-readable argument for why it is allowed to run.

Argument structure:

- claim: what the artifact is allowed to do;
- context: task, environment, user, risk class;
- strategy: how evidence supports the claim;
- evidence: evals, receipts, redaction results, access logs, topology, runtime passport;
- assumptions: what must remain true;
- defeaters: what invalidates the claim;
- closeout: open proof gates.

Product use:

- enterprise packet;
- public sector packet;
- healthcare model-risk review;
- finance SR 11-7 style challenger review;
- legal privilege workflow review;
- internal AI governance board.

Metric lift:

- sales-cycle compression;
- audit readiness;
- compliance support burden;
- trust conversion;
- renewal confidence.

### Design Axis 11: Artifact Lifecycle Governor

Core invention:

> Artifacts need lifecycle control: current, stale, superseded, revoked, quarantined, or experimental.

Lifecycle transitions:

- created;
- signed;
- deployed;
- monitored;
- drift suspected;
- re-evaluated;
- superseded;
- revoked;
- archived.

Trigger sources:

- K-score regression;
- provider baseline change;
- schema change;
- new regulation;
- incident;
- stale training data;
- security advisory;
- license change;
- runtime target change.

Metric lift:

- rollback speed;
- production safety;
- customer trust;
- account clarity;
- support reduction.

Account requirement:

- every artifact card shows lifecycle state, why it changed, and what to do next.

### Design Axis 12: Capture Poisoning And Data Rights Firewall

Core invention:

> Training data must be eligible, safe, and useful before it can influence an artifact.

Checks:

- prompt injection;
- malicious tool traces;
- inconsistent labels;
- synthetic spam;
- privacy leakage;
- copyright/license risk;
- consent absence;
- outlier behavior;
- duplicate or near-duplicate rows;
- cross-tenant contamination risk.

Actions:

- approve;
- quarantine;
- redact;
- downweight;
- request human review;
- exclude from eval;
- exclude from training;
- export as incident.

Metric lift:

- model safety;
- legal defensibility;
- K-score validity;
- enterprise trust;
- active learning quality.

### Design Axis 13: Artifact Marketplace With Comparable Trust

Core invention:

> Marketplace should trade verified task artifacts, not vague models.

Listing requirements:

- task family;
- intended use;
- prohibited use;
- K-score report;
- eval compatibility group;
- license;
- provenance;
- runtime passport;
- security review status;
- fork lineage;
- owner and maintainer;
- revenue share terms.

Anti-gaming:

- no cross-task ranking;
- public eval leakage detection;
- hidden holdout for featured rankings;
- signed reviewer identities;
- fraud and duplicate detection;
- no unverified "best" badges.

Metric lift:

- ecosystem growth;
- artifact reuse;
- creator supply;
- customer acquisition;
- standard adoption.

### Design Axis 14: Account Operating System

Core invention:

> The account page should be the product matrix in operational form.

Top cards:

- Route health.
- Capture readiness.
- Distill readiness.
- Artifact lifecycle.
- Runtime targets.
- Trust evidence.
- Spend displacement.
- Open closeout gates.

Next-action engine:

- "approve 34 examples";
- "add held-out evals";
- "run distill";
- "publish artifact";
- "deploy to BYOC";
- "export evidence packet";
- "fix unsupported device target";
- "rotate stale key";
- "review poisoned capture."

Metric lift:

- activation;
- conversion from gateway to distill;
- enterprise proof completion;
- reduced confusion;
- product surface coherence.

### Design Axis 15: Website As Product Compiler

Core invention:

> The website should behave like a compiler: user intent in, product path out.

Homepage flow:

1. Ask what the visitor has: model API, repeated task, target device, compliance requirement, or artifact to verify.
2. Route them to one of three surfaces.
3. Let them run a minimal live proof.
4. Produce a next action: API key, CLI command, demo artifact, ROI result, or evidence packet.

Navigation rule:

- top nav should expose Product, Developers, Enterprise, Use Cases, Research, Pricing;
- product mega-menu should map Route/Capture, Distill/Compile, Run/Govern;
- docs nav should map tasks, not route count;
- vertical pages should be under Use Cases unless they have strong evidence.

Metric lift:

- above-fold clarity;
- visitor activation;
- demo completion;
- pricing confidence;
- enterprise review progression.

## 100x Product Scorecard

The consolidated product should be judged by metric movement, not by more pages or more waves.

| Metric | Current risk | 100x invention lever | Proof |
|---|---|---|---|
| Above-fold clarity | site can sound like classifier, gateway, compiler, or model forge depending on page | three-surface hero and intent router | 5-second comprehension test |
| Time to first value | docs and pages are broad | first aha demo produces artifact plus receipt | artifact downloaded or verified |
| Gateway-to-distill conversion | gateway can look like wrapper only | distill readiness index | namespace readiness and next action |
| Compile success | users may distill too early | readiness, active learning, TAAS | K-score acceptance rate |
| Runtime portability | "run anywhere" can overclaim | runtime passport | supported/unsupported target matrix |
| Enterprise trust | proof scattered across pages | assurance case compiler | exportable evidence packet |
| Benchmark credibility | broad claims invite skepticism | K-score metrology lab | public calibration report |
| Marketplace quality | rankings can be gamed | comparable trust groups | task-family K-score with holdout |
| Cost displacement | ROI can be generic | route receipts plus local artifact spend model | per-namespace savings report |
| Product coherence | 139 pages can fragment narrative | seven-hub IA and product kernel | no contradictory surface copy |

## Simulated Portfolio Impact

Assume a team starts with:

- 1,000,000 frontier calls per month;
- 12 repeated task namespaces;
- 2 high-risk regulated workflows;
- 4 target runtimes;
- no trustworthy eval baseline;
- no unified account journey.

If Kolm ships the top five inventions in this matrix:

1. Distill Readiness Index.
2. K-Score Metrology Lab.
3. Task-Adaptive Student Architecture Search.
4. Confidence-Aware Hybrid Router.
5. Artifact Passport.

Expected movement:

- compile attempts drop because users wait for readiness;
- compile acceptance rises because eval and data coverage improve;
- frontier calls decline only where local confidence is adequate;
- enterprise review starts earlier because proof is attached to the artifact;
- account actions become obvious because each namespace has a next step;
- website conversion improves because each visitor sees the path that matches their current state.

Do not claim exact percentages until measured. The product claim should be directional until the instrumentation exists.

## Ultimate Build Order

Build in this order:

1. Product truth graph and claim gate.
2. K-score metrology and artifact proof schema.
3. Distill readiness index.
4. First aha demo: paste call -> captured task -> `.kolm` sample -> K-score -> receipt.
5. Confidence-aware hybrid routing.
6. Task-adaptive student selection.
7. Distillation-aware quantization.
8. Runtime passport.
9. Assurance case export.
10. Marketplace trust groups.

Why this order:

- proof must exist before claims;
- measurement must exist before optimization;
- readiness must exist before expensive distillation;
- routing must exist before local artifacts can safely replace frontier calls;
- runtime passports must exist before "run anywhere" can be trusted;
- marketplace must wait until comparison and provenance are mature.

## Experiment Dossier Layer V1

This section converts the design matrix into research experiments that can be implemented, falsified, and shipped. The goal is not to create more roadmap words; the goal is to make every major invention testable.

Evaluation references:

- OpenAI Evals: `https://github.com/openai/evals`
- Inspect AI: `https://inspect.aisi.org.uk/`
- HELM: `https://crfm.stanford.edu/helm/index.html`
- EleutherAI lm-evaluation-harness: `https://github.com/EleutherAI/lm-evaluation-harness`
- MLPerf Inference: `https://docs.mlcommons.org/inference/index_gh/`

### Dossier 1: Distill Readiness Index

Research question:

- Can Kolm predict whether a namespace is ready for successful distillation before spending training compute?

Hypothesis:

- A readiness model using coverage, label stability, privacy status, poison risk, eval sufficiency, and task repetitiveness predicts compile success better than simple row-count thresholds.

Baseline:

- `min_pairs >= N`;
- random compile attempts after threshold;
- user-initiated compile without readiness gate.

Experimental data:

- historical capture namespaces;
- synthetic namespaces with controlled coverage gaps;
- red-team poisoned rows;
- tasks with known eval sets;
- tasks with intentionally unstable teacher outputs.

Procedure:

1. Split namespaces into train, validation, and holdout by customer/task family.
2. Compute readiness features before compile.
3. Run compile/distill on a fixed budget.
4. Score resulting artifacts with K-score and task-specific evals.
5. Compare readiness prediction against row-count baseline.
6. Run ablations for coverage, poison risk, eval sufficiency, and teacher stability.

Primary metrics:

- AUROC for predicting successful compile;
- precision at top-k recommended namespaces;
- wasted compile spend avoided;
- K-score lift per selected namespace;
- false-negative rate for namespaces that would have compiled successfully.

Acceptance gate:

- readiness model beats row-count baseline on holdout;
- no high-risk poisoned namespace receives `ready_for_student`;
- account next-action is explainable in one sentence.

Failure interpretation:

- if row count wins, readiness features are too weak or compile quality is dominated by data volume;
- if false positives are high, add stricter eval sufficiency and teacher stability features;
- if false negatives are high, separate task families or lower gate for low-risk recipe artifacts.

Implementation artifact:

- `distill_readiness_report.json` attached to namespace and account UI.

### Dossier 2: K-Score Calibration And Human Preference Correlation

Research question:

- Can K-score become a reliable shipping gate that correlates with human preference and task-specific correctness?

Hypothesis:

- A task-scoped, decomposed K-score with confidence intervals correlates better with deployability than generic benchmark averages.

Baseline:

- raw accuracy;
- BLEU/ROUGE/BERTScore where applicable;
- model-judge only score;
- generic benchmark score from an external harness.

Experimental data:

- classification tasks;
- extraction tasks;
- structured output tasks;
- redaction tasks;
- support-reply tasks;
- retrieval-grounded answer tasks;
- human preference labels for pairwise artifact comparisons.

Procedure:

1. Define task-family K-score axes and weights.
2. Score multiple artifacts per task.
3. Collect human judgments on correctness, usefulness, safety, and deployability.
4. Compare K-score with each baseline.
5. Estimate calibration curves and confidence intervals.
6. Run quarterly recalibration with fresh holdouts.

Primary metrics:

- Spearman correlation with human preference;
- Kendall tau for artifact ranking;
- calibration error;
- false-ship rate;
- false-block rate;
- confidence interval coverage.

Acceptance gate:

- K-score must outperform generic benchmark average for deployability prediction;
- every score must report task family, eval id, sample size, and confidence;
- no cross-task leaderboard unless task-family comparability is proven.

Failure interpretation:

- if K-score fails on generation tasks, split generation into subfamilies;
- if model-judge dominates, use judge only as one axis and add human calibration;
- if confidence intervals are wide, require more eval data before shipping.

Implementation artifact:

- `kscore_calibration_packet.json` with axis weights, eval ids, confidence, and calibration version.

### Dossier 3: Task-Adaptive Student Architecture Search

Research question:

- Can Kolm choose smaller or faster students without losing task quality, compared with a fixed default model family?

Hypothesis:

- Task-aware student selection improves K-score per dollar and K-score per millisecond compared with fixed student defaults.

Baseline:

- always use one default 7B student;
- user manually selects model;
- choose smallest model that fits memory.

Experimental data:

- repeated customer task families;
- synthetic task contracts;
- varied context lengths;
- multilingual tasks;
- schema-constrained tasks;
- low-latency edge tasks.

Procedure:

1. Generate candidate students by hard constraints: license, memory, modality, context, runtime.
2. Run a small stratified bakeoff on each candidate.
3. Fit a Pareto frontier across K-score, latency, memory, compile cost, and fallback rate.
4. Select candidate with highest expected utility under customer constraints.
5. Compare to default student and user-selected student.

Primary metrics:

- K-score per compile dollar;
- K-score per latency millisecond;
- artifact size;
- target-device fit rate;
- fallback rate after deployment;
- selection regret versus exhaustive search.

Acceptance gate:

- selected student lands on Pareto frontier in holdout tasks;
- regret is below threshold versus exhaustive candidate search;
- selection report explains rejected candidates.

Failure interpretation:

- if default wins, candidate pool is too narrow or tasks are not separable;
- if selection is unstable, add more bakeoff samples or confidence intervals;
- if small students fail on schema tasks, add schema-head sensitivity features.

Implementation artifact:

- `student_selection_report.json` embedded in artifact passport.

### Dossier 4: Distillation-Aware Quantization

Research question:

- Can quantization policies tuned to the artifact task distribution retain more K-score at lower memory than generic quantization presets?

Hypothesis:

- Task-distribution-aware quantization preserves K-score better than generic INT4/NF4/AWQ/GPTQ choice alone.

Baseline:

- fixed quantization preset;
- generic calibration dataset;
- no per-layer sensitivity report.

Experimental data:

- artifact eval sets;
- activation traces;
- attention and KV-cache profiles;
- schema-heavy tasks;
- safety-sensitive extraction tasks;
- low-memory device targets.

Procedure:

1. Profile activations and layer sensitivity on task eval set.
2. Generate mixed-precision candidates.
3. Measure quality delta, latency, memory, and energy.
4. Reject candidates violating K-score loss budget.
5. Emit runtime passport with quantization rationale.

Primary metrics:

- K-score retention;
- memory reduction;
- latency improvement;
- energy reduction;
- schema-validity retention;
- confidence calibration drift.

Acceptance gate:

- task-aware policy beats fixed preset on K-score retention at same memory or same K-score at lower memory;
- unsupported device targets are explicitly marked unsupported;
- runtime passport reports quality delta.

Failure interpretation:

- if fixed preset wins, task profiling is too noisy;
- if K-score drops unexpectedly, calibration set is not representative;
- if latency worsens, runtime kernel choice dominates quantization method.

Implementation artifact:

- `quantization_risk_report.json` and `runtime_passport.json`.

### Dossier 5: Confidence-Aware Hybrid Router

Research question:

- Can Kolm reduce frontier calls while preserving quality by routing only uncertain cases to frontier providers?

Hypothesis:

- A calibrated local artifact plus fallback router lowers cost while matching or improving quality versus frontier-only routing on repeatable tasks.

Baseline:

- always frontier;
- always local artifact;
- static confidence threshold;
- provider-only routing without local artifact.

Experimental data:

- deployed artifact traces;
- held-out eval prompts;
- drifted prompts;
- adversarial prompts;
- high-risk policy prompts;
- provider outage simulations.

Procedure:

1. Calibrate artifact confidence on held-out evals.
2. Define route actions: local, local with warning, frontier fallback, human review, refusal.
3. Replay traffic through multiple policies.
4. Compare cost, quality, latency, and safety.
5. Feed fallback cases into active learning queue.

Primary metrics:

- frontier call reduction;
- quality parity versus frontier-only;
- false-local rate;
- false-fallback rate;
- cost reduction;
- active learning yield;
- fallback reason explainability.

Acceptance gate:

- no high-risk class exceeds false-local threshold;
- cost reduction is measurable under real traffic assumptions;
- every fallback has a receipt reason.

Failure interpretation:

- if false-local is high, confidence is miscalibrated or novelty detection is weak;
- if false-fallback is high, threshold is too conservative;
- if users distrust local answers, add visible confidence and evidence.

Implementation artifact:

- `route_decision_receipt.json` for every routed call.

### Dossier 6: Structured Output Proof Engine

Research question:

- Can Kolm make structured workflow artifacts safer by proving schema validity at compile and runtime?

Hypothesis:

- Schema-constrained compile and runtime validation reduce integration failures compared with unconstrained generation plus best-effort parsing.

Baseline:

- plain prompt instruction;
- regex parsing;
- one-shot JSON repair;
- no schema-specific K-score axis.

Experimental data:

- JSON extraction tasks;
- OpenAPI tool-call tasks;
- healthcare and finance structured forms;
- adversarial malformed inputs;
- multilingual structured outputs.

Procedure:

1. Attach schema to task contract.
2. Evaluate unconstrained generation, constrained decoding, validator-repair, and refusal policies.
3. Measure schema validity and task correctness separately.
4. Include schema validity as K-score axis.
5. Record schema version in artifact passport.

Primary metrics:

- schema validity;
- field-level accuracy;
- repair attempts;
- refusal correctness;
- downstream integration failures;
- latency overhead.

Acceptance gate:

- schema-validity failure rate drops versus baseline;
- invalid output is refused or repaired within bounded attempts;
- K-score report separates content correctness from shape validity.

Failure interpretation:

- if constrained decoding hurts correctness, use validator-repair for that runtime;
- if repair loops are slow, add schema-specific distillation examples;
- if field-level accuracy is low, data coverage is insufficient.

Implementation artifact:

- `schema_proof_report.json` attached to artifact.

### Dossier 7: Runtime Passport And Device Fit

Research question:

- Can Kolm predict and verify where an artifact will run before deployment?

Hypothesis:

- Runtime passports reduce unsupported deployments and make "run anywhere" honest.

Baseline:

- docs table of supported runtimes;
- user tries runtime manually;
- generic model-size estimate.

Experimental data:

- artifacts across sizes and quantization levels;
- CUDA, CPU, browser, phone, and BYOC targets;
- runtime versions;
- memory-limited devices;
- long-context workloads.

Procedure:

1. Generate static compatibility estimate from artifact manifest.
2. Run lightweight smoke on target or simulator.
3. Record memory, latency, throughput, energy if available, and unsupported ops.
4. Compare predicted fit to actual fit.
5. Publish passport with confidence and caveats.

Primary metrics:

- predicted-fit accuracy;
- unsupported deployment reduction;
- memory estimate error;
- latency estimate error;
- target coverage;
- support tickets per deployment.

Acceptance gate:

- unsupported targets fail before deployment;
- passport includes exact runtime version and limits;
- target claims are removed when not proven.

Failure interpretation:

- if prediction error is high, require live smoke for that target family;
- if runtime versions dominate, pin versions in passport;
- if energy data is unavailable, mark energy as unmeasured.

Implementation artifact:

- `runtime_passport.json` with target matrix.

### Dossier 8: Proof-Carrying Artifact Passport

Research question:

- Can one artifact bundle carry enough machine-checkable proof to satisfy developers, CI, security reviewers, and auditors?

Hypothesis:

- Combining manifest, provenance, eval hash, K-score, runtime passport, and policy gates reduces review friction compared with scattered docs.

Baseline:

- README plus model card;
- registry metadata only;
- separate eval report and security document;
- manual enterprise evidence packet.

Experimental data:

- sample artifacts;
- enterprise review checklists;
- CI verifier runs;
- security questionnaire fields;
- marketplace listing requirements.

Procedure:

1. Define minimum passport schema.
2. Attach provenance, eval, runtime, policy, and closeout evidence.
3. Run offline verifier.
4. Ask implementation, security, and GTM reviewers to complete review tasks using passport only.
5. Compare completion time and missing evidence count.

Primary metrics:

- review completion time;
- missing evidence count;
- verifier pass rate;
- CI adoption;
- enterprise packet reuse;
- marketplace listing acceptance.

Acceptance gate:

- reviewer can answer core questions without searching docs;
- verifier reports missing proof explicitly;
- passport does not include secret values.

Failure interpretation:

- if packet is too large, split into passport summary plus evidence attachments;
- if reviewers still need docs, add cross-links to source evidence;
- if proof is stale, add freshness and invalidation rules.

Implementation artifact:

- `artifact_passport.json` and offline verifier output.

### Dossier 9: Website Intent Router

Research question:

- Can the website route visitors to the correct Kolm surface faster than a static hero and navigation?

Hypothesis:

- An intent router that asks what the visitor has and what they need improves comprehension, activation, and demo completion.

Baseline:

- static homepage hero;
- product mega-menu;
- docs-first path;
- pricing-first path.

Experimental data:

- visitor sessions;
- five-second comprehension tests;
- first-click tests;
- task-completion tests;
- demo completion logs;
- enterprise inquiry paths.

Procedure:

1. Define visitor intents: model API, repeated task, target device, compliance proof, artifact verification.
2. Build copy-only prototype and click-through prototype.
3. Run comprehension and first-click tests.
4. Compare activation against static hero.
5. Ship A/B only if sample size supports decision.

Primary metrics:

- 5-second product comprehension;
- correct first click;
- demo start rate;
- demo completion rate;
- API key creation;
- enterprise inquiry quality;
- bounce rate by intent.

Acceptance gate:

- visitors can state "Kolm turns repeated AI work into signed artifacts" without reading docs;
- every intent produces a concrete next action;
- no route overclaims unimplemented features.

Failure interpretation:

- if comprehension stays low, headline is still abstract;
- if clicks scatter, IA is overloaded;
- if enterprise users go to wrong path, trust surface is under-exposed.

Implementation artifact:

- `website_intent_router_spec.md` with copy, paths, metrics, and refusal claims.

### Dossier 10: Enterprise Assurance Case Export

Research question:

- Can Kolm reduce enterprise review friction by exporting a structured assurance case per artifact, namespace, and tenant?

Hypothesis:

- A machine-readable assurance case plus human packet shortens review and reduces repeated security questions.

Baseline:

- static trust page;
- manual security questionnaire;
- separate SOC/BAA/DPA/SLA documents;
- ad hoc artifact evidence.

Experimental data:

- common security questionnaires;
- enterprise procurement checklists;
- regulated vertical requirements;
- artifact passports;
- cloud/storage readiness reports;
- incident/SLA data.

Procedure:

1. Model claims, context, evidence, assumptions, and defeaters.
2. Generate assurance case from product graph and artifact passport.
3. Export human-readable packet and JSON.
4. Run against sample security questionnaires.
5. Track missing fields and review time.

Primary metrics:

- questionnaire auto-answer coverage;
- missing evidence count;
- enterprise review cycle time;
- number of follow-up questions;
- trust page to sales-qualified conversion;
- stale evidence warnings.

Acceptance gate:

- packet distinguishes implemented controls from certification gates;
- no secret values are exported;
- every claim has evidence or an explicit closeout blocker.

Failure interpretation:

- if coverage is low, product graph lacks enterprise evidence fields;
- if stale evidence appears, add freshness rules;
- if buyers still need calls, create persona-specific summaries.

Implementation artifact:

- `assurance_case_export.json` and human review packet.

## Experiment Governance Rules

Every dossier above should follow these rules:

- no success metric without a baseline;
- no broad claim from one task family;
- no benchmark result without dataset version, model version, runtime version, and date;
- no public leaderboard without hidden holdout and anti-gaming checks;
- no "run anywhere" claim without runtime passport proof;
- no "enterprise ready" claim without readiness closeout state;
- no score without confidence or scope;
- no automated rollout without rollback.

## Implementation Packet Template

Every invention handed to an implementation agent should include:

- objective;
- user-visible outcome;
- API contract;
- CLI contract;
- account UI contract;
- artifact schema;
- metrics emitted;
- verifier or smoke test;
- refusal mode;
- docs page;
- claim policy;
- source references;
- rollout sequence.

The implementation agent should not receive only prose. They should receive a contract that can be tested.

## Critical Additions From The Original Research

This section consolidates high-priority original-doc insights that were not yet explicit enough in this blueprint. These are not extra nice-to-haves. They are control systems that keep Kolm from becoming another gateway, fine-tune wrapper, eval dashboard, or runtime library.

### Research Kill Criteria

Kolm needs kill switches for research lines, product claims, demos, and roadmap waves.

Kill or pause an initiative when:

- it improves latency but worsens safety, faithfulness, or calibration beyond budget;
- it improves aggregate K-score but regresses a regulated or high-value stratum;
- it needs data that cannot legally, contractually, or ethically train the system;
- it requires an unsupported runtime claim;
- it cannot produce an artifact passport entry;
- it cannot be explained to a buyer or user without misleading them;
- it creates a one-off demo path that does not strengthen the three product surfaces;
- it depends on package, certification, benchmark, or partner proof that does not exist yet;
- it raises support burden faster than product value;
- it fragments the `.kolm` format or runtime contract.

Decision rule:

> A research win that cannot become a safer, more measurable, more portable artifact is not a Kolm win.

### Failure Taxonomy

Every important failure should map to owner, mitigation, artifact state, and regression test.

| Code | Failure | Owner | Promotion impact |
|---|---|---|---|
| F001 | K-score lower bound misses floor | evals | block |
| F002 | critical safety regression | safety | block |
| F003 | schema validity regression | compile/runtime | block structured artifact |
| F004 | redaction false negative | privacy | quarantine |
| F005 | capture poisoning accepted | capture | quarantine namespace |
| F006 | teacher disagreement too high | distill | require review or Teacher Council |
| F007 | student confidence miscalibrated | routing/evals | disable local-first route |
| F008 | quantization exceeds quality-loss budget | runtime | reject quant tier |
| F009 | unsupported runtime target claimed | runtime/docs | block target claim |
| F010 | artifact provenance incomplete | artifact | block registry publish |
| F011 | license or data rights unresolved | legal/product | block marketplace and training use |
| F012 | compliance proof stale | enterprise | mark evidence expired |
| F013 | user cannot understand next action | account/docs | block launch of that workflow |
| F014 | benchmark can be gamed | research | block public leaderboard |
| F015 | rollback path absent | SRE/product | block production deploy |

Required product behavior:

- failure state is visible in account;
- failure state is present in artifact passport;
- failure state has owner and next action;
- failure state changes marketing claim scope automatically.

### Evidence DAG

Kolm should store proof as a directed acyclic graph, not scattered JSON files.

Core graph:

```text
capture_event_set
  -> behavior_fingerprint
  -> data_rights_graph
  -> dataset_split
  -> teacher_council
  -> student_selection_report
  -> distillation_run
  -> quantization_risk_report
  -> eval_report
  -> kscore_packet
  -> runtime_passport
  -> artifact_manifest
  -> artifact_signature
  -> route_decision_receipts
  -> lifecycle_state
  -> assurance_case_export
```

Why it matters:

- every claim can be traced backward;
- every artifact can be invalidated when upstream evidence changes;
- every marketplace listing can show provenance;
- every enterprise export can be generated from the same graph;
- every stale or revoked artifact can explain why.

Implementation requirement:

- all product surfaces should reference evidence IDs instead of duplicating proof;
- deleting or revoking evidence must propagate to dependent artifacts;
- user-visible proof should be a readable projection of the evidence DAG.

### Anti-Commodity Moat Stack

If Kolm owns only one layer, it becomes commodity.

Commodity traps:

- gateway only: competes with AI gateways and provider SDKs;
- fine-tune only: competes with hosted training platforms;
- eval only: competes with eval dashboards;
- runtime only: competes with vLLM, SGLang, TensorRT-LLM, ONNX, llama.cpp;
- registry only: competes with package managers and model hubs;
- compliance page only: competes with static trust centers.

Defensible stack:

1. Capture moat: task traces, corrections, route outcomes, privacy-aware evidence.
2. Evaluation moat: K-score calibration, private holdouts, typed scorecards, human preference mapping.
3. Distillation moat: student outcomes, teacher council reliability, curriculum effectiveness.
4. Runtime moat: quantization, sparse attention, KV, early-exit, and hardware profiles tied to real task telemetry.
5. Artifact moat: signed `.kolm` format, proof receipts, target conformance, rollback semantics.
6. Enterprise moat: evidence graph, assurance case, procurement packet, readiness closeout.
7. Ecosystem moat: loaders, SDKs, marketplace, certification, third-party verification.

The strategy:

> Let competitors copy individual features. Make the closed loop hard to copy.

### Temporal Truth And Evidence Freshness

Production AI artifacts are time-bound.

Kolm must distinguish:

- source time: when evidence was created;
- capture time: when behavior was observed;
- policy time: which policy version applied;
- eval time: when score was measured;
- artifact time: when artifact was built;
- deployment time: where and when artifact ran;
- verification time: when receipt was checked;
- regulation time: which compliance obligation version applied.

Product requirement:

- artifact passport includes validity windows;
- K-score packet includes eval date and freshness policy;
- account flags stale evidence;
- assurance case export refuses stale proof;
- registry marks artifacts current, stale, superseded, revoked, or experimental.

Why this is critical:

- "verified once" is not enough;
- regulations change;
- provider baselines change;
- customer tasks drift;
- data rights can expire;
- runtime dependencies receive security advisories.

### Conformal Risk, Abstention, And Selective Automation

The best artifact is not the one that always answers. It is the one that knows when not to answer.

Kolm should make abstention first-class:

- answer;
- answer with warning;
- return candidate set;
- ask for missing evidence;
- route to frontier;
- route to human;
- refuse.

Research-to-product requirements:

- K-score includes abstention quality where relevant;
- route receipts include abstention reason;
- artifacts declare risk bands;
- high-impact workflows require selective automation policy;
- local artifact cannot silently answer outside coverage.

Metric:

- false-local rate is more important than raw local-answer rate in regulated workflows.

### Machine Unlearning And Revocable Artifacts

Deletion is not only a data-lake operation. It is an artifact-lifecycle operation.

Kolm needs a revocation path when:

- source data loses consent;
- license changes;
- customer deletes data;
- evidence was poisoned;
- private data leaked into training;
- legal hold or regulator requires exclusion;
- artifact used an invalid dependency.

Product requirement:

- evidence DAG identifies dependent artifacts;
- artifact state can become revoked or needs_rebuild;
- registry blocks new pulls of revoked artifacts;
- account shows affected deployments;
- replacement compile uses exclusion proof;
- verifier can report "this artifact was valid then, revoked now."

Moat:

- revocable signed AI artifacts are far more enterprise-ready than static model files.

### Data Rights And Licensing Graph

Every training row and artifact dependency needs rights metadata.

Track:

- source owner;
- consent basis;
- license;
- retention limit;
- training eligibility;
- eval eligibility;
- marketplace eligibility;
- derivative rights;
- vertical restrictions;
- deletion obligations;
- export restrictions.

Required behavior:

- ineligible rows cannot train artifacts;
- marketplace artifacts cannot publish without license proof;
- customer-specific data cannot leak into public artifacts;
- data-rights changes propagate through evidence DAG;
- artifact passport states rights scope plainly.

### Procurement And Third-Party Risk Compression

Enterprise buyers do not buy only technology. They buy reviewability.

Kolm should compress procurement by generating:

- architecture diagram;
- data-flow diagram;
- subprocessor list;
- storage and residency matrix;
- security controls;
- incident process;
- artifact proof sample;
- readiness closeout;
- SOC/ISO/FedRAMP status;
- BAA/DPA/SLA packet;
- model-risk evidence;
- AI policy mapping.

Metric:

- questionnaire auto-answer coverage;
- review cycle time;
- follow-up questions;
- security approval rate;
- enterprise conversion.

Key point:

> A proof-carrying artifact plus proof-carrying vendor packet is a sales tool, not just a compliance artifact.

### Regulatory Change Intelligence

Compliance is not a one-time document.

Kolm should track:

- AI regulation changes;
- sector guidance;
- procurement standards;
- security framework updates;
- privacy obligations;
- model-risk expectations;
- accessibility requirements;
- sustainability reporting;
- data residency rules.

Product behavior:

- map regulatory change to affected artifacts and customers;
- mark evidence stale when obligations change;
- create rebuild or review tasks;
- update assurance case templates;
- distinguish "implemented control" from "certified status."

Critical rule:

- do not let public copy imply legal compliance from feature presence alone.

### Shadow AI Discovery And Governed Conversion

Enterprises already have unmanaged AI usage.

Kolm should support a migration path from shadow AI to governed artifacts:

1. discover model API traffic, scripts, notebooks, browser tools, internal agents, and SaaS AI usage;
2. classify by task, risk, data sensitivity, provider, cost, and owner;
3. route safe traffic through Kolm gateway;
4. capture approved patterns;
5. compile repeated work into artifacts;
6. retire unmanaged keys and workflows;
7. export governance evidence.

Why this matters:

- it gives Kolm an enterprise wedge before a perfect artifact exists;
- it turns security risk into product adoption;
- it creates real capture data for the distillation moat.

### Insurable AI And Warranty Readiness

Kolm's proof spine can become an underwriting primitive.

Do not promise warranties prematurely. But design for them:

- artifact class;
- task risk;
- K-score and confidence;
- red-team result;
- incident history;
- runtime target;
- human oversight;
- rollback time;
- data-rights proof;
- customer control environment.

Future product:

- artifact warranty eligibility;
- insurance evidence export;
- risk reserve model;
- contract scope for covered use only.

Why it is important:

- enterprise buyers want risk transfer;
- insurers need measurable controls;
- Kolm's evidence DAG can become underwriting data.

### Product Operating System

Research without operating discipline becomes noise.

Kolm needs a product OS that converts every research idea into:

- customer problem;
- product surface;
- metric;
- artifact schema;
- API/CLI/account contract;
- experiment dossier;
- proof gate;
- launch gate;
- docs update;
- claim policy;
- support feedback loop.

Each shipped wave should answer:

- what metric moved;
- what claim became stronger;
- what artifact evidence changed;
- what user action became easier;
- what risk was reduced;
- what remains unproven.

### Support Intelligence Loop

Support is product research.

Every support ticket should classify:

- install friction;
- auth/key friction;
- gateway routing confusion;
- capture approval confusion;
- distill readiness blocker;
- K-score misunderstanding;
- runtime unsupported target;
- pricing confusion;
- enterprise proof gap;
- docs mismatch;
- claim mismatch.

Product requirement:

- recurring support categories create roadmap issues;
- docs and UI copy should be patched from support evidence;
- account next-actions should absorb the most common support questions.

### Original Research Insights Now Retained

The consolidation now explicitly retains these high-priority original-doc ideas:

- research kill criteria;
- failure taxonomy;
- evidence DAG;
- anti-commodity moat stack;
- temporal truth;
- conformal abstention;
- machine unlearning and artifact revocation;
- data rights and licensing graph;
- procurement compression;
- regulatory change intelligence;
- shadow AI discovery;
- insurable AI and warranty readiness;
- product operating system;
- support intelligence loop.

## Critical Additions From The Original Research V2

This second consolidation pass captures the remaining high-priority material from the original research that should shape implementation and positioning.

### Competitive Frontier Map

Kolm should not describe competitors as weak. Many adjacent products are strong in their own layer. Kolm wins by owning the closed loop across layers.

| Category | Representative frontier | What they do well | Kolm wedge |
|---|---|---|---|
| AI gateways | Cloudflare AI Gateway, LiteLLM, Dataiku LLM Mesh | routing, provider abstraction, logs, cost controls | gateway becomes evidence engine for owned artifacts |
| Eval and observability | LangSmith, Braintrust, Inspect AI, OpenAI Evals | experiments, traces, evals, CI checks | evals become artifact promotion gates and K-score packets |
| Fine-tuning platforms | OpenAI fine-tuning, Together AI, Predibase, OpenPipe | managed training, LoRA, hosted inference | deliverable is portable signed `.kolm`, not hosted endpoint only |
| Runtime and serving | vLLM, SGLang, TensorRT-LLM, ONNX Runtime GenAI, llama.cpp | throughput, scheduling, inference kernels, formats | runtime passport chooses and proves target-specific execution |
| Enterprise AI OS | Palantir AIP, Databricks Mosaic AI, Snowflake Cortex, Dataiku | operational AI, data estate integration, governance | artifact-level proof and portability across estates |
| Model hubs and registries | Hugging Face, cloud model catalogs, internal registries | discovery, weights, datasets, community | task artifacts with proof, K-score, licensing, runtime passport |
| Guardrails/security | Lakera, Protect AI, Giskard, NeMo Guardrails, Promptfoo | policy checks, red-team, prompt injection defense | guardrails are part of compile, route, and artifact evidence |
| Trust/compliance platforms | Vanta, Drata, trust centers, GRC tools | compliance evidence collection | AI-specific assurance case generated from artifact evidence DAG |

Positioning rule:

> Kolm is not better because it replaces every adjacent tool. Kolm is better when the artifact becomes the integration point for routing, eval, distill, runtime, proof, and governance.

Official source anchors reviewed:

- Cloudflare AI Gateway: `https://ai.cloudflare.com/gateway`
- LiteLLM docs: `https://docs.litellm.ai/`
- LangSmith evaluation: `https://docs.langchain.com/langsmith/evaluation`
- Braintrust evaluation docs: `https://www.braintrust.dev/docs/evaluate`
- OpenAI fine-tuning/distillation guide: `https://platform.openai.com/docs/guides/distillation`
- Together AI fine-tuning docs: `https://docs.together.ai/docs/fine-tuning-overview`
- Predibase adapters: `https://docs.predibase.com/fine-tuning/adapters`
- Palantir AIP overview: `https://www.palantir.com/docs/foundry/aip/overview//`
- Snowflake Cortex overview: `https://docs.snowflake.com/en/user-guide/snowflake-cortex/overview`
- Dataiku LLM Mesh: `https://www.dataiku.com/product/llm-mesh`

### Competitive Non-Goals

Do not try to win by:

- being the cheapest generic gateway;
- being the broadest model catalog;
- hosting the fastest generic inference endpoint;
- having the most benchmark rows without task-specific proof;
- claiming every compliance framework before certification evidence exists;
- copying enterprise AI OS breadth without artifact portability;
- making a model zoo before proof, licensing, and K-score comparability are mature.

Win by:

- making every repeated model call eligible to become an owned artifact;
- making every artifact verifiable, portable, scored, and revocable;
- making every claim traceable to evidence;
- making every runtime target honest;
- making every enterprise review packet generated from source-of-truth evidence.

### Mathematical North Star

The consolidated product needs a mathematical backbone. Use these principles as design constraints.

1. Rate-distortion: the goal is the smallest artifact that preserves task behavior under a measured distortion budget.
2. Information bottleneck: distillation should remove irrelevant behavior while retaining task-sufficient information.
3. Minimum description length: prefer smaller recipes or students when they explain the task with equal evidence.
4. Conformal prediction: route, abstain, or ask for human review when uncertainty exceeds a calibrated risk bound.
5. Causal inference: claim business impact only when rollout design supports attribution.
6. Decision theory: optimize expected utility under cost, latency, safety, and policy constraints, not raw model quality.
7. Psychometrics: K-score calibration should behave like a measurement instrument, with reliability, validity, and drift checks.
8. Active learning: label and teacher budget should go to the examples with highest expected K-score or risk reduction.
9. Counterfactual evaluation: ask what would have happened under frontier-only, local-only, and hybrid routing.
10. Formal methods: schemas, manifests, receipts, and runtime claims should be machine-checkable where possible.

Engineering consequence:

- no optimization should ship without defining its distortion budget, uncertainty model, and refusal rule.

### Metric Causal Control System

Metrics should not be a dashboard afterthought. They should drive product intervention.

Every important metric needs:

- owner;
- baseline;
- intervention lever;
- guardrail metric;
- segment or stratum;
- causal evidence standard;
- rollback condition;
- claim it supports.

Example:

| Metric | Intervention | Guardrail | Evidence |
|---|---|---|---|
| K-score | more data, better student, Teacher Council | safety and calibration | held-out eval |
| frontier spend | hybrid routing | false-local rate | replay and production canary |
| compile success | readiness index | false-negative ready tasks | holdout namespaces |
| runtime latency | quantization and scheduling | K-score delta | target smoke |
| enterprise review time | assurance export | stale proof count | sales review logs |
| activation | first artifact demo | claim scope violations | funnel experiment |

Rule:

> A metric that cannot change a product decision is not a control metric.

### Canonical Contract Schemas To Preserve

The original research defined many schema ideas. These are the ones the consolidated product should preserve.

#### Behavior Fingerprint

Purpose:

- represent the task shape that decides whether Kolm should route, capture, distill, retrieve, quantize, or block.

Fields:

- task family;
- input shape;
- output shape;
- schema requirement;
- language and locale;
- context length;
- tool path;
- risk class;
- novelty score;
- examples and counterexamples;
- eval coverage.

#### Route Decision Receipt

Purpose:

- explain why a request used local artifact, frontier provider, human review, or refusal.

Fields:

- route policy version;
- artifact id;
- confidence;
- novelty;
- risk;
- provider if used;
- fallback reason;
- cost;
- latency;
- capture eligibility;
- receipt hash.

#### Distill Readiness Report

Purpose:

- decide whether a namespace is ready for recipe compile, student distill, hybrid routing, or human review.

Fields:

- coverage;
- label stability;
- poison risk;
- privacy eligibility;
- eval sufficiency;
- teacher disagreement;
- expected K-score lift;
- expected cost displacement;
- blockers;
- next action.

#### K-Score Packet

Purpose:

- make the score reproducible and scoped.

Fields:

- score version;
- task family;
- axes and weights;
- eval ids;
- baseline;
- sample size;
- confidence interval;
- calibration version;
- refusal conditions;
- score hash.

#### Runtime Passport

Purpose:

- make "run anywhere" honest.

Fields:

- target;
- supported true/false;
- runtime and version;
- precision;
- memory;
- latency;
- throughput;
- energy if measured;
- K-score delta;
- unsupported operators;
- fallback behavior.

#### Data Rights Graph

Purpose:

- prevent data laundering and invalid training.

Fields:

- source;
- owner;
- consent basis;
- license;
- retention;
- training eligibility;
- eval eligibility;
- marketplace eligibility;
- deletion obligations;
- derivative restrictions.

#### Assurance Case

Purpose:

- convert artifact evidence into a structured enterprise argument.

Fields:

- claim;
- context;
- strategy;
- evidence;
- assumptions;
- defeaters;
- closeout state;
- freshness.

### Product-Surface Build Specs

Each surface needs a concrete build spec. These are the minimum viable state-of-art targets.

#### Surface A: Route And Capture

Must build:

- OpenAI-compatible endpoint;
- provider routing;
- retries and fallback;
- redaction membrane;
- capture eligibility policy;
- route decision receipts;
- cost and latency attribution;
- namespace creation;
- poison and rights checks.

Must show:

- what was routed;
- why it was routed;
- what was captured;
- what was excluded;
- what is eligible for distillation.

Must not claim:

- that all traffic is safe to train;
- that gateway routing alone creates owned AI;
- that every provider has equivalent behavior.

#### Surface B: Distill And Compile

Must build:

- distill readiness;
- task contract;
- eval split;
- Teacher Council;
- student selection;
- active learning;
- quantization planner;
- K-score packet;
- artifact passport;
- failure report.

Must show:

- why compile is ready or blocked;
- why the student was selected;
- what quality was retained;
- what quality was lost;
- what data would improve the next run.

Must not claim:

- local student matches frontier on all tasks;
- K-score is universal intelligence;
- quantization preserves safety automatically.

#### Surface C: Run And Govern

Must build:

- runtime passport;
- target smoke;
- artifact lifecycle;
- route fallback;
- verification CLI/browser;
- audit export;
- assurance case;
- revocation and supersession.

Must show:

- supported targets;
- unsupported targets;
- runtime limits;
- verification result;
- lifecycle state;
- rollback path.

Must not claim:

- run anywhere without target proof;
- compliance without evidence;
- offline verification covers future drift.

#### Surface D: Account Operating Console

Must build:

- product matrix dashboard;
- namespace readiness;
- artifact lifecycle;
- runtime target health;
- K-score history;
- cost displacement;
- trust evidence;
- closeout gates;
- next-action engine.

Must show:

- what to do next;
- what is unsafe;
- what is stale;
- what is saving money;
- what proof is exportable.

#### Surface E: Docs And Developer Experience

Must build:

- job-based docs;
- API examples;
- CLI parity;
- SDK parity;
- artifact schema docs;
- failure recipes;
- claim scope notes;
- copy-paste quickstarts.

Must show:

- expected output;
- common failure;
- verifier command;
- account equivalent;
- API equivalent.

#### Surface F: Website And GTM

Must build:

- three-surface hero;
- intent router;
- live artifact proof demo;
- ROI calculator tied to frontier spend and compile cost;
- pricing consistency;
- enterprise packet path;
- vertical pages only where evidence exists.

Must show:

- what Kolm is;
- who it is for;
- why now;
- what proof exists;
- what is not yet claimable.

### Customer Migration And Expansion System

The original research makes one point that should drive GTM: customers do not buy "distillation" in the abstract. They buy transitions.

Three transitions:

1. API traffic becomes signed, portable, audited, and cheaper without an app rewrite.
2. Expensive teacher-model behavior becomes smaller task artifacts with measured retention, safety, and cost payback.
3. Enterprise models become device-ready artifacts with rollback, governance, and fleet observability.

Migration stages:

1. discover current model calls and shadow AI usage;
2. route through Kolm gateway;
3. capture only eligible behavior;
4. identify repeatable namespaces;
5. build evals;
6. compile first artifact;
7. run hybrid;
8. deploy local/BYOC/device;
9. export enterprise evidence;
10. expand to more namespaces.

Account next-action should always map the customer to one of these stages.

### Expert Evaluation And Human Operations

K-score cannot rely only on automated judges.

Kolm needs an expert operations layer:

- rubric compiler;
- reviewer calibration;
- disagreement tracking;
- expertise routing;
- label rights and privacy;
- active learning value-of-expertise;
- reviewer reliability;
- adjudication record;
- human preference calibration.

Why this matters:

- regulated domains need expert labels;
- model-judge scores drift;
- hard failures are often rare;
- disagreement is signal, not just noise;
- human review can become part of the artifact passport.

Product rule:

- high-impact artifacts should not graduate from model-judge-only evidence.

### Release Engineering And Compatibility

Artifacts need release discipline.

Preserve these original-doc ideas:

- behavior semantic versioning;
- artifact compatibility solver;
- behavior diff engine;
- artifact dependency graph;
- staged release channels;
- promotion gate compiler;
- fleet impact simulator;
- rollback rehearsals;
- canary and shadow deployments;
- deprecation policy.

Product requirement:

- every artifact version change explains whether behavior, data, runtime, policy, or proof changed;
- account shows what deployments are affected;
- verifier can compare two artifact versions.

### Workload Digital Twin And Simulation

Kolm should simulate workloads before production rollout.

Digital twin inputs:

- captured traffic;
- task fingerprint;
- tool environment;
- permissions;
- runtime target;
- policy;
- cost model;
- failure abstractions;
- drift assumptions.

Use cases:

- replay local-only, frontier-only, and hybrid route policies;
- estimate cost displacement;
- test failure modes;
- forecast runtime fit;
- validate eval coverage;
- generate rare scenarios;
- rehearse rollback.

Metric:

- production incident reduction and compile success improvement from simulation-derived tests.

### Scientific Credibility And Publication Moat

The research strategy should produce public credibility without giving away the private data moat.

Publish:

- K-score methodology;
- calibration calculator;
- TAAS paper;
- confidence-calibrated hybrid routing paper;
- distillation-aware quantization study;
- capture poisoning benchmark;
- artifact passport specification.

Keep proprietary:

- customer task traces;
- private holdouts;
- teacher council telemetry;
- runtime telemetry;
- artifact marketplace behavior;
- support-derived failure distribution;
- data-to-runtime optimization curves.

Rule:

- publish measurement and interfaces; keep the compounding evidence flywheel proprietary.

### Autonomous Research Lab Operating Model

The original research's autonomous lab ideas should become an internal operating system, not a public claim.

Required loops:

- paper-to-product compiler;
- reproduction queue;
- negative result registry;
- ablation debt detector;
- experiment autopilot;
- literature contradiction resolver;
- benchmark freshness monitor;
- leakage and contamination guard;
- claim-to-evidence linker.

Why this matters:

- the field changes too fast for static roadmap planning;
- negative results prevent wasted waves;
- reproduction quality protects technical credibility;
- claim-to-evidence linking prevents marketing drift.

### High-Priority Original Research Now Retained V2

This V2 consolidation explicitly retains:

- competitor frontier teardown;
- mathematical foundations;
- metric causal control system;
- canonical contract schemas;
- product-surface build specs;
- customer migration and expansion;
- expert evaluation and human operations;
- release engineering and compatibility;
- workload digital twin and simulation;
- scientific credibility and publication moat;
- autonomous research lab operating model.

## Critical Additions From The Original Research V3

This pass consolidates the remaining deep technical domains that should influence Kolm's ultimate architecture. These are not homepage-first ideas. They are the infrastructure layers that make the product defensible as it moves from API traffic to owned artifacts in regulated environments.

### Private Distillation And Confidential Telemetry

Kolm should not assume all useful training signal can be centralized.

Required primitives:

- privacy-preserving telemetry;
- consent-scope compiler;
- differential privacy budget;
- membership inference risk gate;
- per-example influence tracking;
- private holdout sets;
- data minimization distiller;
- federated analytics;
- secure aggregation;
- confidential-clean-room mode.

Product implication:

- account should show whether a namespace can train local-only, tenant-only, consortium-only, public benchmark, or not at all;
- artifact passport should state privacy budget and training eligibility scope where applicable;
- K-score should distinguish private eval, public eval, and cross-tenant calibration evidence.

Source anchors:

- OpenMined PySyft: `https://openmined.org/pysyft`
- OpenMined secure computation mission: `https://openmined.org/`

### Federated Distillation And Consortium Pattern Lake

Some verticals need shared learning without shared raw data.

Use cases:

- hospitals learning from similar administrative workflows;
- banks comparing fraud or compliance patterns;
- insurers improving claims triage;
- public sector agencies sharing non-sensitive failure modes;
- enterprise customers contributing benchmark metadata without exposing prompts.

Build requirements:

- federated teacher council;
- secure aggregation compiler;
- cross-silo eval harness;
- client drift weighting;
- federated poisoning defense;
- consortium participation contract;
- opt-in pattern lake with data-rights graph;
- contribution valuation and revocation policy.

Claim rule:

- do not market cross-tenant learning unless raw-data boundaries, aggregation method, and customer opt-in are explicit.

### Confidential Compute And Remote Attestation

Confidential compute matters when customers need Kolm to operate on sensitive data but cannot expose it to a normal hosted control plane.

Required primitives:

- attestation-gated key release;
- enclave or confidential VM runner;
- attested inference receipt;
- attested distillation receipt;
- enclave build reproducibility;
- side-channel risk register;
- confidential data clean room;
- customer-verifiable measurement;
- policy-bound secret release.

Product implication:

- Enterprise and BYOC should expose "attested mode" separately from ordinary hosted mode;
- artifact passport should record whether training or inference occurred in an attested environment;
- proof should include the attestation evidence hash, not secret values.

Source anchor:

- Confidential Computing Consortium attestation overview: `https://confidentialcomputing.io/2023/04/06/why-is-attestation-required-for-confidential-computing/`

### Verifiable Inference And Cryptographic Proof Tiers

Not every AI run needs zero-knowledge proof or homomorphic encryption. Kolm should define proof tiers.

Proof tiers:

1. Receipt proof: input/output hash, artifact hash, signature, policy version.
2. Runtime proof: runtime passport, target smoke, environment metadata.
3. Attestation proof: confidential environment measurement.
4. Eval proof: K-score and eval report hash.
5. Cryptographic proof: ZK or MPC proof for a small, high-value subset where feasible.

Use cases:

- audit and disputes;
- regulated evidence;
- public benchmark verification;
- third-party marketplace verification;
- high-value redaction or classification claims.

Rule:

- ZKML is a research track, not a near-term universal product promise. Keep it scoped to narrow kernels and proof-of-eval first.

### Retrieval Graph, GraphRAG, And Knowledge Artifacts

Kolm should not treat retrieval as a generic RAG add-on. Retrieval should become a verifiable artifact component.

Required primitives:

- retrieval evidence graph;
- citation coverage guard;
- source freshness sentinel;
- contradiction-aware retrieval;
- permissioned memory compiler;
- retrieval distillation objective;
- graph memory compaction;
- RAG-specific K-score axis;
- citation replay;
- source-rights propagation.

Product implication:

- a `.kolm` artifact can contain or reference a retrieval graph;
- answer receipts should name cited evidence;
- stale sources should invalidate or downgrade artifact confidence;
- retrieval failures should feed distill readiness and active learning.

### Agent Tool-Use And MCP Safety

Agentic artifacts are not safe because they call tools. They are safe only when tool permissions, schemas, side effects, and approvals are compiled into the artifact.

Required primitives:

- tool capability evidence graph;
- MCP boundary compiler;
- tool schema fuzzer;
- side-effect classifier;
- tool output injection guard;
- deterministic tool replay ledger;
- least-privilege credential compiler;
- human approval policy synthesizer;
- tool reliability circuit breaker;
- TOOL-K score.

Source anchors:

- Model Context Protocol specification: `https://modelcontextprotocol.io/specification/2025-06-18/basic/index`
- MCP specification repository: `https://github.com/modelcontextprotocol/modelcontextprotocol`

Product rule:

- tool-use artifacts must declare side-effect class and approval policy before deployment.

### Non-Human Identity And Delegated Authority

Owned AI artifacts need identity.

Required primitives:

- non-human identity inventory;
- workload identity binding;
- secretless credential references;
- OAuth/OIDC token exchange boundary;
- just-in-time capability leases;
- intent-bound access tokens;
- tool credential vault;
- policy projection to OPA/Rego, Cedar, ReBAC, or OpenFGA style models where applicable;
- credential-use receipts.

Source anchor:

- SPIFFE X.509-SVID specification: `https://spiffe.io/docs/latest/spiffe-specs/x509-svid/`

Product implication:

- an artifact should never ship with raw secrets;
- the runtime should request scoped capability leases;
- receipts should record capability use without leaking secret values.

### Multimodal Evidence Artifacts

Kolm should support multimodal workflows only when evidence, eval, and runtime contracts are modality-aware.

Document AI:

- layout-aware distillation;
- OCR confidence fusion;
- table structure compiler;
- form field grounder;
- contract clause extractor;
- document citation validator;
- document redaction verifier.

Voice:

- streaming ASR distillation;
- speaker-aware transcript compiler;
- domain vocabulary adapter;
- consent-aware recording policy;
- contact-center outcome compiler;
- voice privacy guard.

Vision and video:

- visual grounding verifier;
- segmentation-aware artifact;
- temporal evidence compiler;
- visual token budget optimizer;
- visual redaction firewall;
- adversarial robustness lab.

Product rule:

- multimodal pages should not imply capability until each modality has evals, privacy gates, runtime passport, and artifact evidence.

### Hardware Root Of Trust And Device Identity

If Kolm runs on edge devices, phones, factories, clinics, vehicles, or air-gapped boxes, device identity matters.

Required primitives:

- hardware capability and root-of-trust ledger;
- secure/measured boot binder;
- TPM or secure element attestation binder;
- device identity chain;
- artifact-to-firmware binding;
- OTA metadata binder;
- rollback and anti-rollback policy;
- device posture verifier;
- offline attestation bundle.

Product implication:

- "runs on device" should become "runs on this measured device posture";
- critical deployments need artifact, runtime, firmware, and device proof together.

### Output Authenticity And Content Provenance

Kolm artifacts should be able to prove which artifact produced an output and how the output changed afterward.

Required primitives:

- output authenticity receipt;
- C2PA manifest adapter for media where relevant;
- detached verification service;
- output hash canonicalizer;
- human edit provenance;
- tool action chain of custody;
- tamper-evident export bundle;
- authenticity-aware typed output.

Source anchor:

- C2PA technical specification: `https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html`

Product implication:

- content provenance should be framed as "verifiable output history," not as a guarantee that content is true.

### Crypto Agility And Long-Horizon Verification

Artifacts may need to verify years after they were produced.

Required primitives:

- cryptographic inventory;
- signature algorithm versioning;
- key provenance ledger;
- timestamping;
- re-signing and rollover;
- evidence vault encryption agility;
- post-quantum migration plan;
- offline verification policy versions.

Source anchor:

- NIST post-quantum cryptography project: `https://csrc.nist.gov/Projects/Post-Quantum-Cryptography`

Product rule:

- do not hard-code one signature story as permanent. The artifact format must be crypto-agile.

### Evidence Lakehouse And Training Data Supply Chain

Kolm's evidence graph needs storage architecture that supports audit, replay, and scale.

Required primitives:

- receipt object store;
- columnar projections;
- open table format strategy;
- snapshot and time travel;
- schema evolution guard;
- training split lineage;
- transform reproducibility checker;
- data freshness SLO;
- evidence redaction and export projections;
- audit query reproducibility.

Source anchors:

- OpenLineage docs: `https://openlineage.io/docs/`
- Delta Lake UniForm: `https://docs.delta.io/delta-uniform.html`
- Apache Hudi table format framework: `https://hudi.apache.org/docs/hudi_stack/`

Product implication:

- artifact proof is only as strong as the evidence supply chain behind it.

### Ontology, Semantic Layer, And Process Mining

Kolm's best enterprise wedge may be discovering repeatable AI work from real processes, not waiting for users to describe it.

Required primitives:

- semantic evidence graph;
- ontology compiler;
- entity resolution;
- schema matching;
- process evidence graph;
- object-centric workflow miner;
- AI opportunity miner;
- process conformance checker;
- workflow bottleneck detector;
- process-aware capture filter.

Product implication:

- enterprise onboarding should identify which workflows are route-only, distill-ready, proof-sensitive, or device-bound.

### Synthetic Data Quality And Model-Collapse Defense

Synthetic data is valuable but dangerous if it creates feedback loops.

Required primitives:

- synthetic ancestry ledger;
- real-data anchor ratio;
- recursive synthetic depth limit;
- tail distribution preservation monitor;
- diversity collapse score;
- synthetic source rights gate;
- generator bias fingerprint;
- multi-generator council;
- synthetic row fitness test;
- collapse-aware mixing policy.

Product rule:

- synthetic examples should never be indistinguishable from real captures in artifact evidence.

### Vertical Foundation Student Strategy

Kolm should not launch every vertical equally. Vertical foundation students need evidence thresholds.

Candidate vertical packs:

- healthcare clinical/admin;
- revenue cycle and claims;
- finance and banking operations;
- insurance underwriting and claims;
- legal contract and policy;
- customer support and success;
- software engineering and maintenance;
- sales engineering and RFP/procurement;
- public sector casework;
- manufacturing and field service.

Launch criteria:

- buyer pain is repeated and high-cost;
- workflow has stable inputs and outputs;
- evals can be built;
- compliance mapping is clear;
- runtime target is known;
- ROI can be measured;
- artifact passport can explain evidence.

Do not launch a vertical page as a flagship unless it has:

- sample artifact;
- eval/K-score packet;
- workflow-specific ROI;
- trust mapping;
- deployment path.

### High-Priority Original Research Now Retained V3

This V3 consolidation explicitly retains:

- private distillation and confidential telemetry;
- federated distillation and consortium pattern lakes;
- confidential compute and attestation;
- verifiable inference proof tiers;
- retrieval graph and GraphRAG knowledge artifacts;
- agent tool-use and MCP safety;
- non-human identity and delegated authority;
- multimodal evidence artifacts;
- hardware root of trust and device identity;
- output authenticity and content provenance;
- crypto agility and post-quantum planning;
- evidence lakehouse and training data supply chain;
- ontology, semantic layer, and process mining;
- synthetic data quality and model-collapse defense;
- vertical foundation student strategy.

## Consolidation Coverage Audit And Execution Triage

This section explains how the 299-section original research corpus should be interpreted after consolidation.

The consolidated document is not meant to preserve every wave title. It is meant to preserve the product-defining logic, the invention families, the proof gates, and the implementation contracts. Raw wave count is useful as a search space; it is not a product strategy by itself.

### Coverage Summary

The original research corpus has 299 top-level sections and thousands of wave-level ideas. The consolidated blueprint now preserves the high-priority content in these forms:

| Original research class | Consolidated representation |
|---|---|
| executive thesis and positioning | Executive Decision, Copy System, Final North Star |
| three product surfaces | The Three Product Surfaces, Product-Surface Build Specs |
| K-score and evaluation | K-Score Metrology Lab, K-score dossier, Metric Causal Control System |
| distillation science | Distill Readiness, TAAS, DAQ, Teacher Council references, experiment dossiers |
| runtime/device research | Runtime Passport, DAQ, hardware root of trust, crypto agility |
| proof/trust/compliance | Artifact Passport, Assurance Case, Evidence DAG, closeout/claim policy |
| website/product experience | Website Rewrite Requirements, Website Intent Router, Product OS |
| customer migration/GTM | Migration System, Procurement Compression, Shadow AI Discovery |
| marketplace/ecosystem | Marketplace Trust, Ecosystem Track, Data Rights Graph |
| privacy/federation/confidential compute | V3 private distillation, federated distillation, confidential compute |
| retrieval/knowledge/process mining | V3 retrieval graph, ontology, process mining |
| multimodal/document/voice/vision | V3 multimodal evidence artifacts |
| reliability/SRE/support | Failure Taxonomy, Support Intelligence, Product OS |
| vertical/domain waves | Vertical Foundation Student Strategy and launch criteria |
| moonshot cryptographic/proof ideas | Proof Tiers, crypto agility, scoped ZKML posture |

### Priority Tiers

Use these tiers to decide what implementation agents build next.

#### P0: Product Truth Spine

Build first because every other surface depends on it.

- canonical product graph;
- canonical pricing and plan taxonomy;
- artifact passport;
- K-score packet;
- readiness closeout;
- claim gate;
- evidence DAG;
- account product matrix;
- docs IA by job-to-be-done.

Why P0:

- without this, every page, API, and demo can drift.

#### P1: First Aha And Activation

Build immediately after truth spine.

- paste OpenAI call or choose sample task;
- capture and fingerprint task;
- show distill readiness;
- produce sample `.kolm` or verified artifact;
- show K-score;
- verify receipt;
- show next action.

Why P1:

- the website and product must make the category obvious by doing, not explaining.

#### P2: Distillation Moat

Build once activation path exists.

- Distill Readiness Index;
- TAAS;
- Teacher Council;
- DAQ;
- active learning;
- K-score calibration;
- structured output proof;
- confidence-aware hybrid routing.

Why P2:

- this is the core technical wedge against gateways, fine-tune platforms, and eval tools.

#### P3: Runtime And Deployment Moat

Build once artifacts are credible.

- runtime passport;
- target smoke;
- BYOC and air-gap proof;
- device fit;
- lifecycle governance;
- rollback;
- attestation where required.

Why P3:

- "run anywhere" is only credible when targets are proven and unsupported targets are explicit.

#### P4: Enterprise And Ecosystem Moat

Build once artifact proof is strong.

- assurance case export;
- procurement packet;
- regulatory change intelligence;
- marketplace;
- SDK conformance;
- loader ecosystem;
- certification;
- partner channels.

Why P4:

- ecosystem and enterprise claims depend on proof maturity.

#### P5: Frontier And Moonshot Research

Keep as research tracks, not launch blockers.

- ZKML;
- homomorphic inference;
- broad federated consortium learning;
- robotics and embodied AI;
- cyber-physical runtime assurance;
- post-quantum signatures beyond migration planning;
- highly specialized vertical packs without evidence.

Why P5:

- these can become moats later, but premature marketing would damage trust.

### Intentional Demotion Rules

Demote original research material when:

- it is a vertical expansion without sample artifact, eval, and buyer proof;
- it is a runtime target without a passport or smoke;
- it is a cryptographic proof idea that is too expensive for general inference;
- it is a compliance claim that needs external certification;
- it is a marketplace feature before licensing, provenance, and K-score comparability exist;
- it is a website page that duplicates another buyer journey;
- it is an academic idea without a product metric;
- it is a support promise without operational owner;
- it is a benchmark without public data or hidden holdout;
- it is a "best" claim without strong current evidence.

Demotion does not mean deletion. It means the idea stays in the research archive until the proof gate exists.

### Retention Rules

Retain original research material when it strengthens at least one of these:

- product clarity;
- K-score validity;
- artifact portability;
- evidence traceability;
- runtime honesty;
- data rights safety;
- customer activation;
- enterprise reviewability;
- cost displacement;
- marketplace trust;
- ecosystem adoption;
- long-term format defensibility.

### Coverage Gaps Still Worth Future Passes

The consolidated doc is substantially stronger, but these areas can still use future deepening:

- concrete per-vertical build cards for the first 5 verticals only;
- exact K-score axis formulas and calibration math;
- model/student candidate matrix by target hardware;
- first-aha demo script and event schema;
- public benchmark launch plan;
- marketplace anti-gaming spec;
- support taxonomy tied to account next-actions;
- production incident and SLO packet;
- enterprise security questionnaire mapping;
- SDK and loader conformance matrix.

### Implementation Agent Readiness Checklist

Before an implementation agent starts any item from this blueprint, they should have:

- objective;
- product surface;
- user-visible output;
- input schema;
- output schema;
- API endpoint if needed;
- CLI command if needed;
- account UI slot if needed;
- artifact passport field if needed;
- K-score or metric impact;
- refusal mode;
- smoke test;
- docs page;
- claim policy;
- rollout order.

If any of those are missing, the item is still research, not implementation-ready.

### Research Archive Policy

Keep the original giant document as:

- ideation archive;
- source register;
- wave ledger;
- frontier scan;
- future backlog;
- reference library for implementation agents.

Use the consolidated blueprint as:

- product truth;
- strategy;
- build priority;
- claim discipline;
- research-to-product handoff;
- frontend/backend/docs/account alignment source.

### Completion Standard For This Research Track

This research track is not complete until:

- the consolidated blueprint has a traceable build spec for every P0-P2 invention;
- every high-priority original research section is retained, demoted, or explicitly deferred;
- every public product claim maps to a proof class;
- every implementation agent can pick up a section and know the contracts, metrics, proof, and refusal mode;
- the actual product/site/docs/account eventually reflect the blueprint.

Current status:

- high-priority consolidation is materially improved;
- implementation-grade dossiers exist for the top experiments;
- multiple critical original research layers are retained;
- full completion is still not proven because implementation and product reflection are separate workstreams.

## P0-P2 Implementation Build Packets V1

This section converts the priority tiers into build packets. These are research contracts for implementation agents, not code.

Standards references:

- JSON Schema 2020-12: `https://json-schema.org/draft/2020-12`
- OpenAPI 3.1.0: `https://spec.openapis.org/oas/v3.1.0.html`
- AsyncAPI: `https://www.asyncapi.com/`
- CloudEvents: `https://github.com/cloudevents/spec`

### Packet P0-1: Product Truth Graph

Objective:

- make product truth queryable by every surface.

User-visible outcome:

- website, account, CLI, docs, and API agree on product surfaces, readiness, pricing, and claim scope.

Core schema:

```json
{
  "schema": "kolm.product_truth_graph.v1",
  "surfaces": [],
  "journeys": [],
  "routes": [],
  "cli_commands": [],
  "account_links": [],
  "tui_views": [],
  "pricing_plans": [],
  "readiness_requirements": [],
  "claim_classes": [],
  "source_paths": [],
  "generated_at": "iso8601"
}
```

API contract:

- `GET /v1/product/graph`
- `GET /v1/product/readiness`
- `GET /v1/product/claims`

CLI contract:

- `kolm surfaces --json`
- `kolm surfaces --readiness --json`

Account UI slot:

- product matrix status panel.

Metrics emitted:

- unowned route groups;
- stale generated graph;
- open readiness gates;
- pricing drift;
- claim-scope violations.

Refusal mode:

- do not render "all shipped" if any requirement is package, benchmark, certification, partner, or external-proof gated.

Smoke test:

- product graph loads;
- counts match route/docs inventory;
- every public claim class has proof or closeout.

### Packet P0-2: Artifact Passport

Objective:

- make a `.kolm` artifact self-describing and verifiable.

User-visible outcome:

- user can drop an artifact into verifier and see identity, provenance, K-score, runtime support, data rights, and lifecycle state.

Core schema:

```json
{
  "schema": "kolm.artifact_passport.v1",
  "artifact_id": "string",
  "artifact_hash": "sha256",
  "signature": {},
  "task_contract": {},
  "provenance": {},
  "data_rights": {},
  "kscore_packet": {},
  "runtime_passports": [],
  "lifecycle": {},
  "assurance_case": {},
  "closeout": {}
}
```

API contract:

- `GET /v1/artifacts/{id}/passport`
- `GET /v1/artifacts/{id}/verify`

CLI contract:

- `kolm verify artifact.kolm --passport --json`
- `kolm inspect artifact.kolm --json`

Account UI slot:

- artifact detail page.

Metrics emitted:

- passport completeness;
- verification success;
- stale evidence count;
- unsupported runtime targets;
- rights blockers.

Refusal mode:

- refuse registry publish if signature, eval hash, rights scope, or lifecycle state is invalid.

Smoke test:

- verifier recomputes hash;
- signature checks;
- no secret values included;
- missing proof appears as explicit closeout.

### Packet P0-3: K-Score Packet

Objective:

- make every score scoped, reproducible, and non-misleading.

User-visible outcome:

- user understands why an artifact shipped, failed, or needs more data.

Core schema:

```json
{
  "schema": "kolm.kscore_packet.v1",
  "score_version": "string",
  "task_family": "string",
  "artifact_id": "string",
  "baseline_id": "string",
  "eval_ids": [],
  "axes": {},
  "weights": {},
  "sample_size": 0,
  "confidence_interval": {},
  "calibration_version": "string",
  "failure_slices": [],
  "refusal_reason": null
}
```

API contract:

- `GET /v1/artifacts/{id}/kscore`
- `POST /v1/kscore/evaluate`

CLI contract:

- `kolm score artifact.kolm --json`
- `kolm bench artifact.kolm --eval <id> --json`

Account UI slot:

- K-score trend and failure slice panel.

Metrics emitted:

- K-score;
- axis scores;
- confidence interval;
- false-ship rate;
- false-block rate;
- calibration drift.

Refusal mode:

- no eval, no score;
- insufficient sample, provisional score only;
- incompatible task family, no comparison;
- stale calibration, warn or block depending on risk.

Smoke test:

- deterministic fixture returns same score;
- score packet includes eval ids and confidence;
- cross-task comparison is rejected.

### Packet P0-4: Evidence DAG

Objective:

- make all claims traceable.

User-visible outcome:

- every artifact, score, route, and enterprise export can explain what evidence it depends on.

Core schema:

```json
{
  "schema": "kolm.evidence_dag.v1",
  "nodes": [
    {
      "id": "string",
      "kind": "capture|eval|teacher|student|runtime|signature|policy|rights|attestation",
      "hash": "string",
      "freshness": {},
      "rights": {},
      "owner": "string"
    }
  ],
  "edges": [
    {
      "from": "string",
      "to": "string",
      "relationship": "derived_from|validated_by|invalidates|supersedes"
    }
  ]
}
```

API contract:

- `GET /v1/evidence/{id}`
- `GET /v1/artifacts/{id}/evidence-dag`

CLI contract:

- `kolm evidence show <id> --json`
- `kolm evidence trace artifact.kolm --json`

Account UI slot:

- evidence graph drawer.

Metrics emitted:

- orphan evidence;
- stale proof;
- revoked dependency count;
- unverifiable claim count.

Refusal mode:

- refuse assurance export if critical claim has no evidence path.

Smoke test:

- revoking a data-rights node marks dependent artifact as needs review.

### Packet P1-1: First Aha Demo

Objective:

- make a visitor understand Kolm by doing the product loop.

User-visible outcome:

- paste an OpenAI-style call or choose sample, get a task fingerprint, sample artifact, K-score, and receipt.

Flow:

1. paste call or select sample;
2. parse provider request;
3. create behavior fingerprint;
4. show capture eligibility;
5. select sample or generated `.kolm`;
6. show K-score packet;
7. verify receipt;
8. show next action: API key, CLI, account, docs, or enterprise packet.

Event schema:

```json
{
  "schema": "kolm.first_aha_event.v1",
  "session_id": "string",
  "intent": "gateway|distill|runtime|trust|verify",
  "step": "paste|fingerprint|artifact|score|verify|next_action",
  "artifact_id": "string|null",
  "error": "string|null",
  "claim_scope": "string"
}
```

API contract:

- `POST /v1/demo/fingerprint`
- `POST /v1/demo/artifact`
- `GET /v1/demo/receipt/{id}`

CLI contract:

- `kolm demo openai-call call.json --json`

Account UI slot:

- onboarding and homepage embedded demo.

Metrics emitted:

- demo start;
- fingerprint success;
- artifact generated or selected;
- receipt verified;
- next-action click;
- comprehension survey result.

Refusal mode:

- if user input includes sensitive data, warn and offer local/sample mode.

Smoke test:

- fixture OpenAI call produces deterministic fingerprint and sample receipt.

### Packet P1-2: Namespace Distill Readiness

Objective:

- show when captured work is ready to compile.

User-visible outcome:

- account tells user exactly why a namespace is ready or blocked.

Core schema:

```json
{
  "schema": "kolm.distill_readiness.v1",
  "namespace_id": "string",
  "verdict": "not_ready|ready_for_recipe|ready_for_student|ready_for_hybrid|needs_human_review",
  "coverage": {},
  "label_stability": {},
  "poison_risk": {},
  "privacy_eligibility": {},
  "eval_sufficiency": {},
  "teacher_disagreement": {},
  "expected_kscore_lift": null,
  "expected_cost_displacement": null,
  "blockers": [],
  "next_actions": []
}
```

API contract:

- `GET /v1/namespaces/{id}/distill-readiness`

CLI contract:

- `kolm distill readiness --namespace <id> --json`

Account UI slot:

- namespace readiness table and next-action panel.

Metrics emitted:

- readiness verdict;
- blockers by class;
- time from first capture to readiness;
- compile success after readiness;
- false-ready and false-block rates.

Refusal mode:

- block distill if privacy, poison, eval, or rights gate fails.

Smoke test:

- synthetic namespace with poison rows returns not_ready;
- complete fixture namespace returns ready_for_student.

### Packet P1-3: Route Decision Receipt

Objective:

- make local/frontier/human/refusal routing explainable.

User-visible outcome:

- every routed call explains why it used local artifact, provider fallback, human review, or refusal.

Core schema:

```json
{
  "schema": "kolm.route_decision_receipt.v1",
  "request_id": "string",
  "policy_version": "string",
  "artifact_id": "string|null",
  "decision": "local|local_warning|frontier|human_review|refuse",
  "confidence": null,
  "novelty": null,
  "risk": null,
  "fallback_reason": "string|null",
  "provider": "string|null",
  "cost": null,
  "latency_ms": null,
  "capture_eligible": false
}
```

API contract:

- `POST /v1/routes/decision`
- `GET /v1/routes/{request_id}/receipt`

CLI contract:

- `kolm route explain <request_id> --json`

Account UI slot:

- route trace drawer.

Metrics emitted:

- local rate;
- frontier fallback rate;
- false-local rate;
- abstention rate;
- cost avoided;
- active-learning yield.

Refusal mode:

- refuse local route when confidence, novelty, or policy risk exceeds bound.

Smoke test:

- high-novelty prompt triggers frontier or human review, not silent local.

### Packet P2-1: Task-Adaptive Student Selection

Objective:

- choose the best student for task, target, and risk constraints.

User-visible outcome:

- compile report explains why this student was chosen and what alternatives were rejected.

Core schema:

```json
{
  "schema": "kolm.student_selection_report.v1",
  "task_contract_id": "string",
  "constraints": {},
  "candidates": [],
  "bakeoff_eval_ids": [],
  "pareto_frontier": [],
  "selected_student": "string",
  "rejected_candidates": [],
  "expected_kscore": null,
  "expected_latency_ms": null,
  "expected_memory_mb": null,
  "expected_fallback_rate": null
}
```

API contract:

- `POST /v1/distill/select-student`

CLI contract:

- `kolm distill select-student --namespace <id> --target <target> --json`

Account UI slot:

- candidate student frontier.

Metrics emitted:

- selection regret;
- K-score per dollar;
- K-score per millisecond;
- target fit rate.

Refusal mode:

- refuse selection when no candidate meets hard constraints or minimum expected score.

Smoke test:

- fixture task selects smaller student for simple extraction and rejects it for reasoning-heavy task.

### Packet P2-2: Distillation-Aware Quantization

Objective:

- compress artifacts while preserving task-specific quality.

User-visible outcome:

- user sees which precision tier is safe for each target and what quality loss is expected.

Core schema:

```json
{
  "schema": "kolm.quantization_risk_report.v1",
  "artifact_id": "string",
  "target": "string",
  "candidate_precisions": [],
  "activation_profile": {},
  "layer_sensitivity": {},
  "schema_sensitivity": {},
  "selected_precision": "string",
  "quality_delta": null,
  "memory_delta": null,
  "latency_delta": null,
  "energy_delta": null,
  "blocked_precisions": []
}
```

API contract:

- `POST /v1/artifacts/{id}/quantization-plan`

CLI contract:

- `kolm quantize plan artifact.kolm --target <target> --json`

Account UI slot:

- target precision planner.

Metrics emitted:

- K-score retention;
- memory reduction;
- latency improvement;
- schema validity retention;
- energy estimate where measured.

Refusal mode:

- block quant tier when quality loss exceeds budget or eval coverage is insufficient.

Smoke test:

- fixture structured task rejects aggressive quantization if schema validity drops.

### Packet P2-3: Structured Output Proof

Objective:

- prove artifacts satisfy workflow schemas.

User-visible outcome:

- user can attach a schema and see whether generated outputs are valid, repaired, or refused.

Core schema:

```json
{
  "schema": "kolm.schema_proof_report.v1",
  "artifact_id": "string",
  "schema_id": "string",
  "schema_version": "string",
  "task_family": "string",
  "validity_rate": null,
  "field_accuracy": {},
  "repair_rate": null,
  "refusal_rate": null,
  "runtime_support": {},
  "failure_examples": []
}
```

API contract:

- `POST /v1/artifacts/{id}/schema-proof`

CLI contract:

- `kolm schema verify artifact.kolm --schema schema.json --json`

Account UI slot:

- structured output proof panel.

Metrics emitted:

- schema validity;
- field-level accuracy;
- repair attempts;
- invalid-output refusal correctness.

Refusal mode:

- refuse output when schema cannot be satisfied within bounded repair attempts.

Smoke test:

- invalid schema fixture fails loudly;
- valid fixture reports separate shape and content scores.

### Packet P2-4: K-Score Calibration Workbench

Objective:

- make K-score a measured instrument, not a marketing number.

User-visible outcome:

- public and private calibration reports show what K-score means for each task family.

Core schema:

```json
{
  "schema": "kolm.kscore_calibration_report.v1",
  "calibration_version": "string",
  "task_family": "string",
  "dataset_ids": [],
  "human_label_protocol": {},
  "judge_models": [],
  "correlations": {},
  "confidence_coverage": {},
  "bias_audit": {},
  "known_limits": [],
  "next_recalibration_due": "iso8601"
}
```

API contract:

- `GET /v1/kscore/calibration`
- `GET /v1/kscore/calibration/{task_family}`

CLI contract:

- `kolm kscore calibration --task-family <id> --json`

Account UI slot:

- score explanation and calibration scope.

Metrics emitted:

- correlation with human preference;
- false-ship rate;
- false-block rate;
- calibration drift;
- confidence coverage.

Refusal mode:

- do not compare artifacts across task families without calibration proof.

Smoke test:

- two incompatible task-family reports cannot produce a single leaderboard score.

### Packet P2-5: Active Learning And Expert Review Queue

Objective:

- spend human/teacher budget where it most improves score or reduces risk.

User-visible outcome:

- account recommends which examples to label, review, redact, or exclude next.

Core schema:

```json
{
  "schema": "kolm.active_learning_queue.v1",
  "namespace_id": "string",
  "items": [
    {
      "capture_id": "string",
      "reason": "uncertain|high_value|risk|coverage_gap|teacher_disagreement",
      "expected_kscore_lift": null,
      "expected_risk_reduction": null,
      "reviewer_role": "string",
      "privacy_scope": "string"
    }
  ]
}
```

API contract:

- `GET /v1/namespaces/{id}/active-learning`
- `POST /v1/reviews/{id}/decision`

CLI contract:

- `kolm review queue --namespace <id> --json`

Account UI slot:

- review queue and label ROI panel.

Metrics emitted:

- K-score lift per reviewed example;
- disagreement resolution rate;
- reviewer reliability;
- label cost per accepted artifact.

Refusal mode:

- do not send sensitive or ineligible data to reviewers outside its privacy scope.

Smoke test:

- high-risk fixture routes to expert review, not generic crowd label.

### Packet Dependency Graph

Build order:

```text
Product Truth Graph
  -> Artifact Passport
  -> Evidence DAG
  -> K-Score Packet
  -> First Aha Demo
  -> Distill Readiness
  -> Route Decision Receipt
  -> Student Selection
  -> Quantization Risk Report
  -> Structured Output Proof
  -> K-Score Calibration
  -> Active Learning Queue
```

Rule:

- if a packet cannot emit a verifier artifact, it is not ready to ship.

### Packet Sources And Spec Alignment

Use:

- JSON Schema for packet schemas;
- OpenAPI for request/response APIs;
- AsyncAPI or CloudEvents for streaming capture, route, review, and artifact lifecycle events;
- artifact passport hashes for immutable proof;
- account UI projections for human readability.

## P3-P5 Implementation Build Packets V1

This section preserves the critical execution material from the original research that did not fit inside the P0-P2 product, distillation, and evaluation packets. These packets are lower priority than the first product loop, but they are not optional if Kolm is meant to become infrastructure rather than a clever gateway.

Design rule:

- P3 packets make artifacts deployable and observable across runtimes.
- P4 packets make artifacts buyable, governable, and extensible by enterprises and ecosystems.
- P5 packets turn Kolm into a compounding research machine.

Every packet below must have:

- a machine-readable contract;
- a user-visible account surface;
- a CLI or API proof path;
- a refusal mode that prevents overclaiming;
- a smoke test that can run without a perfect production environment.

### Packet P3-1: Runtime Passport And Target Smoke

Objective:

- make every `.kolm` artifact carry a runtime passport that states where it can run, what it needs, what it was tested against, and what degraded behavior is allowed.

User outcome:

- a team can answer "will this artifact run on Vercel, Kubernetes, an air-gapped GPU box, a browser worker, a phone, or an edge device?" before deployment.

Why it matters:

- runtime portability is one of the three product surfaces, but portability without target proof becomes marketing copy.
- the runtime passport converts portability into a verifiable compatibility claim.

Core packet schema:

```json
{
  "artifact_id": "art_...",
  "runtime_passport_version": "1",
  "targets": [
    {
      "target_id": "webgpu-browser",
      "target_class": "browser",
      "runtime": "webgpu",
      "status": "passed",
      "min_memory_mb": 512,
      "min_compute": "adapter:webgpu",
      "latency_p50_ms": 42,
      "latency_p95_ms": 79,
      "quality_delta": -0.012,
      "fallback": "route_to_cloud",
      "evidence_id": "ev_..."
    }
  ],
  "unsupported_targets": [
    {
      "target_id": "ios-neural-engine",
      "reason": "no_signed_loader_yet",
      "next_action": "run mobile SDK target smoke"
    }
  ]
}
```

API contract:

- `GET /v1/artifacts/{id}/runtime-passport`
- `POST /v1/artifacts/{id}/runtime-smoke`
- `GET /v1/runtime/targets`

CLI contract:

- `kolm runtime targets --json`
- `kolm runtime smoke <artifact.kolm> --target webgpu-browser --json`
- `kolm runtime passport <artifact.kolm> --json`

Account UI slot:

- artifact detail page: target matrix with pass, degraded, not tested, and unsupported states.
- deployment page: target picker should filter by proven targets first, then show experimental targets separately.

Metrics emitted:

- target smoke pass rate;
- portability coverage by target class;
- quality delta per target;
- latency and memory envelope per target;
- fallback activation rate.

Refusal mode:

- never call a target "supported" unless it has a dated smoke result or signed external loader conformance.
- separate "format could support" from "this artifact was tested."

Smoke test:

- compile a small deterministic fixture and run the same input on at least one local target and one degraded target.
- passport must include target status, quality delta, latency, and fallback behavior.

### Packet P3-2: Artifact Lifecycle And Release Channels

Objective:

- make `.kolm` artifacts behave like serious deployable software: versioned, signed, promoted, rolled back, deprecated, and retired with evidence.

User outcome:

- enterprises can promote an artifact from dev to staging to production without losing lineage, auditability, or rollback safety.

Why it matters:

- model replacement is operationally risky.
- a signed artifact is only valuable if its lifecycle is controlled after it is built.

Core packet schema:

```json
{
  "artifact_id": "art_...",
  "release_channel": "production",
  "version": "2026.05.24.3",
  "state": "promoted",
  "promotion_policy": "requires_eval_pass_and_admin_approval",
  "previous_artifact_id": "art_...",
  "rollback_artifact_id": "art_...",
  "signature": {
    "algorithm": "ed25519",
    "key_id": "key_...",
    "bundle_id": "sig_..."
  },
  "lifecycle_events": [
    {
      "event": "promoted",
      "actor": "user_...",
      "time": "2026-05-24T00:00:00Z",
      "evidence_id": "ev_..."
    }
  ]
}
```

API contract:

- `POST /v1/artifacts/{id}/release`
- `POST /v1/artifacts/{id}/promote`
- `POST /v1/artifacts/{id}/rollback`
- `GET /v1/artifacts/{id}/lineage`

CLI contract:

- `kolm artifact release <artifact.kolm> --channel staging --json`
- `kolm artifact promote <id> --to production --json`
- `kolm artifact rollback <id> --json`

Account UI slot:

- artifact lifecycle timeline.
- channel selector with gated promotion requirements.
- rollback button visible only when rollback evidence exists.

Metrics emitted:

- promotion lead time;
- rollback frequency;
- release failure rate;
- stale artifact age;
- channels without signed artifacts.

Refusal mode:

- do not promote if evals, signatures, or approval requirements are missing.
- do not hide the previous artifact state when rollback changes production behavior.

Smoke test:

- create a fixture artifact, promote it to staging, reject production promotion when eval evidence is missing, attach eval evidence, then promote and rollback.

### Packet P3-3: BYOC, Kubernetes, And Air-Gap Deployment Packet

Objective:

- give regulated customers a deployment packet that proves Kolm can run in their cloud, cluster, or offline environment without silently depending on Kolm-hosted control planes.

User outcome:

- a buyer can say "this can run in our environment" without waiting for a bespoke solutions-engineering proof.

Why it matters:

- enterprise AI infrastructure buyers often reject SaaS-only products.
- BYOC and air-gap support turn Kolm from app-layer tooling into infrastructure.

Core packet schema:

```json
{
  "deployment_id": "dep_...",
  "mode": "byoc_kubernetes",
  "control_plane": "customer_owned",
  "data_plane": "customer_owned",
  "required_secrets": ["object_store", "signing_key", "otel_exporter"],
  "network_policy": {
    "egress_required": false,
    "allowed_hosts": []
  },
  "kubernetes": {
    "crds": ["KolmArtifact", "KolmRuntime", "KolmEval"],
    "namespace": "kolm",
    "minimum_version": "1.29"
  },
  "air_gap": {
    "bundle_hash": "sha256:...",
    "offline_verifier": true,
    "sneakernet_import": true
  }
}
```

API contract:

- `GET /v1/deployments/templates`
- `POST /v1/deployments/byoc-plan`
- `POST /v1/deployments/airgap-bundle`
- `GET /v1/deployments/{id}/readiness`

CLI contract:

- `kolm deploy plan --target kubernetes --artifact <id> --json`
- `kolm deploy bundle --airgap --artifact <id> --json`
- `kolm deploy smoke --target byoc --json`

Account UI slot:

- BYOC deployment wizard.
- air-gap bundle generator.
- readiness checklist with secrets, storage, runtime, telemetry, and signer status.

Metrics emitted:

- BYOC plan completion rate;
- air-gap bundle verification rate;
- missing secret class frequency;
- deployment smoke pass rate;
- runtime egress dependency count.

Refusal mode:

- never claim air-gapped support if live cloud callbacks, remote telemetry, or hosted signers are required.
- label managed-cloud, BYOC, and offline modes separately.

Smoke test:

- generate a local offline bundle, verify its manifest hash, run an offline verify command, and reject a bundle with a missing runtime dependency.

### Packet P3-4: Device Identity And Attestation Packet

Objective:

- make device, runtime, and signer identity part of the artifact evidence chain.

User outcome:

- a customer can prove not only what artifact ran, but where it ran and under which runtime identity.

Why it matters:

- edge and enterprise deployments need stronger trust than "the app says it ran."
- runtime attestation makes the "run anywhere" claim auditable.

Core packet schema:

```json
{
  "run_id": "run_...",
  "artifact_id": "art_...",
  "device_id": "dev_...",
  "runtime_id": "rt_...",
  "identity_type": "spiffe_x509_svid",
  "attestation": {
    "tier": "runtime_signed",
    "issuer": "customer_ca",
    "evidence_id": "ev_..."
  },
  "policy_result": {
    "allowed": true,
    "policy_id": "pol_..."
  }
}
```

API contract:

- `POST /v1/devices/register`
- `POST /v1/runtime/attest`
- `GET /v1/runs/{id}/attestation`

CLI contract:

- `kolm device register --json`
- `kolm runtime attest --artifact <id> --json`
- `kolm verify run <run-id> --attestation --json`

Account UI slot:

- device fleet table.
- runtime identity detail.
- run receipt panel with identity and policy result.

Metrics emitted:

- attested run percentage;
- untrusted runtime rejection count;
- device key rotation age;
- policy denial reason distribution.

Refusal mode:

- separate self-reported device metadata from cryptographic attestation.
- do not imply hardware attestation if only runtime signing exists.

Smoke test:

- register a local mock device, run a signed fixture, verify the run receipt, then reject the same run under an untrusted device identity.

### Packet P4-1: Enterprise Assurance Case Export

Objective:

- export a structured assurance case that security, legal, procurement, and compliance teams can inspect without reading scattered docs.

User outcome:

- a buyer receives one evidence packet for controls, data flow, model behavior, eval status, subprocessor scope, and deployment mode.

Why it matters:

- procurement speed is a tracked product metric.
- enterprise buyers do not buy "AI magic"; they buy evidence, controls, and clear responsibility boundaries.

Core packet schema:

```json
{
  "assurance_case_id": "case_...",
  "scope": "artifact_and_workspace",
  "claims": [
    {
      "claim_id": "claim_...",
      "claim": "artifact outputs are reproducible for fixture set v3",
      "status": "supported",
      "evidence_ids": ["ev_..."],
      "limitations": ["live teacher availability not included"]
    }
  ],
  "controls": [
    {
      "framework": "nist_ai_rmf",
      "control_id": "map-1",
      "implementation_status": "implemented",
      "evidence_id": "ev_..."
    }
  ],
  "export_formats": ["json", "pdf", "oscal"]
}
```

API contract:

- `POST /v1/assurance-cases`
- `GET /v1/assurance-cases/{id}`
- `GET /v1/assurance-cases/{id}/export?format=oscal`

CLI contract:

- `kolm assurance export --artifact <id> --format json`
- `kolm assurance export --workspace <id> --format oscal`

Account UI slot:

- trust center export drawer.
- artifact assurance tab.
- workspace compliance readiness panel.

Metrics emitted:

- evidence completeness;
- unsupported claim count;
- procurement export count;
- assurance case review age;
- customer security questionnaire cycle time.

Refusal mode:

- never convert "control implemented" into "certified" without external certification evidence.
- unsupported claims must appear as unsupported, not be dropped.

Smoke test:

- create a fixture assurance case containing one supported claim, one scoped claim, and one unsupported claim; export JSON and verify all three appear.

### Packet P4-2: Procurement And Security Questionnaire Packet

Objective:

- auto-answer enterprise security questionnaires from the same evidence graph used by product and runtime surfaces.

User outcome:

- sales and security teams can answer repeat questionnaires in hours instead of weeks.

Why it matters:

- this is a revenue accelerator and a consistency guard.
- every answer should map to evidence, not human memory.

Core packet schema:

```json
{
  "questionnaire_id": "qq_...",
  "buyer": "enterprise",
  "answers": [
    {
      "question": "Do you support customer-owned storage?",
      "answer": "Yes, when BYOC object storage is configured.",
      "scope": "byoc_only",
      "evidence_ids": ["ev_..."],
      "owner": "security"
    }
  ],
  "unanswered": [
    {
      "question": "Do you have SOC 2 Type II?",
      "reason": "live_certification_not_complete",
      "next_action": "attach auditor report when available"
    }
  ]
}
```

API contract:

- `POST /v1/procurement/questionnaires`
- `POST /v1/procurement/questionnaires/{id}/answer`
- `GET /v1/procurement/questionnaires/{id}/export`

CLI contract:

- `kolm procurement answer <questionnaire.json> --workspace <id> --json`
- `kolm procurement gaps <questionnaire.json> --json`

Account UI slot:

- questionnaire upload and review flow.
- answer confidence and evidence links.
- gap list with owner and due date.

Metrics emitted:

- auto-answer coverage;
- human-review rate;
- unsupported-answer count;
- sales-cycle compression;
- repeated-question frequency.

Refusal mode:

- do not synthesize a positive answer when evidence is missing.
- route legal/compliance answers to approval before export.

Smoke test:

- upload a small questionnaire with one supported BYOC question, one unsupported certification question, and one ambiguous privacy question; verify outputs are scoped correctly.

### Packet P4-3: Registry, Marketplace, And Comparable Trust Packet

Objective:

- make the artifact registry useful without becoming a black-box model marketplace.

User outcome:

- users can compare artifacts by task, proof, runtime targets, cost, quality, privacy, and trust status.

Why it matters:

- a registry becomes a network effect only when each new artifact improves discovery and comparison.
- comparable trust is the moat; not just a catalog.

Core packet schema:

```json
{
  "listing_id": "lst_...",
  "artifact_id": "art_...",
  "task_class": "claims_redaction",
  "trust_summary": {
    "k_score": 0.91,
    "runtime_targets": ["node", "webgpu"],
    "privacy_scope": "workspace_local",
    "signature_status": "valid",
    "benchmark_scope": "public_fixture_v1"
  },
  "comparison_group": "phi_redaction",
  "price_model": "usage_or_private_license",
  "limitations": ["not certified for clinical diagnosis"]
}
```

API contract:

- `GET /v1/registry/listings`
- `GET /v1/registry/listings/{id}/compare`
- `POST /v1/registry/listings`
- `GET /v1/registry/trust-matrix`

CLI contract:

- `kolm registry search --task claims_redaction --json`
- `kolm registry compare <a> <b> --json`
- `kolm registry verify <listing-id> --json`

Account UI slot:

- artifact comparison table.
- trust filter sidebar.
- listing detail with proof and limitations first, marketing copy second.

Metrics emitted:

- registry search-to-install conversion;
- comparison view rate;
- verified listing percentage;
- stale listing percentage;
- artifact reuse across teams.

Refusal mode:

- do not rank artifacts only by vendor-provided claims.
- listings with missing proof must be visibly unverified.

Smoke test:

- create two fixture listings, one verified and one unverified; compare them and verify proof status changes ranking and UI labels.

### Packet P4-4: SDK, Loader, And Ecosystem Conformance Packet

Objective:

- make Kolm usable from the tools customers already use: SDKs, loaders, CI, IDEs, Kubernetes, and runtime adapters.

User outcome:

- a developer can adopt Kolm without changing their full stack.

Why it matters:

- ecosystem adoption is an open readiness gate.
- conformance tests turn "supports X" into a reproducible adapter contract.

Core packet schema:

```json
{
  "adapter_id": "adapter_llama_cpp",
  "adapter_class": "runtime_loader",
  "version": "0.1.0",
  "conformance": {
    "format_parse": "passed",
    "signature_verify": "passed",
    "fixture_run": "partial",
    "limitations": ["text_only", "no_multimodal"]
  },
  "package": {
    "channel": "source",
    "url": "https://example.invalid",
    "published": false
  }
}
```

API contract:

- `GET /v1/ecosystem/adapters`
- `GET /v1/ecosystem/adapters/{id}/conformance`
- `POST /v1/ecosystem/adapters/{id}/smoke`

CLI contract:

- `kolm adapter list --json`
- `kolm adapter smoke --adapter llama-cpp --artifact <id> --json`
- `kolm adapter conformance --json`

Account UI slot:

- ecosystem readiness matrix.
- SDK install cards that distinguish source-only from package-published.
- adapter limitations section.

Metrics emitted:

- adapter smoke pass rate;
- package publication coverage;
- external integration count;
- adapter issue rate;
- time-to-first-run by SDK.

Refusal mode:

- do not describe an SDK or adapter as production-ready if it is source-only or lacks package release proof.
- keep third-party adoption separate from internal compatibility.

Smoke test:

- run a fixture parse/signature/verify flow through each adapter stub and fail if any adapter lacks an explicit limitation list.

### Packet P5-1: Confidential And Federated Research Packet

Objective:

- let customers improve artifacts from sensitive data without centralizing raw data into Kolm.

User outcome:

- regulated customers can participate in cross-tenant learning, consortium benchmarks, or private improvement loops while keeping data local.

Why it matters:

- the best distillation advantage comes from broad task evidence, but raw data sharing is impossible for many customers.
- confidential and federated learning turn privacy into a data network advantage.

Core packet schema:

```json
{
  "federated_run_id": "fed_...",
  "participants": [
    {
      "namespace_id": "ns_...",
      "data_policy": "no_raw_export",
      "update_type": "gradient_or_metric_only",
      "privacy_budget": {
        "epsilon": 2.0,
        "delta": 0.000001
      }
    }
  ],
  "aggregation": {
    "method": "secure_weighted_update",
    "outlier_filter": "poisoning_detector_v1",
    "accepted_updates": 7,
    "rejected_updates": 1
  }
}
```

API contract:

- `POST /v1/research/federated-runs`
- `POST /v1/research/federated-runs/{id}/updates`
- `GET /v1/research/federated-runs/{id}/report`

CLI contract:

- `kolm research federated plan --json`
- `kolm research federated submit-update --json`
- `kolm research federated report <id> --json`

Account UI slot:

- consortium participation panel.
- privacy budget and update policy controls.
- accepted/rejected update audit trail.

Metrics emitted:

- cross-namespace lift;
- accepted update rate;
- privacy budget consumption;
- poisoning rejection rate;
- participant contribution value.

Refusal mode:

- do not combine customer data unless policy, privacy budget, and participation consent are explicit.
- do not claim model improvement came from federated learning unless accepted updates are recorded.

Smoke test:

- simulate three namespace updates, reject one poisoned update, aggregate two accepted updates, and emit a report with no raw examples.

### Packet P5-2: Verifiable Inference And Crypto-Agility Packet

Objective:

- prepare Kolm for a world where customers ask for stronger proof that the right artifact ran and produced the claimed output.

User outcome:

- customers can choose the proof tier that matches risk: receipt-only, runtime-signed, hardware-attested, or cryptographic proof.

Why it matters:

- not every workload needs zero-knowledge inference, but high-trust markets will ask for escalating proof tiers.
- crypto agility prevents today signatures from becoming tomorrow migration crisis.

Core packet schema:

```json
{
  "proof_id": "proof_...",
  "run_id": "run_...",
  "proof_tier": "runtime_signed",
  "artifact_hash": "sha256:...",
  "input_commitment": "sha256:...",
  "output_commitment": "sha256:...",
  "signature": {
    "algorithm": "ed25519",
    "key_id": "key_..."
  },
  "crypto_agility": {
    "supported_algorithms": ["ed25519", "ecdsa-p256", "ml-dsa-placeholder"],
    "rotation_policy": "annual_or_compromise"
  }
}
```

API contract:

- `POST /v1/runs/{id}/proof`
- `GET /v1/runs/{id}/proof`
- `POST /v1/crypto/rotate-key`
- `GET /v1/crypto/policy`

CLI contract:

- `kolm proof create --run <id> --tier runtime-signed --json`
- `kolm proof verify <proof.json> --json`
- `kolm crypto policy --json`

Account UI slot:

- run proof panel.
- cryptographic policy and key rotation dashboard.
- proof tier recommendation by workload risk.

Metrics emitted:

- proof coverage by tier;
- failed proof verification count;
- key rotation age;
- algorithm distribution;
- high-risk workloads without proof.

Refusal mode:

- do not imply zero-knowledge or hardware attestation where only signed receipts exist.
- label experimental proof tiers as experimental until benchmarked and audited.

Smoke test:

- create a signed run receipt for a fixture artifact, verify it, rotate a test key, and reject proof verification under the retired key unless historical trust policy allows it.

### Packet P5-3: Autonomous Research Lab Packet

Objective:

- turn Kolm's own product telemetry, benchmarks, failures, and customer outcomes into a controlled invention engine.

User outcome:

- the roadmap becomes evidence-driven: every proposed invention has a hypothesis, experiment plan, metric target, rollout gate, and kill criterion.

Why it matters:

- "research 100x" only compounds if the system learns what improves cost, quality, latency, reliability, trust, adoption, and revenue.
- the lab packet prevents invention sprawl by forcing experiments to carry proof.

Core packet schema:

```json
{
  "experiment_id": "exp_...",
  "hypothesis": "DAQ reduces artifact size without unacceptable K-score loss",
  "metric_targets": [
    {
      "metric": "artifact_size_delta",
      "target": "-35%"
    },
    {
      "metric": "k_score_delta",
      "floor": "-0.02"
    }
  ],
  "rollout_gate": "shadow_then_canary",
  "kill_criteria": [
    "p95_latency_regresses_more_than_10_percent",
    "safety_eval_fails"
  ],
  "evidence_ids": ["ev_..."]
}
```

API contract:

- `POST /v1/research/experiments`
- `GET /v1/research/experiments/{id}`
- `POST /v1/research/experiments/{id}/result`
- `GET /v1/research/portfolio`

CLI contract:

- `kolm research experiment new --json`
- `kolm research experiment result <id> --json`
- `kolm research portfolio --json`

Account UI slot:

- research portfolio dashboard.
- metric movement table.
- experiment kill/ship decision log.

Metrics emitted:

- experiment throughput;
- shipped invention rate;
- killed experiment rate;
- metric lift by product surface;
- research-to-product lead time.

Refusal mode:

- do not ship a research feature because it is novel; ship only if it moves a tracked metric without violating safety, trust, or quality floors.

Smoke test:

- create a DAQ experiment fixture, record one failing result and one passing result, verify only the passing result is eligible for rollout.

### P3-P5 Dependency Graph

Build order:

```text
Runtime Passport
  -> Artifact Lifecycle
  -> BYOC/Kubernetes/Air-Gap
  -> Device Identity And Attestation
  -> Assurance Case Export
  -> Procurement Questionnaire
  -> Registry Comparable Trust
  -> SDK/Loader Conformance
  -> Confidential/Federated Research
  -> Verifiable Inference And Crypto-Agility
  -> Autonomous Research Lab
```

Dependency rules:

- runtime passport must exist before marketplace comparison, because listings need runtime truth;
- artifact lifecycle must exist before BYOC promotion, because customers need rollback and release channels;
- assurance case export must read from the evidence DAG and readiness ledger, not a separate compliance document;
- ecosystem conformance must distinguish first-party tests from third-party adoption;
- confidential research must route through poisoning detection and privacy policy before it can affect a shared artifact;
- verifiable inference proof tiers must be explicit, not collapsed into one "verified" label;
- the autonomous research lab cannot create product claims unless K-score, benchmark, or business metrics prove the lift.

### P3-P5 Sources And Spec Alignment

Standards and specs that should constrain implementation:

- OCI Image Spec and artifact distribution concepts: `https://github.com/opencontainers/image-spec`
- Kubernetes Custom Resources for Kolm runtime, artifact, eval, and deployment operators: `https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/`
- WebGPU target class for browser/device acceleration: `https://www.w3.org/TR/webgpu/`
- WebNN target class for browser-native neural network execution: `https://www.w3.org/TR/webnn/`
- NIST OSCAL for machine-readable control and assurance export: `https://pages.nist.gov/OSCAL/`
- OpenID Connect for enterprise identity boundary alignment: `https://openid.net/specs/openid-connect-core-1_0.html`
- SCIM protocol and schema for enterprise user lifecycle: `https://www.rfc-editor.org/rfc/rfc7644` and `https://www.rfc-editor.org/rfc/rfc7643`
- OpenFGA-style relationship authorization for artifact, workspace, registry, and approval policies: `https://openfga.dev/docs`

Implementation principle:

- when a packet overlaps an existing standard, use the standard vocabulary at the boundary and reserve Kolm-specific vocabulary for artifact, K-score, passport, evidence DAG, and route receipt concepts.

### P3-P5 Product Impact Map

Runtime and deployment metrics:

- first successful deploy time;
- target smoke pass rate;
- artifact rollback rate;
- deployment support ticket rate;
- runtime cost per accepted task;
- customer-owned environment adoption.

Enterprise and ecosystem metrics:

- procurement cycle time;
- security questionnaire auto-answer rate;
- trust export count;
- registry reuse rate;
- SDK first-run completion;
- verified adapter coverage.

Frontier and moat metrics:

- research experiment throughput;
- invention ship rate;
- cross-namespace learning lift;
- privacy-preserving contribution count;
- proof-tier adoption;
- public benchmark citation rate.

What this adds to the original P0-P2 plan:

- P0-P2 create the artifact and prove it is useful.
- P3 makes it deployable in the environments customers actually run.
- P4 makes it buyable and extensible by enterprises and ecosystems.
- P5 makes the whole system improve faster than competitors can copy.

## Critical Additions From The Original Research V4

This section captures remaining high-priority material from the original research that should not be lost, but that is too cross-cutting to fit cleanly inside one build packet.

### Publication And Moat Boundary

Kolm should publish enough to define the category and recruit serious ML talent, but not enough to give away the private compounding loop.

Publish:

- K-Score math and public calculator;
- benchmark protocol and fixture schemas;
- `.kolm` artifact receipt format;
- conformance test harnesses;
- negative results and known limitations;
- paper-quality descriptions of TAAS, confidence routing, and distillation-aware quantization.

Keep private:

- longitudinal customer failure clusters;
- private holdout sets;
- student genome outcomes by workload;
- teacher reliability priors;
- activation and KV telemetry from production distillation runs;
- conversion economics and procurement objections by segment;
- private calibration maps between K-score, human preference, and revenue.

Operating rule:

- if a paper cannot ship a product primitive, it is academic drift;
- if a product primitive cannot produce publishable evidence, it is not technical leadership;
- if a public claim depends on private data, the public claim must state the scope and use an auditable proxy.

### Category Control And Standardization Strategy

The category should not be "AI gateway," "fine-tuning platform," "observability," or "model marketplace." Those are partial categories.

Kolm's category should be:

- evidence-to-artifact compiler for production AI;
- owned AI behavior plus proof;
- portable task intelligence with reproducible evidence.

Standardization path:

1. Publish the `.kolm` receipt and artifact-passport vocabulary.
2. Publish a conformance suite that any runtime can pass.
3. Publish K-Score scorecard format and public fixtures.
4. Publish registry listing and comparable-trust metadata.
5. Submit the format to a neutral process only when internal contracts are stable.

Failure mode:

- do not standardize too early around unstable internals.
- do not make the standard dependent on Kolm-hosted services.
- do not let the hosted registry become the only valid implementation.

### Benchmark Protocol Pack

The original research treated benchmarks as a product, not a marketing page. The consolidated roadmap must preserve that.

Required benchmark protocols:

- K-Score human alignment benchmark;
- student architecture search benchmark;
- calibrated routing benchmark;
- runtime profile benchmark;
- RAG and evidence benchmark;
- red-team and security benchmark;
- agent tool benchmark;
- artifact economics benchmark.

Each benchmark must include:

- dataset or fixture hash;
- model and artifact versions;
- hardware and runtime profile;
- scoring code version;
- confidence interval or uncertainty estimate;
- failure examples;
- cost and latency;
- date and freshness window.

Anti-gaming rule:

- no metric can become a public headline until it has a gaming sentinel, held-out task class, and documented failure case.

### Metric Anti-Gaming And Causal Control

Metrics must move because the product got better, not because the measurement was easier to optimize.

Metric control requirements:

- every invention maps to a causal metric DAG;
- every metric has an owner, countermetric, and review cadence;
- every experiment has a kill criterion before it starts;
- every launch has a shadow period or canary unless risk is trivial;
- every public metric has a freshness date and scope label.

Countermetrics:

- cost savings must be checked against quality loss, latency, safety, and fallback rate;
- K-score lift must be checked against overfitting, held-out failure rate, and human disagreement;
- portability must be checked against target-specific quality delta;
- registry conversion must be checked against unverified artifact adoption;
- procurement speed must be checked against unsupported compliance claims.

Decision rule:

- if a metric improves while the countermetric regresses past its floor, the invention is not shipped.

### Sales, ROI, And Pricing Truth

The website, ROI calculator, pricing page, backend plans, account billing state, and sales collateral must all use the same economic model.

Required economics:

- cost per successful task, not just cost per token;
- teacher-call deferral value;
- artifact reuse value across teams;
- cost of fallbacks and escalations;
- cost of reviewer labels;
- deployment and support cost;
- risk-adjusted value for auditability and portability.

Pricing strategy carryover:

- free tier should create the first aha moment, not hide the product;
- Pro should monetize individual developers and small production apps;
- Team should monetize multi-user capture, distill, registry, and review workflows;
- Enterprise should monetize governance, BYOC, procurement evidence, custom support, and deployment control;
- savings-based pricing can be a future enterprise expansion model only when cost attribution is proven.

Refusal mode:

- do not promise "40 percent savings" without workload-specific assumptions, baseline spend, fallback rate, and quality floor.
- do not sell enterprise self-serve if sales review, security review, or custom terms are required.

### Reliability And Incident Learning Loop

Reliability is not only uptime. For Kolm it means the artifact, route, evaluator, deployment, and evidence chain are behaving as expected.

Incident classes:

- route chose wrong provider or student;
- artifact output regressed;
- runtime target degraded;
- structured output failed validation;
- eval passed but production users disagreed;
- capture data was stale, poisoned, or rights-ineligible;
- registry listing was outdated;
- procurement claim became stale.

Required incident packet:

```json
{
  "incident_id": "inc_...",
  "class": "artifact_regression",
  "artifact_id": "art_...",
  "first_seen": "2026-05-24T00:00:00Z",
  "detected_by": "runtime_monitor",
  "blast_radius": {
    "namespaces": 2,
    "runs": 913
  },
  "root_cause": "distill_holdout_gap",
  "repair_action": "add_failure_cluster_to_active_learning_queue",
  "evidence_ids": ["ev_..."]
}
```

Product loop:

- every incident should become either a test, benchmark fixture, routing rule, eval threshold, docs warning, or product kill criterion.

### Security And Abuse-Resistance Compiler

Kolm should not bolt security onto the side. Security needs to compile into the artifact and run receipt.

Required security compiler outputs:

- attack surface inventory;
- prompt and context poisoning detector;
- jailbreak and policy-bypass benchmark;
- membership and memorization risk scan;
- tool privilege escalation checker;
- tenant security policy compiler;
- abuse-rate circuit breakers;
- security evidence export for procurement.

High-priority distinction:

- "safe output" is not enough.
- Kolm must know whether the capture, teacher, student, route, context, tool call, runtime, and registry listing are safe enough for the declared task.

### Agentic Control Plane

Agent workflows need their own proof layer because agent failure is not just bad text. It can be wrong tool use, privilege escalation, memory poisoning, unbounded autonomy, or silent state mutation.

Agent packet requirements:

- tool receipt for every external effect;
- delegated authority scope;
- memory provenance;
- inter-agent message attestation;
- tool-risk K-score;
- replayable incident pack;
- circuit breaker for rogue behavior;
- policy diff when permissions change.

Account UI requirement:

- agent activity should show task, tool, authority, evidence, and rollback/compensation status in one timeline.

Refusal mode:

- never call an agent "auditable" if only final messages are stored.

### Context, Retrieval, And Knowledge Moat

Kolm's distillation story must handle RAG, memory, and customer knowledge systems, because many valuable AI tasks are not contained in prompts alone.

Required capabilities:

- rights-aware ingestion compiler;
- citation-preserving distillation dataset;
- retrieval failure corpus;
- context staleness detector;
- GraphRAG/community memory builder;
- knowledge artifact passport;
- retrieval-to-student transfer planner.

Moat rule:

- customer documents do not become Kolm's owned moat.
- allowed aggregate failure signatures, retrieval patterns, citation gaps, and calibration priors can become a privacy-scoped moat.

### Hardware Procurement And Device Economics

The "enterprise models down to any device" product surface needs an economic planner, not just runtime adapters.

Planner inputs:

- target task mix;
- expected call volume;
- latency floor;
- offline requirement;
- privacy requirement;
- device fleet distribution;
- power and thermal constraints;
- fallback cloud budget;
- supportability tier.

Planner outputs:

- recommended target devices;
- expected cost per successful task;
- memory and quantization ladder;
- runtime target passport;
- deployment support risk;
- purchase or cloud-deferral ROI.

Failure mode:

- do not recommend hardware if the artifact lacks target smoke evidence.

### Vertical Wedge Selection

Vertical foundation students should be selected by evidence density, willingness to pay, repeatability, regulation pressure, and fallback economics, not by market size alone.

Selection criteria:

- high repeated-task volume;
- expensive frontier-model baseline;
- clear success metric;
- tolerable data-rights boundary;
- buyer cares about auditability;
- local or edge deployment creates real value;
- failure examples can be captured and improved.

Initial vertical candidates:

- healthcare administration and payer workflows;
- insurance claims and underwriting support;
- financial compliance review;
- customer support automation;
- manufacturing quality and maintenance;
- legal and contract operations.

Do not pursue a vertical if:

- success cannot be scored;
- data rights are unclear;
- the workflow changes too quickly to distill;
- expert review is unavailable;
- the buyer only wants a chatbot.

### 90-Day Execution Doctrine

The first 90 days should reduce ambiguity, not maximize wave count.

Must ship:

- one public artifact passport demo;
- one K-Score public calculator;
- one distill-readiness account flow;
- one runtime passport target matrix;
- one enterprise assurance export;
- one ROI calculator tied to real assumptions;
- one registry listing with comparable trust;
- one live customer or design-partner case study;
- one benchmark report with raw fixture outputs.

Must not ship:

- broad "best AI compiler" claims;
- fake enterprise self-serve;
- unsupported "run anywhere" copy;
- unscoped savings claims;
- benchmark charts without raw methods;
- agent audit claims without tool receipts.

Success criterion:

- a technical buyer should understand within five minutes how Kolm turns repeated AI usage into an owned, evaluated, deployable artifact, and should be able to verify at least one claim without talking to sales.

## Critical Additions From The Original Research V5

The V4 layer retained strategic doctrine. This V5 layer retains the highest-priority named mechanisms that were still underrepresented after comparing the original research headings and term coverage against the consolidated blueprint.

### Continuous Background Distillation

This is the killer product loop from the original roadmap: Kolm should continuously observe approved production traffic, detect repeated stable tasks, and propose or refresh owned artifacts without waiting for a manual project.

Product definition:

- capture qualified task behavior;
- cluster repeated workflows;
- detect when enough evidence exists for an artifact;
- propose a distillation plan;
- run shadow evaluation;
- promote only when quality, cost, latency, safety, privacy, and rollback gates pass.

Contract:

```json
{
  "type": "kolm.continuous_distill_candidate.v1",
  "namespace_id": "ns_...",
  "task_cluster_id": "tc_...",
  "evidence_window": {
    "first_seen": "2026-05-01T00:00:00Z",
    "last_seen": "2026-05-24T00:00:00Z",
    "eligible_calls": 12840
  },
  "expected_lift": {
    "cost_delta": -0.42,
    "latency_delta": -0.31,
    "teacher_deferral_rate": 0.74
  },
  "risk": {
    "privacy_scope": "workspace_only",
    "critical_failure_floor": 0.0,
    "fallback_required": true
  },
  "next_action": "shadow_distill"
}
```

Implementation notes:

- never train from traffic until the rights graph allows it;
- prioritize clusters by value of information, not raw volume;
- expose candidate artifacts in account as "ready to compile," "needs labels," "needs more traffic," or "blocked by rights";
- tie every candidate to ROI assumptions and a refusal policy.

Smoke test:

- simulate two high-volume clusters where one has eligible data rights and one does not; only the eligible cluster can create a distillation candidate.

### AI Reliability Compiler

The original research correctly argued that AI reliability cannot be reduced to uptime. A response can be fast and HTTP-successful while being wrong, stale, unsafe, costly, unreplayable, or routed to the wrong model.

Kolm should compile a `ReliabilityIR` for every artifact and route.

Required reliability dimensions:

- request success;
- p50, p95, and p99 latency;
- cost per successful task;
- K-Score floor;
- critical failure rate;
- refusal correctness;
- citation faithfulness;
- route correctness;
- fallback rate;
- context freshness;
- privacy block rate;
- security probe pass rate;
- reproducibility pass rate;
- rollback readiness.

Contract:

```json
{
  "type": "kolm.reliability_ir.v1",
  "artifact_id": "art_...",
  "route_id": "route_...",
  "risk_tier": "regulated",
  "slos": {
    "k_score_floor": 0.91,
    "critical_failure_rate_max": 0.001,
    "p95_latency_ms_max": 900,
    "cost_per_successful_task_max": 0.012
  },
  "rollout": {
    "mode": "shadow_then_canary",
    "max_initial_traffic_percent": 5,
    "rollback_policy_id": "rb_..."
  },
  "incident_replay_required": true
}
```

Product requirements:

- status pages must show AI behavior degradation, not just infrastructure outage;
- enterprise reliability exports must include artifact-specific SLOs, incident replay, rollback evidence, provider drift, and open dependencies;
- quality and cost error budgets must page or roll back just like latency budgets.

Smoke test:

- provider quality drifts while HTTP status remains green; reliability compiler must mark route degraded and block savings claims for that slice.

### Formal Compiler And Proof Obligations

Kolm should not claim every model behavior is formally proven. The better frontier is proof obligations: every compilation, route, quantization, runtime profile, rights choice, and claim should emit the proof it requires and the evidence that satisfies it.

Proof obligation classes:

- format validity;
- signature validity;
- rights eligibility;
- data retention eligibility;
- evaluation coverage;
- K-Score threshold;
- route fallback safety;
- runtime target compatibility;
- quantization safety;
- structured output validation;
- tool permission safety;
- rollback path;
- claim scope.

Contract:

```json
{
  "type": "kolm.proof_obligation_set.v1",
  "artifact_id": "art_...",
  "obligations": [
    {
      "id": "po_runtime_target_webgpu",
      "class": "runtime_target_compatibility",
      "required": true,
      "status": "satisfied",
      "evidence_id": "ev_..."
    },
    {
      "id": "po_public_savings_claim",
      "class": "claim_scope",
      "required": true,
      "status": "unsatisfied",
      "blocking_reason": "no_public_benchmark_for_workload"
    }
  ]
}
```

Implementation rule:

- unsupported proof obligations should block promotion, public claims, or target badges depending on severity.
- "unknown" is a valid engineering state and an invalid marketing claim.

Smoke test:

- compile an artifact without quantization safety evidence; artifact can remain experimental but cannot receive production target badge.

### Mechanistic Feature Evidence And Causal Repair

The original research included a strong but under-retained idea: distillation should eventually preserve not only outputs, but critical internal features where measurement is possible.

Use this carefully:

- open models may expose activations and sparse feature probes;
- closed model teachers often cannot provide internal features;
- feature evidence is not full explanation;
- feature labels are not legal explanations.

Mechanistic contract:

```json
{
  "type": "kolm.mechanistic_features.v1",
  "artifact_id": "art_...",
  "activation_sites": ["layer_12.mlp", "layer_18.attn"],
  "sparse_features": [
    {
      "feature_id": "feat_refusal_boundary",
      "evidence": "causal_patch_and_random_baseline",
      "teacher_strength": 0.83,
      "student_strength": 0.79,
      "quantized_strength": 0.77
    }
  ],
  "feature_consistency": {
    "critical_features_preserved": true,
    "regression_blocks_promotion": true
  }
}
```

Product use:

- block quantization or layer skipping when critical safety, citation, domain vocabulary, or tool-schema features degrade;
- include feature-regression warnings in safety reports;
- use mechanistic failure clusters to guide active learning and teacher selection.

Smoke test:

- student passes average K-Score but loses a refusal-boundary feature under quantization; promotion must block until rerun, fallback, or waiver.

### Research Evidence OS

The autonomous research lab needs operational mechanics, not just ambition.

Retained mechanisms:

- experiment type system;
- multi-fidelity planner;
- cost-aware Bayesian scheduler;
- causal metric DAG;
- counterfactual K-Score estimator;
- safe policy improvement gate;
- anytime-valid research monitor;
- benchmark anti-gaming sentinel;
- negative result bank;
- active label acquisition engine;
- reproducibility capsule;
- claim promotion gate;
- research debt ledger;
- automated replication agent;
- research-to-code compiler;
- data rights firewall.
- enterprise outcome instrumentation;
- model and runtime interaction matrix.

Minimum experiment contract:

```json
{
  "type": "kolm.experiment_contract.v1",
  "hypothesis": "distillation-aware quantization preserves regulated refusal quality at lower memory",
  "target_metric": "memory_peak_mb",
  "guardrail_metrics": ["k_score", "critical_failure_rate", "refusal_correctness"],
  "minimum_detectable_effect": -0.15,
  "stopping_rule": "anytime_valid",
  "required_replication": "new_seed_and_private_holdout",
  "claim_scope_if_successful": "local_benchmark_claim"
}
```

Important requirement:

- repeated peeking must not create false wins; use confidence sequences, e-values, or explicit alpha-spending policy for long-running experiments.

Smoke test:

- an experiment checked 100 times cannot report fixed-horizon significance unless the monitor says the evidence is peeking-safe.

### Failure-To-Feature Roadmap Loop

Production failures should become roadmap items automatically.

Loop:

1. Capture incident or near miss.
2. Classify product-owned failure type.
3. Cluster against prior failures.
4. Map to artifact, route, runtime, eval, context, tool, or UI surface.
5. Estimate metric impact and customer value.
6. Generate a regression fixture.
7. Generate an implementation packet.
8. Verify the repair.
9. Update benchmark, docs, and claim scope.

Contract:

```json
{
  "type": "kolm.failure_to_feature.v1",
  "failure_cluster_id": "fc_...",
  "failure_type": "context_freshness",
  "affected_surfaces": ["runtime", "account", "enterprise_export"],
  "generated_fixture_id": "fix_...",
  "recommended_build_packet": "context_freshness_slo",
  "expected_metric_lift": {
    "critical_failure_rate": -0.004,
    "support_ticket_rate": -0.12
  }
}
```

Smoke test:

- recurring citation failures must produce a regression fixture and roadmap packet, not just support tickets.

### Shadow Promotion And Device-Fleet Rollouts

The original research repeatedly emphasized shadow mode and cohort-specific promotion. This must remain explicit for any-device claims.

Promotion ladder:

1. offline fixture;
2. private holdout;
3. synthetic counterexamples;
4. local runtime smoke;
5. device cohort shadow;
6. canary by tenant and task class;
7. progressive rollout;
8. full promotion;
9. background monitoring.

Device-specific requirements:

- cold start;
- memory peak;
- battery cost;
- thermal throttling;
- offline policy state;
- cache size;
- model load time;
- local fallback;
- privacy mode;
- rollback path.

Smoke test:

- an artifact that passes desktop WebGPU but fails mobile memory cannot be marketed as mobile-ready.

### Runtime Cost Attribution And Margin Compiler

The ROI story requires exact cost attribution, otherwise savings claims become fragile.

Cost ledger dimensions:

- teacher calls;
- student calls;
- routing decisions;
- retries;
- fallback calls;
- cache hits;
- retrieval fanout;
- GPU seconds;
- CPU seconds;
- object storage;
- egress;
- human review;
- incident cost;
- support cost.

Contract:

```json
{
  "type": "kolm.runtime_cost_attribution.v1",
  "task_cluster_id": "tc_...",
  "baseline": {
    "cost_per_successful_task": 0.041
  },
  "kolm": {
    "cost_per_successful_task": 0.018,
    "teacher_calls": 102,
    "student_calls": 8190,
    "fallback_calls": 211,
    "review_cost": 19.4
  },
  "savings_claim_allowed": true,
  "claim_scope": "customer_private"
}
```

Smoke test:

- ROI calculator cannot report savings if fallback and review costs are omitted.

### Kernel Marketplace And Hardware Co-Design

The original research had an important runtime moat: a kernel marketplace and device-specific profile economy. This is additive to normal runtime adapters.

Product shape:

- runtime profile identifies bottleneck;
- compiler recommends kernel or quantization profile;
- kernel package declares hardware class, precision, memory envelope, K-Score risk, and license;
- device smoke proves target fit;
- registry ranks kernels by proof, not vendor claim.

Contract:

```json
{
  "type": "kolm.kernel_profile.v1",
  "kernel_id": "kern_...",
  "target": "mobile_npu",
  "supports": ["int4_weight", "int8_activation", "sparse_attention"],
  "risk": {
    "k_score_delta": -0.008,
    "critical_feature_loss": false
  },
  "benchmarks": {
    "latency_delta": -0.37,
    "memory_delta": -0.44,
    "energy_delta": -0.29
  }
}
```

Smoke test:

- kernel improves latency but harms critical feature evidence; marketplace listing must mark it unsafe for that task.

### Ecosystem Standard Packet

The standardization packet should be concrete enough that an external implementer can rerun claims.

This is also the network-effect compiler: every new conformant artifact, runtime, loader, scorecard, registry listing, and proof packet should make every other participant's search, comparison, deployment, and procurement workflows more valuable.

Packet contents:

- RFC;
- manifest schema;
- media types;
- model card;
- data card;
- K-Score card;
- conformance suite;
- example artifact;
- signature and provenance examples;
- registry metadata examples;
- limitations;
- compatibility policy;
- governance proposal.

Smoke test:

- external reviewer cannot parse, verify, and run the example artifact from the packet alone; standard packet fails.

### Security Moat Compiler

The security moat is not a generic checklist. It is the accumulated ability to turn attack traces, abuse probes, prompt-injection failures, memory poisoning, tool misuse, and tenant policy differences into reusable compiled controls.

Moat inputs:

- red-team fixtures;
- attack surface inventories;
- prompt and context poisoning traces;
- tool privilege failures;
- abuse-rate patterns;
- incident replay packs;
- policy-as-code decisions;
- procurement evidence packets.

Moat outputs:

- safer default artifact policies;
- better security K-score slices;
- reusable red-team benchmarks;
- route-level security gates;
- registry trust penalties;
- enterprise-ready evidence exports.

Smoke test:

- a new prompt-injection incident is closed as a one-off support ticket; security moat compiler fails because no fixture, policy patch, or registry signal was generated.

### Agent Registry Trust Rank

Agent and tool artifacts need different ranking than simple model artifacts because failure can mutate external systems.

Trust rank factors:

- tool permission specificity;
- delegated authority scope;
- tool receipt coverage;
- memory provenance;
- sandbox status;
- incident history;
- rollback or compensation path;
- human approval requirements;
- policy diff history;
- registry proof completeness.

Smoke test:

- an agent with many downloads but vague tool permissions cannot outrank a lower-download agent with complete receipts and scoped authority.

### Context Compiler And Citation-Preserving Distillation

The original research's context compiler should be retained as a first-class path because many valuable enterprise artifacts depend on retrieval and memory.

Required components:

- rights-aware ingestion compiler;
- context freshness SLO;
- retrieval failure corpus;
- citation-preserving distillation dataset;
- GraphRAG/community memory builder;
- retrieval-to-student transfer planner;
- context BOM;
- permission-sync monitor.

Smoke test:

- artifact answer cites a stale or revoked document; context compiler must block answer or route to fallback.

### Additive Roadmap Merge Rule

The user's roadmap has many W707-W835 items, some shipped, some in flight, and some superseded. The research doc should treat that roadmap as additive, not contradictory.

Merge rule:

- if a wave is superseded, preserve the underlying capability as a subcomponent of the canonical wave;
- if a wave overlaps a packet, attach it as implementation detail, not duplicate product strategy;
- if a wave is infrastructure and another is UX, keep both but bind them to one product outcome;
- if a wave creates a claim, attach it to the claim gate;
- if a wave creates runtime behavior, attach it to runtime passport and reliability IR;
- if a wave creates research evidence, attach it to the research evidence OS.

Examples:

- confidence-aware routing belongs to route decision receipts, conformal abstention, and reliability IR;
- active learning belongs to expert review, research evidence OS, and continuous background distillation;
- speculative decoding belongs to runtime passport, kernel marketplace, and reliability budgets;
- drift detection belongs to calibration monitor, provider degradation detector, and claim freshness;
- A/B testing belongs to experiment guardrail compiler and anytime-valid monitoring;
- marketplace expansion belongs to comparable trust, standard packet, and registry federation.

### V5 Source Alignment

External standards and primary references to keep attached to this layer:

- OpenTelemetry GenAI semantic conventions: `https://opentelemetry.io/docs/specs/semconv/gen-ai/`
- The Update Framework specification: `https://theupdateframework.github.io/specification/latest/`
- SLSA provenance specification: `https://slsa.dev/spec/v1.1/provenance`
- in-toto specifications: `https://in-toto.io/specs`
- CycloneDX AI/ML-BOM capability: `https://www.cyclonedx.org/capabilities/mlbom`
- SPDX AI profile: `https://spdx.github.io/spdx-spec/v3.0.1/model/AI/AI/`
- NIST AI Risk Management Framework: `https://www.nist.gov/itl/ai-risk-management-framework`
- C2PA technical specification: `https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html`
- Transformer Circuits mechanistic interpretability research: `https://transformer-circuits.pub/`

## Final Consolidated North Star

Kolm wins if every repeated AI workflow can move through this path:

1. Start as a normal model API call.
2. Route through Kolm without rewriting the app.
3. Capture approved behavior as evidence.
4. Convert the repeated task into a task contract.
5. Distill a smaller specialist from the best teacher evidence.
6. Quantize and profile it for the target runtime.
7. Gate it with K-score and held-out evals.
8. Package it as a signed `.kolm` artifact.
9. Run it where the customer chooses.
10. Verify every run and improve without regression.

The product is not the gateway, the model, the eval, the registry, or the dashboard alone.

The product is the closed loop:

> rented intelligence -> captured evidence -> owned artifact -> verified runtime -> better artifact.

That is the useful core of the research document.

## Source Notes

Live site pages reviewed:

- `https://kolm.ai/`
- `https://kolm.ai/docs`
- `https://kolm.ai/pricing`
- `https://kolm.ai/quickstart`
- `https://kolm.ai/compile`
- `https://kolm.ai/k-score`
- `https://kolm.ai/legal`

Local site inventory:

- 139 `public/*.html` routes.
- Build/product routes: 20.
- Trust routes: 10.
- Vertical routes: 16.
- Runtime routes: 9.
- Compare routes: 18.
- Account routes: 6.
- Docs routes: 8.
- Pricing routes: 3.

Local product graph:

- 12 journeys.
- 7 route surfaces.
- 418 routes.
- 117 route groups.
- 69 product API routes.
- 64 CLI commands.
- 19 TUI views.
- 57 readiness requirements.
- 8 open closeout requirements.

Research corpus:

- Source file: `docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md`
- Last verified max wave before consolidation: `W14194`.
- Last verified size before consolidation: 153,079 lines, 521,676 words, 2,013 unique URLs.
