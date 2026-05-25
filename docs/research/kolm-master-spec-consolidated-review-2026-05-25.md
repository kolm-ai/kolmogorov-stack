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
| 4 | Wave registry | W-numbered roadmap work, tests, and agents need one canonical registry to avoid duplicate or contradictory implementation. | `docs/internal/wave-registry.json`, schema, reconcile report, active lane locks, wave packets. |
| 5 | Catalog manifest | Provider/model/runtime/pricing/device facts are high-churn and affect every product promise. | `docs/internal/catalog-manifest.json`, freshness report, provider/runtime/device smoke, consumer parity. |
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

## Contract Encoding Decision

The current local codebase already answers the JSON question: Kolm should use JSON heavily, but JSON should not be the universal source of truth.

Current live tree findings:

- `package.json` declares a Node ESM JavaScript backend. There is no root TypeScript project today.
- `public/product-graph.json` is already a generated projection of the product truth spine: 12 journeys, 8 customization dimensions, 582 routes, 163 route groups, 64 CLI commands, and 32 TUI views.
- `docs/internal/codebase-file-ledger.json`, `design-cascade-ledger.json`, `product-media-proof.json`, `catalog-manifest.json`, and `wave-registry.json` are generated evidence/control projections, not handwritten product behavior.
- `src/store.js` uses JSON files for dependency-free local development and SQLite for production-like environments when available.
- `src/event-store.js` uses SQLite as the main event path and JSONL as the fallback.
- `.kolm` artifacts intentionally use inspectable JSON metadata inside a signed container.

The serious architecture is therefore:

| concern | serious authority | JSON role |
|---|---|---|
| Product vocabulary | `src/product-kernel.js` | generated product graph projection |
| Product journeys and account/site surface map | `src/product-experience.js` | generated graph/account/CLI/TUI projection |
| API behavior | route contract modules | OpenAPI and API docs projection |
| Request/response validation | JSON Schema 2020-12 schemas | schema payload and SDK projection |
| Mutable tenant/account state | database repositories and migrations | snapshots/evidence only |
| Events/audit | append-only event store and event schema modules | JSONL fallback and CloudEvents-style payload |
| Authorization | code-backed policy model, Cedar, or Rego | generated policy matrix |
| Public website/design/media proof | design tokens, page-family contracts, product media modules | ledgers and screenshot evidence |
| Artifact metadata | canonical signed artifact metadata | JSON is valid authority here because it is inspectable and hash-bound |
| Binary/runtime protocol | only use Protocol Buffers when cross-language binary compatibility is worth the complexity | debug/export projection |

Decision: every future `docs/internal/*.json` file must be classified as `generated_projection`, `human_decision_record`, `runtime_cache`, `dev_fallback_store`, or explicit schema data. It must name its source paths, generator, validator, runtime enforcer, mutability, customer visibility, and secret policy. If it cannot do that, it is not a serious control file.

The primary implementation redline for this is now in `docs/research/kolm-100-percent-finished-code-redline-2026-05-25.md` under `Master Spec Tree And Contract Encoding Redline`.

## Live Master Site And Product Spec Tree

This is the operating master spec for the live local tree as of the current pass. It replaces any framing that treats the site as a pile of pages or the product as a single "one AI API" story.

### Live Authority Snapshot

