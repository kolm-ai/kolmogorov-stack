# Kolm Internal Spec Index

Date: 2026-05-25

Audience: internal implementation agents only. This file and the documents it classifies are not customer-facing docs, not public marketing pages, not SEO content, and not product copy for `kolm.ai`.

Purpose: make the current research/spec files understandable. The recent docs are useful only if they drive implementation of generated control files, verifiers, product fixes, and release evidence. If they stay as prose forever, they become clutter.

## Direct Answer

These documents are internal.

They are not external.

They are not meant to be read by customers.

They are not useful as standalone deliverables.

They are useful as implementation scaffolding for turning the codebase into a controlled, verifiable, finished product.

The line is simple:

- Internal specs tell agents and engineers what to build, verify, and clean up.
- External docs help users understand, install, use, trust, and buy Kolm.
- Anything that does neither should be archived or deleted.

## Current Internal Spec Files

| file | classification | useful? | what it is for | what it is not for | final disposition |
|---|---|---:|---|---|---|
| `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | internal archive | yes, but too large | Full raw institutional memory, evidence, research, roadmap, and historical context. | Daily task queue, public docs, investor copy, UI copy. | Freeze as archive; mine only when generating specific control files or tickets. |
| `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md` | internal operating summary | yes | Shorter operating spine for what blocks 100 percent completion. | Public roadmap or website copy. | Keep until real generated registries replace it. |
| `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md` | internal implementation spec | yes | Defines the P0 control files, schemas, scripts, and gates to build. | User docs or marketing claims. | Convert into scripts, JSON schemas, generated docs, and verifiers; archive after implementation. |
| `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md` | internal buildbook | yes | Practical build order and reuse map for existing scripts. | Public engineering blog, docs, or launch material. | Use as an implementation runbook; archive once all control files exist. |
| `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md` | internal seed | yes, temporarily | Current file census and rules for `docs/codebase-file-ledger.json`. | Permanent spec or public docs. | Replace with generated `docs/codebase-file-ledger.json` and `docs/codebase-file-ledger.md`. |
| `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md` | internal seed | yes, temporarily | Current feature/journey completion criteria across UI, API, CLI, TUI, docs, tests, and production proof. | Customer-facing product matrix. | Replace with generated `docs/internal/product-feature-completion-matrix.json` and `.md`. |
| `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md` | internal seed | yes, temporarily | Current UI/CSS/nav/component cascade evidence and rules. | Design system website or external brand guide. | Replace with generated `docs/design-cascade-ledger.json` and exceptions ledger. |
| `docs/research/kolm-product-media-proof-seed-2026-05-25.md` | internal seed | yes, temporarily | Current image/video/demo/social/screenshot evidence and rules for real product proof media. | Public media kit or brand campaign. | Replace with generated `docs/product-media-proof.json` and `.md`. |
| `docs/research/kolm-account-product-matrix-seed-2026-05-25.md` | internal seed | yes, temporarily | Current post-auth account page inventory, journey ownership gaps, state requirements, and auth-smoke proof rules. | Customer-facing account documentation. | Replace with generated `docs/internal/account-product-matrix.json` and `.md`. |
| `docs/research/kolm-100-percent-finished-code-redline-2026-05-25.md` | internal code redline | yes | Primary implementation-only redline for finishing the codebase, cleaning the tree, integrating control files, and closing product behavior gaps. | Test plan, public roadmap, or research archive. | Keep active until `reports/build-redline/final-build-redline.json` is generated and green. |
| `docs/research/kolm-internal-spec-index-2026-05-25.md` | internal index | yes | Explains which research docs are internal, external, useful, temporary, or archive-only. | Public docs. | Keep until repo has a stable internal docs index. |

## What Should Become Real Artifacts

These internal specs should produce generated files and verifiers:

| internal spec | target artifact | target verifier |
|---|---|---|
| P0 control file spec/buildbook | `docs/internal/wave-registry.json` | `verify:wave-registry` |
| P0 control file spec/buildbook | `docs/internal/active-lanes.json` | `verify:active-lanes` |
| P0 control file spec/buildbook + codebase seed | `docs/internal/codebase-file-ledger.json` | `verify:file-ledger` |
| P0 control file spec/buildbook + API redline | `docs/internal/api-contract-matrix.json` | `verify:api-contracts` |
| P0 control file spec/buildbook + API redline | `docs/internal/openapi-dialect-policy.json` | `verify:openapi-policy` |
| P0 control file spec/buildbook + data-plane redline | `docs/internal/data-plane-contract.json` | `verify:data-plane` |
| P0 control file spec/buildbook + env/secret redline | `docs/internal/env-secret-contract.json` | `verify:env-secrets` |
| P0 control file spec/buildbook + retention redline | `docs/internal/data-retention-backup-contract.json` | `verify:data-retention` |
| P0 control file spec/buildbook + tenant-boundary redline | `docs/internal/tenant-data-boundary-contract.json` | `verify:tenant-boundary` |
| P0 control file spec/buildbook + SDK redline | `docs/internal/sdk-api-parity.json` | `verify:sdk-parity` |
| SDK/package truth redline | `docs/internal/sdk-package-truth-matrix.json` | `verify:sdk-package-truth` |
| P0 control file spec/buildbook + docs redline | `docs/internal/docs-ia-contract.json` | `verify:docs-ia` |
| developer docs shell redline | `docs/internal/developer-docs-shell-contract.json` | `verify:developer-docs-shell` |
| API reference redline | `docs/internal/api-reference-contract.json` | `verify:api-reference-contract` |
| docs sample redline | `docs/internal/docs-sample-contract.json` | `verify:docs-samples` |
| P0 control file spec/buildbook + feature matrix seed | `docs/internal/product-feature-completion-matrix.json` | `verify:feature-matrix` |
| account product matrix seed | `docs/internal/account-product-matrix.json` | `verify:account-matrix` |
| account shell/nav redline | `docs/internal/account-shell-contract.json` | `verify:account-shell` |
| account shell/nav redline | `docs/internal/account-nav-manifest.json` | `verify:account-nav` |
| account shell/nav redline | `docs/internal/nav-runtime-debt-ledger.json` | `verify:nav-runtime-debt` |
| account journey redline | `docs/internal/account-product-journey-state-machine.json` | `verify:account-product-journey-state-machine` |
| P0 control file spec/buildbook + page-family redline | `docs/internal/page-family-contracts.json` | `verify:page-families` |
| P0 control file spec/buildbook + page-family redline | `docs/internal/component-state-contracts.json` | `verify:page-families` |
| P0 control file spec/buildbook + page-family redline | `docs/internal/nav-contract.json` | `verify:page-families` |
| component/UI redline | `docs/internal/component-interaction-state-contract.json` | `verify:component-interaction-state` |
| component/UI redline | `docs/internal/ui-accessibility-performance-contract.json` | `verify:ui-accessibility-performance` |
| P0 control file spec/buildbook + design cascade seed | `docs/internal/design-cascade-ledger.json` | `verify:design-cascade-ledger` |
| P0 control file spec/buildbook + media proof seed | `docs/internal/product-media-proof.json` | `verify:product-media-proof` |
| P0 control file spec/buildbook | `docs/internal/catalog-manifest.json` | `verify:catalog-manifest` |
| P0 control file spec/buildbook | `docs/internal/generated-artifact-manifest.json` | `verify:generated-artifacts` |
| P0 control file spec/buildbook + production redline | `docs/internal/observability-contract.json` | `verify:observability-contract` |
| P0 control file spec/buildbook + production redline | `docs/internal/security-release-contract.json` | `verify:security-release` |
| P0 control file spec/buildbook + release-boundary redline | `docs/internal/release-boundary-manifest.json` | `verify:release-boundary` |
| P0 control file spec/buildbook + CI release redline | `docs/internal/ci-release-pipeline-contract.json` | `verify:ci-release` |
| P0 control file spec/buildbook + required-checks redline | `docs/internal/ci-required-checks-policy.json` | `verify:ci-required-checks` |
| P0 control file spec/buildbook + release artifact redline | `docs/internal/release-artifact-evidence-matrix.json` | `verify:release-artifacts` |
| P0 control file spec/buildbook + SBOM/provenance redline | `docs/internal/sbom-provenance-contract.json` | `verify:sbom-provenance` |
| P0 control file spec/buildbook | `reports/deployments/<release-id>/production-evidence.json` | `verify:production-evidence` |
| P0 control file spec/buildbook | `reports/build-redline/final-build-redline.json` | `verify:final-redline` |

## What Should Never Be External

Do not publish these as public docs:

- dirty worktree notes
- internal file-census counts
- agent coordination notes
- raw screenshot audit inventories
- hidden-anchor/test-contract discussion
- internal wave implementation history
- speculation about incomplete features
- local data path notes
- malformed-path quarantine notes
- "state of the art" internal redlines

Those belong in internal specs, generated reports, or issue trackers.

## What Should Be External Instead

External docs should be shorter and user-outcome focused:

| external surface | should contain |
|---|---|
| Homepage | What Kolm does, for whom, why now, proof demo, three product surfaces. |
| Product pages | Route/capture, distill/compile, run/govern explained with real workflows. |
| Docs | Quickstart, API reference, SDK guides, deployment guides, troubleshooting. |
| Trust pages | Implemented controls, certification scope, legal docs, security model. |
| Pricing | Free, Pro, Team, Enterprise/custom plan truth and sales path. |
| Account | Full product matrix, readiness state, artifacts, captures, distill, runtime, billing, governance. |

## Usefulness Score

| doc group | usefulness now | usefulness after generated controls exist |
|---|---:|---:|
| giant blueprint | 7/10 | 3/10 archive reference |
| consolidated master spec | 8/10 | 4/10 transition doc |
| P0 implementation spec/buildbook | 8/10 | 2/10 archived runbook |
| seed docs | 7/10 | 1/10 replaced by generated ledgers |
| generated JSON/MD control files | not built yet | 10/10 if wired into verification |

## Decision Rule

Any future research/spec doc must declare:

1. Audience: internal or external.
2. Lifecycle: permanent, temporary seed, generated, archive, or delete-after-conversion.
3. Target artifact: what file, route, page, verifier, or product behavior it creates.
4. Exit condition: when the prose can be archived.
5. Owner: frontend, backend, research, CLI, docs, product, security, or release.

If a doc cannot answer those five questions, it is probably useless.

## Immediate Cleanup Direction

Do not delete the current internal specs yet. They are carrying useful structure.

Do this instead:

1. Keep them under `docs/research/`.
2. Treat them as internal-only.
3. Convert the seeds into generated control files and verifiers.
4. Stop expanding the giant blueprint unless a new section directly maps to a target artifact.
5. Archive each seed after its generated control file exists and passes verification.
