# Kolm P0 Control Files Implementation Spec

Date: 2026-05-25

Purpose: turn the consolidated master spec into buildable control files, packets, reports, and verifiers. This is the bridge between the large research archive and the actual codebase finish line.

Implementation sequence and script reuse details are in `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`.

## Current Tree Finding

The consolidated review named the P0 control files that should exist before Kolm can claim real completion. A current worktree check found that the first wave now exists under `docs/internal/`, not the older root `docs/` paths this spec originally named. Treat `docs/internal/` as the internal generated-control namespace unless a file is intentionally customer-facing.

| Artifact | Current path | Exists now | Current live count / next redline |
|---|---|---:|---|
| Wave registry | `docs/internal/wave-registry.json` | yes | 551 waves; still has 323 test-only and 93 plan-only waves that need canonical resolution. |
| Wave registry schema | `docs/internal/wave-registry.schema.json` | yes | Schema exists; next redline is enforcing active lane ownership and generated-output locks. |
| Wave reconcile report | `docs/internal/wave-reconcile-report.json` | yes | Exists; must feed final build redline and stop being a detached report. |
| Active lanes | `docs/internal/active-lanes.json` | no | Still needed to prevent frontend/backend/research/CLI/spec collisions. |
| Design cascade ledger | `docs/internal/design-cascade-ledger.json` | yes | 729 public HTML pages, 19 CSS files, 3,873 CSS `!important` uses, 1,524 raw CSS hex values, 75 negative letter-spacing uses, 3,215 inline styles; cleanup is still open. |
| Product media proof | `docs/internal/product-media-proof.json` | yes | 3,710 media refs, 0 missing local media, 4 image dimension gaps; next redline is usefulness/primary-proof ownership, not existence. |
| Catalog manifest | `docs/internal/catalog-manifest.json` | yes | 132 provider/model/device/runtime entries; must add freshness enforcement and all consumer parity checks. |
| Codebase file ledger | `docs/internal/codebase-file-ledger.json` | yes | 3,673 paths, 0 unowned paths, 24 dirty paths, 22 untracked paths; final completion still requires scratch cleanup and clean release state. |
| API contract matrix | `docs/internal/api-contract-matrix.json` | no | Current generated API surface has OpenAPI `3.0.3`, 556 paths, 586 operations, 11 missing `operationId`, 583 missing operation-level security, 282 mutating operations without request bodies, and 127 source-indexed/stub routes; contracts must replace route scraping. |
| OpenAPI dialect policy | `docs/internal/openapi-dialect-policy.json` | no | Required to pin OpenAPI `3.2.0` or stable `3.1.2`, JSON Schema dialect, generator compatibility, webhook/streaming treatment, and migration away from non-final `3.0.3`. |
| Data plane contract | `docs/internal/data-plane-contract.json` | no | Required to reconcile `src/store.js` JSON/SQLite facade, separate `src/event-store.js`, typed `src/event-schema.js`, dormant cloud store drivers, object storage, migrations, indexes, tenant fences, and durability truth. |
| Env/secret contract | `docs/internal/env-secret-contract.json` | no | Required because local source scan found 378 direct `process.env.*` variables and `.env.example` is partial/stale; it must generate env docs, secret policy, readiness expectations, and no-leak checks. |
| Data retention/backup contract | `docs/internal/data-retention-backup-contract.json` | no | Required to bind `src/audit-retention.js`, event retention, account deletion/export, backup, restore, RPO/RTO, legal hold, deletion, and restore-drill evidence. |
| Tenant data boundary contract | `docs/internal/tenant-data-boundary-contract.json` | no | Required to standardize tenant id/name/email use, tenant fences, admin overrides, OAuth claim/merge, key rotation, residency, export-control source ownership, and lifecycle data effects. |
| Release boundary manifest | `docs/internal/release-boundary-manifest.json` | no | Required because `.gitignore` and `.vercelignore` exist but no `.dockerignore` exists while `Dockerfile` uses `COPY . .`; release bundles need a manifest-backed include/exclude proof. |
| CI release pipeline contract | `docs/internal/ci-release-pipeline-contract.json` | no | Required because current local gates, GitHub workflows, product-template workflows, SBOM job, release verify, smoke jobs, and package-readiness checks are not one required release-control plane. |
| CI required checks policy | `docs/internal/ci-required-checks-policy.json` | no | Required to define merge, release-candidate, production-deploy, and post-deploy checks, plus flake, retry, skip, timeout, artifact-retention, and owner escalation policy. |
| Release artifact evidence matrix | `docs/internal/release-artifact-evidence-matrix.json` | no | Required because package-release readiness currently has 16 structurally-present targets but `publish_ready=false` and all channels are pending signed registry/artifact evidence. |
| SBOM/provenance contract | `docs/internal/sbom-provenance-contract.json` | no | Required because the SBOM workflow uploads SBOM artifacts but does not bind SBOM/provenance/signature evidence to each release subject and deployed release ID. |
| SDK API parity | `docs/internal/sdk-api-parity.json` | no | Required to prove Node, Python, Rust, C, MCP, VS Code, TypeScript/browser, React Native, Swift, Kotlin, integrations, and installers cover the API honestly. |
| Docs IA contract | `docs/internal/docs-ia-contract.json` | no | Required to turn broad docs into runnable tutorial/how-to/reference/explanation paths for each product loop. |
| Developer docs shell contract | `docs/internal/developer-docs-shell-contract.json` | no | Required because current local source shows 221 docs HTML pages, 48 docs pages with bad `繚` separators, 141 missing `/nav.js`, 51 missing `/ks.css`, and 170 missing `/surface-polish.css`. |
| API reference contract | `docs/internal/api-reference-contract.json` | no | Required because `/api`, `/docs/api`, `public/openapi.json`, and `public/docs/api-routes.json` currently disagree on route count, auth header framing, envelope truth, examples, and source-indexed status. |
| Docs sample contract | `docs/internal/docs-sample-contract.json` | no | Required because docs contain stale key placeholders and hand-maintained examples that are not tied to route/CLI/SDK contract output or expected results. |
| SDK package truth matrix | `docs/internal/sdk-package-truth-matrix.json` | no | Required because SDK docs and local SDK/package READMEs currently mix browser bundle proof, source-only local installs, unpublished package states, and name-blocked package channels. |
| Product feature completion matrix | `docs/internal/product-feature-completion-matrix.json` | no | Required to prove each feature is done as behavior, API, account UI, public page, CLI, TUI, SDK, docs, tests, readiness, UI states, and production proof. |
| Account product matrix | `docs/internal/account-product-matrix.json` | no | Required to classify all 51 account HTML pages by journey, feature, data state, API route, UI state, and authenticated smoke. |
| Page family contracts | `docs/internal/page-family-contracts.json` | no | Required to govern homepage, product pages, docs, pricing, trust, comparisons, verticals, account pages, demos, and content pages. |
| Component and nav contracts | `docs/internal/component-state-contracts.json`, `docs/internal/nav-contract.json` | no | Required to fix buttons, nav underlines/popovers, interaction states, mobile behavior, focus states, and component consistency. |
| Account shell contract | `docs/internal/account-shell-contract.json` | no | Required because current local source shows 51 account page-local style blocks, 44 account pages missing `/nav.js`, 50 missing `/surface-polish.css`, 10 missing `account-sidebar`, and 17 source files with the bad `繚` separator. |
| Account nav manifest | `docs/internal/account-nav-manifest.json` | no | Required because account navigation currently lives in duplicated account HTML plus runtime `public/nav.js` sidebar repair rather than one generated account route/journey/CLI/TUI manifest. |
| Component interaction state contract | `docs/internal/component-interaction-state-contract.json` | no | Required to make buttons, links, nav, popovers, forms, tables, cards, demos, videos, calculators, chat, and account widgets share one token/state model across light/dark/mobile/auth states. |
| UI accessibility/performance contract | `docs/internal/ui-accessibility-performance-contract.json` | no | Required to bind WCAG 2.2, WAI-ARIA nav behavior, Core Web Vitals LCP/INP/CLS, skeleton/media stability, no-auth/auth/error/partial account states, and production field proof. |
| Nav runtime debt ledger | `docs/internal/nav-runtime-debt-ledger.json` | no | Required because `public/nav.js` is currently shell composer, account injector, media injector, copy repair, auth affordance, trust ribbon, and emergency CSS patcher; only true runtime behavior should remain there. |
| Account product journey state machine | `docs/internal/account-product-journey-state-machine.json` | no | Required to make post-auth route/capture, distill/compile, and run/govern workflows explicit as object state, next action, readiness, proof, and fallback states. |
| Generated artifact manifest | `docs/internal/generated-artifact-manifest.json` | no | Required to register every generated file, generator, input, check command, downstream consumer, release inclusion, and write lock. |
| Observability contract | `docs/internal/observability-contract.json` | no | Required to prove traces, metrics, logs/events, SLOs, alerts, dashboards, owners, and runbooks by product journey. |
| Security release contract | `docs/internal/security-release-contract.json` | no | Required to tie ASVS/API controls, headers, auth, object authorization, rate limits, webhooks, CORS/CSP, secret handling, SBOM/provenance, and incident response to release evidence. |
| Production evidence packet | `reports/deployments/<release-id>/production-evidence.json` | no | Still required; local proof is not production proof. |
| Final build redline | `reports/build-redline/final-build-redline.json` | no | Still required; this is the completion certificate that consumes all control files and live prod evidence. |

