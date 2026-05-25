# Kolm P0 Control Files Buildbook

Date: 2026-05-25

Purpose: provide the implementation sequence for the P0 control files defined in `kolm-p0-control-files-implementation-spec-2026-05-25.md`. This buildbook is intentionally practical: it names the existing scripts to reuse, the new scripts to add, the data extraction approach, and the failure mode for each phase.

## Current Inputs To Reuse

The current tree already has useful raw material. Do not rewrite these behaviors from scratch unless the implementation proves they are inadequate.

| Existing asset | What it already does | Reuse for |
|---|---|---|
| `scripts/build-codegraph.mjs` + `src/repo-codegraph.js` | Builds and audits a repo code graph with files, routes, symbols, and scripts. | Seed `docs/codebase-file-ledger.json`. |
| `scripts/product-graph-lib.cjs` | Reads product surfaces, journeys, readiness, API routes, and product experience into a stable graph. | Pattern for stable JSON output and cross-doc joins. |
| `scripts/build-product-graph.cjs` | Emits `public/product-graph.json`. | Use as a model for generated file style. |
| `scripts/build-readiness-closeout.cjs` | Emits public and docs closeout ledgers and supports check mode. | Use as a model for write/check mode. |
| `scripts/verify-product-surfaces.cjs` | Verifies route ownership and product-surface smoke definitions. | Input to wave registry and final redline. |
| `scripts/prod-surface-smoke.cjs` | Probes production product surfaces with public/deep/auth modes and secret-safe API keys. | Core input to production evidence packet. |
| `scripts/local-surface-smoke.cjs` | Runs local product-surface probes. | Local proof input for final build redline. |
| `scripts/ui-surface-audit.cjs` | Discovers HTML routes, runs Playwright screenshot checks, writes reports. | Product media proof and design evidence. |
| `scripts/audit-claim-scope.cjs` | Enforces claim scope against readiness state. | Final redline and public-copy gating. |
| `scripts/release-verify.cjs` | Runs the broad release gate. | Final redline aggregator. |
| `scripts/build-sitemap.cjs` and `scripts/seo-audit.cjs` | Build and audit discovery assets. | Discovery inputs to final redline and production evidence. |
| `scripts/smoke-models.mjs` and `scripts/smoke-device-bind.mjs` | Model/device smoke utilities. | Catalog manifest proof. |

## Implementation Principles

1. Use deterministic stable JSON output. Object keys should be sorted before writing.
2. Every generator must support `--check` and fail if the existing generated file is stale.
3. Every generated file must include `schema`, `generated_at`, `secret_values_included: false`, `source_paths`, `counts`, `items`, and `failures`.
4. Every verifier should initially support `--warn-only`, then graduate to fail mode once the initial inventory is complete.
5. Do not put secret values into any report. Store only presence, source class, hash, or redacted identity.
6. Prefer existing scripts as input rather than parsing console text.
7. Reports must survive CI log expiry. Write files under `reports/`, not only stdout.
8. The final redline is an aggregate, not another independent scanner.

## Phase 1: Codebase File Ledger

Goal: classify every current path so release inclusion, ownership, generated status, and cleanup responsibility are explicit.

Current seed: `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md`.

New files:

- `scripts/build-codebase-file-ledger.cjs`
- `scripts/verify-codebase-file-ledger.cjs`
- `docs/codebase-file-ledger.json`

Data sources:

- `git ls-files`
- `git status --porcelain`
- `.gitignore`
- `.vercelignore`
- `package.json` `files` field and scripts
- `scripts/build-codegraph.mjs --json --full`
- known generated outputs: OpenAPI, API routes, product graph, readiness closeout, CLI docs, sitemap, screenshots, reports

Algorithm:

1. Enumerate tracked files with `git ls-files`.
2. Enumerate untracked files with `git status --porcelain`.
3. Classify each path by prefix and extension.
4. Join codegraph output for routes, scripts, and source code.
5. Mark generated files by known generator.
6. Mark release inclusion using package `files`, Vercel/public conventions, and explicit allowlists.
7. Mark suspicious root artifacts and path-like filenames as `scratch` or `quarantine`.
8. Emit `docs/codebase-file-ledger.json`.

Warn-mode failures:

- unclassified path
- generated file without generator
- release-included path without owner node
- large file without review owner
- dirty path without active lane owner

Fail-mode graduation:

- no unowned release-included paths
- no root scratch artifacts included in release
- all generated outputs have `--check` command

## Phase 2: Wave Registry

Goal: replace chat-derived roadmap state with one canonical machine-readable registry.

New files:

- `scripts/build-wave-registry.cjs`
- `scripts/verify-wave-registry.cjs`
- `docs/wave-registry.json`
- `docs/wave-registry.schema.json`
- `docs/wave-reconcile-report.json`

Data sources:

- `KOLM_W707_SYSTEM_UPGRADE_PLAN.md`
- `KOLM_W851_CLI_TUI_100X_PLAN.md`
- `KOLM_ULTRA_PLAN_2026_05_24.md`
- `docs/product-invention-portfolio.json`
- `docs/product-invention-implementation-spec.json`
- `docs/product-invention-buildbook.json`
- frontier/research/readiness JSON files in `docs/`
- W-numbered test names under `tests/`
- `package.json` verify scripts
- codebase file ledger

Algorithm:

1. Extract all `W[0-9]+` references from root roadmap files.
2. Extract all wave IDs from `tests/wave*.test.js`.
3. Extract invention/frontier IDs from JSON ledgers.
4. Normalize each to `canonical_wave_id`.
5. Apply known duplicate/supersession rules from the master blueprint.
6. Attach owner lane and master nodes from file paths and node map.
7. Attach proof commands from `package.json` scripts and test files.
8. Produce reconcile report: duplicates, orphan tests, orphan plan items, missing packets, generated-output conflicts.

Warn-mode failures:

- orphan wave test
- orphan roadmap item
- duplicate canonical ID
- missing owner lane
- missing proof command
- state says shipped without production evidence

Fail-mode graduation:

- every W-numbered test maps to one canonical wave
- no Tier 0/Tier 1 wave lacks owner/proof/state
- public roadmap projection can be generated from registry state

## Phase 3: Active Lanes And Write Locks

Goal: make concurrent agent work explicit before generated artifacts or deploy decisions.

New files:

- `scripts/build-active-lanes.cjs`
- `scripts/verify-active-lanes.cjs`
- `docs/active-lanes.json`
- `docs/agent-write-locks.json`

Data sources:

- `git status --porcelain`
- current dirty paths
- wave registry
- codebase file ledger
- known generated artifact groups

Seed approach:

Start with a manual seed file because active agents are not discoverable from git alone. Then let the verifier compare dirty files against declared write sets.

Minimum active lanes:

- frontend
- backend
- research
- CLI/TUI
- production
- spec

Warn-mode failures:

- dirty file with no lane owner
- generated output modified without lock
- same path owned by two active lanes
- expired lock
- deploy-relevant file dirty with no release exclusion

Fail-mode graduation:

- no generated-artifact conflicts
- no deploy recommendation while release-relevant lock is active

## Phase 4: Catalog Manifest

Goal: unify provider, model, runtime, hardware, device, and pricing truth.

New files:

- `scripts/build-catalog-manifest.cjs`
- `scripts/verify-catalog-manifest.cjs`
- `docs/catalog-manifest.json`
- `docs/catalog-freshness-report.json`

Data sources:

- `src/provider-registry.js`
- `src/model-registry.js`
- `src/models.js`
- `src/runtime-policy.js`
- `src/runtime-placement.js`
- `src/runtime-perf-estimate.js`
- `src/device-capabilities.js`
- `src/devices.js`
- `src/cost-estimator.js`
- `scripts/smoke-models.mjs`
- `scripts/smoke-device-bind.mjs`
- public model/runtime/docs pages

Algorithm:

1. Import local registry modules where safe.
2. Normalize entries to provider/model/runtime/device/pricing rows.
3. Attach source URL, checked date, freshness TTL, and claim scope.
4. Attach consumer paths by static text scan.
5. Attach smoke commands and current pass/fail status where local command exists.
6. Emit freshness report.

Warn-mode failures:

- model/provider/runtime ID used in public/docs/account but missing from manifest
- price row without source date
- unknown paid provider price treated as zero
- candidate model used as default
- runtime "supported" without package state or smoke command

Fail-mode graduation:

- all public model/runtime/provider/pricing claims resolve to manifest
- unknown/stale rows fail visible
- provider/model/runtime/device smoke attached for release-relevant entries

## Phase 5: Design Cascade Ledger

Goal: convert CSS and runtime visual guards into a governed design-system inventory.

Current seed: `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`.

New files:

- `scripts/build-design-cascade-ledger.cjs`
- `scripts/verify-design-cascade-ledger.cjs`
- `docs/design-cascade-ledger.json`
- `docs/design-cascade-exceptions.json`

Data sources:

- `public/*.css`
- `public/nav.js`
- `public/*.html`
- `public/account/**/*.html`
- `public/docs/**/*.html`
- latest `reports/ui-surface-audit/**/report.md`

Algorithm:

1. Enumerate CSS files and byte/line counts.
2. Count raw colors, `!important`, negative `letter-spacing`, media queries, reduced-motion rules, and theme selectors.
3. Extract runtime style injection blocks from `public/nav.js`.
4. Classify files as token, component, route, transitional, generated, deprecated, or emergency guard.
5. Build exception records with owner, reason, expiry, screenshot proof, and deletion ticket.

Warn-mode failures:

- unclassified CSS file
- `!important` without exception
- negative visible tracking without exception
- runtime visual guard without expiry
- route imports deprecated CSS without migration plan

Fail-mode graduation:

- no permanent visual authority lives only in JavaScript
- visual debt has numeric budgets and owners
- screenshot audit can cite design ledger version

## Phase 6: Product Media Proof

