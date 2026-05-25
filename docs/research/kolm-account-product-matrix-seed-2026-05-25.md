# Kolm Account Product Matrix Seed

Date: 2026-05-25

Audience: internal implementation agents only. This is not public documentation, not website copy, and not a customer-facing dashboard spec.

Purpose: seed `docs/account-product-matrix.json`, the control file that should prove the post-auth account surface covers every Kolm product feature, every journey, and every readiness state with usable UI, real API data, and screenshot/auth smoke evidence.

Related documents:

- `docs/research/kolm-internal-spec-index-2026-05-25.md`
- `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md`
- `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md`
- `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`
- `docs/research/kolm-product-media-proof-seed-2026-05-25.md`

## Direct Assessment

The account surface is no longer a small dashboard. It is the product cockpit. It currently contains many useful pages, but ownership is not yet tight enough to call it complete.

Current authoritative scan:

- account HTML pages: 41
- unique account page IDs referenced by `public/product-graph.json`: 20
- account pages missing product-graph ownership: 22
- product journeys in graph: 12
- account pages with no direct fetch/kfetch in static scan: several pages appear reference/static unless generated scripts attach behavior elsewhere

That does not mean the account product is bad. It means the account surface needs a generated matrix that says which pages are live tenant dashboards, which are setup pages, which are reference pages, which are experimental wave pages, and which product journey each page belongs to.

## Current Account Pages

Observed files under `public/account/`:

| page | initial role |
|---|---|
| `overview.html` | command center; must summarize the full product matrix |
| `connectors.html` | gateway/capture provider setup |
| `captured.html` | captured calls and observations |
| `captures.html` | capture status/reference page |
| `lake.html` | privacy lake and storage views |
| `privacy-events.html` | privacy/redaction evidence |
| `datasets.html` | dataset inventory |
| `labeling.html` | labeling queue |
| `simulations.html` | simulation/synthetic data setup |
| `bakeoffs.html` | bakeoff list |
| `bakeoff.html` | bakeoff result/reference page |
| `builds.html` | compile/build jobs |
| `distill-runs.html` | distillation runs |
| `multimodal-bakeoff.html` | multimodal bakeoff |
| `artifacts.html` | artifact inventory |
| `devices.html` | devices/fleet/runtime placement |
| `storage.html` | storage/cloud readiness |
| `settings.html` | account/org/cloud settings |
| `api-keys.html` | API key management |
| `audit-log.html` | audit events |
| `billing.html` | plan, usage, savings |
| `agent-telemetry.html` | agent/runtime telemetry |
| `ab-tests.html` | A/B testing |
| `active-learning.html` | active learning gaps and route loop |
| `approvals.html` | approval workflow |
| `chargeback.html` | cost attribution |
| `confidence.html` | confidence-aware routing |
| `continuous-monitoring.html` | security/compliance monitoring |
| `diagnose.html` | diagnostics |
| `drift.html` | drift configuration/status |
| `drift-alert.html` | drift alerting |
| `failure-modes.html` | failure-mode analysis |
| `opportunities.html` | savings/compile opportunities |
| `pipelines.html` | pipeline reference |
| `repeated-workflows.html` | repeated workflow detection |
| `routing.html` | routing summary/test |
| `seasonal.html` | seasonal variants |
| `sla.html` | SLA dashboard |
| `staleness.html` | capture/model staleness |
| `sustainability.html` | sustainability/reference surface |
| `synthetic.html` | synthetic data generation |

## Current Product-Graph Coverage Gap

The generated product graph currently maps these account paths into journeys:

- `/account/connectors`
- `/account/captured`
- `/account/lake`
- `/account/privacy-events`
- `/account/storage`
- `/account/datasets`
- `/account/labeling`
- `/account/simulations`
- `/account/bakeoffs`
- `/account/builds`
- `/account/distill-runs`
- `/account/multimodal-bakeoff`
- `/account/artifacts`
- `/account/devices`
- `/account/settings`
- `/account/api-keys`
- `/account/audit-log`
- `/account/billing`
- `/account/agent-telemetry`
- `/models`

Observed account pages missing product-graph ownership:

- `ab-tests`
- `active-learning`
- `approvals`
- `bakeoff`
- `captures`
- `chargeback`
- `confidence`
- `continuous-monitoring`
- `diagnose`
- `drift`
- `drift-alert`
- `failure-modes`
- `opportunities`
- `overview`
- `pipelines`
- `repeated-workflows`
- `routing`
- `seasonal`
- `sla`
- `staleness`
- `sustainability`
- `synthetic`