Related scripts already exist and should be reused rather than rewritten from scratch: `build-api-ref.cjs`, `build-openapi.cjs`, `build-product-graph.cjs`, `build-readiness-closeout.cjs`, `build-codegraph.mjs`, `verify-product-surfaces.cjs`, `audit-claim-scope.cjs`, `local-surface-smoke.cjs`, `prod-surface-smoke.cjs`, `release-verify.cjs`, `ui-surface-audit.cjs`, `build-sitemap.cjs`, `seo-audit.cjs`, `smoke-models.mjs`, `smoke-device-bind.mjs`, and the invention/frontier simulation scripts.

Correction to the original spec: the problem is no longer "none of the control files exist." The problem is that existing generated ledgers are not yet a finished master spec tree: they are not all source/projection classified, not all wired into a final build packet, not all production-proved, and not all tied back to route contracts, page-family contracts, account UX, claim scope, and release evidence.

## External Rules To Follow

| Source | Rule imported |
|---|---|
| JSON Schema 2020-12, https://json-schema.org/draft/2020-12/json-schema-core | Every control file should have a schema and machine validation, not just prose. |
| OpenAPI Specification 3.2.0, https://spec.openapis.org/oas/latest | The API description must be a complete contract for humans and tooling, not a best-effort scraped inventory. |
| RFC 9457 Problem Details, https://www.rfc-editor.org/rfc/rfc9457.html | API errors should use typed problem details so account UI, SDKs, and docs can render failures without parsing strings. |
| OWASP API Security Top 10 2023, https://owasp.org/www-project-api-security/ | Every route contract must include object authorization, tenant scope, function authorization, rate/resource limits, and unsafe-upstream policy. |
| OWASP ASVS, https://owasp.org/www-project-application-security-verification-standard/ | Security release evidence should map to a recognized application security verification baseline, not just ad hoc headers. |
| OpenTelemetry HTTP and GenAI semantic conventions, https://opentelemetry.io/docs/specs/semconv/ | Production telemetry should use standard HTTP and GenAI span/metric names where possible, with `kolm.*` only for product-specific attributes. |
| DORA deployment metrics, https://docs.cloud.google.com/deploy/docs/metrics | Production evidence should record deployment frequency, lead time, change failure, and restore/rollback signals where measurable. |
| Diataxis, https://diataxis.fr/ | Docs must be separated by user need: tutorial, how-to guide, technical reference, and explanation. |
| Command Line Interface Guidelines, https://clig.dev/ | CLI help and examples must be version-local, predictable, scriptable, and aligned with API/docs behavior. |
| GitHub CODEOWNERS, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners | Ownership should be explicit; CODEOWNERS has location, syntax, and size constraints, so Kolm also needs a richer internal file ledger. |
| GitHub workflow artifacts, https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts | Test logs, screenshots, binaries, performance output, and coverage-style evidence should be retained as artifacts, not lost in console output. |
| SLSA provenance v1.1, https://slsa.dev/spec/v1.1/provenance | Packets should record inputs, build definition, run details, builder identity, parameters, dependencies, and subjects/hashes. |
| Twelve-Factor App config, https://www.12factor.net/config | Deploy-specific config must be separated from code and injected per environment; Kolm's env inventory must be generated and audited, not scattered through 378 direct reads. |
| OWASP Secrets Management Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html | Secrets need centralized storage, provisioning, auditing, rotation, and management; local vault support is not the same as production secret-manager proof. |
| NIST SP 800-53 Rev. 5 contingency planning, https://csrc.nist.gov/Pubs/sp/800/53/r5/upd1/Final | Backup, recovery, contingency planning, and resilience evidence must be explicit for production data-plane trust claims. |
| GitHub Artifact Attestations, https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds | GitHub-built binaries, packages, archives, and images should have attestations that prove build provenance and subject digests. |
| npm provenance, https://docs.npmjs.com/generating-provenance-statements | npm package publication should attach provenance where supported and should be verifiable from the package registry. |
| CycloneDX specification, https://cyclonedx.org/specification/overview | SBOM evidence should use a standard machine-readable BOM format and bind each BOM to its release subject. |
| OpenSSF Scorecard, https://openssf.org/scorecard/ | External security posture scoring can be tracked as a hygiene signal, but it cannot replace Kolm's own release evidence. |

## Build Order

Do not build these files in arbitrary order. The correct sequence is:

1. `docs/internal/codebase-file-ledger.json`
2. `docs/internal/wave-registry.json` and `docs/internal/wave-registry.schema.json`
3. `docs/internal/active-lanes.json`
4. `docs/internal/catalog-manifest.json`
5. `docs/internal/data-plane-contract.json`
6. `docs/internal/env-secret-contract.json`
7. `docs/internal/data-retention-backup-contract.json`
8. `docs/internal/tenant-data-boundary-contract.json`
9. `docs/internal/api-contract-matrix.json` and `docs/internal/openapi-dialect-policy.json`
10. `docs/internal/sdk-api-parity.json`
11. `docs/internal/sdk-package-truth-matrix.json`
12. `docs/internal/docs-ia-contract.json`
13. `docs/internal/developer-docs-shell-contract.json`
14. `docs/internal/api-reference-contract.json`
15. `docs/internal/docs-sample-contract.json`
16. `docs/internal/product-feature-completion-matrix.json`
17. `docs/internal/account-product-matrix.json`
18. `docs/internal/account-shell-contract.json`
19. `docs/internal/account-nav-manifest.json`
20. `docs/internal/account-product-journey-state-machine.json`
21. `docs/internal/page-family-contracts.json`, `docs/internal/component-state-contracts.json`, and `docs/internal/nav-contract.json`
22. `docs/internal/component-interaction-state-contract.json`
23. `docs/internal/ui-accessibility-performance-contract.json`
24. `docs/internal/nav-runtime-debt-ledger.json`
25. `docs/internal/design-cascade-ledger.json`
26. `docs/internal/product-media-proof.json`
27. `docs/internal/generated-artifact-manifest.json`
28. `docs/internal/observability-contract.json`
29. `docs/internal/security-release-contract.json`
30. `docs/internal/release-boundary-manifest.json`
31. `docs/internal/ci-release-pipeline-contract.json`
32. `docs/internal/ci-required-checks-policy.json`
33. `docs/internal/release-artifact-evidence-matrix.json`
34. `docs/internal/sbom-provenance-contract.json`
35. `reports/deployments/<release-id>/production-evidence.json`
36. `reports/build-redline/final-build-redline.json`

Reason: file ownership comes before wave ownership; wave ownership comes before lane locks; catalog truth and data-plane truth feed route contracts; route contracts feed OpenAPI, SDKs, docs, account UX, CLI help, design proof, and production proof; release-boundary truth must be known before production evidence can certify a build artifact; CI and artifact/provenance truth must be known before any package or deploy can be called shipped; final build redline consumes all prior packets.

## Control File 1: Codebase File Ledger

Target path: `docs/internal/codebase-file-ledger.json`

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

- `docs/internal/wave-registry.json`
- `docs/internal/wave-registry.schema.json`
- `docs/internal/wave-reconcile-report.json`

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

- `docs/internal/active-lanes.json`
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

Target path: `docs/internal/catalog-manifest.json`

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

Target path: `docs/internal/design-cascade-ledger.json`

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

Target path: `docs/internal/product-media-proof.json`

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

## Control File 7: API Contract Matrix

Target paths:

- `docs/internal/api-contract-matrix.json`
- `docs/internal/route-security-matrix.json`
- `docs/internal/api-error-catalog.json`
- `docs/internal/idempotency-matrix.json`

Build script to add: `scripts/build-api-contract-matrix.cjs`

Verify script to add: `scripts/verify-api-contracts.cjs`

Inputs:

- `src/router.js`
- `src/oauth.js`
- `src/envelope.js`
- `docs/product-surfaces.json`
- `public/product-graph.json`
- `public/docs/api-routes.json`
- `public/openapi.json`
- `cli/kolm.js`
- `public/account/**/*.html`
- `sdk/`
- `packages/`

Minimum schema:

```json
{
  "schema": "kolm.api_contract_matrix.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "summary": {
    "routes": 0,
    "production_contract": 0,
    "source_indexed": 0,
    "missing_security": 0,
    "missing_schema": 0,
    "missing_idempotency": 0
  },
  "routes": [
    {
      "route_id": "string",
      "operation_id": "string",
      "method": "GET|POST|PUT|PATCH|DELETE",
      "path": "/v1/example",
      "status": "production_contract|beta_contract|local_only|external_gated|source_indexed|deprecated_alias|internal_hidden|remove",
      "surface": "string",
      "journey": "string",
      "owner": "backend|frontend|cli|docs|research",
      "auth": "none|api_key|session|admin|service",
      "tenant_scope": "none|tenant|user|org|artifact|device|deployment",
      "object_scope": "none|path_param|body_param|derived_from_session|server_generated",
      "request_schema": "schema_id|null",
      "response_schema": "schema_id",
      "problem_types": ["problem.type"],
      "idempotency": "not_applicable|required|supported|forbidden",
      "audit_event": "event.name|null",
      "sdk_exposure": "all|selected|none",
      "account_exposure": "required|optional|none",
      "cli_exposure": "required|optional|none",
      "production_smoke": "required|optional|not_applicable",
      "claim_scope": "shipped|local_only|external_gated|do_not_market"
    }
  ]
}
```

