# Product Surface Spec

Updated: 2026-06-13

## Verdict

**Locally coherent, not production-final.**

Kolm now has an enforceable product-surface contract for the compiler-first product. The current truth is:

- `docs/product-surfaces.json` is the canonical product surface registry.
- `public/product-graph.json` is the generated public graph consumed by the site and account UI.
- `public/product-readiness-closeout.json` is the generated open-blocker ledger.
- `scripts/verify-product-surfaces.cjs` verifies route-group ownership against `public/docs/api-routes.json`.
- `scripts/audit-product-kernel.cjs` verifies the product kernel and readiness graph.
- `scripts/ui-surface-audit.cjs` verifies critical public UI surfaces.
- The catalog maps `922` generated routes across `214` route groups to `7` product surfaces with `29` competitor/research references.

No claim of "100% final", "fully certified", "best", or "state of the art" is valid unless the claim is tied to dated evidence and the relevant readiness item is closed.

## Current Product Scope

Kolm is the AI compiler and artifact contract layer: production model traffic becomes captured evidence, datasets, evals, signed `.kolm` artifacts, runtime targets, receipts, and governance exports.

The old agent security-readiness audit site is preserved as a focused secondary product at `audit.kolm.ai`. It is not the main `kolm.ai` homepage or account workspace.

## Source Of Truth

| Artifact | Role |
| --- | --- |
| `docs/PRODUCT.md` | Human product spec and old-vs-current scope. |
| `docs/product-surfaces.json` | Machine-readable owner, route-group, code-path, doc-path, research, certification, and probe registry. |
| `public/product-graph.json` | Generated product graph for site/account/runtime reads. |
| `public/product-readiness-closeout.json` | Generated non-final readiness ledger. |
| `public/docs/api-routes.json` | Generated backend route inventory. |
| `public/openapi.json` | Generated OpenAPI contract. |
| `scripts/verify-product-surfaces.cjs` | Surface ownership gate. |
| `scripts/audit-product-kernel.cjs` | Product kernel and readiness gate. |
| `scripts/prod-surface-smoke.cjs` | Production smoke runner. |
| `scripts/local-surface-smoke.cjs` | Hermetic local smoke runner. |

## Surface Map

| Surface | Routes | Groups | Local status | Product promise | Not-final gates |
| --- | ---: | ---: | --- | --- | --- |
| Identity, access, teams, billing | 148 | 26 | `certified` | Buyer can sign up, authenticate, manage teams/keys/plans, and prove entitlement state. | SSO/SCIM, package-backed billing portal, webhook entitlement proof, production auth smoke. |
| Public site, docs, API reference, SDK | 72 | 21 | `certified` | Public pages, API reference, SDK assets, route contracts, and readiness ledgers are coherent. | Production fetch/hash smoke, package publication, public benchmark evidence. |
| Compile, artifacts, registry, receipts, verification | 88 | 28 | `certified` | Tasks become signed portable artifacts with K-score, receipt chain, registry metadata, and verification. | Production compile/list/download/verify, durable artifact storage, release evidence. |
| Runtime, inference, connectors, multimodal APIs | 131 | 41 | `certified` | Kolm can sit in the hot path as an OpenAI/Anthropic-compatible runtime and connector gateway. | Provider readiness, third-party runtime adoption, package/channel release. |
| Capture, datasets, evals, labels, training, improvement loop | 205 | 47 | `certified` | Production traces become governed datasets, labels, evals, simulations, distill runs, and follow-up artifacts. | Public reproducible benchmarks, importer fixtures, remote loop production auth. |
| Governance, compliance, admin, audit, privacy, trace, notifications | 171 | 31 | `certified` | Operators can prove actions, data movement, artifact execution, privacy decisions, and compliance exportability. | Live auditor/certification evidence, compliance package production export, trust-page dated evidence. |
| Deployment, edge devices, BYOC, storage, sync, tunnel, federated learning | 107 | 20 | `certified` | Artifacts move across cloud, BYOC, devices, tunnels, sync, confidential-compute, and federated flows with tenant boundaries. | External partner/runtime acceptance, BYOC lifecycle smoke, mobile/browser package releases. |

`certified` here means locally mapped and gateable. It does not mean externally certified, package-published, benchmark-proven, or production-auth complete.

## Research Baseline

