# Kolm P0 Control Files Implementation Spec

Date: 2026-05-25

Purpose: turn the consolidated master spec into buildable control files, packets, reports, and verifiers. This is the bridge between the large research archive and the actual codebase finish line.

Implementation sequence and script reuse details are in `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`.

## Current Tree Finding

The consolidated review named the P0 control files that should exist before Kolm can claim real completion. A current worktree check found that none of the core P0 files exist yet:

| Artifact | Exists now | Why it matters |
|---|---:|---|
| `docs/wave-registry.json` | no | Canonical state for every W-numbered wave, duplicate, roadmap item, and invention. |
| `docs/wave-registry.schema.json` | no | Mechanical validation of wave ownership, proof, state, and claim scope. |
| `docs/active-lanes.json` | no | Prevents concurrent frontend/backend/research/CLI/spec collisions. |
| `docs/design-cascade-ledger.json` | no | Classifies CSS systems, runtime visual guards, raw colors, `!important`, and negative tracking. |
| `docs/product-media-proof.json` | no | Proves product images, videos, demos, and screenshots are real, useful, accessible, and theme-safe. |
| `docs/catalog-manifest.json` | no | Single provider/model/runtime/device/pricing truth source. |
| `docs/codebase-file-ledger.json` | no | Source/generated/archive/scratch ownership for every path. |
| `reports/deployments/` | no | Release-specific production evidence archive. |
| `reports/build-redline/final-build-redline.json` | no | Final clean-tree, generated-artifact, test, smoke, UI, and production release certificate. |

Related scripts already exist and should be reused rather than rewritten from scratch: `build-api-ref.cjs`, `build-openapi.cjs`, `build-product-graph.cjs`, `build-readiness-closeout.cjs`, `build-codegraph.mjs`, `verify-product-surfaces.cjs`, `audit-claim-scope.cjs`, `local-surface-smoke.cjs`, `prod-surface-smoke.cjs`, `release-verify.cjs`, `ui-surface-audit.cjs`, `build-sitemap.cjs`, `seo-audit.cjs`, `smoke-models.mjs`, `smoke-device-bind.mjs`, and the invention/frontier simulation scripts.

## External Rules To Follow

| Source | Rule imported |
|---|---|
| JSON Schema 2020-12, https://json-schema.org/draft/2020-12/json-schema-core | Every control file should have a schema and machine validation, not just prose. |
| GitHub CODEOWNERS, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners | Ownership should be explicit; CODEOWNERS has location, syntax, and size constraints, so Kolm also needs a richer internal file ledger. |
| GitHub workflow artifacts, https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts | Test logs, screenshots, binaries, performance output, and coverage-style evidence should be retained as artifacts, not lost in console output. |
| SLSA provenance v1.1, https://slsa.dev/spec/v1.1/provenance | Packets should record inputs, build definition, run details, builder identity, parameters, dependencies, and subjects/hashes. |

## Build Order

Do not build these files in arbitrary order. The correct sequence is:

1. `docs/codebase-file-ledger.json`
2. `docs/wave-registry.json` and `docs/wave-registry.schema.json`
3. `docs/active-lanes.json`
4. `docs/catalog-manifest.json`
5. `docs/design-cascade-ledger.json`
6. `docs/product-media-proof.json`
7. `reports/deployments/<release-id>/production-evidence.json`
8. `reports/build-redline/final-build-redline.json`

Reason: file ownership comes before wave ownership; wave ownership comes before lane locks; catalog truth and design truth feed production proof; final build redline consumes all prior packets.

## Control File 1: Codebase File Ledger

Target path: `docs/codebase-file-ledger.json`

Build script to add: `scripts/build-codebase-file-ledger.cjs`

Verify script to add: `scripts/verify-codebase-file-ledger.cjs`

Minimum schema:

```json
{
  "schema": "kolm.codebase_file_ledger.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "root": "C:/Users/user/Desktop/kolmogorov-stack",
  "counts": {
    "total_paths": 0,
    "source_paths": 0,
    "generated_paths": 0,
    "docs_paths": 0,
    "test_paths": 0,
    "report_paths": 0,
    "scratch_or_quarantine_paths": 0,
    "unowned_paths": 0
  },
  "paths": [
    {
      "path": "src/router.js",
      "kind": "source|generated|docs|test|report|fixture|asset|scratch|quarantine|config",
      "owner_node": "2",
      "owner_lane": "backend",
      "generated_by": null,
      "consumed_by": ["server.js"],
      "release_included": true,
      "codeowners_pattern": null,
      "large_file": false,
      "dirty_state": "clean|modified|untracked|ignored",
      "redline": null
    }
  ]
}
```