Acceptance:

- No public `/v1/*` route is ownerless, schema-less, security-less, or claim-scope-less.
- Mutating operations declare body, idempotency, audit event, and problem types.
- `source_indexed` routes cannot be SDK-generated or marketed as product-complete.
- API docs, OpenAPI, SDK parity, account actions, and CLI examples consume this matrix.

## Control File 8: OpenAPI Dialect Policy

Target path: `docs/internal/openapi-dialect-policy.json`

Build script to add: `scripts/build-openapi-dialect-policy.cjs`

Verify script to add: `scripts/verify-openapi-dialect-policy.cjs`

Minimum schema:

```json
{
  "schema": "kolm.openapi_dialect_policy.v1",
  "target_openapi": "3.2.0|3.1.2",
  "json_schema_dialect": "https://json-schema.org/draft/2020-12/schema",
  "compatibility_target": "sdk_generation|docs_generation|gateway_import|mixed",
  "fallback_openapi": "3.1.2|null",
  "disallowed_final_versions": ["3.0.3"],
  "required_sections": ["securitySchemes", "operationId", "requestBody", "responses", "schemas", "examples", "problemDetails"],
  "streaming_policy": "sse|ndjson|websocket|documented_extension",
  "webhook_policy": "callbacks|webhooks|documented_external",
  "generator_order": ["api-contract-matrix", "schemas", "openapi", "api-docs", "sdk-parity"]
}
```

Acceptance:

- `public/openapi.json` is not accepted as final while it is `3.0.3`.
- OpenAPI generation fails when operation IDs, security, request/response schemas, or problem details are missing for production routes.
- Generator order is serial and deterministic so one generator cannot read a half-written artifact from another.

## Control File 9: SDK API Parity

Target paths:

- `docs/internal/sdk-api-parity.json`
- `docs/internal/sdk-capability-matrix.json`
- `docs/internal/sdk-generation-manifest.json`

Build script to add: `scripts/build-sdk-capability-matrix.cjs`

Verify script to add: `scripts/verify-sdk-api-parity.cjs`

Minimum schema:

```json
{
  "schema": "kolm.sdk_api_parity.v1",
  "generated_at": "iso-8601",
  "packages": [
    {
      "id": "sdk-node",
      "path": "sdk/node",
      "language": "javascript|python|rust|c|typescript|swift|kotlin|react-native|mcp|vscode|browser",
      "release_state": "source_preview|local_build|package_ready|published|deprecated",
      "generated_client": true,
      "handwritten_wrapper": true,
      "route_coverage": {
        "supported": 0,
        "unsupported": 0,
        "unsupported_policy": "documented"
      },
      "capabilities": ["auth", "typed_errors", "idempotency", "streaming", "uploads", "downloads", "artifact_verify", "local_files"],
      "examples": ["path"],
      "build_command": "string",
      "test_command": "string",
      "package_command": "string",
      "published_artifact": "url|null"
    }
  ]
}
```

Acceptance:

- Each SDK declares installability, route coverage, unsupported operations, generated-source state, and typed error behavior.
- SDK docs cannot advertise a package as installable until its release state says `package_ready` or `published`.
- Route payloads come from API schemas, not hand-maintained duplicate shapes.

## Control File 9A: SDK Package Truth Matrix

Target paths:

- `docs/internal/sdk-package-truth-matrix.json`
- `docs/internal/sdk-package-truth-matrix.md`

Build script to add: `scripts/build-sdk-package-truth-matrix.cjs`

Verify script to add: `scripts/verify-sdk-package-truth.cjs`

Inputs:

- `sdk/**/README.md`
- `sdk/**/package.json`
- `sdk/**/pyproject.toml`
- `sdk/**/Cargo.toml`
- `packages/**/README.md`
- `packages/**/package.json`
- `packages/**/pyproject.toml`
- `packages/**/Cargo.toml`
- `packages/**/Package.swift`
- `packages/**/build.gradle*`
- `public/sdk-current.json`
- package release readiness reports
- SBOM/provenance contracts
- API and SDK parity matrices

Minimum schema:

```json
{
  "schema": "kolm.sdk_package_truth_matrix.v1",
  "generated_at": "iso-8601",
  "packages": [
    {
      "id": "sdk-node",
      "source_path": "sdk/node",
      "language": "javascript",
      "package_name": "@kolm/kolm-sdk",
      "registry": "npm",
      "registry_owner": "kolm|unrelated|unknown",
      "release_state": "source_preview|local_build|package_ready|published|name_blocked|deprecated",
      "install_commands_allowed": ["local_checkout"],
      "docs_pages": ["/docs/sdk"],
      "public_copy_allowed": "local_source_only|package_installable|published|do_not_market",
      "smoke_command": "npm test",
      "known_unsupported_operations": ["string"],
      "proof_paths": ["path"]
    }
  ]
}
```

Acceptance:

- SDK docs and package READMEs cannot disagree on package publication state.
- Name-blocked packages, unpublished packages, source-only local checkouts, and browser-bundle-only SDKs are labeled explicitly.
- `/docs/sdk`, `/sdks`, SDK READMEs, package release readiness, and release artifact evidence consume this matrix.
- No public install command appears unless the package state allows it.

## Control File 10: Docs IA Contract

Target paths:

- `docs/internal/docs-ia-contract.json`
- `public/docs/docs-index.json`
- `public/docs/search-index.json`

Build script to add: `scripts/build-docs-ia.cjs`

Verify script to add: `scripts/verify-docs-ia.cjs`

Minimum schema:

```json
{
  "schema": "kolm.docs_ia_contract.v1",
  "generated_at": "iso-8601",
  "journeys": [
    {
      "journey": "gateway-capture",
      "tutorial": "public/docs/start/capture.html",
      "how_to": "public/docs/how-to/capture-production-traffic.html",
      "reference": "public/docs/api.html#capture",
      "explanation": "public/docs/explain/capture-to-artifact.html",
      "api_routes": ["/v1/example"],
      "cli_commands": ["kolm capture"],
      "sdk_examples": ["sdk/node/examples/capture.js"],
      "expected_output": "present",
      "failure_modes": "present",
      "account_destination": "/account/connectors"
    }
  ]
}
```

Acceptance:

- Every product journey has a tutorial, how-to, reference, and explanation.
- Every runnable sample includes prerequisites, env vars, exact command, expected output, cleanup, failure cases, and account/API/CLI equivalents.
- Docs search and page nav derive from the same IA contract instead of ad hoc links.

## Control File 10A: Developer Docs Shell Contract

Target paths:

- `docs/internal/developer-docs-shell-contract.json`
- `docs/internal/developer-docs-shell-contract.md`

Build script to add: `scripts/build-developer-docs-shell-contract.cjs`

Verify script to add: `scripts/verify-developer-docs-shell.cjs`

Inputs:

- `public/docs/**/*.html`
- `public/api.html`
- `public/quickstart.html`
- `public/sdks.html`
- `public/docs/sdk.html`
- docs shell CSS/JS files
- `public/nav.js`
- `docs/internal/page-family-contracts.json`
- `docs/internal/ui-accessibility-performance-contract.json`

Minimum schema:

```json
{
  "schema": "kolm.developer_docs_shell_contract.v1",
  "generated_at": "iso-8601",
  "pages": [
    {
      "path": "/docs/api",
      "source_path": "public/docs/api.html",
      "doc_type": "tutorial|how_to|reference|explanation|index|archive|remove",
      "product_loop": "route_capture|distill_compile|run_govern|cross_product",
      "shell_family": "docs_shell|public_ks_shell|legacy_docs_shell|archive",
      "loads": {
        "ks_css": true,
        "surface_polish_css": true,
        "warm_paper_css": true,
        "nav_js": true
      },
      "metadata": {
        "has_mojibake": false,
        "title_policy": "ascii_separator",
        "description_within_budget": true
      },
      "local_debt": {
        "style_tags": 0,
        "style_attributes": 0,
        "script_tags": 0,
        "test_anchors": 0
      }
    }
  ]
}
```

Acceptance:

- All public docs pages are classified by Diataxis type and product loop.
- Bad `繚` separators, hidden test anchors, unowned shell variants, and missing docs shell assets fail the verifier.
- Docs nav, metadata, stylesheet sets, skip-link policy, and accessibility behavior are generated or declared by one docs shell contract.

## Control File 10B: API Reference And Docs Sample Contracts

Target paths:

- `docs/internal/api-reference-contract.json`
- `docs/internal/api-reference-contract.md`
- `docs/internal/docs-sample-contract.json`
- `docs/internal/docs-sample-contract.md`

Build scripts to add:

- `scripts/build-api-reference-contract.cjs`
- `scripts/build-docs-sample-contract.cjs`

Verify scripts to add:

- `scripts/verify-api-reference-contract.cjs`
- `scripts/verify-docs-samples.cjs`

Minimum API reference schema:

