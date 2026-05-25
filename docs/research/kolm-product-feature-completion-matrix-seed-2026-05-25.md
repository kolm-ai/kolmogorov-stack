# Kolm Product Feature Completion Matrix Seed

Date: 2026-05-25

Purpose: define the feature-by-feature completion matrix that should sit above the file ledger. The file ledger answers "what files exist?" This matrix answers "which product capability does each file serve, what must be true before that capability is complete, and what UI/UX/functionality evidence proves it?"

Related documents:

- `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md`
- `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md`
- `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`
- `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md`
- `docs/research/kolm-account-product-matrix-seed-2026-05-25.md`

## Current Evidence Snapshot

Current generated product graph reports:

| metric | count |
|---|---:|
| journeys | 12 |
| route surfaces | 7 |
| routes | 582 |
| route groups | 163 |
| API routes | 69 |
| CLI commands | 64 |
| TUI views | 32 |
| account links | 33 |
| customization dimensions | 8 |
| readiness requirements | 57 |

Current readiness counts:

| status | count |
|---|---:|
| shipped | 14 |
| implemented | 35 |
| needs_public_benchmark_data | 1 |
| needs_package_release | 4 |
| needs_external_partner | 2 |
| needs_live_certification | 1 |

Current public-docs product surfaces:

| surface | routes | smoke probes |
|---|---:|---:|
| identity-access-billing | 66 | 8 |
| public-docs-sdk | 42 | 17 |
| compile-artifact-verification | 51 | 10 |
| runtime-inference-connectors | 53 | 12 |
| capture-data-eval-training | 116 | 15 |
| governance-compliance-security | 64 | 12 |
| deployment-edge-federated | 60 | 10 |

Current account surface has at least 41 HTML feature pages under `public/account/`, including capture, datasets, distill runs, routing, failure modes, active learning, storage, devices, audit log, billing, approvals, chargeback, and API keys.

## Matrix Completion Standard

No product feature is complete until every applicable row below is satisfied.

| layer | completion requirement |
|---|---|
| Product outcome | The user-facing page states the concrete business/technical outcome in one sentence without jargon. |
| First value path | A new user can reach the first meaningful artifact, report, capture, route, or receipt within one guided flow. |
| API contract | Routes have envelope shape, auth model, error states, OpenAPI entry, and ownership in `docs/product-surfaces.json`. |
| CLI parity | Operator workflows have a CLI proof path when the feature affects deployment, capture, storage, build, or governance. |
| TUI/account parity | Post-auth account UX and TUI expose the same readiness state, not separate partial truths. |
| Docs parity | Quickstart, API reference, SDK docs, and troubleshooting describe the same current behavior. |
| UI/UX quality | Layout, nav, spacing, font scale, color, empty/loading/error states, keyboard access, and mobile behavior are verified. |
| Product media | Images, videos, demos, and diagrams show the real product surface or a faithful generated artifact, not vague decoration. |
| Tests | Unit, route, contract, and smoke tests prove the feature path and the failure path. |
| Production proof | Live deployed surface is smoke-tested with current env, current commit, screenshots, and rollback evidence. |
| Claim scope | Marketing copy distinguishes shipped, implemented-local, benchmark-gated, package-gated, certification-gated, and partner-gated states. |

## Product Feature Matrix

### 1. Gateway Capture

Outcome: route existing model calls through Kolm, capture useful behavior, and create compile-ready evidence without trapping the customer in a provider.

Current evidence:

- Account paths: `/account/connectors`, `/account/captured`, `/account/lake`
- CLI: `kolm capture --provider openai --as local`, `kolm capture --provider anthropic --as local`, `kolm capture status`, `kolm tail captures`
- Surface owner: `capture-data-eval-training`
- Related public pages: `/capture`, `/quickstart`, `/integrations`, `/docs`

Completion redline:

- Drop-in OpenAI-compatible and Anthropic-compatible capture flow must work in docs, CLI, account, and API with the same provider readiness state.
- Capture must show exactly what is stored, what is redacted, and what is excluded.
- The account UI must show captured calls, duplicates, cost, and compile opportunities in one clear workflow.
- Public copy must not make "one AI API" sound like the whole product.