Redline: no account page should exist outside a journey, a feature, or a deliberate archive/reference classification.

## Journey-To-Account Matrix

| journey | current graph account pages | missing or weak account coverage |
|---|---|---|
| `gateway-capture` | connectors, captured, lake | captures, routing, confidence, opportunities, repeated-workflows should be owned here or explicitly elsewhere |
| `privacy-lake` | lake, privacy-events, storage | continuous-monitoring and data-retention related pages need governance or privacy ownership |
| `datasets-labeling` | datasets, labeling, simulations, bakeoffs | synthetic, active-learning, bakeoff detail, failure-modes should be integrated |
| `train-distill` | builds, distill-runs, multimodal-bakeoff | pipelines, active-learning, ab-tests, failure-modes, synthetic need ownership |
| `models-backbones` | models, builds, devices | staleness and routing confidence should connect to model selection |
| `multimodal-tokenization` | multimodal-bakeoff, lake, datasets | multimodal tokenization state should have explicit page or panel ownership |
| `compile-verify` | artifacts | builds, failure-modes, diagnose, audit-log should connect to compile verification |
| `runtime-inference` | devices, artifacts | routing, confidence, SLA, staleness should connect to runtime operations |
| `compute-cloud` | devices, storage, settings | chargeback, sustainability, SLA should be linked to compute/cloud or enterprise |
| `devices-fleet` | devices | air-gap/device install state needs explicit account panel or external page proof |
| `enterprise-governance` | api-keys, audit-log, billing, settings, privacy-events | approvals, chargeback, continuous-monitoring, SLA, diagnose should be owned here |
| `agents-registry` | agent-telemetry, artifacts | marketplace/registry state and agent install telemetry need explicit post-auth flow |

## Account Page State Contract

Every account page must declare:

| field | requirement |
|---|---|
| `page_id` | Stable ID derived from account path. |
| `journey_ids` | One or more product journeys. |
| `feature_ids` | Feature matrix IDs served by the page. |
| `route_surface_ids` | Product surface ownership. |
| `api_routes` | Live routes used by page. |
| `cli_equivalents` | Operator command equivalent where applicable. |
| `tui_views` | TUI parity where applicable. |
| `state_model` | loading, empty, error, partial, success, no-auth, no-credential, no-data. |
| `mode` | live tenant dashboard, setup wizard, reference page, generated report, experimental wave, archive. |
| `primary_action` | One clear next action. |
| `secondary_actions` | Supporting actions. |
| `claim_scope` | shipped, implemented-local, benchmark-gated, package-gated, certification-gated, partner-gated. |
| `data_safety` | safe fixture, tenant data, secret-free, redacted, local-only. |
| `uiux_proof` | desktop/mobile, dark/light, keyboard, no-overlap, target-size. |
| `auth_smoke` | local and production authenticated smoke evidence. |

## Account UX Rules

The account surface should behave like an operator workbench:

1. `overview.html` is the command center, not a generic dashboard.
2. Overview must consume `public/product-graph.json`, readiness closeout, billing, storage readiness, and next actions.
3. Every product journey needs a visible account entry point.
4. Every open readiness gate relevant to the tenant must be visible and scoped.
5. Every account page needs clear loading, empty, error, partial, and success states.
6. Pages without live data must be labeled as setup, reference, or report pages.
7. Tables must be dense, scannable, keyboard-accessible, and stable in row height.
8. Buttons must use canonical variants and 44px touch targets unless a table-density exception is documented.
9. API errors should produce useful recovery actions, not generic failure text.
10. Enterprise pages must distinguish controls implemented from certifications awarded.
11. Cloud/storage pages must never expose secret values.
12. All account pages need authenticated screenshot proof after latest edits.

## High-Priority Page Redlines