```json
{
  "schema": "kolm.api_reference_contract.v1",
  "generated_at": "iso-8601",
  "sources": ["docs/internal/api-contract-matrix.json", "public/openapi.json", "public/docs/api-routes.json"],
  "surfaces": [
    {
      "page": "/docs/api",
      "role": "exhaustive_reference",
      "route_count_source": "api_contract_matrix",
      "auth_header_policy": "authorization_bearer_ks|x_api_key_alias|both_documented",
      "envelope_policy": "problem_details|kolm_envelope|hybrid_documented",
      "source_indexed_policy": "visible_not_market_ready"
    },
    {
      "page": "/api",
      "role": "guided_api_map",
      "route_count_source": "api_contract_matrix",
      "auth_header_policy": "authorization_bearer_ks|x_api_key_alias|both_documented",
      "envelope_policy": "problem_details|kolm_envelope|hybrid_documented",
      "source_indexed_policy": "visible_not_market_ready"
    }
  ]
}
```

Minimum docs sample schema:

```json
{
  "schema": "kolm.docs_sample_contract.v1",
  "generated_at": "iso-8601",
  "samples": [
    {
      "sample_id": "quickstart-route-call",
      "source_path": "public/quickstart.html",
      "language": "bash",
      "surface": "route_capture",
      "route_or_cli": "/v1/chat/completions",
      "required_env": ["KOLM_API_KEY"],
      "placeholder_policy": "ks_placeholder_only",
      "secret_safe": true,
      "expected_output": "declared",
      "cleanup": "not_applicable",
      "verification": "smoke_tested|syntax_checked|generated|illustrative_only"
    }
  ]
}
```

Acceptance:

- `/api`, `/docs/api`, `public/openapi.json`, `public/docs/api-routes.json`, SDK examples, CLI REST hints, and account actions use the same route facts.
- Route count, auth header, key shape, base URL, envelope, request/response schemas, problem types, examples, and source-indexed/beta status cannot diverge between API pages.
- Every sample either runs in CI/local smoke or is clearly marked illustrative-only with no stale keys, package claims, or unsupported payloads.

## Control File 11: Product Feature Completion Matrix

Target paths:

- `docs/internal/product-feature-completion-matrix.json`
- `docs/internal/product-feature-completion-matrix.md`

Build script to add: `scripts/build-product-feature-completion-matrix.cjs`

Verify script to add: `scripts/verify-product-feature-completion-matrix.cjs`

Inputs:

- `public/product-graph.json`
- `docs/product-surfaces.json`
- `docs/product-journeys.json`
- `docs/product-sota-readiness.json`
- `docs/readiness-gate-workorders.json`
- `docs/internal/codebase-file-ledger.json`
- `docs/internal/catalog-manifest.json`
- `docs/internal/design-cascade-ledger.json`
- `docs/internal/product-media-proof.json`
- `docs/internal/api-contract-matrix.json`
- `docs/internal/sdk-api-parity.json`
- `docs/internal/docs-ia-contract.json`
- account pages, public pages, CLI help, TUI views, tests, and package scripts

Minimum schema:

```json
{
  "schema": "kolm.product_feature_completion_matrix.v1",
  "generated_at": "iso-8601",
  "features": [
    {
      "feature_id": "gateway-capture.capture-first-call",
      "journey_id": "gateway-capture",
      "route_surface_id": "capture-data-eval-training",
      "user_outcome": "string",
      "first_value_path": "string",
      "source_files": ["src/capture.js"],
      "account_pages": ["/account/connectors"],
      "public_pages": ["/capture"],
      "api_routes": ["/v1/capture/openai"],
      "cli_commands": ["kolm capture --provider openai --as local"],
      "tui_views": ["connectors"],
      "sdk_methods": ["capture.openai"],
      "docs_pages": ["/docs/start/capture"],
      "tests": ["tests/wave498-capture-route-contract.test.js"],
      "proof_commands": ["kolm capture --provider openai --as local --json"],
      "uiux_states": ["loading", "empty", "error", "partial", "success"],
      "readiness_status": "shipped|implemented|needs_public_benchmark_data|needs_package_release|needs_external_partner|needs_live_certification",
      "claim_scope": "public_claim_allowed|scoped_claim_only|do_not_market",
      "production_smoke": "required|not_applicable",
      "owner_lane": "backend|frontend|cli|docs|research|release",
      "next_build_cut": "string"
    }
  ]
}
```

Acceptance:

- Every product graph journey has at least one first-value feature and one mature-operating feature.
- Every feature maps to behavior, API, account, public page, docs, CLI/TUI, tests, UI states, readiness, and claim scope.
- Features with external/package/benchmark/certification blockers are visible and cannot be marketed as final.

## Control File 12: Account Product Matrix

Target paths:

- `docs/internal/account-product-matrix.json`
- `docs/internal/account-product-matrix.md`

Build script to add: `scripts/build-account-product-matrix.cjs`

Verify script to add: `scripts/verify-account-product-matrix.cjs`

Minimum schema:

```json
{
  "schema": "kolm.account_product_matrix.v1",
  "generated_at": "iso-8601",
  "pages": [
    {
      "page_id": "overview",
      "path": "/account/overview",
      "mode": "live_tenant_dashboard|setup_wizard|generated_report|reference|experimental_wave|archive|remove",
      "journey_ids": ["gateway-capture"],
      "feature_ids": ["gateway-capture.capture-first-call"],
      "api_routes": ["/v1/product/graph"],
      "cli_equivalents": ["kolm surfaces --json"],
      "tui_views": ["connectors"],
      "primary_action": "string",
      "state_model": ["loading", "empty", "error", "partial", "success", "no_auth", "no_credentials"],
      "data_safety": ["tenant_scoped", "secret_values_included:false"],
      "claim_scope": "public_claim_allowed|scoped_claim_only|do_not_market",
      "uiux_proof": {
        "desktop_dark": "pass|fail|missing",
        "desktop_light": "pass|fail|missing",
        "mobile_dark": "pass|fail|missing",
        "mobile_light": "pass|fail|missing",
        "keyboard": "pass|fail|missing"
      },
      "auth_smoke": {
        "local": "pass|fail|missing",
        "production": "pass|fail|missing"
      }
    }
  ]
}
```

Acceptance:

- All 51 local account HTML pages are classified.
- No page is outside a product journey, deliberate reference/archive mode, or remove decision.
- Account overview exposes the three product loops, readiness gates, storage/cloud state, billing state, and next actions.

## Control File 13: Page Family, Component State, And Nav Contracts

Target paths:

- `docs/internal/page-family-contracts.json`
- `docs/internal/component-state-contracts.json`
- `docs/internal/nav-contract.json`

Build script to add: `scripts/build-page-family-contracts.cjs`

Verify script to add: `scripts/verify-page-family-contracts.cjs`

Minimum schema:

```json
{
  "schema": "kolm.page_family_contracts.v1",
  "generated_at": "iso-8601",
  "families": [
    {
      "family_id": "homepage-category-entry",
      "routes": ["/"],
      "first_screen_promise": "string",
      "primary_cta": "string",
      "secondary_cta": "string",
      "proof_component": "demo|video|calculator|product-screenshot|live-widget",
      "media_requirement": "real_product_proof",
      "account_destination": "/account/overview",
      "docs_destination": "/docs/start",
      "api_destination": "/docs/api",
      "seo_schema": ["SoftwareApplication", "WebApplication", "BreadcrumbList"],
      "component_requirements": ["button", "nav", "popover", "form", "table", "status-token"],
      "accessibility_gates": ["wcag_2_2_aa", "keyboard", "focus_visible", "target_size"],
      "performance_gates": ["lcp", "inp", "cls"],
      "visual_exception_budget": {
        "raw_hex": 0,
        "important": 0,
        "inline_style": 0,
        "negative_letter_spacing": 0
      }
    }
  ]
}
```

Acceptance:

- Every public/account page belongs to exactly one page family or a deliberate archive/remove class.
- Nav active state, underline, popover, keyboard, mobile, and CTA behavior are governed by `nav-contract`.
- Buttons, forms, cards, tables, dialogs, videos, demos, calculators, and account widgets share a state contract.
- WCAG 2.2, Core Web Vitals LCP/INP/CLS, and product-media proof are explicit gates.

## Control File 13A: Account Shell, Nav Manifest, And Runtime Debt

Target paths:

- `docs/internal/account-shell-contract.json`
- `docs/internal/account-shell-contract.md`
- `docs/internal/account-nav-manifest.json`
- `docs/internal/account-nav-manifest.md`
- `docs/internal/nav-runtime-debt-ledger.json`
- `docs/internal/nav-runtime-debt-ledger.md`

Build scripts to add:

- `scripts/build-account-shell-contract.cjs`
- `scripts/build-account-nav-manifest.cjs`
- `scripts/build-nav-runtime-debt-ledger.cjs`

Verify scripts to add:

- `scripts/verify-account-shell.cjs`
- `scripts/verify-account-nav.cjs`
- `scripts/verify-nav-runtime-debt.cjs`

Minimum schema for account shell:

```json
{
  "schema": "kolm.account_shell_contract.v1",
  "generated_at": "iso-8601",
  "source_inputs": [
    "public/account/**/*.html",
    "public/nav.js",
    "public/ks.css",
    "public/surface-polish.css",
    "public/warm-paper.css",
    "public/product-graph.json"
  ],
  "pages": [
    {
      "path": "/account/overview",
      "shell_mode": "generated_shell|legacy_shell_pending_migration|embedded_tool|archive|remove",
      "loads": {
        "ks_css": true,
        "surface_polish_css": true,
        "warm_paper_css": true,
        "nav_js": true
      },
      "metadata": {
        "title_separator": "ascii_pipe|middle_dot|invalid",
        "has_mojibake": false,
        "canonical_url": "https://kolm.ai/account/overview"
      },
      "shell_regions": {
        "top_nav": "present|missing",
        "account_sidebar": "present|missing",
        "command_center": "present|missing",
        "readiness_band": "present|missing",
        "skip_link_count": 1
      },
      "local_debt": {
        "style_tags": 0,
        "style_attributes": 0,
        "inline_scripts": 0,
        "inner_html_writes": 0
      },
      "states_required": ["no_auth", "loading", "empty", "partial", "error", "success", "external_gated"]
    }
  ]
}
```

