# Kolm Product Spec

Updated: 2026-06-13

## One Sentence

Kolm is the AI compiler and API wrapper that turns repeated model traffic into signed `.kolm` artifacts with eval gates, receipts, runtime targets, and governance evidence.

## What Changed From The Old Product

The old public surface was centered on agent security-readiness audit reports. That surface still exists and is preserved on `audit.kolm.ai` through `public/audit.html`, `public/audit-docs.html`, and `public/audit-pricing.html`.

The main `kolm.ai` product is now broader:

1. Capture model calls through provider-compatible routes.
2. Curate traces into datasets, labels, evals, and improvement loops.
3. Compile stable behavior into signed `.kolm` artifacts.
4. Compose smaller specialists where that is cheaper or safer.
5. Deploy artifacts toward concrete runtimes and devices.
6. Export receipts, audit logs, privacy evidence, and compliance packets.
7. Give enterprise teams one API control center for ingress, egress, capture policy, redaction, routing, eval gates, compile state, deployment targets, and exports.

Audit is a secondary module on that stack, not the default homepage product.

## Product Spine

```
gateway traffic
  -> capture ledger
  -> dataset / labels / evals
  -> compile preview
  -> signed artifact
  -> runtime target
  -> receipt chain
  -> governance export
```

This spine is the scope boundary. A feature is product only when it lands on this path or directly proves one part of it.

## Enterprise API Control Center

The account-side control plane is `/account/api-control-center`, backed by `GET /v1/account/api-control-center`.

The contract covers REST JSON, streaming/SSE, webhooks, batch JSONL/CSV-style exports, OpenTelemetry/GenAI spans, MCP tool traffic, A2A agent traffic, browser/client events, files/blobs, GraphQL/RPC envelopes, queues/topics, warehouse/lakehouse drops, database CDC, SIEM/log drains, collaboration/ticketing callbacks, package/registry releases, and custom adapter envelopes. Each channel declares direction, data styles, routes, and controls.

The same endpoint now also exposes 12 ingress collection modes, 10 egress/export modes, and 8 governance stages: accept, classify, redact, route, evaluate, compile, target, and export. This is the enforceable control-center shape behind the public claim that Kolm can govern broad API/data collection in and out without pretending every unknown vendor schema is semantically understood on day one.

The endpoint also exposes an operator workbench. Its job is to turn the broad coverage contract into a usable source-to-proof runbook: declare source and schema, set egress policy, diagnose the failure loop, compile target receipts, and export governance packets. Each workbench step must declare trigger, operator action, proof, and backend route.

The control center must accept unknown vendor payloads as opaque governed events when tenant policy allows them, but it must not claim semantic understanding until an adapter manifest, schema hints, or a native connector proves that understanding.

Default posture:

- Capture mode: metadata plus redacted body.
- Egress mode: deny until the provider or destination is declared.
- Cache mode: tenant-isolated cache keys only.
- Unknown payloads: accepted as opaque events only when size and tenant policy allow.
- Public envelopes: no secret values.

This is the practical answer to the market gap: gateways, observability tools, eval tools, and closed-loop SLM retraining systems usually cover only part of the lifecycle. Kolm's control center keeps the API data path, evidence path, compile path, and deployment path in one tenant-scoped contract.

## Competitive Position

The current category atlas is `docs/research/category-competitor-atlas-2026-06-13.md`. It maps 290+ competitors, standards, protocols, and adjacent players across gateways, API management, observability/evals, fine-tuning, serving, runtimes, agent frameworks, RAG substrate, AI security, GRC/trust, standards, and developer-platform design references.

The product rule from that research is: Kolm should not claim to be a better version of every specialized tool. Gateways route, eval platforms score, fine-tuning platforms train, security tools defend, GRC platforms manage trust, and runtimes serve. Kolm should own the transition from captured API behavior into governed, signed, portable runtime artifacts.

The current unicorn product benchmark is `docs/research/unicorn-product-research-2026-06-13.md`. It is an internal quality bar for product specificity, docs, control centers, proof, trust, integrations, and exportable artifacts, not a public valuation claim.

The current API Control Center operator-workbench pass is `docs/research/api-control-center-operator-workbench-gap-2026-06-13.md`. It adds current-source pressure from Pioneer Agent, Portkey, Vercel AI Gateway, LiteLLM, Langfuse, Braintrust, LangSmith, Galileo, MCP, A2A, and OpenTelemetry. The product requirement from that pass is: broad coverage must be rendered as a usable source-to-proof workflow, not only a list of supported channels.