| authority | current live evidence | redline it creates |
|---|---|---|
| Product graph | `public/product-graph.json`: 12 journeys, 8 customization dimensions, 582 routes, 163 route groups, 64 CLI commands, 32 TUI views, 33 account links, 57 readiness requirements. | The graph is the center of the site/product spec; every page, route, account action, CTA, demo, docs page, and claim must point back to one journey and one proof path. |
| Product readiness | `public/product-graph.json`: 14 shipped, 35 implemented, and 8 non-local open gates across benchmark, package release, external partner, and live certification scope. `docs/readiness-gate-workorders.json`: 8 workorders. | The site and account UX must keep these gates visible. "Implemented locally" cannot become public "done" until the closeout proof exists. |
| Generated control plane | `docs/internal/`: 7 generated control files exist today: catalog manifest, codebase file ledger, design cascade ledger, product media proof, wave reconcile report, wave registry, and wave registry schema. | The first control plane is real, but incomplete. Missing matrices for feature completion, account coverage, page families, API contracts, SDK parity, docs IA, generated artifacts, production evidence, and final redline block any 100 percent claim. |
| API contract surface | `public/openapi.json`: OpenAPI `3.0.3`, 556 paths, 586 operations, 11 operations without `operationId`, 583 operations without operation-level security, and 282 mutating operations without request bodies. `public/docs/api-routes.json`: 582 routes, 163 groups, 127 source-indexed/stub routes. | API completion cannot mean "route inventory exists." Route contracts must become the authority for auth, tenancy, schemas, errors, idempotency, audit, docs, SDKs, account actions, CLI examples, and OpenAPI. |
| SDK/package surface | `public/sdk-current.json` exposes the browser bundle and SRI; the tree also contains Node, Python, Rust, C, MCP, VS Code, TypeScript, React Native, Swift, Kotlin, Python package, browser extension, LangChain, LlamaIndex, installer, and runtime packages. | SDK breadth must become generated parity: each package needs release state, route coverage, typed errors, idempotency/streaming/upload support, examples, install proof, and unsupported-operation honesty. |
| Developer docs shell | `public/docs/`: 221 HTML pages, 58 Markdown files, 28 JSON files, one `.kolm` file, and one text file. Local source pass: 48 docs HTML pages with `繚` separators, 141 pages missing `/nav.js`, 51 missing `/ks.css`, 170 missing `/surface-polish.css`, 170 style blocks, 116 inline style attributes, 569 script tags, and one hidden test anchor. `/api` says `355+ routes` and `x-kolm-api-key`; `/docs/api` says 582 routes and `Authorization: Bearer`; SDK docs claim a simple JS/Python/Rust/Go story while local SDK package docs show source-only/unpublished/name-blocked states. | Docs are product UI, not an appendix. Build a developer docs shell contract, API reference contract, docs sample contract, and SDK package truth matrix so quickstarts, API refs, SDK docs, and install commands render from route/package truth instead of stale page-local copy. |
| Account surface | `public/account/**/*.html`: 51 account HTML pages, including builds, distill, capture analytics/review, SSO, security, storage, drift, failure modes, active learning, and product overview. | Account UX must become the command center for all three product loops, not disconnected dashboards. |
| Account shell and nav | Local source pass: 51 account pages, 51 page-local style blocks, 373 inline style attributes, 142 script tags, 191 `innerHTML` writes, 44 pages missing `/nav.js`, 50 pages missing `/surface-polish.css`, 10 pages missing `account-sidebar`, and 17 pages with the bad `繚` title/separator artifact. `public/nav.js` injects account command center, product matrix, sidebar repair, chat, trust ribbon, product media, primary-nav unifier, theme/auth controls, and emergency surface guard rules. | Account finish is structural, not just visual. Build `docs/internal/account-shell-contract.json`, `account-nav-manifest.json`, `component-interaction-state-contract.json`, `ui-accessibility-performance-contract.json`, `nav-runtime-debt-ledger.json`, and `account-product-journey-state-machine.json`; then move static shell/copy/CSS repair out of runtime patching and into generated source. |
| Runtime/backend shape | `server.js` is a Node.js/Express entrypoint that mounts `src/router.js`; product logic is mainly JS modules under `src/`, with workers, services, SDKs, runtime packages, installers, and integrations outside the main router. | The master spec should describe the actual architecture: Node/Express product API plus workers/services and multi-language SDK/runtime distribution. Do not imply a different backend stack. |
| Data plane | `src/store.js` supports `json` and `sqlite`; `src/store-drivers/vercel-postgres.js` and `src/store-drivers/vercel-kv.js` exist but are not selectable by the main facade; `src/event-store.js` owns a separate typed SQLite/JSONL event plane; `src/event-schema.js` is the strongest typed row contract. | Completion needs `docs/internal/data-plane-contract.json`: all persisted rows/blobs/logs classified, driver support reconciled, generic JSON tables typed, migration/index/tenant/retention owners declared, and `/ready`/account/CLI truth aligned. |
| Env and secrets | Local scan found 378 direct `process.env.*` variables. `.env.example` is partial and still contains retired Stripe plan/price language. `src/secrets-vault.js` is a local AES-GCM vault with external secret reference intents, not full production secret-manager proof. | Completion needs `docs/internal/env-secret-contract.json`: env inventory, sensitivity, owner, default, deploy target, readiness check, rotation policy, generated `.env.example`, and a proof gate that no secret value enters public files, logs, reports, screenshots, API examples, or account UI. |
| Tenant, retention, residency | `src/auth.js` mixes tenant id/name/email flows and contains a hardcoded export-control baseline; `src/audit-retention.js` has tenant-fenced 90/365/2555 day audit retention; `src/data-residency.js` writes residency tags with `GLOBAL` as honest unknown. | Completion needs `docs/internal/tenant-data-boundary-contract.json` and `docs/internal/data-retention-backup-contract.json`: canonical tenant identifiers, all data effects for account lifecycle, legal-review ownership for sanctions, backup/restore/RPO/RTO, deletion, legal hold, and restore-drill evidence. |
| Production routing | `vercel.json`: 49 redirects, 526 rewrites, 52 account rewrites, 108 docs rewrites, and production rewrites from `/v1/*`, `/health`, and `/ready` to the Railway backend. | Production proof must verify the CDN/static app, Railway API, health/ready split, account rewrites, docs rewrites, headers, and API rewrite target for the same release ID. |
| Release evidence | `scripts/release-verify.cjs` and `scripts/prod-surface-smoke.cjs` exist, but `reports/deployments/`, `reports/build-redline/`, `production-evidence.json`, and `final-build-redline.json` do not exist. `reports/` is dominated by UI screenshot audit output. | The final ship gate must stop being local-only. It needs a production evidence packet with public/auth smokes, screenshots, readiness, telemetry, headers, rollback, provenance, and signoff. |
| Release boundary | `.gitignore` and `.vercelignore` exclude many local/scratch paths, but there is no `.dockerignore` and `Dockerfile` uses `COPY . .`. The root currently contains local agent dirs, temp dirs, screenshots, reports, backups, data, node_modules, audit output, and malformed prior test artifacts. | Completion needs `docs/internal/release-boundary-manifest.json`: exact include/exclude policy for Docker, Railway, Vercel, npm/SDK packages, CLI, extension, public static assets, and proof that local secrets/data/scratch outputs cannot enter release artifacts. |
| CI/release pipeline | `package.json` has broad local gates and `scripts/release-verify.cjs` is semantically useful, but `.github/workflows/test-suite.yml`, `lint.yml`, `smoke.yml`, `sbom.yml`, and product-template workflows do not form one required release-control plane. | Completion needs `docs/internal/ci-release-pipeline-contract.json` and `docs/internal/ci-required-checks-policy.json`: required checks by merge/RC/deploy/post-deploy phase, workflow permissions, trigger scope, runtime matrix, artifacts, retention, owners, flake policy, and skip exceptions. |
| Package/SBOM/provenance | `scripts/package-release-readiness.mjs --summary --require-local-contract` reports `ok=true publish_ready=false targets=16 structural_ok=16 pending=16 blocked=0`; all 16 package targets are missing signed registry/artifact evidence and some installer metadata still has placeholder SHA values. `sbom.yml` emits SBOM artifacts but does not bind them to a release packet. | Completion needs `docs/internal/release-artifact-evidence-matrix.json` and `docs/internal/sbom-provenance-contract.json`: per-subject SHA, SBOM, provenance, signature/attestation bundle, registry/artifact URL, local/channel checks, retention, and verification. |
| Observability | `src/otel.js` implements OTLP/HTTP export and router spans exist for some inference/routing paths. | Observability is not complete until every journey has trace/metric/log/SLO/alert/dashboard/runbook ownership and production evidence proves collector delivery without secrets or prompt leakage. |
| Public surface | `public/*.html`: 100+ top-level product, docs, comparison, trust, pricing, vertical, runtime, and demo pages. | Public IA must collapse into a few explicit page families with shared copy, CTA, media, proof, SEO, and nav contracts. |
| Design cascade | `docs/internal/design-cascade-ledger.json`: 729 public HTML pages, 19 CSS files, 3,873 CSS `!important` uses, 1,524 raw CSS hex values, 75 negative letter-spacing uses, 3,215 inline styles. | The visual system is not finished until these are converted into token/component/page-family ownership with strict exception budgets. |
| Product media | `docs/internal/product-media-proof.json`: 3,710 media refs, 0 missing local media, 4 image dimension gaps. | Existence is not enough; key pages need real product proof media, demo states, transcripts, posters, and theme-safe screenshots. |
| Catalog truth | `docs/internal/catalog-manifest.json`: 132 provider/model/device/runtime/hardware/pricing entries. | All provider/model/runtime/device/pricing copy, docs, selectors, and recommendations must consume this catalog or declare a dated exception. |
| Wave truth | `docs/internal/wave-registry.json`: 551 waves, 450 local-green states, 93 planned states, 323 test-only waves, 93 plan-only waves. | Roadmap status must stop living in chat. Every live claim must map to a canonical wave state or be removed. |
| File truth | `docs/internal/codebase-file-ledger.json`: 3,673 paths, 2,509 source paths, 228 generated paths, 569 test paths, 0 unowned paths, 24 dirty paths, 22 untracked paths. | Final completion requires a clean release tree or an explicit release inclusion/exclusion packet. |

