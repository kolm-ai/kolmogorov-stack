# Kolm Master Spec Consolidated Review

Date: 2026-05-25

Audience: internal implementation agents only. This is not customer-facing documentation, not website copy, and not an external roadmap.

Primary source reviewed: `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md`

Spec index: `docs/research/kolm-internal-spec-index-2026-05-25.md`

Purpose: consolidate the useful parts of the master research/spec document into an operational version that an implementation agent can follow without reading 30,000+ lines every time.

Primary code-finish redline: `docs/research/kolm-100-percent-finished-code-redline-2026-05-25.md`

## Verdict

The research doc is useful, but not yet efficient.

As a full institutional memory and requirements archive, it is strong: 8/10. It captures the product ambition, current repo evidence, route/product surfaces, UI/UX redlines, backend proof gates, release evidence, catalog truth, wave governance, research inventions, and production proof requirements in one place.

As a daily execution document, it is overloaded: 5/10. It is 3,116,328 bytes, 30,902 lines, 75 H3 sections, 501 H4 sections, roughly 2,069 ticket rows, and 83 schema snippets. That scale makes it hard for an implementation agent to know what to do next, what is canonical, what is historical, what is duplicated, and what actually blocks release today.

The right model is:

- Keep the large blueprint as the evidence archive.
- Use this consolidation as the operating spine.
- Generate smaller per-node implementation packets from the large blueprint.
- Do not keep adding V4/V5/V6 addenda unless they collapse into a registry, packet, or verifier.

## What The Research Doc Does Well

| Strength | Why it matters |
|---|---|
| It preserves the full product ambition. | Kolm is not just "one AI API"; it has three core product surfaces: route/capture, distill/compile, and run/govern. The document keeps that broader shape alive. |
| It ties strategy to repo evidence. | Many sections reference actual files, scripts, tests, docs, generated outputs, screenshots, and dirty-tree state rather than generic advice. |
| It separates local proof from production proof. | This is critical. Local green tests, screenshots, and backend gates do not prove `https://kolm.ai` is finished. |
| It is honest about external gates. | Certifications, public benchmarks, package releases, standards adoption, and partner runtime support cannot be marked shipped just because local scaffolding exists. |
| It names cross-product dependencies. | Provider catalog, product graph, readiness closeout, wave registry, API docs, account UX, production evidence, and visual proof are all shared control planes. |
| It captures the UI/UX complaints in enforceable language. | Nav underlines, popouts, buttons, fonts, color drift, paragraph sprawl, weak media, account UX, and light-mode breakage are treated as product defects, not taste. |
| It gives future agents write targets. | The tickets are often concrete enough to become implementation work orders. |

## Where The Research Doc Is Weak

| Weakness | Impact | Consolidation decision |
|---|---|---|
| Too large for daily use. | Agents will skim, miss blockers, or duplicate work. | Use this document as the short operating layer. |
| Too many addenda per node. | V2/V3/V4/V5 layers blur what is canonical. | Latest addendum wins unless superseded by a generated registry or packet. |
| Ticket count is too high. | Thousands of rows make priority invisible. | Collapse into P0 release blockers, P1 product strengtheners, and P2 scale/market work. |
| Not enough machine-readable registries yet. | The doc says what should exist, but many control files are still absent. | Prioritize building registries and verifiers over more prose. |
| Some sections repeat similar redlines. | Production proof, visual proof, claim scope, and clean tree appear many times. | Consolidate these into shared gates. |
| It mixes "research idea", "local implementation", "production shipped", and "external proof" in long prose. | Makes it easy to overclaim. | Every item needs a state: research, local, integrated, production, external-gated, superseded, killed. |
| Some evidence is snapshot-specific. | Counts and dirty files change quickly. | Snapshot evidence should live in generated reports; the doc should name required reports. |
| It is not yet a build system. | Reading it does not itself verify completion. | Convert key sections into scripts, schemas, packets, and failing gates. |

## Canonical Product Shape

Kolm should be described and built around three product surfaces:

| Surface | Plain-language outcome | What must be visible in product |
|---|---|---|
| Route and capture | Route existing model API calls and capture the behavior worth keeping. | OpenAI-compatible swap, provider readiness, capture logs, duplicate spend/cost view, `.kolm` preview. |
| Distill and compile | Turn frontier behavior into smaller specialist models with evals, K-Score, and signed artifacts. | Teacher/student strategy, distill job, K-Score report, failure modes, benchmark scope, artifact signature. |
| Run and govern | Run signed artifacts across cloud, BYOC, edge, mobile, local, browser, and auditors. | Runtime matrix, device fit, storage readiness, deployment receipt, audit export, account readiness. |

Anything that only explains "one AI API" is incomplete. Anything that only explains "AI compiler" without showing route/capture and run/govern is also incomplete.

## Consolidated Release Blockers

These are the blockers that matter most for getting the entire codebase to a real finish line.