Acceptance:

- Every tracked and untracked non-ignored path is classified.
- Root malformed/path-like artifacts are classified as scratch, quarantine, or report.
- Generated files name their generator and regeneration order.
- Large files name their owner and review policy.
- No release-included path is unowned.

## Control File 2: Wave Registry

Target paths:

- `docs/wave-registry.json`
- `docs/wave-registry.schema.json`
- `docs/wave-reconcile-report.json`

Build script to add: `scripts/build-wave-registry.cjs`

Verify script to add: `scripts/verify-wave-registry.cjs`

Inputs:

- `KOLM_W707_SYSTEM_UPGRADE_PLAN.md`
- `KOLM_W851_CLI_TUI_100X_PLAN.md`
- `KOLM_ULTRA_PLAN_2026_05_24.md`
- invention/frontier/readiness JSON files in `docs/`
- W-numbered test files under `tests/`
- `package.json` verification scripts
- master blueprint sections for node `31`

Minimum schema:

```json
{
  "schema": "kolm.wave_registry.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "counts": {
    "waves": 0,
    "tests": 0,
    "duplicates": 0,
    "orphan_tests": 0,
    "orphan_plan_items": 0,
    "active_lanes": 0
  },
  "waves": [
    {
      "canonical_wave_id": "W807",
      "title": "Confidence-aware adaptive routing",
      "state": "planned|in_progress|local_green|batch_ready|prod_deployed_unverified|production_verified|external_gated|superseded|killed|historical",
      "source_ids": ["W709", "W807"],
      "priority": "T0|T1|T2|T3|T4|P0|P1|P2",
      "owner_lane": "backend|frontend|research|cli|docs|production|spec",
      "master_nodes": ["31"],
      "product_surfaces": ["route_capture", "distill_compile", "run_govern"],
      "write_set": [],
      "generated_outputs": [],
      "depends_on": [],
      "supersedes": [],
      "merge_into": null,
      "claim_scope": "none|internal|docs_scoped|beta|production|external_gated",
      "tests": [],
      "proof_commands": [],
      "packet_paths": {}
    }
  ],
  "reconcile": {
    "duplicates": [],
    "orphan_tests": [],
    "orphan_plan_items": [],
    "generated_artifact_conflicts": [],
    "active_lane_conflicts": []
  }
}
```

Acceptance:

- Every W-numbered test maps to a canonical wave or is explicitly historical/orphaned.
- Every root roadmap wave maps to canonical state.
- Known duplicates have `supersedes` or `merge_into`.
- Local green, production verified, and external gated are never conflated.
- `verify:depth` eventually includes `verify:wave-registry`.

## Control File 3: Active Lanes And Write Locks

Target paths:

- `docs/active-lanes.json`
- `docs/agent-write-locks.json`

Build script to add: `scripts/build-active-lanes.cjs`

Verify script to add: `scripts/verify-active-lanes.cjs`

Minimum schema:

```json
{
  "schema": "kolm.active_lanes.v1",
  "updated_at": "iso-8601",
  "secret_values_included": false,
  "lanes": [
    {
      "lane": "frontend",
      "owner": "parallel-agent-or-human",
      "status": "active|paused|complete|blocked",
      "write_set": ["public/nav.js"],
      "generated_outputs": [],
      "conflict_paths": ["public/openapi.json"],
      "release_gate": "ui:audit:all",
      "expires_at": "iso-8601"
    }
  ]
}
```

Acceptance:

- Any shared file edit has an owner and expiry.
- Generated artifacts require exclusive lock.
- Deploy cannot be recommended with unresolved active conflicts.

## Control File 4: Catalog Manifest

Target path: `docs/catalog-manifest.json`

Build script to add: `scripts/build-catalog-manifest.cjs`

Verify script to add: `scripts/verify-catalog-manifest.cjs`

Inputs:

- `src/provider-registry.js`
- `src/model-registry.js`
- `src/models.js`
- runtime/device/cost modules
- provider/runtime smoke scripts
- official provider/model/runtime sources

Minimum schema:

```json
{
  "schema": "kolm.catalog_manifest.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "counts": {
    "providers": 0,
    "models": 0,
    "runtimes": 0,
    "devices": 0,
    "pricing_rows": 0,
    "stale_rows": 0,
    "unknown_price_rows": 0
  },
  "entries": [
    {
      "id": "openai:gpt-example",
      "kind": "provider_model|local_model|runtime|device|hardware|pricing",
      "status": "available|candidate|deprecated|removed|unknown|external_gated",
      "source_url": "https://example.com",
      "checked_at": "iso-8601",
      "freshness_ttl_days": 7,
      "license_url": null,
      "capabilities": {},
      "pricing": {},
      "runtime_fit": {},
      "device_fit": {},
      "consumer_paths": []
    }
  ]
}
```

Acceptance:

- No public/provider/model/runtime/device claim references an ID absent from the manifest.
- Unknown paid provider prices do not become zero.
- Stale rows fail visible or fail release.
- Account, API, CLI, docs, ROI, and benchmark consumers use the same IDs.

## Control File 5: Design Cascade Ledger

Target path: `docs/design-cascade-ledger.json`

Current seed: `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`

Build script to add: `scripts/build-design-cascade-ledger.cjs`

Verify script to add: `scripts/verify-design-cascade-ledger.cjs`

Inputs:

- top-level `public/*.css`
- `public/nav.js`
- public/account/docs HTML route classes
- UI audit reports

Minimum schema:

```json
{
  "schema": "kolm.design_cascade_ledger.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "counts": {
    "css_files": 0,
    "css_bytes": 0,
    "important_count": 0,
    "negative_letter_spacing_count": 0,
    "raw_color_count": 0,
    "runtime_visual_guards": 0,
    "unowned_rules": 0
  },
  "files": [
    {
      "path": "public/brand-refresh.css",
      "kind": "tokens|component|route|transitional|generated|deprecated|emergency_guard",
      "owner_node": "30",
      "route_classes": [],
      "important_count": 0,
      "raw_color_count": 0,
      "negative_letter_spacing_count": 0,
      "deletion_or_retention_plan": "string"
    }
  ],
  "exceptions": []
}
```

Acceptance:

- CSS authority is explicit.
- `!important`, raw colors, negative tracking, and runtime visual guards have owner/reason/expiry.
- The ledger can block visual completion when design debt regresses.

## Control File 6: Product Media Proof

Target path: `docs/product-media-proof.json`

Current seed: `docs/research/kolm-product-media-proof-seed-2026-05-25.md`

Build script to add: `scripts/build-product-media-proof.cjs`

Verify script to add: `scripts/verify-product-media-proof.cjs`

Minimum schema:

```json
{
  "schema": "kolm.product_media_proof.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "assets": [
    {
      "path": "public/img/example.png",
      "type": "screenshot|diagram|video|poster|demo|og|logo",
      "product_surface": "route_capture|distill_compile|run_govern|enterprise|docs|account",
      "route_paths": ["/"],
      "purpose": "string",
      "alt_or_caption": "string",
      "dark_light_proof": "pass|fail|missing",
      "mobile_desktop_proof": "pass|fail|missing",
      "reduced_motion": "pass|fail|not_applicable",
      "source_or_generation_record": "string"
    }
  ],
  "failures": []
}
```

Acceptance:

- Homepage, product, pricing, enterprise, docs, account, and demo routes use real product proof media.
- Video/demo assets have captions/transcripts/fallbacks.
- Dark/light and mobile/desktop proof exists.

## Control File 7: Production Evidence Packet

Target path: `reports/deployments/<release-id>/production-evidence.json`

Build script to add: `scripts/build-production-evidence-packet.cjs`

Verify script to add: `scripts/verify-production-evidence-packet.cjs`

Minimum schema:

```json
{
  "schema": "kolm.production_evidence_packet.v1",
  "release_id": "string",
  "secret_values_included": false,
  "commit": "string",
  "dirty_tree": false,
  "target_identity": {},
  "generated_artifacts": {},
  "env_profile": {},
  "public_smoke": {},
  "auth_smoke": {},
  "screenshots": {},
  "telemetry": {},
  "rollback": {},
  "status_decision": {},
  "watch_windows": [],
  "sha256_manifest": "SHA256SUMS"
}
```