UI/UX redline:

- The first screen must answer: "connect this provider, capture this call, get this artifact candidate."
- Empty state should show a pasteable OpenAI call and the generated `.kolm` candidate path.
- Avoid long explanatory paragraphs; use command, result, receipt, and next action.

### 2. Privacy Lake

Outcome: preserve useful AI behavior while making privacy, storage, redaction, retention, and export state visible and governable.

Current evidence:

- Account paths: `/account/lake`, `/account/privacy-events`, `/account/storage`
- CLI: `kolm lake stats --json`, `kolm lake tail --limit 20`, `kolm privacy scan`, `kolm privacy report`
- Related APIs include privacy scan, redaction benchmark, storage readiness, and lake stats.

Completion redline:

- Every stored class must be visible: prompt, response, tool call, media, redaction class, tenant, namespace, retention, storage provider.
- Redaction benchmark status must appear in product copy with benchmark date and scope.
- Storage readiness must distinguish local disk, R2, S3, Supabase, and missing credentials without exposing secrets.

UI/UX redline:

- Use a dense operational dashboard, not a marketing card layout.
- Loading, empty, error, partial, and no-credential states must be designed and screenshot-tested.

### 3. Datasets And Labeling

Outcome: turn captured traffic into curated datasets, labels, simulations, bakeoffs, and split-ready training/evaluation material.

Current evidence:

- Account paths: `/account/datasets`, `/account/labeling`, `/account/simulations`, `/account/bakeoffs`
- CLI: `kolm dataset candidates --json`, `kolm label next --json`, `kolm dataset split <id>`, `kolm sim generate-dataset <id>`
- Surface owner: `capture-data-eval-training`

Completion redline:

- Dataset candidates need provenance back to capture IDs and privacy events.
- Labeling needs keyboard-first review, conflict state, reviewer identity, and export history.
- Simulations must record synthetic/genuine data boundaries.

UI/UX redline:

- Tables need density, filtering, stable row heights, keyboard navigation, and visible bulk actions.
- Every dataset state needs a next action: capture more, label, split, simulate, distill, or benchmark.

### 4. Train And Distill

Outcome: convert approved behavior into smaller task-specific models with teacher selection, student strategy, K-Score, failure modes, and signed artifacts.

Current evidence:

- Account paths: `/account/builds`, `/account/distill-runs`, `/account/multimodal-bakeoff`
- CLI: `kolm train plan <dataset> --strategy`, `kolm distill strategy --json`, `kolm bench evidence --summary`, `kolm train --namespace <name>`, `kolm distill --namespace <name>`
- Public pages: `/distill`, `/benchmarks`, `/k-score`, `/k-score-calibration`
- Roadmap context includes W711-W719, W720-W722, W807-W810, and later distillation/runtime waves.

Completion redline:

- Distill page and account flow must distinguish strategy selection, training run, evaluation, artifact production, and deployment.
- K-Score methodology must be mathematically specified and tied to public benchmark scope.
- Public benchmark claims must remain scoped until W571 public leaderboard evidence exists.
- Teacher Council, TAAS, progressive distill, reasoning trace distill, contrastive distill, and DAQ need visible status: shipped, experimental, or research.

UI/UX redline:

- Replace abstract "AI compiler" language with a concrete flow: captured tasks -> teacher council -> student search -> quantization -> K-Score -> signed `.kolm`.
- Distill run UI needs progress, cost, dataset, teacher, student, failure mode, eval score, artifact, and rollback action.

### 5. Models And Backbones

Outcome: help users choose the right teacher, student, local model, multimodal backbone, and device fit for their workload.

Current evidence:

- Account paths: `/models`, `/account/builds`, `/account/devices`
- CLI: `kolm models list --json`, `kolm models recommend --json`, `kolm models devices --json`, `kolm models info google/gemma-3n-E2B-it`
- Surface owner: `runtime-inference-connectors`