### Three Product Loops

Kolm's public and account product must be organized around three loops. The loops share the same product graph, catalog, route contracts, account pages, docs, and proof packets.

| loop | journeys from live product graph | public pages that must lead it | account surfaces that must prove it | user-visible outcome |
|---|---|---|---|---|
| Route and capture | `gateway-capture`, `privacy-lake`, `datasets-labeling` | `index.html`, `product.html`, `capture.html`, `captures.html`, `quickstart.html`, `api.html`, `docs.html`, `pricing.html` | `/account/connectors`, `/account/captured`, `/account/lake`, `/account/privacy-events`, `/account/datasets`, `/account/labeling` | Existing provider traffic becomes owned examples, privacy-scoped logs, datasets, and cost/latency evidence. |
| Distill and compile | `datasets-labeling`, `train-distill`, `models-backbones`, `multimodal-tokenization`, `compile-verify` | `distill.html`, `compile.html`, `train.html`, `models.html`, `k-score.html`, `benchmarks.html`, `spec.html`, `runtimes.html` | `/account/builds`, `/account/builds/new`, `/account/distill-runs`, `/account/distill/new`, `/account/multimodal-bakeoff`, `/account/artifacts`, `/account/bakeoffs` | Captured behavior becomes evaluated, signed, runtime-targeted `.kolm` artifacts. |
| Run and govern | `runtime-inference`, `compute-cloud`, `devices-fleet`, `enterprise-governance`, `agents-registry` | `run.html`, `cloud.html`, `byoc.html`, `device.html`, `enterprise.html`, `security.html`, `trust.html`, `sdks.html`, `integrations.html` | `/account/devices`, `/account/storage`, `/account/api-keys`, `/account/audit-log`, `/account/billing`, `/account/settings`, `/account/agent-telemetry`, `/account/enterprise/sso`, `/account/security/2fa` | Artifacts run across cloud, BYOC, edge, browser, mobile, agents, and auditors with receipts and controls. |