| page | redline |
|---|---|
| `overview.html` | Must be journey-driven and show the whole product matrix: route/capture, privacy/lake, datasets, distill/compile, artifacts, runtime/devices, cloud/storage, governance/billing, agents/registry. |
| `storage.html` | Must show `/v1/storage/object-readiness`, `/v1/cloud/readiness`, provider groups, missing env groups, object-size limits, and `secret_values_included: false`. |
| `billing.html` | Must align Free, Pro, Team, Enterprise/custom with billing APIs and sales-required enterprise flow. |
| `connectors.html` | Must show provider readiness and next copyable setup commands, not just connector names. |
| `captured.html` | Must show capture events, redaction/storage state, cost, duplicate/repeated-work signal, and compile opportunity. |
| `datasets.html` | Must show provenance, splits, labels, synthetic boundary, and next distill action. |
| `distill-runs.html` | Must show teacher, student, strategy, dataset, cost, K-Score, failure modes, artifact, and rollback. |
| `artifacts.html` | Must show signature, runtime target, quantization profile, eval gate, receipt, export targets, and verification failure recovery. |
| `devices.html` | Must show can-run/needs-quantization/cannot-run states with memory and runtime reason. |
| `api-keys.html` | Must show key scope, rotation, last used, owner, provider capture examples, and least-privilege guidance. |
| `audit-log.html` | Must show export, SIEM, filters, actor, tenant, route, artifact, and retention. |
| `agent-telemetry.html` | Must show tool calls, failures, latency, quality, permission boundary, and install next action. |
| `routing.html` | Must be owned by gateway/runtime and show decision reason, fallback, cost, confidence, and receipt. |
| `failure-modes.html` | Must connect back to datasets, active learning, distill retry, and product improvement loop. |
| `active-learning.html` | Must show coverage gaps, label queue generation, and which model/artifact will improve. |
| `ab-tests.html` | Must show experiment state, statistical significance, rollback, and artifact/version split. |
| `continuous-monitoring.html` | Must show implemented controls versus external certification status. |
| `sla.html` | Must show live SLOs, incidents, route health, and production-vs-local scope. |
| `chargeback.html` | Must connect to billing, teams, cost attribution, and savings-based value. |
| `synthetic.html` | Must label synthetic data clearly and avoid mixing it with captured real data without provenance. |

## Generated Matrix Schema Seed

Each row in `docs/account-product-matrix.json` should look like:

```json
{
  "page_id": "storage",
  "path": "/account/storage",
  "mode": "live-tenant-dashboard",
  "journey_ids": ["privacy-lake", "compute-cloud"],
  "feature_ids": ["storage-plane", "cloud-readiness"],
  "route_surface_ids": ["deployment-edge-federated"],
  "api_routes": ["/v1/storage/object-readiness", "/v1/cloud/readiness"],
  "cli_equivalents": ["kolm cloud storage --json", "kolm cloud readiness --remote --json"],
  "tui_views": ["storage-sync", "settings"],
  "state_model": ["loading", "empty", "error", "partial", "success", "missing-credentials"],
  "primary_action": "Configure artifact storage",
  "claim_scope": "implemented-local",
  "data_safety": ["secret_values_included:false", "tenant-scoped"],
  "uiux_proof": {
    "desktop_dark": null,
    "desktop_light": null,
    "mobile_dark": null,
    "mobile_light": null,
    "keyboard": null,
    "target_size": null
  },
  "auth_smoke": {
    "local": null,
    "production": null
  },
  "status": "needs-proof"
}
```

Required `mode` values:

- `live-tenant-dashboard`
- `setup-wizard`
- `operator-workbench`
- `reference-page`
- `generated-report`
- `experimental-wave`
- `archive`

Required `status` values:

- `complete`
- `needs-journey-owner`
- `needs-api-proof`
- `needs-state-proof`
- `needs-uiux-proof`
- `needs-auth-smoke`
- `needs-copy-scope`
- `archive`

## Verifier Requirements

Add `scripts/build-account-product-matrix.cjs` and `scripts/verify-account-product-matrix.cjs`.

Minimum behavior:

1. Enumerate `public/account/*.html`.
2. Load `public/product-graph.json`.
3. Load `docs/product-surfaces.json`.
4. Load `public/product-readiness-closeout.json`.
5. Extract account page endpoints, buttons, forms, tables, H1, loading/empty/error signals, and auth-sensitive routes.
6. Fail when an account page has no journey owner, unless explicitly marked `reference-page` or `archive`.
7. Fail when a journey has no account path and it needs post-auth operation.
8. Fail when a live dashboard has no API route.
9. Fail when a page has no state model.
10. Fail when open readiness gates are not visible in account readiness where relevant.
11. Join local and production authenticated smoke evidence.
12. Emit `docs/account-product-matrix.json`.
13. Emit `docs/account-product-matrix.md`.
14. Add `verify:account-product-matrix` to `verify:depth` once warn mode is stable.

## Redline Before Account UX Is Complete

Do not claim account UX is complete until:

- all 41 current account pages are classified
- all 12 journeys have account coverage or an explicit reason they do not need it
- all 22 currently unowned account pages are mapped, archived, or deleted
- account overview consumes generated product graph and closeout state
- every live dashboard has API, CLI/TUI parity where applicable, state coverage, and auth smoke
- every setup page has a copyable next command and a clear no-credential state
- every account page has dark/light and desktop/mobile screenshot proof after latest edits
- production authenticated account smoke passes against the deployed commit