Goal: prove that images, videos, demos, posters, and screenshots are real product proof and not decorative filler.

Current seed: `docs/research/kolm-product-media-proof-seed-2026-05-25.md`.

New files:

- `scripts/build-product-media-proof.cjs`
- `scripts/verify-product-media-proof.cjs`
- `docs/product-media-proof.json`

Data sources:

- public HTML image/video/canvas/script references
- `public/img/**`
- `public/og/**`
- demo modules and `public/studio.html`
- UI screenshot reports
- alt/caption/transcript text

Algorithm:

1. Extract all image/video/media/demo references from public HTML and JS.
2. Classify by route and product surface.
3. Verify file existence and dimensions where possible.
4. Check alt/caption/transcript for non-decorative media.
5. Join screenshot reports to dark/light and mobile/desktop proof.
6. Record demo loading/error/success/fallback states where scripts expose them.

Warn-mode failures:

- missing media file
- product route without proof media
- meaningful image without alt/caption
- video without transcript/caption/fallback
- product media not present in latest screenshot report

Fail-mode graduation:

- homepage/product/pricing/enterprise/docs/account/demo routes all have proof media
- dark/light and mobile/desktop evidence exists

## Phase 7: Production Evidence Packet

Goal: prove the deployed site, not just local code.

New files:

- `scripts/build-production-evidence-packet.cjs`
- `scripts/verify-production-evidence-packet.cjs`
- `reports/deployments/<release-id>/production-evidence.json`
- `reports/deployments/<release-id>/SHA256SUMS`

Data sources:

- production deploy ID and base URL
- `prod-surface-smoke.cjs --json`
- `prod-surface-smoke.cjs --deep --require-auth --json`
- UI screenshot audit against production
- generated artifact hashes
- git commit/status
- env readiness reports
- rollback target
- status/RSS decision

Algorithm:

1. Require explicit `--release-id`.
2. Capture commit and dirty-tree state.
3. Hash generated artifacts.
4. Attach public and auth smoke JSON reports.
5. Attach production screenshot report.
6. Attach env readiness and object storage readiness if available.
7. Attach rollback plan and telemetry query links.
8. Write `SHA256SUMS`.

Fail-mode failures:

- missing release ID
- dirty release tree without explicit exclusion
- public smoke missing
- auth smoke missing for account-impacting release
- production screenshots missing for frontend release
- generated artifact hash mismatch
- rollback target missing

## Phase 8: Final Build Redline

Goal: aggregate all control files into the single "are we actually done?" certificate.

New files:

- `scripts/build-final-build-redline.cjs`
- `scripts/verify-final-build-redline.cjs`
- `reports/build-redline/final-build-redline.json`

Inputs:

- codebase file ledger
- wave registry
- active lanes/write locks
- catalog manifest
- design cascade ledger
- product media proof
- product graph/readiness closeout
- claim-scope report
- local/release/prod smoke
- production evidence packet
- UI screenshot reports

Algorithm:

1. Load every P0 control file.
2. Run or ingest verification summaries.
3. Compute gate states.
4. Distinguish local completion, production completion, and external-gated completion.
5. Emit open blockers with owner node and required proof.
6. Set `state: closed` only when every P0 gate is green and external gates are scoped.

Fail-mode failures:

- any missing P0 control file
- stale generated artifact
- active lane conflict
- unresolved dirty release file
- red product surface
- red production evidence
- public claim exceeds proof

## Package Script Additions

Add these only after the corresponding scripts exist:

```json
{
  "build:control-files": "npm run build:file-ledger && npm run build:wave-registry && npm run build:active-lanes && npm run build:catalog-manifest && npm run build:design-cascade-ledger && npm run build:product-media-proof",
  "verify:control-files": "npm run verify:file-ledger && npm run verify:wave-registry && npm run verify:active-lanes && npm run verify:catalog-manifest && npm run verify:design-cascade-ledger && npm run verify:product-media-proof",
  "build:release-evidence": "npm run build:production-evidence && npm run build:final-redline",
  "verify:release-evidence": "npm run verify:production-evidence && npm run verify:final-redline"
}
```

## Implementation Risk Notes

- Do not run API/OpenAPI generation in parallel. Prior work observed a read/write race.
- Do not make the first implementation fail the whole repo on known debt. Start warn-only, commit inventory, then tighten.
- Do not rely on `rg`; it is not available in this shell. Scripts should use Node filesystem traversal.
- Do not parse long console output when a script can write JSON. Add JSON output modes where missing.
- Do not include API keys, provider credentials, project IDs, tenant secrets, or raw env values.
- Do not make production evidence depend on local-only paths that will not exist in CI.
- Do not let generated reports become root clutter. Put them under `reports/` with retention policy.

## Done When

This buildbook is satisfied when:

1. the eight P0 control files exist;
2. every control file has a schema or documented validator;
3. every generator supports write and check mode;
4. every verifier is included in `verify:control-files` or `verify:release-evidence`;
5. `verify:depth` consumes the relevant control-file checks;
6. final build redline can close or report blockers without reading chat history.