Minimum schema for account nav:

```json
{
  "schema": "kolm.account_nav_manifest.v1",
  "generated_at": "iso-8601",
  "groups": [
    {
      "group_id": "build",
      "label": "BUILD",
      "items": [
        {
          "label": "Connectors",
          "path": "/account/connectors",
          "active_match": "exact|prefix",
          "journey_ids": ["gateway-capture"],
          "feature_ids": ["gateway-capture.provider-setup"],
          "api_routes": ["/v1/account"],
          "cli_equivalents": ["kolm capture status --json"],
          "tui_views": ["connectors"],
          "badge_source": "none|api|readiness|billing|route",
          "auth_scope": "tenant_user|tenant_admin|owner"
        }
      ]
    }
  ]
}
```

Minimum schema for runtime debt:

```json
{
  "schema": "kolm.nav_runtime_debt_ledger.v1",
  "generated_at": "iso-8601",
  "behaviors": [
    {
      "behavior_id": "account-command-center-injection",
      "source_path": "public/nav.js",
      "classification": "permanent_runtime_feature|build_time_shell_candidate|css_migration_candidate|copy_metadata_migration_candidate|auth_runtime_required|remove_after_migration",
      "current_reason": "string",
      "target_owner": "frontend|account|design-system|auth|release",
      "target_artifact": "docs/internal/account-shell-contract.json",
      "removal_or_keep_rule": "string",
      "proof_required": ["keyboard", "mobile", "dark_light", "no_auth", "auth"]
    }
  ],
  "budgets": {
    "account_pages_missing_nav_js": 0,
    "account_pages_missing_surface_polish": 0,
    "account_pages_missing_sidebar": 0,
    "account_pages_with_mojibake": 0,
    "unowned_runtime_patch_behaviors": 0
  }
}
```

Acceptance:

- All 51 account HTML pages are present in the shell contract.
- No account page has an unclassified shell mode.
- No account page has a bad `繚` source separator.
- No account page has duplicate skip links.
- No shell-required account page is missing `/ks.css`, `/surface-polish.css`, `/warm-paper.css`, `/nav.js`, `#account-sidebar`, or a generated command/readiness region.
- Every account nav path maps to a product graph journey, API route contract, CLI equivalent, and TUI view or declares a scoped exception.
- Every static `public/nav.js` repair behavior has a target migration owner. Runtime behavior remains only where runtime state is genuinely required.

## Control File 13B: Component Interaction State And UI Accessibility/Performance

Target paths:

- `docs/internal/component-interaction-state-contract.json`
- `docs/internal/component-interaction-state-contract.md`
- `docs/internal/ui-accessibility-performance-contract.json`
- `docs/internal/ui-accessibility-performance-contract.md`

Build scripts to add:

- `scripts/build-component-interaction-state-contract.cjs`
- `scripts/build-ui-accessibility-performance-contract.cjs`

Verify scripts to add:

- `scripts/verify-component-interaction-state.cjs`
- `scripts/verify-ui-accessibility-performance.cjs`

Minimum component schema:

```json
{
  "schema": "kolm.component_interaction_state_contract.v1",
  "generated_at": "iso-8601",
  "component_families": [
    {
      "family_id": "button",
      "selectors": [".btn", ".ks-btn", "button"],
      "tokens_required": ["color", "background", "border", "radius", "focus_ring", "motion"],
      "states": ["default", "hover", "pressed", "focus_visible", "disabled", "loading", "selected", "success", "warning", "error", "external_gated"],
      "light_dark_required": true,
      "min_target_css_px": 44,
      "raw_hex_allowed": false,
      "important_allowed": false,
      "inline_style_allowed": false
    }
  ]
}
```

Minimum UI/accessibility/performance schema:

```json
{
  "schema": "kolm.ui_accessibility_performance_contract.v1",
  "generated_at": "iso-8601",
  "standards": {
    "wcag": "2.2",
    "aria_practices": "disclosure-navigation",
    "core_web_vitals": ["lcp", "inp", "cls"]
  },
  "gates": {
    "focus_not_obscured": "required",
    "focus_visible": "required",
    "target_size": "required",
    "consistent_help": "required",
    "accessible_authentication": "required",
    "keyboard_navigation": "required",
    "reduced_motion": "required",
    "lcp_ms_p75": 2500,
    "inp_ms_p75": 200,
    "cls_p75": 0.1
  },
  "page_state_matrix": {
    "account": ["no_auth", "auth", "loading", "empty", "partial", "error", "success", "external_gated"],
    "public": ["initial", "interactive", "media_loaded", "media_failed", "reduced_motion"]
  }
}
```

Acceptance:

- Buttons, links, nav items, popovers, forms, tables, cards, dialogs, videos, demos, calculators, chat, account widgets, status tokens, and copy buttons have a canonical state contract.
- Light/dark, desktop/mobile, keyboard, reduced-motion, no-auth, auth, loading, empty, partial, error, success, and external-gated states are not optional.
- WCAG 2.2 and WAI-ARIA disclosure navigation rules are treated as release gates for account/nav surfaces.
- Core Web Vitals proof uses LCP, INP, and CLS thresholds at the 75th percentile and distinguishes local lab data from production field data.
- Product media, skeletons, async account panels, and runtime injected bands reserve dimensions so CLS cannot be hidden by screenshots alone.

## Control File 13C: Account Product Journey State Machine

Target paths:

- `docs/internal/account-product-journey-state-machine.json`
- `docs/internal/account-product-journey-state-machine.md`

Build script to add: `scripts/build-account-product-journey-state-machine.cjs`

Verify script to add: `scripts/verify-account-product-journey-state-machine.cjs`

Minimum schema:

```json
{
  "schema": "kolm.account_product_journey_state_machine.v1",
  "generated_at": "iso-8601",
  "loops": [
    {
      "loop_id": "route-capture",
      "pages": ["/account/connectors", "/account/captured", "/account/lake"],
      "objects": ["provider_connection", "capture_event", "privacy_event", "dataset_row"],
      "states": ["not_connected", "capturing", "review_required", "ready_for_dataset", "error", "external_gated"],
      "next_actions": ["connect_provider", "review_capture", "redact", "promote_to_dataset"],
      "proof_paths": ["api_route", "audit_event", "cli_command", "screenshot", "production_smoke"]
    }
  ]
}
```

Acceptance:

- The three product loops are explicit in account: route/capture, distill/compile, and run/govern.
- Every account page exposes object state, next action, readiness state, proof path, and fallback state.
- Pages that only show a report without a next action and proof path are marked incomplete.
- Readiness and closeout scope appear on the page where they affect the user's action, not only on account overview.

## Control File 14: Generated Artifact Manifest

Target path: `docs/internal/generated-artifact-manifest.json`

Build script to add: `scripts/build-generated-artifact-manifest.cjs`

Verify script to add: `scripts/verify-generated-artifacts.cjs`

Minimum schema:

```json
{
  "schema": "kolm.generated_artifact_manifest.v1",
  "generated_at": "iso-8601",
  "artifacts": [
    {
      "path": "public/openapi.json",
      "generator": "node scripts/build-openapi.cjs",
      "check_command": "node scripts/build-openapi.cjs --check",
      "source_inputs": ["docs/internal/api-contract-matrix.json"],
      "downstream_consumers": ["public/docs/api.html", "sdk clients"],
      "release_included": true,
      "requires_write_lock": true,
      "serial_after": ["public/docs/api-routes.json"],
      "stale_policy": "fail_release",
      "sha256": "string"
    }
  ]
}
```

Acceptance:

- Every generated artifact has one generator, check command, input list, downstream consumer list, and release-inclusion decision.
- Race-prone generation order is explicit and serial.
- Final build redline fails if any generated artifact is stale or written without an active lock.

## Control File 15: Observability Contract

Target path: `docs/internal/observability-contract.json`

Build script to add: `scripts/build-observability-contract.cjs`

Verify script to add: `scripts/verify-observability-contract.cjs`

Minimum schema:

```json
{
  "schema": "kolm.observability_contract.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "journeys": [
    {
      "journey_id": "runtime-inference",
      "routes": ["/v1/chat/completions"],
      "spans": ["http.server", "gen_ai.client", "kolm.inference"],
      "metrics": ["http.server.request.duration", "kolm.runtime.latency_ms"],
      "events": ["audit.runtime.inference"],
      "slo": {
        "availability": "99.9",
        "latency_p95_ms": 0,
        "error_budget_policy": "string"
      },
      "alerts": ["string"],
      "dashboards": ["url-or-path"],
      "runbook": "docs/runbooks/runtime-inference.md",
      "owner": "backend",
      "data_safety": ["no_prompts", "no_secrets", "redacted_ids"]
    }
  ]
}
```

Acceptance:

- Every product journey has trace, metric, event/log, SLO, alert, dashboard, and runbook ownership.
- HTTP and GenAI telemetry uses OpenTelemetry semantic conventions where possible.
- Custom attributes use `kolm.*` and never include secrets, raw prompts, raw PHI/PII, API keys, or provider credentials.
- Production evidence proves collector configuration and at least one delivered trace/metric sample for release-critical flows.

## Control File 16: Security Release Contract

Target path: `docs/internal/security-release-contract.json`

Build script to add: `scripts/build-security-release-contract.cjs`

Verify script to add: `scripts/verify-security-release-contract.cjs`

Minimum schema:

```json
{
  "schema": "kolm.security_release_contract.v1",
  "generated_at": "iso-8601",
  "secret_values_included": false,
  "controls": [
    {
      "control_id": "api.object_authorization",
      "standard_refs": ["OWASP-API1", "ASVS"],
      "scope": "api|account|public|worker|sdk|deployment",
      "routes": ["/v1/artifacts/:id"],
      "implementation_paths": ["src/api/object-authorization.js"],
      "tests": ["tests/example.test.js"],
      "production_probe": "required|not_applicable",
      "evidence_path": "reports/deployments/<release-id>/security.json",
      "status": "missing|implemented|production_proved|external_gated"
    }
  ]
}
```

Acceptance:

- Security headers, CORS, CSP, auth, object authorization, tenant isolation, rate/resource limiting, webhooks, upload policy, provider upstream policy, secret handling, audit logging, redaction, retention, dependency/SBOM, provenance, and incident response are mapped.
- Production evidence records header checks, unauthorized/authorized probes, object-authorization probes, idempotency probes, webhook signature probes, and no-secret report validation.
- Public trust pages can distinguish implemented controls from certifications awarded.

## Control File 16A: Data Plane Contract

Target paths:

- `docs/internal/data-plane-contract.json`
- `docs/internal/data-plane-contract.md`

Inputs:

- `src/store.js`
- `src/store-drivers/*.js`
- `src/event-store.js`
- `src/event-schema.js`
- `src/object-storage.js`
- `src/audit-retention.js`
- `src/data-residency.js`
- `src/auth.js`
- `public/product-graph.json`
- `docs/internal/catalog-manifest.json`

Minimum schema:

```json
{
  "schema_version": "kolm-data-plane-contract/1",
  "generated_at": "iso8601",
  "stores": [
    {
      "id": "server-store",
      "module": "src/store.js",
      "supported_drivers": ["json", "sqlite"],
      "production_allowed_drivers": ["sqlite"],
      "unsupported_or_dormant_drivers": ["vercel_postgres", "vercel_kv"],
      "durability_class": "local_file|transactional_file|cloud_database|object_store|append_log",
      "status": "supported|experimental|dormant|blocked",
      "redline": "facade_and_driver_set_must_match"
    }
  ],
  "data_classes": [
    {
      "id": "events",
      "source_module": "src/event-store.js",
      "table_or_path": "events",
      "classification": "authoritative|derived|cache|scratch|audit|artifact|secret_reference|test_fixture",
      "tenant_field": "tenant_id",
      "schema_owner": "src/event-schema.js",
      "migration_owner": "script path",
      "indexes": ["idx_events_tenant_ts"],
      "retention_policy_id": "audit-events",
      "backup_policy_id": "primary-events",
      "readiness_probe": "command or route",
      "release_inclusion": "include|exclude|generated|external"
    }
  ],
  "blocking_redlines": []
}
```

Acceptance:

- `json` is explicitly local/single-node unless an emergency override is present and public product copy says so.
- `src/store.js` and `src/store-drivers/*` cannot contradict each other.
- Every product-critical row has a tenant fence, schema owner, migration owner, index policy, retention policy, backup policy, and readiness probe.
- Generic JSON-row tables cannot remain unowned in final state.

## Control File 16B: Env And Secret Contract

Target paths:

- `docs/internal/env-secret-contract.json`
- `docs/internal/env-secret-contract.md`
- generated `.env.example`

Inputs:

- direct env scan across `src/`, `scripts/`, `cli/`, `api/`, `workers/`, `services/`, `packages/`, and `sdk/`
- `.env.example`
- `src/env.js`
- `src/secrets-vault.js`
- `src/platform-capabilities.js`
- `src/object-storage.js`
- deploy files and CI workflows

Minimum schema:

```json
{
  "schema_version": "kolm-env-secret-contract/1",
  "env_vars": [
    {
      "name": "KOLM_DATA_DIR",
      "type": "path|secret|string|bool|integer|url|enum|json",
      "sensitivity": "public|internal|secret|credential|regulated",
      "owner_module": "src/env.js",
      "readers": ["src/store.js"],
      "default": "runtime-derived",
      "required_in": ["production"],
      "valid_values": [],
      "readiness_check": "/ready",
      "rotation_policy": "none|manual|scheduled|provider-managed",
      "docs_surface": ".env.example",
      "account_visible": false,
      "secret_value_may_be_logged": false
    }
  ],
  "generated_files": [".env.example"],
  "redlines": []
}
```

Acceptance:

- Every `process.env.*` reader is represented exactly once.
- Secret readers use `envSecret()` or a provider-specific resolver; boolean readers use `envBool()` or an equivalent parser.
- `.env.example` is generated and cannot drift from pricing, plan, provider, storage, and deployment truth.
- Public outputs prove `secret_values_included:false` or equivalent for secret-bearing readiness endpoints.

## Control File 16C: Data Retention And Backup Contract

Target paths:

- `docs/internal/data-retention-backup-contract.json`
- `docs/internal/data-retention-backup-contract.md`

Inputs:

- `src/audit-retention.js`
- `src/event-store.js`
- `src/store.js`
- `src/object-storage.js`
- account export/delete/privacy pages
- route contracts
- production evidence packet

Minimum schema:

```json
{
  "schema_version": "kolm-data-retention-backup-contract/1",
  "policies": [
    {
      "id": "audit-events",
      "data_class": "audit",
      "retention_days_min": 90,
      "retention_days_default": 365,
      "retention_days_max": 2555,
      "delete_mode": "dry_run_first",
      "backup_required": true,
      "rpo_minutes": 1440,
      "rto_minutes": 240,
      "restore_drill_required": true,
      "legal_hold_supported": true,
      "right_to_erasure_exception": "audit/legal/compliance"
    }
  ],
  "restore_drills": [],
  "blocking_redlines": []
}
```

Acceptance:

- Every authoritative or audit data class has retention, deletion, backup, RPO, RTO, and restore evidence.
- Destructive actions are tenant-fenced, idempotent, dry-run capable, audit-logged, and recoverable.
- Production evidence includes a dated restore drill for the release line.

## Control File 16D: Tenant Data Boundary Contract

Target paths:

- `docs/internal/tenant-data-boundary-contract.json`
- `docs/internal/tenant-data-boundary-contract.md`

Inputs:

- `src/auth.js`
- `src/store.js`
- `src/event-store.js`
- `src/event-schema.js`
- `src/data-residency.js`
- account/team/RBAC routes
- SDK auth helpers
- route contracts

Minimum schema:

```json
{
  "schema_version": "kolm-tenant-data-boundary-contract/1",
  "tenant_identifiers": [
    {
      "field": "tenant_id",
      "status": "canonical",
      "allowed_tables": ["events"],
      "translation_sources": ["auth tenant record"]
    }
  ],
  "data_effects": [
    {
      "operation": "account.delete",
      "routes": ["/v1/account/delete"],
      "tables_or_blobs": ["tenants", "events", "artifacts"],
      "tenant_fence": "required",
      "admin_override": "forbidden|allowed_with_audit",
      "audit_event": "required",
      "dry_run": true
    }
  ],
  "legal_sources": [
    {
      "control": "export-control-denylist",
      "runtime_module": "src/auth.js",
      "owner": "legal/security",
      "review_cadence_days": 30,
      "source_of_truth": "external legal process"
    }
  ]
}
```

Acceptance:

- Tenant id, tenant name, email, and API-key identity are not interchangeable without an explicit translation row.
- Every read/write route has a declared tenant fence and data effect.
- Export-control logic has owner, review cadence, source, override, and evidence. A hardcoded baseline alone is not final production truth.

## Control File 16E: Release Boundary Manifest

Target paths:

- `docs/internal/release-boundary-manifest.json`
- `docs/internal/release-boundary-manifest.md`

Inputs:

- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `.vercelignore`
- `vercel.json`
- `railway.toml`
- `package.json`
- `docs/internal/codebase-file-ledger.json`
- `docs/internal/generated-artifact-manifest.json`
- production evidence packet

Minimum schema:

```json
{
  "schema_version": "kolm-release-boundary-manifest/1",
  "targets": [
    {
      "id": "docker",
      "entrypoint": "Dockerfile",
      "include_rules": [],
      "exclude_rules": [".env*", "data/", "reports/", "screenshots/", "node_modules/", ".agent/", ".claude/"],
      "required_ignore_file": ".dockerignore",
      "copy_policy": "manifest_bounded",
      "secret_scan": "required",
      "scratch_scan": "required",
      "status": "blocked_until_manifest_exists"
    }
  ],
  "blocked_paths": [],
  "release_subjects": []
}
```

Acceptance:

- Docker, Railway, Vercel, public assets, npm/SDK packages, CLI, and browser extension each have a release boundary.
- No release bundle can include local env files, local data, backups, screenshots, reports, node_modules cache, temp artifacts, local agent dirs, or malformed prior test artifacts.
- `final-build-redline` must consume this manifest before certifying clean git or deploy readiness.

## Control File 16F: CI Release Pipeline Contract

Target paths:

- `docs/internal/ci-release-pipeline-contract.json`
- `docs/internal/ci-release-pipeline-contract.md`

Inputs:

- `package.json`
- `.github/workflows/*.yml`
- `.github/actions/*/action.yml`
- `scripts/release-verify.cjs`
- `scripts/local-surface-smoke.cjs`
- `scripts/prod-surface-smoke.cjs`
- `scripts/ui-surface-audit.cjs`
- package release readiness scripts
- generated control files

Minimum schema:

```json
{
  "schema_version": "kolm-ci-release-pipeline-contract/1",
  "workflows": [
    {
      "path": ".github/workflows/test-suite.yml",
      "classification": "required|optional|reference_template|manual_only|disabled",
      "triggers": ["pull_request", "push"],
      "path_filters": ["src/**"],
      "permissions": {"contents": "read"},
      "runtime_matrix": ["node20"],
      "install_commands": ["npm ci"],
      "commands": ["node --test --test-concurrency=1 tests/"],
      "artifacts": [],
      "retention_days": null,
      "secrets": [],
      "blocks_release_phase": ["merge"],
      "redlines": []
    }
  ],
  "actions": [],
  "runtime_policy": {
    "node_versions": ["20", "22", "24"],
    "minimum_release_matrix": ["20", "22"],
    "node_sqlite_coverage_required": true
  }
}
```

Acceptance:

- Every workflow and composite action is classified. Reference/template workflows cannot count as product release proof.
- Release-critical commands are not duplicated only in chat or local shells.
- Permissions, secrets, runtime versions, install modes, path filters, emitted artifacts, and retention are explicit.
- Unpinned `@latest` or unbounded global installs are not accepted in release-critical proof paths unless a signed exception exists.

## Control File 16G: CI Required Checks Policy

Target paths:

- `docs/internal/ci-required-checks-policy.json`
- `docs/internal/ci-required-checks-policy.md`

Inputs:

- CI release pipeline contract
- active lanes
- generated control files
- package release evidence
- production evidence
- final build redline

Minimum schema:

```json
{
  "schema_version": "kolm-ci-required-checks-policy/1",
  "phases": [
    {
      "id": "merge",
      "required_checks": ["lint", "test-suite", "verify:control-files"],
      "optional_checks": [],
      "allowed_skips": [],
      "flake_policy": "retry_once_then_owner",
      "timeout_policy": "hard_timeout_required",
      "owner_escalation": "CODEOWNER or internal ledger owner"
    }
  ],
  "exceptions": []
}
```

Acceptance:

- Merge, release candidate, production deploy, and post-deploy phases are separate.
- Each phase lists exact commands, workflows, artifacts, owners, retries, and skip rules.
- No release can be certified from local-only evidence when production evidence is required.

## Control File 16H: Release Artifact Evidence Matrix

Target paths:

- `docs/internal/release-artifact-evidence-matrix.json`
- `docs/internal/release-artifact-evidence-matrix.md`

Inputs:

- package release readiness catalog
- release boundary manifest
- generated artifact manifest
- SBOM/provenance contract
- package manifests
- static/backend/Docker/SDK/installer/browser-extension build outputs
- production evidence packet

Minimum schema:

```json
{
  "schema_version": "kolm-release-artifact-evidence-matrix/1",
  "release_id": "pending",
  "subjects": [
    {
      "id": "sdk-ts",
      "kind": "npm_package",
      "version": "0.2.6",
      "source_paths": ["packages/sdk-ts"],
      "build_command": "npm run build",
      "output_paths": ["dist or npm pack tarball"],
      "sha256": "required",
      "sbom_sha256": "required",
      "provenance_sha256": "required",
      "signature_bundle_sha256": "required",
      "registry_url": "required_or_not_released",
      "local_checks": ["npm run build", "npm pack --dry-run"],
      "channel_checks": [],
      "retention_days": 365,
      "status": "missing|local_ready|published|not_released|blocked"
    }
  ]
}
```

Acceptance:

- All 16 package-release targets are represented.
- Static site, API backend, Docker image, CLI/root package, browser SDK, SDK packages, installers, browser extension, GitHub Actions, and sample `.kolm` artifacts are represented.
- `publish_ready=false` remains visible until every released target has registry/artifact URL, hashes, SBOM, provenance, signature/attestation bundle, and channel checks.
- Placeholder hashes fail.

## Control File 16I: SBOM And Provenance Contract

Target paths:

- `docs/internal/sbom-provenance-contract.json`
- `docs/internal/sbom-provenance-contract.md`

Inputs:

- `.github/workflows/sbom.yml`
- `apps/export/sbom.py`
- package lockfiles and manifests
- release artifact evidence matrix
- SLSA/GitHub/npm provenance outputs
- package/channel evidence

Minimum schema:

```json
{
  "schema_version": "kolm-sbom-provenance-contract/1",
  "formats": ["cyclonedx-json", "spdx-json", "slsa-provenance"],
  "subjects": [
    {
      "subject_id": "docker-image",
      "subject_digest": "sha256",
      "sbom": {"format": "cyclonedx-json", "path": "artifact", "sha256": "required", "validated": true},
      "provenance": {"format": "slsa-v1.1", "path": "artifact", "sha256": "required", "verified": true},
      "attestation": {"provider": "github|npm|sigstore|manual", "verified": true},
      "verification_command": "command"
    }
  ],
  "secret_values_included": false
}
```

Acceptance:

- SBOMs are release artifacts tied to subject digests, not loose workflow uploads.
- Provenance is verified against expected repository, commit, workflow, and subject digest.
- npm packages use provenance where supported; Docker/images/archives/extensions use GitHub/SLSA-style attestations or a documented equivalent.
- Final build redline fails if a released subject lacks SBOM/provenance/signature evidence.

## Control File 17: Production Evidence Packet

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
  "core_web_vitals": {},
  "headers": {},
  "api_contracts": {},
  "sdk_assets": {},
  "storage_and_cloud_readiness": {},
  "telemetry": {},
  "security_release": {},
  "slsa_provenance": {},
  "dora_metrics": {},
  "rollback": {},
  "status_decision": {},
  "watch_windows": [],
  "sha256_manifest": "SHA256SUMS"
}
```

Acceptance:

- Ties `https://kolm.ai` to exact commit/deploy/env/generated artifacts.
- Public and auth smoke reports are retained, including `/health`, `/ready`, product graph, readiness closeout, OpenAPI, SDK asset, billing tiers, storage readiness, account auth, and every declared product surface.
- Production screenshots, Core Web Vitals, headers, API contracts, SDK assets, telemetry, security release evidence, SLSA-style provenance, DORA-style metrics, rollback, and watch window are retained.
- No secret values are printed.