| Rank | Blocker | Why it blocks 100 percent completion | Evidence required |
|---:|---|---|---|
| 1 | Clean-tree release control | Multiple agents are editing shared files. A dirty tree cannot prove finality. | Clean or intentionally scoped git status, lane locks, generated-artifact sequence, release packet. |
| 2 | Production evidence packet | Deploying is not proof. The live domain must match the exact commit, generated files, env, smoke, screenshots, telemetry, and rollback target. | Node 29 V4 packet, prod public smoke, prod auth smoke, prod screenshots, rollback proof. |
| 3 | Product-experience packet | The website cannot be "state of the art" while CSS, nav, media, account UX, and copy are patched by many layers. | Node 30 V3 packet, dark/light desktop/mobile screenshots, manual-use pass, accessibility, Core Web Vitals. |
| 4 | Wave registry | W-numbered roadmap work, tests, and agents need one canonical registry to avoid duplicate or contradictory implementation. | `docs/wave-registry.json`, schema, reconcile report, active lane locks, wave packets. |
| 5 | Catalog manifest | Provider/model/runtime/pricing/device facts are high-churn and affect every product promise. | `docs/catalog-manifest.json`, freshness report, provider/runtime/device smoke, consumer parity. |
| 6 | Codebase redline | The repo has many files, generated outputs, historical artifacts, and large source files. Completion requires path ownership. | File ledger, generated/source/archive classification, large-file review, clean root, build graph proof. |
| 7 | Account matrix UX | Post-auth account pages must cover the full product matrix, not just audits or marketing cards. | Account feature matrix, route screenshots, loading/empty/error/partial states, auth smoke. |
| 8 | Claim-scope compiler | Public copy must not claim external-gated items as shipped. | Claim scanner, readiness closeout, benchmark/package/certification gates, release-copy diff. |
| 9 | Test architecture and deterministic QA | Current gates are large and useful, but final completion needs mapped coverage by requirement. | Test inventory, wave/test mapping, flake policy, fixture ownership, release evidence graph. |
| 10 | Docs and first-value paths | Docs must help developers get value quickly and stay aligned with API/CLI/SDK/account truth. | Runnable quickstarts, API reference parity, SDK examples, docs screenshots, link/ref lint. |

## The Execution Spine

The large blueprint should collapse into these operating systems.

| Operating system | Owns | Must generate |
|---|---|---|
| Product truth spine | Product graph, journeys, readiness, closeout, claims | `public/product-graph.json`, readiness closeout, claim-scope report |
| Visual/product experience | Public site, docs shell, account UX, nav, CSS, media, demos | Product-experience packet, design cascade ledger, media manifest, screenshots |
| Backend/API contract | Routes, schemas, envelope, OpenAPI, SDK compatibility | API route inventory, OpenAPI, schema tests, route ownership report |
| AI capability proof | Capture, distill, compile, K-Score, runtime, artifact quality | Eval reports, benchmark evidence, artifact receipts, K-Score calibration |
| Catalog truth | Providers, models, pricing, runtimes, devices, hardware | Catalog manifest, freshness report, provider/runtime/device smoke |
| Release and production proof | Deploy targets, env parity, prod smoke, rollback, telemetry | Production evidence packet, deploy archive, DORA/release metrics |
| Wave execution governance | Roadmap, agents, generated artifacts, evidence retention | Wave registry, lane locks, wave packets, reconcile report |
| Codebase redline | File ownership, generated/source/archive boundaries, clean git | File ledger, path quarantine report, build graph, clean release certificate |
| Security/legal/trust | Auth, tenancy, provider terms, compliance, safety | Trust packet, control evidence, red-team results, legal/provider usage map |
| Customer lifecycle | Signup, onboarding, billing, support, enterprise sales | Lifecycle state map, account states, support/incident workflows |
| Discovery/content | SEO, AI discovery, docs IA, structured data, content graph | Sitemap/metadata/llms/ai-context report, content freshness report |
| Demo/media proof | Homepage demo, runner, video, proof visuals, social assets | Demo manifest, media QA, transcripts, production demo smoke |

## What To Build Next

The doc should stop growing until the following files or equivalent generated packets exist.

Implementation detail for these files is separated into `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md`; build sequence and existing-script reuse details are in `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`.

