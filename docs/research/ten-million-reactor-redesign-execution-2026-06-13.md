# Ten Million Reactor Redesign Execution - 2026-06-13

## Brand Direction

Kolm should look like a buttoned-up radioactive laboratory control room: precise, enterprise-safe, dark reactor surfaces where the product is operational, pale lab paper where the buyer reads, acid green as the signal color, blue and amber as instrument states, and image 2 as the canonical API Control Center artifact.

The site should not look like a generic AI SaaS page. The visual system must make the product thesis obvious before a buyer reads deeply:

1. API behavior enters.
2. Policy and evidence gates run before interpretation.
3. A signed `.kolm` artifact is compiled.
4. Proof leaves the dashboard through receipts, GRC, SIEM, warehouse, docs, webhooks, and auditor packets.

## Competitive Bar

The current product position should synthesize the strongest pressure from the category rather than copy a single company:

- Pioneer-style continuous improvement: production failures, diagnosis, targeted supervision, retraining or compile, and regression verification.
- Cohere-style enterprise AI posture: private deployment, data control, model/tooling depth, and enterprise platform framing.
- Glean-style enterprise connectors and knowledge context: broad source coverage, permissions, graph/context, agents, governance, and APIs.
- LangChain/LangSmith-style agent lifecycle: build, test, deploy, monitor, evaluate, and debug across agent workflows.
- Vanta/Drata-style evidence expectation: externalized controls, audit trail, owner-ready proof, and verifiable readiness.

Kolm's wedge is not "better at every layer." The wedge is the governed source-to-proof transition across those layers.

## Execution This Pass

- Reframed the shared public CSS around the reactor-lab system instead of generic soft cards.
- Added non-home hero instrumentation rails so enterprise/docs/platform pages feel authored, not template-cloned.
- Added instrument top bars to cards, panels, docs links, product tiles, pricing cards, and proof cards.
- Upgraded `surface-table` rows into ledgers with hover-visible control rails.
- Preserved image 2 as the homepage product artifact and kept the mobile first viewport clean.
- Regenerated control ledgers after the CSS change.

## Acceptance Gates

This pass is acceptable only when the visual work and product contracts both hold:

- 20-route UI audit passes across desktop and mobile with no failures or warnings.
- Static/product contract tests pass.
- Claims remain readiness-gated and do not imply public benchmark, certification, package, partner, or standards claims without evidence.
- Static refs and product surfaces resolve.
- Deep local surface smoke passes all product surfaces.
- Control-file ledgers are regenerated and verify cleanly.

## Remaining Release Blocker

Full release verification still cannot honestly pass the demo evidence gate because the checked-in public benchmark fixtures required by `scripts/capture-demo-timeline.mjs` are absent:

- `public/benchmarks/sota-quantize-matrix.json`
- `public/benchmarks/trinity-500-benchmark.json`
- `public/benchmarks/wave887-wrapper-prod-benchmark.json`

There are related benchmark outputs under `benchmarks/`, but they are not the exact public evidence fixtures the verifier requires. Do not fabricate these files. The correct next step is to either restore the original public evidence fixtures or rerun the benchmark pipelines and emit verifier-compatible public fixtures.