### Page-Family Contracts

Every public page must belong to exactly one page family. Family membership controls nav treatment, hero density, CTA style, media requirements, structured data, docs links, and account destination.

| page family | examples in live tree | required implementation |
|---|---|---|
| Homepage/category entry | `index.html`, `why-kolm.html`, `why-now.html`, `what-is-an-ai-compiler.html` | First viewport must state the three-loop outcome, show one real product proof component, and give one primary path to demo/start. No abstract slogans without workflow proof. |
| Product loop pages | `capture.html`, `distill.html`, `compile.html`, `run.html`, `cloud.html`, `device.html`, `enterprise.html` | Each page owns one loop, one primary CTA, one proof graphic/demo, one account destination, one docs/API destination, and one readiness scope note. |
| Developer/docs pages | `docs.html`, `quickstart.html`, `api.html`, `sdks.html`, `integrations.html`, `verify-cli.html` | Docs must be generated from route/CLI/SDK contracts where possible; quickstarts must be runnable and must show expected output. |
| Trust/legal/compliance pages | `security.html`, `privacy.html`, `terms.html`, `tos.html`, `baa.html`, `dpa.html`, `soc2.html`, `slsa.html`, `sbom.html`, `threat-model.html` | Trust copy must distinguish implemented controls, local proof, production proof, and external certification gates. |
| Pricing/commercial pages | `pricing.html`, `roi.html`, `upgrade.html`, `enterprise.html`, `teams.html`, vertical pages | Pricing, plan names, CTA routing, ROI formulas, and enterprise sales states must come from commercial contract modules and dated pricing evidence. |
| Comparison/positioning pages | `vs-*.html`, `how-vs-*.html`, `compare.html` | Comparisons must map claims to product graph journeys and catalog evidence; no unsupported superiority language. |
| Vertical/use-case pages | `healthcare.html`, `finance.html`, `gov.html`, `education.html`, `nonprofits.html`, `saas.html`, `use-cases.html` | Verticals must show the same loop, adapted evidence, trust boundary, and account destination; no custom one-off product story. |
| Account cockpit pages | `public/account/**/*.html` | Every page must have loading, empty, error, partial, unauthorized, and external-gated states; every action must map to route contract, audit event, and product graph journey. |