The current integrations/data-plane pass is `docs/research/integrations-data-plane-gap-2026-06-13.md`. It adds current-source pressure from Workato, MuleSoft, Airbyte, Fivetran, Confluent, OpenLineage, Akto, Vanta, and Drata. The product requirement from that pass is: the public integration story must treat existing workflow, data movement, catalog, security, GRC, gateway, eval, and runtime platforms as source, control, evidence, or target nodes, then show how Kolm turns their signals into receipts, artifacts, lineage, and governance packets.

The public category page is `/compare`. It should stay compiler/control-center-first and avoid audit-only positioning.

The public integration map is `/integrations`. It should show the 17 API/data-channel families, source/sink clusters, source-to-proof operator path, market-pressure context, policy posture, and adapter caveats that make the account API control center credible.

The public runtime target matrix is `/runtimes`. It should show serving engines, hosted GPU targets, local runners, portable inference, device edge, and enterprise fleet exports as readiness-gated target recipes, not unproven runtime ownership claims.

## Current Enforced Scope

The machine-readable source of truth is `docs/product-surfaces.json`; the generated public graph is `public/product-graph.json`.

Current generated graph:

| Area | Count |
| --- | ---: |
| Routes | 922 |
| Route groups | 214 |
| Route surfaces | 7 |
| API reference routes | 69 |
| Product journeys | 12 |
| Readiness requirements | 57 |
| Open readiness groups | 8 |
| CLI commands | 64 |
| Account links | 33 |
| TUI views | 32 |

The seven route surfaces are:

1. Identity, access, teams, and billing.
2. Public site, docs, API reference, and SDK distribution.
3. Compile, artifact, registry, receipts, and verification.
4. Runtime, inference, connectors, and multimodal APIs.
5. Capture, datasets, evals, labels, training, and improvement loop.
6. Governance, compliance, admin, audit, privacy, trace, and notifications.
7. Deployment, edge devices, BYOC, storage, sync, tunnel, and federated learning.

## Shipped Locally Vs Not Final

The route ownership contract is locally certified: every generated route group is assigned to exactly one product surface and the static/API reference gates can verify that mapping.

The product is not production-final. `public/product-readiness-closeout.json` currently lists eight open readiness requirements:

- Public reproducible benchmark data.
- Live auditor/certification evidence.
- Signed installer channel release.
- External runtime adoption proof.
- External standards/foundation acceptance.
- SDK package release matrix.
- Mobile package release.
- Browser/runtime package channel release.

Marketing and UI must not describe those items as fully shipped until the closeout ledger promotes them.

## Non-Negotiable Scope Rules

- Do not claim formal SOC 2, ISO 27001, HIPAA, FedRAMP, SLSA, package-channel, standards-body, benchmark-leaderboard, or third-party runtime adoption evidence without a dated artifact in the readiness ledger.
- Do not imply full trained-weight bundling or mobile/runtime parity. Current artifacts package executable recipes, examples, evaluators, tokenizer metadata, manifests, hashes, and receipts; trained-weight bundling remains gated.
- Do not position Kolm as a generic fine-tuning UI. The product wins only when capture, eval, artifact, runtime, and governance evidence stay connected.
- Do not bury the audit product. It remains available at `audit.kolm.ai`, but main-site navigation and onboarding should start with compiler workflows.

## Backend Contract

Minimum public routes that must remain coherent with the site:

- `GET /v1/product/capabilities`
- `GET /v1/product/graph`
- `GET /v1/plans`
- `GET /v1/billing/tiers`
- `POST /v1/signup`
- `GET /v1/account/compiler-overview`
- `GET /v1/account/api-control-center`
- `GET /docs/api`
- `GET /openapi.json`
- `GET /docs/api-routes.json`

Compatibility URLs such as `/product`, `/models`, `/api`, `/quickstart`, `/captures`, `/training`, `/distill`, `/control-center`, `/api-control-center`, `/enterprise-control`, `/self-host`, and `/airgap` must redirect to the nearest canonical compiler surface. `/runtimes` is now a canonical product surface.

## Verification Commands

```powershell
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

Production-final claims additionally require authenticated production smoke:

```powershell
node scripts\prod-surface-smoke.cjs --json --require-auth
node scripts\prod-surface-smoke.cjs --json --deep --require-auth
node scripts\release-verify.cjs --json
```