Completion redline:

- Provider/model facts must come from `docs/catalog-manifest.json` or equivalent, with source dates and freshness rules.
- Model recommendations must show constraints: context, modality, license, cost, memory, runtime target, device fit, and benchmark status.
- No stale pricing/model claims should live directly in copy.

UI/UX redline:

- Use comparison tables and filters; avoid long narrative model lists.
- Device-fit warnings should be concrete: memory, quantization, target runtime, expected latency class.

### 6. Multimodal Tokenization

Outcome: ingest image, PDF, audio, transcript, and future video evidence into safe, tokenized, redacted, benchmarkable forms.

Current evidence:

- Account paths: `/account/multimodal-bakeoff`, `/account/lake`, `/account/datasets`
- CLI: `kolm media tokenize --path ./scan.png --json`, `kolm media tokenize --dir ./evidence --json`, `kolm media redact-job --path ./scan.pdf --json`, `kolm bakeoff multimodal --json`

Completion redline:

- Each modality needs source handling, redaction behavior, token budget, benchmark score, and known unsupported cases.
- Video must remain explicitly scoped until implemented and verified.
- Product copy must not imply full multimodal inference if the implementation only covers redaction/tokenization/bakeoff.

UI/UX redline:

- Media previews need dimensions, alt text, accessible error state, and no layout shift.
- Empty state should show supported file types and privacy treatment.

### 7. Compile And Verify

Outcome: compile specs, captures, or datasets into signed `.kolm` artifacts with verifiable receipts, diffs, quantization decisions, and export targets.

Current evidence:

- Account paths: `/account/artifacts`
- CLI: `kolm compile --spec spec.json --out task.kolm`, `kolm quantize oracle --json`, `kolm verify task.kolm`, `kolm diff old.kolm new.kolm`, `kolm export task.kolm --target gguf --preview`
- Surface owner: `compile-artifact-verification`

Completion redline:

- Every artifact view needs spec, model hash, dataset hash, eval gate, signature, runtime target, quantization profile, and receipt history.
- Exports must show what is first-class, preview, package-gated, or external-runtime-gated.
- Verification failures must be understandable and actionable.

UI/UX redline:

- Artifact detail page should behave like a build/release record, not a generic file card.
- Diffs should visually separate model, data, prompt, eval, runtime, and governance changes.

### 8. Runtime Inference

Outcome: run signed artifacts across local, hosted, browser, device, MCP, and server contexts with measurable latency/cost/quality behavior.

Current evidence:

- Account paths: `/account/devices`, `/account/artifacts`
- CLI: `kolm run task.kolm "input"`, `kolm serve --mcp --http`, `kolm chat-tui --model=kolm:task`, `kolm runtime targets`, `kolm packages release-readiness --summary`
- Surface owner: `runtime-inference-connectors`

Completion redline:

- Runtime matrix must show support by target: GGUF, ONNX Runtime, CoreML, MLX, ExecuTorch, LiteRT, WASM/WebGPU, TensorRT-LLM, vLLM, SGLang, TGI.
- Package-gated runtime items must point to W569, W570, W572, or W575 closeout.
- Runtime receipts should include target, hardware, latency, memory, and fallback path.

UI/UX redline:

- The run page should start with "where this artifact runs" and "what it costs after compile."
- Do not imply every runtime is equally mature; use shipped/implemented/package-gated labels.

### 9. Compute And Cloud

Outcome: let teams choose local, remote, hosted, BYOC, object storage, and GPU paths without hiding credentials or deployment constraints.

Current evidence:

- Account paths: `/account/devices`, `/account/storage`, `/account/settings`
- CLI: `kolm cloud broker --json`, `kolm cloud readiness --remote --json`, `kolm cloud storage --json`, `kolm cloud storage --provider cloudflare-r2-s3 --smoke --json`, `kolm cloud targets --json`
- Surface owner: `deployment-edge-federated`

Completion redline:

- Readiness UI must show provider group, configured/missing state, secret-safe proof, object-size limits, and next command.
- Cloud readiness must distinguish local shell, production deploy, and customer BYOC.
- Hosted GPU availability cannot be claimed from local tests without live env proof.

UI/UX redline:

- Account storage/cloud screens should be setup dashboards, not docs pages.
- Use status tokens, provider rows, copyable env names, and exact smoke commands.

### 10. Devices And Fleet

Outcome: deploy, sync, and verify artifacts on laptops, phones, browsers, edge devices, air-gapped machines, and fleets.

Current evidence:

- Account paths: `/account/devices`
- CLI: `kolm devices detect --json`, `kolm devices recommend --json`, `kolm tunnel new --team <id>`, `kolm install-device artifact.kolm --device <id>`, `kolm airgap verify artifact.kolm`
- Public pages: `/device`, `/airgap`, `/runtimes`, `/download`

Completion redline:

- Device support must state runtime, model size, quantization, memory, install method, and verification command.
- Mobile/package release gates must stay visible until packages are published.
- Air-gap flow needs import/export, hash verification, offline docs, and failure recovery.

UI/UX redline:

- Device cards should be operational: "can run", "needs quantization", "cannot run", with reasons.
- Avoid decorative hardware pages unless they lead to an install path.

### 11. Enterprise Governance

Outcome: make org, team, RBAC, audit, billing, privacy, compliance, SIEM, SSO/SCIM, and procurement workflows first-class.

Current evidence:

- Account paths: `/account/api-keys`, `/account/audit-log`, `/account/billing`, `/account/settings`, `/account/privacy-events`
- CLI: `kolm whoami --json`, `kolm keys list`, `kolm audit --json`, `kolm billing usage --json`, `kolm team members`
- Surface owners: `identity-access-billing`, `governance-compliance-security`

Completion redline:

- Enterprise pages must separate controls implemented from certifications awarded.
- Billing plans must remain Free, Pro, Team, Enterprise/custom unless canonical plan files change.
- Compliance certification remains gated by W573 until live auditor evidence exists.
- Account overview must cover every product matrix feature, including readiness and closeout state.

UI/UX redline:

- Enterprise/account UI should feel like a serious admin console: dense, consistent, quiet, and predictable.
- No fake self-serve Enterprise checkout if sales review is required.

### 12. Agents And Registry

Outcome: compile, serve, publish, install, and govern `.kolm` artifacts for agents, MCP, registries, and reusable workflows.

Current evidence:

- Account paths: `/account/agent-telemetry`, `/account/artifacts`
- CLI: `kolm compile --as-mcp --spec spec.json`, `kolm serve --mcp`, `kolm install claude-code --apply`, `kolm publish artifact.kolm`, `kolm hub list`
- Surface owners: `compile-artifact-verification`, `runtime-inference-connectors`

Completion redline:

- Registry entries need artifact signature, version, owner, runtime targets, install instructions, permissions, and rollback.
- Agent telemetry must show tool calls, failures, latency, quality, and prompt/data boundaries.
- Marketplace claims must remain scoped until W825 or equivalent is implemented and verified.

UI/UX redline:

- Registry UX should resemble a package/release manager, not a gallery.
- Install flows need copyable commands, permission warnings, and version pinning.

## Page Family Completion Matrix