### State-Of-Art Website Gates

These are implementation gates, not generic audit advice:

- WCAG 2.2 gate: visible focus, no hover-only controls, target sizing and spacing, consistent help, keyboard path, reduced-motion support, and meaningful headings on every page family.
- Core Web Vitals gate: measure LCP, INP, and CLS using field-capable instrumentation and screenshot/performance budgets; reserve media dimensions and eliminate unnecessary render-blocking page-local scripts.
- Structured data gate: public product pages must generate coherent `SoftwareApplication`, `WebApplication`, `Product`, `FAQPage`, `BreadcrumbList`, and organization identity JSON-LD from one metadata registry.
- OpenAPI/docs gate: API docs must be generated from route contracts and use a current OpenAPI 3.1/3.2 policy, not route scraping alone.
- Visual system gate: raw hex, `!important`, inline styles, negative tracking, and page-local style tags must have decreasing budgets and owner-approved exceptions.
- Media proof gate: every key page must have real product media or a live proof component; decorative media cannot satisfy product proof.
- Account UX gate: post-auth pages must expose all product loops, object state, readiness state, next action, and proof. Account cannot be a collection of isolated reports.
- Account shell gate: all account pages must use one generated shell, one nav manifest, one metadata separator policy, one skip-link policy, one sidebar contract, and one component-state contract. Runtime DOM repair cannot be the only reason account pages look coherent.
- Nav/runtime debt gate: `public/nav.js` must be reduced to true runtime behavior. Static product copy, page-family media insertion, source nav unification, CSS emergency rules, and account shell markup need build-time owners or explicit temporary exceptions.
- Production proof gate: local screenshots and local smokes are not enough. Final completion requires the live domain, auth state, public pages, account pages, API graph, OpenAPI, storage readiness, billing/pricing, and rollback target tied to one release id.

## What To Build Next

The doc should stop growing until the following files or equivalent generated packets exist.

Implementation detail for these files is separated into `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md`; build sequence and existing-script reuse details are in `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`.