| Priority | Artifact | Purpose |
|---|---|---|
| P0 | `docs/wave-registry.json` | Single canonical state for every W-numbered wave, duplicate, roadmap item, and invention. |
| P0 | `docs/wave-registry.schema.json` | Mechanical validation of wave ownership, proof, state, and claim scope. |
| P0 | `docs/active-lanes.json` | Prevent concurrent frontend/backend/research/CLI/spec collisions. |
| P0 | `docs/design-cascade-ledger.json` | Classify CSS systems, runtime visual guards, raw colors, `!important`, and negative tracking. Seed: `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`. |
| P0 | `docs/product-media-proof.json` | Prove every product image, video, demo, and screenshot is real, useful, accessible, and theme-safe. Seed: `docs/research/kolm-product-media-proof-seed-2026-05-25.md`. |
| P0 | `reports/deployments/<release-id>/production-evidence.json` | Tie live `kolm.ai` proof to commit, deploy, env, smoke, screenshots, rollback, and telemetry. |
| P0 | `docs/catalog-manifest.json` | Single provider/model/runtime/device/pricing truth source. |
| P0 | `docs/codebase-file-ledger.json` | Source/generated/archive/scratch ownership for every path. |
| P0 | `docs/product-feature-completion-matrix.json` | Journey, route, account, docs, CLI, TUI, UI/UX, and production proof ownership for every product feature. Seed: `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md`. |
| P0 | `reports/build-redline/final-build-redline.json` | Final clean-tree, generated-artifact, test, smoke, UI, and production release certificate. |
| P1 | `docs/account-product-matrix.json` | Post-auth account coverage for every product feature and state. Seed: `docs/research/kolm-account-product-matrix-seed-2026-05-25.md`. |
| P1 | `docs/page-family-contracts.json` | First-screen, CTA, media, proof, copy, and accessibility rules by page family. |
| P1 | `docs/claim-copy-map.json` | Allowed/scoped/blocked product claims based on readiness and evidence. |

## Recommended Document Architecture

The large blueprint should be treated as an archive, not the only working doc.

| Document | Role |
|---|---|
| `kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | Full archival spec and evidence memory. Keep it, but stop using it as the daily work queue. |
| `kolm-master-spec-consolidated-review-2026-05-25.md` | This operating summary. Use it to decide what to build next. |
| `docs/wave-registry.json` | Canonical roadmap state. This should replace chat-based wave status. |
| `docs/catalog-manifest.json` | Canonical provider/model/runtime/device/pricing truth. |
| `reports/deployments/<release-id>/production-evidence.json` | Canonical production proof. |
| `reports/build-redline/final-build-redline.json` | Canonical "100 percent done" certificate. |

## How Useful Is The Original?

Usefulness score by use case:

| Use case | Score | Reason |
|---|---:|---|
| Long-term product memory | 9/10 | It preserves context, ambition, and many hard-earned findings. |
| Requirements discovery | 8/10 | It covers nearly every product surface and codebase branch. |
| Preventing overclaims | 8/10 | Readiness, claim scope, production proof, and external gates are repeatedly captured. |
| Daily implementation planning | 5/10 | Too large, too many tickets, too much repeated addendum structure. |
| Release decision-making | 6/10 | Strong release concepts, but needs generated packets to become evidence. |
| Onboarding a new agent | 4/10 | Too much context before action. New agents need this consolidation first. |
| Investor/product narrative | 6/10 | Contains strong insights, but buried under implementation detail. |
| Final completion audit | 7/10 | Good checklist source, but not proof until converted into registries and reports. |

## What To Keep From The Original

Keep these concepts as canonical:

- Three product surfaces: route/capture, distill/compile, run/govern.
- Product graph and readiness closeout as truth spine.
- Production evidence packet distinction between local and live proof.
- Design/product-experience packet for real UI completion.
- Wave registry and generated-artifact locks.
- Catalog manifest for provider/model/runtime/device/pricing facts.
- Claim-scope compiler and external-gated states.
- Codebase/file redline and clean-tree closure.
- Account product matrix as the post-auth operating cockpit.
- Public docs and demos as first-value proof, not marketing filler.

## What To Demote

Demote these from daily execution authority:

- Older V1/V2/V3 addenda once a newer addendum exists for the same node.
- Chat-derived wave status that is not in a registry.
- Hidden hero/test anchors as product truth.
- Static provider pricing or model facts without source dates.
- Screenshot reports from before the latest frontend/backend changes.
- Synthetic invention lift as public proof.
- Local smoke as production completion.
- "Run anywhere" or "model-agnostic" language without catalog/runtime evidence.

## Minimum 100 Percent Completion Definition

Kolm is not 100 percent complete until current evidence proves all of this:

1. Clean git or intentionally scoped release tree.
2. Generated files are current and regenerated in the right order.
3. Every product route is owned by a product surface.
4. Every product feature has account, API/CLI/docs, claim, and smoke evidence.
5. Website explains all three product surfaces in under five seconds.
6. Visual system is unified, accessible, responsive, and production-screenshotted.
7. Backend routes, schemas, errors, SDKs, and docs match.
8. Provider/model/runtime/device/pricing catalog is sourced and fresh.
9. AI capability claims have eval, benchmark, or scoped local proof.
10. External-gated claims remain scoped until external proof exists.
11. Production deploy is verified with public smoke, auth smoke, screenshots, telemetry, rollback, and status decision.
12. Final build redline packet exists and can be audited without reading chat history.

## Bottom Line

The original research doc is worth keeping. It is the full memory of what "best version of Kolm" means.

But the next phase should be less prose and more control files. The highest-value move is to convert the blueprint into registries, packets, reports, and verifiers. That is what will turn a strong research artifact into a finished codebase.