| page family | current examples | completion requirement |
|---|---|---|
| Homepage | `/` | One first-screen narrative for all three product surfaces: route/capture, distill/compile, run/govern. No jargon headline. No large hidden proof payloads driving product truth. Real demo/video/media must load in light and dark. |
| Product overview | `/product`, `/compile`, `/distill`, `/run`, `/capture` | Each page must have outcome-led H1, one primary CTA, real proof surface, short copy, and a path into account/docs/CLI. |
| Pricing and enterprise | `/pricing`, `/enterprise`, `/roi` | Plans, sales-required enterprise, ROI assumptions, and billing API must match canonical backend tiers. |
| Docs and quickstart | `/docs`, `/quickstart`, `/docs/api`, `/sdks` | Runnable examples, SDK parity, generated route docs, OpenAPI, and "first artifact" tutorial. |
| Account cockpit | `/account/*` | Full product matrix, readiness states, empty/loading/error/partial states, keyboard use, and authenticated smoke coverage. |
| Trust and legal | `/security`, `/privacy`, `/soc2`, `/baa`, `/dpa`, `/terms` | Controls implemented versus certification status must be explicit and tied to readiness closeout. |
| Vertical pages | `/healthcare`, `/finance`, `/legal`, `/gov`, `/saas` | Concrete use case, data boundary, artifact path, compliance proof, and industry-specific first value. |
| Comparison pages | `/how-vs-*`, `/compare` | Honest competitor positioning, current source dates, and no unproven superiority claims. |
| Runtime/device pages | `/device`, `/runtimes`, `/airgap`, `/download`, `/self-host` | Device/runtime matrix, package gates, install commands, and verification path. |

## UI/UX Completion Rules

The UI/UX standard for every product feature:

1. Minimum 16px body copy on mobile.
2. 44px minimum touch targets and visible focus states.
3. No hover-only disclosure for critical nav or account actions.
4. No horizontal mobile scroll.
5. No raw one-off colors in feature surfaces unless they map to design tokens.
6. No mixed navigation systems across sibling pages unless a migration is documented.
7. No button style drift: primary, secondary, ghost, danger, disabled, loading must be canonical.
8. No visible long-form proof dumps on product pages; proof belongs in docs, receipts, reports, and structured UI.
9. Every async panel has loading, empty, error, partial, and success states.
10. Every image/video/demo has dimensions, fallback, alt/label, and theme-safe verification.
11. Every account table supports scanability: labels, sorting/filtering where useful, stable row heights, and clear bulk actions.
12. Every page family has a first-screen contract and a screenshot proof path.

## Additive Roadmap Alignment

This matrix is additive to the current wave roadmap. It should not replace W720-W835 or the research bot's invention work. It should force every wave to declare where it lands in product experience.

Required addition to future wave packets:

| field | meaning |
|---|---|
| `journey_ids` | Which of the 12 product journeys this wave improves. |
| `route_surface_ids` | Which of the 7 product surfaces own the shipped routes. |
| `public_pages` | Public pages touched or requiring copy/docs update. |
| `account_pages` | Post-auth pages touched or requiring state handling. |
| `api_routes` | API routes added/changed. |
| `cli_commands` | CLI commands added/changed. |
| `tui_views` | TUI views added/changed. |
| `claim_scope` | Shipped, implemented-local, benchmark-gated, package-gated, certification-gated, partner-gated. |
| `uiux_evidence` | Screenshot report, accessibility check, manual-use notes. |
| `prod_evidence` | Production smoke/screenshots if user-facing. |

## Immediate Build Order

1. Generate `docs/product-feature-completion-matrix.json` from `public/product-graph.json`, `docs/product-surfaces.json`, account pages, public page inventory, CLI/TUI command maps, and readiness closeout.
2. Add `docs/product-feature-completion-matrix.md` as the human-readable version.
3. Add `verify:feature-matrix` to fail on missing journey/page/API/CLI/readiness ownership.
4. Link every account page to a journey and every journey to at least one account or public first-value path.
5. Link every public page family to a first-screen contract.
6. Add a UI/UX proof column: desktop/mobile, dark/light, keyboard, empty/loading/error, media.
7. Add wave packet fields so future waves cannot ship without feature-matrix ownership.
8. Add the feature matrix to `verify:depth`.

## Redline Before "100 Percent Complete"

Do not claim completion until:

- every one of the 12 journeys has a complete row in the generated feature matrix
- every one of the 7 route surfaces has at least one route owner, smoke proof, docs proof, and UI/account proof where applicable
- every account page is tied to a journey and state contract
- every public page family is tied to a first-screen contract
- every readiness closeout item is visible in product copy or account readiness where relevant
- every wave packet declares journey and feature ownership
- every feature has UI/UX evidence after the latest edits, not stale screenshots
- live production evidence exists for the exact deployed commit