The registry uses primary competitor and platform references. The product implication is:

- Fine-tuning providers are mature; Kolm must not compete only on generic training UI.
- AI gateways and prompt caching are table stakes; Kolm must preserve provider compatibility while proving avoided calls and local hot paths.
- Observability/eval systems are table stakes; Kolm must bind traces and evals into signed artifacts and receipts.
- Enterprise identity/billing is table stakes; Kolm must support orgs, keys, quotas, entitlements, audit logs, production smoke, and an account-side API control center.
- API gateways alone are not enough; Kolm must show ingress, egress, retention, redaction, routing, eval, compile, deployment, and export policy in one tenant-scoped contract.
- Runtime engines are the substrate; Kolm should package, govern, and verify artifacts for those runtimes rather than claiming to replace all execution engines.

## Open Readiness Gates

The current closeout ledger has eight open items:

| Priority | Requirement | Blocking condition |
| --- | --- | --- |
| P0 | Benchmark harness public data | `public_leaderboard_data` |
| P0 | Formal compliance/certification evidence | `live_auditor_certification` |
| P1 | One-line installer release | `installer_channel_release` |
| P1 | Ecosystem runtime adoption | `external_runtime_adoption` |
| P1 | Neutral format governance | `external_partner_acceptance` |
| P1 | SDK package release matrix | `sdk_package_release` |
| P1 | iOS/Android/React Native package release | `mobile_package_release` |
| P1 | Browser/runtime package channel | `package_channel_release` |

Every public page and email must remain scoped to those gates. If a gate is open, copy may say "source exists", "local proof exists", or "readiness tracked"; it may not say "shipped", "certified", "published", or "adopted".

## URL Contract

Canonical compiler URLs:

- `/`
- `/compiler-product`
- `/platform`
- `/docs`
- `/docs/api`
- `/pricing`
- `/signup`
- `/account/overview`
- `/account/api-control-center`
- `/enterprise`
- `/security`
- `/trust`

Compatibility URLs that must keep working:

- `/product -> /compiler-product`
- `/models -> /platform`
- `/api -> /docs/api`
- `/api-routes.json -> /docs/api-routes.json`
- `/quickstart -> /docs#quickstart`
- `/captures`, `/training`, `/distill -> /compiler-product#pipeline`
- `/runtimes -> /platform`
- `/tui -> /account/overview`
- `/control-center`, `/api-control-center`, `/enterprise-control -> /account/api-control-center`
- `/self-host`, `/airgap -> /security`

Audit URLs on the main domain should redirect to `https://audit.kolm.ai/...` unless the request host is already `audit.kolm.ai`, where preserved audit pages are served.

## Maintenance Rule

When product scope changes:

1. Update the backend route or static route.
2. Regenerate `public/docs/api-routes.json`, `public/docs/api.html`, and `public/openapi.json`.
3. Assign the route group exactly once in `docs/product-surfaces.json`.
4. Regenerate `public/product-graph.json`.
5. Regenerate readiness/control files if the graph or docs changed.
6. Update public copy so claims match shipped evidence.
7. Run the certification commands below.

## Certification Commands

Local contract:

```powershell
node scripts\build-api-ref.cjs
node scripts\build-openapi.cjs
npm.cmd run build:product-graph
npm.cmd run build:readiness-closeout
npm.cmd run build:control-files
npm.cmd run lint:refs
npm.cmd run verify:kernel
npm.cmd run verify:surfaces
npm.cmd run verify:control-files
npm.cmd run verify:claims-scope
npm.cmd run ui:audit:critical
node --check server.js
node --check src\router.js
node --test --test-concurrency=1 tests\site.test.js
node --test --test-concurrency=1 tests\product-compiler-contract.test.js tests\wrapper-email.test.js
```

Production-final contract:

```powershell
node cli\kolm.js health --json --require-ready --require-auth
node cli\kolm.js doctor --json
node cli\kolm.js whoami --json
node cli\kolm.js doctor --loop --remote --json
node scripts\prod-surface-smoke.cjs --json --require-auth
node scripts\prod-surface-smoke.cjs --json --deep --require-auth
node scripts\release-verify.cjs --json
```

Production-final commands must not use `--allow-logged-out`, skipped gates, offline billing fallbacks, or unpublished package artifacts.