| Priority | Artifact | Current state | Purpose |
|---|---|---|---|
| P0 | `docs/internal/wave-registry.json` | exists | Canonical state for every W-numbered wave, duplicate, roadmap item, and invention; still needs orphan/plan-only resolution. |
| P0 | `docs/internal/wave-registry.schema.json` | exists | Mechanical validation of wave ownership, proof, state, and claim scope. |
| P0 | `docs/internal/active-lanes.json` | missing | Prevent concurrent frontend/backend/research/CLI/spec collisions. |
| P0 | `docs/internal/design-cascade-ledger.json` | exists | Classify CSS systems, runtime visual guards, raw colors, `!important`, and negative tracking; now needs cleanup enforcement. |
| P0 | `docs/internal/product-media-proof.json` | exists | Prove every product image, video, demo, and screenshot is real, useful, accessible, and theme-safe; now needs primary-proof usefulness ownership. |
| P0 | `reports/deployments/<release-id>/production-evidence.json` | missing | Tie live `kolm.ai` proof to commit, deploy, env, smoke, screenshots, rollback, and telemetry. |
| P0 | `docs/internal/catalog-manifest.json` | exists | Single provider/model/runtime/device/pricing truth source; now needs freshness and consumer parity enforcement. |
| P0 | `docs/internal/codebase-file-ledger.json` | exists | Source/generated/archive/scratch ownership for every path; now needs final clean-tree release application. |
| P0 | `docs/internal/product-feature-completion-matrix.json` | missing | Per-feature proof across behavior, API, account, public page, docs, CLI, TUI, SDK, tests, UI states, readiness, and production. |
| P0 | `docs/internal/account-product-matrix.json` | missing | Classify all 51 account pages by journey, feature, state model, API routes, CLI/TUI equivalents, data safety, claim scope, and authenticated smoke. |
| P0 | `docs/internal/account-shell-contract.json` | missing | One account shell authority for top nav, sidebar, command center, readiness band, chat, skip link, theme/auth controls, footer, and state containers. |
| P0 | `docs/internal/account-nav-manifest.json` | missing | Single generated account nav source for labels, groups, paths, active-state rules, journey ownership, API routes, CLI/TUI equivalents, badges, and auth scopes. |
| P0 | `docs/internal/component-interaction-state-contract.json` | missing | Canonical states for buttons, links, nav, popovers, tables, forms, cards, videos, demos, calculators, account widgets, loading, empty, partial, error, success, disabled, selected, and external-gated UI. |
| P0 | `docs/internal/ui-accessibility-performance-contract.json` | missing | WCAG 2.2, WAI-ARIA nav, Core Web Vitals, media dimensions, skeleton stability, keyboard, reduced motion, no-auth/auth/error/partial account states, and production field measurement rules. |
| P0 | `docs/internal/nav-runtime-debt-ledger.json` | missing | Classify every `public/nav.js` behavior as permanent runtime, build-time shell candidate, CSS migration, copy/metadata migration, auth-required runtime, or remove-after-migration. |
| P0 | `docs/internal/account-product-journey-state-machine.json` | missing | Route/capture, distill/compile, and run/govern account workflows with object state, next action, readiness, proof, and fallback states for every page. |
| P0 | `docs/internal/api-contract-matrix.json` | missing | Source of truth for every route's auth, tenancy, object authorization, schema, error, idempotency, audit, SDK, account, CLI, docs, smoke, and claim scope. |
| P0 | `docs/internal/openapi-dialect-policy.json` | missing | Pin OpenAPI `3.2.0` or `3.1.2`, JSON Schema dialect, generator compatibility, and non-final `3.0.3` migration rules. |
| P0 | `docs/internal/developer-docs-shell-contract.json` | missing | Govern all `public/docs/**/*.html`, `/api`, `/quickstart`, `/sdks`, and SDK reference pages by shell family, nav, metadata, CSS, skip link, product journey, Diataxis type, and first-value state. |
| P0 | `docs/internal/api-reference-contract.json` | missing | Make `/api`, `/docs/api`, OpenAPI, route inventory, SDK examples, CLI REST hints, and account actions consume the same route count, auth, envelope, examples, and source-indexed/beta status. |
| P0 | `docs/internal/docs-sample-contract.json` | missing | Treat every code sample as a generated or smoke-tested artifact with language, env, placeholder policy, expected output, cleanup, failure modes, and stale-key/package protection. |
| P0 | `docs/internal/sdk-package-truth-matrix.json` | missing | Package/install truth for every SDK/integration: registry owner, publication state, install command, route coverage, typed errors, examples, smoke command, and public-copy allowance. |
| P0 | `docs/internal/data-plane-contract.json` | missing | Classify every persisted table, event, blob, artifact, cache, audit row, and scratch output; reconcile JSON/SQLite/cloud drivers, migrations, indexes, tenant fences, retention, and readiness truth. |
| P0 | `docs/internal/env-secret-contract.json` | missing | Canonical inventory for all 378 local env vars: owner, type, sensitivity, default, deploy target, readiness check, rotation, generated `.env.example`, and no-secret-leak proof. |
| P0 | `docs/internal/data-retention-backup-contract.json` | missing | Retention, deletion, backup, restore, RPO, RTO, legal hold, right-to-erasure exception, object lock/versioning, and restore-drill evidence by data class. |
| P0 | `docs/internal/tenant-data-boundary-contract.json` | missing | Canonical tenant identifier, tenant fence, admin override, lifecycle data effects, account deletion/export/merge, residency, and export-control ownership for every table and route. |
| P0 | `docs/internal/release-boundary-manifest.json` | missing | Exact include/exclude policy for Docker, Railway, Vercel, npm/SDK packages, CLI, extension, and public assets; blocks `.env`, local data, backups, reports, screenshots, temp artifacts, and agent state from release bundles. |
| P0 | `docs/internal/ci-release-pipeline-contract.json` | missing | Workflow, trigger, permission, runtime, install, command, artifact, retention, owner, and required/referenced/template classification for every CI/release workflow and action. |
| P0 | `docs/internal/ci-required-checks-policy.json` | missing | Required checks by merge, release candidate, production deploy, and post-deploy phase, including flake/retry/skip/exception policy and owner escalation. |
| P0 | `docs/internal/release-artifact-evidence-matrix.json` | missing | Release subjects for site, API, Docker, packages, SDKs, installers, browser extension, actions, and `.kolm` artifacts with output hashes, SBOM, provenance, signatures, registry URLs, checks, and retention. |
| P0 | `docs/internal/sbom-provenance-contract.json` | missing | SBOM/provenance/attestation requirements and verification commands for every release subject, not just uploaded CI artifacts. |
| P0 | `docs/internal/generated-artifact-manifest.json` | missing | Register every generated artifact, generator, input set, check command, downstream consumer, write lock, and stale-file policy. |
| P0 | `docs/internal/observability-contract.json` | missing | Trace, metric, log/event, SLO, alert, dashboard, owner, and runbook coverage for every product journey and release-critical route. |
| P0 | `docs/internal/security-release-contract.json` | missing | ASVS/API/security release contract tying headers, auth, object authorization, rate limits, CORS, CSP, webhooks, secret handling, SBOM/provenance, and incident response to production evidence. |
| P0 | `reports/build-redline/final-build-redline.json` | missing | Final clean-tree, generated-artifact, test, smoke, UI, and production release certificate. |
| P1 | `docs/internal/sdk-api-parity.json` | missing | Per-language SDK support matrix for generated methods, handwritten wrappers, packages, examples, auth, errors, streaming, uploads, artifact helpers, and release state. |
| P1 | `docs/internal/docs-ia-contract.json` | missing | Diataxis-style tutorial/how-to/reference/explanation coverage tied to product graph journeys and route/CLI/SDK contracts. |
| P1 | `docs/internal/page-family-contracts.json` | missing | First-screen, CTA, media, proof, copy, and accessibility rules by page family. |
| P1 | `docs/internal/component-state-contracts.json` | missing | Canonical interaction states for buttons, forms, tables, cards, modals, nav, demos, videos, calculators, account widgets, and docs widgets. |
| P1 | `docs/internal/nav-contract.json` | missing | Govern active states, underlines, popovers, mobile nav, keyboard behavior, page-family mapping, and CTA placement. |
| P1 | `docs/internal/claim-copy-map.json` | missing | Allowed/scoped/blocked product claims based on readiness and evidence. |