## Control File 18: Final Build Redline

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
    "codebase_file_ledger": "docs/internal/codebase-file-ledger.json",
    "wave_registry": "docs/internal/wave-registry.json",
    "active_lanes": "docs/internal/active-lanes.json",
    "catalog_manifest": "docs/internal/catalog-manifest.json",
    "api_contract_matrix": "docs/internal/api-contract-matrix.json",
    "openapi_dialect_policy": "docs/internal/openapi-dialect-policy.json",
    "sdk_api_parity": "docs/internal/sdk-api-parity.json",
    "sdk_package_truth_matrix": "docs/internal/sdk-package-truth-matrix.json",
    "docs_ia_contract": "docs/internal/docs-ia-contract.json",
    "developer_docs_shell_contract": "docs/internal/developer-docs-shell-contract.json",
    "api_reference_contract": "docs/internal/api-reference-contract.json",
    "docs_sample_contract": "docs/internal/docs-sample-contract.json",
    "product_feature_completion_matrix": "docs/internal/product-feature-completion-matrix.json",
    "account_product_matrix": "docs/internal/account-product-matrix.json",
    "account_shell_contract": "docs/internal/account-shell-contract.json",
    "account_nav_manifest": "docs/internal/account-nav-manifest.json",
    "account_product_journey_state_machine": "docs/internal/account-product-journey-state-machine.json",
    "page_family_contracts": "docs/internal/page-family-contracts.json",
    "component_state_contracts": "docs/internal/component-state-contracts.json",
    "component_interaction_state_contract": "docs/internal/component-interaction-state-contract.json",
    "ui_accessibility_performance_contract": "docs/internal/ui-accessibility-performance-contract.json",
    "nav_contract": "docs/internal/nav-contract.json",
    "nav_runtime_debt_ledger": "docs/internal/nav-runtime-debt-ledger.json",
    "design_cascade_ledger": "docs/internal/design-cascade-ledger.json",
    "product_media_proof": "docs/internal/product-media-proof.json",
    "generated_artifact_manifest": "docs/internal/generated-artifact-manifest.json",
    "observability_contract": "docs/internal/observability-contract.json",
    "security_release_contract": "docs/internal/security-release-contract.json",
    "production_evidence": "reports/deployments/<release-id>/production-evidence.json"
  },
  "gates": {
    "clean_git": "pass|fail",
    "generated_artifacts_current": "pass|fail",
    "release_verify": "pass|fail",
    "local_surfaces": "pass|fail",
    "prod_surfaces": "pass|fail",
    "visual_proof": "pass|fail",
    "developer_docs_shell": "pass|fail",
    "api_reference_contract": "pass|fail",
    "docs_samples": "pass|fail",
    "sdk_package_truth": "pass|fail",
    "account_matrix": "pass|fail",
    "account_shell": "pass|fail",
    "account_nav": "pass|fail",
    "account_product_journey_state_machine": "pass|fail",
    "component_interaction_state": "pass|fail",
    "ui_accessibility_performance": "pass|fail",
    "nav_runtime_debt": "pass|fail",
    "claim_scope": "pass|fail",
    "data_plane": "pass|fail",
    "env_secrets": "pass|fail",
    "data_retention": "pass|fail",
    "tenant_boundary": "pass|fail",
    "observability": "pass|fail",
    "security_release": "pass|fail",
    "release_boundary": "pass|fail",
    "ci_release": "pass|fail",
    "required_checks": "pass|fail",
    "release_artifacts": "pass|fail",
    "sbom": "pass|fail",
    "slsa_provenance": "pass|fail",
    "package_channels": "pass|fail",
    "rollback_ready": "pass|fail",
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
  "build:api-contracts": "node scripts/build-api-contract-matrix.cjs",
  "verify:api-contracts": "node scripts/verify-api-contracts.cjs",
  "build:openapi-policy": "node scripts/build-openapi-dialect-policy.cjs",
  "verify:openapi-policy": "node scripts/verify-openapi-dialect-policy.cjs",
  "build:sdk-parity": "node scripts/build-sdk-capability-matrix.cjs",
  "verify:sdk-parity": "node scripts/verify-sdk-api-parity.cjs",
  "build:sdk-package-truth": "node scripts/build-sdk-package-truth-matrix.cjs",
  "verify:sdk-package-truth": "node scripts/verify-sdk-package-truth.cjs",
  "build:docs-ia": "node scripts/build-docs-ia.cjs",
  "verify:docs-ia": "node scripts/verify-docs-ia.cjs",
  "build:developer-docs-shell": "node scripts/build-developer-docs-shell-contract.cjs",
  "verify:developer-docs-shell": "node scripts/verify-developer-docs-shell.cjs",
  "build:api-reference-contract": "node scripts/build-api-reference-contract.cjs",
  "verify:api-reference-contract": "node scripts/verify-api-reference-contract.cjs",
  "build:docs-samples": "node scripts/build-docs-sample-contract.cjs",
  "verify:docs-samples": "node scripts/verify-docs-samples.cjs",
  "build:feature-matrix": "node scripts/build-product-feature-completion-matrix.cjs",
  "verify:feature-matrix": "node scripts/verify-product-feature-completion-matrix.cjs",
  "build:account-matrix": "node scripts/build-account-product-matrix.cjs",
  "verify:account-matrix": "node scripts/verify-account-product-matrix.cjs",
  "build:page-families": "node scripts/build-page-family-contracts.cjs",
  "verify:page-families": "node scripts/verify-page-family-contracts.cjs",
  "build:design-cascade-ledger": "node scripts/build-design-cascade-ledger.cjs",
  "verify:design-cascade-ledger": "node scripts/verify-design-cascade-ledger.cjs",
  "build:product-media-proof": "node scripts/build-product-media-proof.cjs",
  "verify:product-media-proof": "node scripts/verify-product-media-proof.cjs",
  "build:data-plane": "node scripts/build-data-plane-contract.cjs",
  "verify:data-plane": "node scripts/verify-data-plane-contract.cjs",
  "build:env-secrets": "node scripts/build-env-secret-contract.cjs",
  "verify:env-secrets": "node scripts/verify-env-secret-contract.cjs",
  "build:data-retention": "node scripts/build-data-retention-backup-contract.cjs",
  "verify:data-retention": "node scripts/verify-data-retention-backup-contract.cjs",
  "build:tenant-boundary": "node scripts/build-tenant-data-boundary-contract.cjs",
  "verify:tenant-boundary": "node scripts/verify-tenant-data-boundary-contract.cjs",
  "build:release-boundary": "node scripts/build-release-boundary-manifest.cjs",
  "verify:release-boundary": "node scripts/verify-release-boundary-manifest.cjs",
  "build:ci-release": "node scripts/build-ci-release-pipeline-contract.cjs",
  "verify:ci-release": "node scripts/verify-ci-release-pipeline-contract.cjs",
  "build:ci-required-checks": "node scripts/build-ci-required-checks-policy.cjs",
  "verify:ci-required-checks": "node scripts/verify-ci-required-checks-policy.cjs",
  "build:release-artifacts": "node scripts/build-release-artifact-evidence-matrix.cjs",
  "verify:release-artifacts": "node scripts/verify-release-artifact-evidence-matrix.cjs",
  "build:sbom-provenance": "node scripts/build-sbom-provenance-contract.cjs",
  "verify:sbom-provenance": "node scripts/verify-sbom-provenance-contract.cjs",
  "build:generated-artifacts": "node scripts/build-generated-artifact-manifest.cjs",
  "verify:generated-artifacts": "node scripts/verify-generated-artifacts.cjs",
  "build:observability-contract": "node scripts/build-observability-contract.cjs",
  "verify:observability-contract": "node scripts/verify-observability-contract.cjs",
  "build:security-release": "node scripts/build-security-release-contract.cjs",
  "verify:security-release": "node scripts/verify-security-release-contract.cjs",
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
npm run verify:api-contracts
npm run verify:openapi-policy
npm run verify:sdk-parity
npm run verify:sdk-package-truth
npm run verify:docs-ia
npm run verify:developer-docs-shell
npm run verify:api-reference-contract
npm run verify:docs-samples
npm run verify:feature-matrix
npm run verify:account-matrix
npm run verify:page-families
npm run verify:design-cascade-ledger
npm run verify:product-media-proof
npm run verify:data-plane
npm run verify:env-secrets
npm run verify:data-retention
npm run verify:tenant-boundary
npm run verify:release-boundary
npm run verify:ci-release
npm run verify:ci-required-checks
npm run verify:release-artifacts
npm run verify:sbom-provenance
npm run verify:generated-artifacts
npm run verify:observability-contract
npm run verify:security-release
npm run verify:production-evidence
npm run verify:final-redline
```

## Immediate Build Strategy

Do not try to make all files perfect in one pass. Build them in this order:

1. File ledger in warn mode.
2. Wave registry in warn mode.
3. Active lanes in manual seed mode.
4. Catalog manifest from local modules only.
5. Data plane contract from store/event/object-storage/retention/residency modules; start in warn mode but fail on facade-driver contradictions and unowned authoritative data.
6. Env/secret contract from direct env scan, `.env.example`, readiness, secrets vault, deploy files, and provider catalogs; generate `.env.example` from it after first pass.
7. Data retention and backup contract from audit retention, event store, account delete/export/privacy routes, and object storage.
8. Tenant data boundary contract from auth, tenant fields, event schema, account lifecycle routes, data residency, and route contracts.
9. API contract matrix from router, product graph, account pages, CLI, SDK tree, data plane, tenant boundary, and existing generated API artifacts.
10. OpenAPI dialect policy, then regenerate OpenAPI from API contracts only.
11. SDK parity matrix from API contracts and package trees.
12. SDK package truth matrix from package manifests, READMEs, package readiness, browser SDK manifest, and release artifact evidence.
13. Docs IA contract from product graph, API contracts, CLI docs, SDK docs, and current page families.
14. Developer docs shell contract from all `public/docs/**/*.html`, `/api`, `/quickstart`, `/sdks`, and SDK docs pages.
15. API reference contract from `/api`, `/docs/api`, OpenAPI, API route inventory, CLI REST hints, SDK examples, and account action contracts.
16. Docs sample contract from every code block/sample in quickstarts, docs, SDK pages, CLI docs, and top-level API pages.
17. Product feature completion matrix from product graph, API contracts, SDK parity, SDK package truth, docs IA, docs samples, control files, tests, and scripts.
18. Account product matrix from all `public/account/**/*.html` pages and authenticated smoke requirements.
19. Account shell/nav/component state controls from public/account pages, docs shell evidence, and design ledger evidence.
20. Page family, component state, and nav contracts from public/account pages and design ledger evidence.
21. Design cascade ledger from static scans.
22. Product media proof from static routes and screenshot reports.
23. Generated artifact manifest from every generated output and generator script.
24. Observability contract from router, OTEL code, product journeys, events, audit logs, SLO pages, and runbooks.
25. Security release contract from route contracts, headers, auth, object authorization, dependency/provenance evidence, and production probes.
26. Release boundary manifest from Git, Vercel, Railway, Docker, npm/SDK package, CLI, and public static bundle inclusion rules.
27. CI release pipeline contract from workflows/actions/scripts and package scripts.
28. CI required checks policy from the release pipeline, active lanes, control files, and owner model.
29. Release artifact evidence matrix from every package/channel/build/deploy subject.
30. SBOM/provenance contract from SBOM workflow, package manifests, release artifacts, attestations, and verification commands.
31. Production evidence packet from explicit release ID.
32. Final build redline as read-only aggregate.

Then tighten each from warn mode to fail mode.

## Completion Rule

This spec is complete only when the listed control files exist, validate, and are referenced by the consolidated review and the master blueprint. The product is complete only when the final build redline closes against the current production deployment.