Acceptance:

- Ties `https://kolm.ai` to exact commit/deploy/env/generated artifacts.
- Public and auth smoke reports are retained.
- Production screenshots are retained.
- Rollback and telemetry are documented.
- No secret values are printed.

## Control File 8: Final Build Redline

Target path: `reports/build-redline/final-build-redline.json`

Build script to add: `scripts/build-final-build-redline.cjs`

Verify script to add: `scripts/verify-final-build-redline.cjs`

Minimum schema:

```json
{
  "schema": "kolm.final_build_redline.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "state": "open|candidate|failed|closed",
  "inputs": {
    "codebase_file_ledger": "docs/codebase-file-ledger.json",
    "wave_registry": "docs/wave-registry.json",
    "active_lanes": "docs/active-lanes.json",
    "catalog_manifest": "docs/catalog-manifest.json",
    "design_cascade_ledger": "docs/design-cascade-ledger.json",
    "product_media_proof": "docs/product-media-proof.json",
    "production_evidence": "reports/deployments/<release-id>/production-evidence.json"
  },
  "gates": {
    "clean_git": "pass|fail",
    "generated_artifacts_current": "pass|fail",
    "release_verify": "pass|fail",
    "local_surfaces": "pass|fail",
    "prod_surfaces": "pass|fail",
    "visual_proof": "pass|fail",
    "account_matrix": "pass|fail",
    "claim_scope": "pass|fail",
    "external_gates_scoped": "pass|fail"
  },
  "open_blockers": []
}
```

Acceptance:

- Final state cannot be `closed` unless every P0 control file validates.
- The packet can be audited without reading chat history.
- It distinguishes external-gated truth from local completion.

## Package Script Targets To Add

The implementation agent should add scripts with these names:

```json
{
  "build:file-ledger": "node scripts/build-codebase-file-ledger.cjs",
  "verify:file-ledger": "node scripts/verify-codebase-file-ledger.cjs",
  "build:wave-registry": "node scripts/build-wave-registry.cjs",
  "verify:wave-registry": "node scripts/verify-wave-registry.cjs",
  "build:active-lanes": "node scripts/build-active-lanes.cjs",
  "verify:active-lanes": "node scripts/verify-active-lanes.cjs",
  "build:catalog-manifest": "node scripts/build-catalog-manifest.cjs",
  "verify:catalog-manifest": "node scripts/verify-catalog-manifest.cjs",
  "build:design-cascade-ledger": "node scripts/build-design-cascade-ledger.cjs",
  "verify:design-cascade-ledger": "node scripts/verify-design-cascade-ledger.cjs",
  "build:product-media-proof": "node scripts/build-product-media-proof.cjs",
  "verify:product-media-proof": "node scripts/verify-product-media-proof.cjs",
  "build:production-evidence": "node scripts/build-production-evidence-packet.cjs",
  "verify:production-evidence": "node scripts/verify-production-evidence-packet.cjs",
  "build:final-redline": "node scripts/build-final-build-redline.cjs",
  "verify:final-redline": "node scripts/verify-final-build-redline.cjs"
}
```

After the scripts are implemented, `verify:depth` should eventually include:

```text
npm run verify:file-ledger
npm run verify:wave-registry
npm run verify:active-lanes
npm run verify:catalog-manifest
npm run verify:design-cascade-ledger
npm run verify:product-media-proof
npm run verify:production-evidence
npm run verify:final-redline
```

## Immediate Build Strategy

Do not try to make all files perfect in one pass. Build them in this order:

1. File ledger in warn mode.
2. Wave registry in warn mode.
3. Active lanes in manual seed mode.
4. Catalog manifest from local modules only.
5. Design cascade ledger from static scans.
6. Product media proof from static routes and screenshot reports.
7. Production evidence packet from explicit release ID.
8. Final build redline as read-only aggregate.

Then tighten each from warn mode to fail mode.

## Completion Rule

This spec is complete only when the listed control files exist, validate, and are referenced by the consolidated review and the master blueprint. The product is complete only when the final build redline closes against the current production deployment.