## Recommended Document Architecture

The large blueprint should be treated as an archive, not the only working doc.

| Document | Role |
|---|---|
| `kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | Full archival spec and evidence memory. Keep it, but stop using it as the daily work queue. |
| `kolm-master-spec-consolidated-review-2026-05-25.md` | This operating summary. Use it to decide what to build next. |
| `docs/internal/wave-registry.json` | Canonical roadmap state. This should replace chat-based wave status. |
| `docs/internal/catalog-manifest.json` | Canonical provider/model/runtime/device/pricing truth. |
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
8. Data plane, env/secrets, retention/backup, tenant boundaries, and release-boundary manifests exist and pass.
9. CI/release pipeline, required-checks policy, release artifact matrix, SBOM, provenance, package/channel evidence, and attestation verification exist and pass.
10. Provider/model/runtime/device/pricing catalog is sourced and fresh.
11. AI capability claims have eval, benchmark, or scoped local proof.
12. External-gated claims remain scoped until external proof exists.
13. Production deploy is verified with public smoke, auth smoke, screenshots, telemetry, rollback, and status decision.
14. Final build redline packet exists and can be audited without reading chat history.

## Bottom Line

The original research doc is worth keeping. It is the full memory of what "best version of Kolm" means.

But the next phase should be less prose and more control files. The highest-value move is to convert the blueprint into registries, packets, reports, and verifiers. That is what will turn a strong research artifact into a finished codebase.
