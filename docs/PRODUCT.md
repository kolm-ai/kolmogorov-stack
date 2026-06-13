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

The current homepage infra-site pass is `docs/research/homepage-infra-site-gap-2026-06-13.md`. It adds current-source pressure from Vercel, Cloudflare, Supabase, Stripe, Workato, Vanta, and Drata. The product requirement from that pass is: the homepage must prove the contract behind the claim by showing route inventory, public API contract endpoints, readiness limits, source-to-proof workflow, and the competitor-aware integration stance within the main product narrative.

The current homepage image-2 facelift pass is `docs/research/homepage-image-two-facelift-2026-06-13.md`. It turns the local `_audit/test/ev2.png` reference into a homepage visual contract: compact paper navigation, black primary action, green accent, and a full-bleed dark product artifact in the first viewport, while preserving the proof board and API Control Center product spine.

The current main-site image-2 cascade pass is `docs/research/main-site-image-two-cascade-2026-06-13.md`. It promotes the homepage visual contract into a reusable primary-site shell: `compiler-site--paper`, the image-2 design marker, `compiler-brand-hero.png`, light browser theme metadata, and dark technical panels only where the product machine is being shown.

The current API reference operating-surface pass is `docs/research/api-reference-operating-surface-gap-2026-06-13.md`. It adds current-source pressure from Stripe, Vercel AI Gateway, Cloudflare API Shield, Supabase Data REST API, and Pioneer Agent. The product requirement from that pass is: the generated API reference must show the runnable source-to-proof path, enterprise control-center contract, generated OpenAPI surface, and readiness limits instead of behaving like a static endpoint dump.

The current iconic unicorn/API-control design pass is `docs/research/iconic-unicorn-api-control-design-pass-2026-06-13.md`. It rechecks Pioneer Agent, Vercel AI Gateway, Portkey, LiteLLM, Langfuse, Braintrust, Airbyte, and Confluent against the image-2 design system. The product requirement from that pass is: Kolm must show the control layer between gateway capture, eval/observability, data-plane connectors, Pioneer-style improvement loops, portable artifacts, runtime targets, and governance exports, while the UI enforces no clipped mobile hero content.

The current universal-intake implementation pass is `docs/research/unicorn-api-control-universal-intake-pass-2026-06-13.md`. It adds a live `POST /v1/account/api-control-center/events` route and requires every prompt/response tuple, payload, event, data, or request body to return a canonical control-event envelope with redaction result, schema confidence, retention class, policy decision, receipt id, and `secret_values_included: false`.

The current iconic homepage hardening pass is `docs/research/iconic-homepage-unicorn-hardening-2026-06-13.md`. It rechecks Pioneer, Vercel AI Gateway, Portkey, LiteLLM, Langfuse, Braintrust, Airbyte, Confluent, and MuleSoft against the image-2 reference. The product requirement from that pass is: the first viewport must feel like serious infrastructure, with one compact nav action, a signature green headline break, a dark proof terminal, no crowded hero button row, and mobile terminal code that wraps instead of smushing.

The current API reference image-2 hardening pass is `docs/research/api-reference-image-two-hardening-2026-06-13.md`. It rechecks Vercel AI Gateway, LiteLLM, Airbyte, and Confluent docs as infra-doc pressure. The product requirement from that pass is: generated API docs must feel like a first-class product surface, not a detached route dump, while still preserving source-generated route inventory, proof cards, source-to-proof runbook, OpenAPI links, readiness limits, and dark code blocks where technical artifacts belong.

The current image-2 unicorn nav contract is `docs/research/image-two-unicorn-nav-contract-2026-06-13.md`. It rechecks Workato, MuleSoft, Airbyte, Confluent, Pioneer Agent, and Vercel interface guidance against the local `_audit/test/ev2.png` reference. The product requirement from that pass is: primary `kolm.ai` paper pages and generated API docs use the compact `Solutions / Developers / Pricing` header with status icon, quiet sign-in, and `Get API key ->`, while API Control Center and audit positioning are proven in the page body instead of crowding the primary nav.

The current homepage control-map unicorn pass is `docs/research/homepage-control-map-unicorn-pass-2026-06-13.md`. It rechecks Workato, MuleSoft, Airbyte, Fivetran, Confluent, OpenLineage, Akto, Vanta, Drata, Pioneer Agent, and Vercel interface guidance against the image-2 homepage. The product requirement from that pass is: the homepage proof board must visually show existing enterprise systems as source, sink, lineage, security, and GRC nodes, Kolm as the central API Control Center and behavior-to-artifact compiler, and the outputs as canonical event envelopes, readiness-gated artifacts, and enterprise proof exports.

The current unicorn control-plane refresh is `docs/research/unicorn-control-plane-research-refresh-2026-06-13.md`. It rechecks Pioneer Agent, Data Product MCP, MuleSoft API Management, and Workato Enterprise MCP. The product requirement from that pass is: Kolm should prove source-to-proof control, readiness-gated promotion, canonical event envelopes, SDK distribution, and image-2 first-viewport product specificity without claiming objective superiority before public benchmark, certification, package-release, and partner-adoption gates close.

The current iconic control-center mobile facelift is `docs/research/iconic-control-center-mobile-facelift-2026-06-13.md`. It rechecks Pioneer Agent, Vercel AI Gateway, Portkey, Langfuse, Braintrust, Airbyte, Confluent, Workato, Vanta, and MCP against the local image-2 design contract. The product requirement from that pass is: the API Control Center first viewport must show the source-to-proof console before mobile metric tiles, the homepage image layer must behave like a technical artifact rather than a clipped decoration, and the backend claim must stay bound to `GET /v1/account/api-control-center` plus `POST /v1/account/api-control-center/events`.

The current pricing estimator unicorn-control pass is `docs/research/pricing-estimator-unicorn-control-pass-2026-06-13.md`. It rechecks Pioneer Agent, Fivetran, Confluent, Vanta, Akto, OpenLineage, and Vercel interface guidance. The product requirement from that pass is: pricing must become a runnable workload control surface backed by `GET /v1/pricing/estimate` and `POST /v1/pricing/estimate`, not only a static set of SaaS cards.

The current API Control live intake workbench pass is `docs/research/api-control-live-intake-workbench-2026-06-13.md`. It rechecks Pioneer Agent, Data Product MCP, MuleSoft API Management, Workato Enterprise MCP, and Vercel interface guidance. The product requirement from that pass is: the account API Control Center must let an operator submit a governed event to `POST /v1/account/api-control-center/events`, render the canonical receipt envelope, and prove sensitive values stay out of the receipt UI.

The current adapter manifest control workbench is `docs/research/adapter-manifest-control-workbench-2026-06-13.md`. It converts broad "any API data" positioning into a runnable semantic-promotion gate: `POST /v1/account/api-control-center/adapter-manifests/validate` validates adapter id, version, channel family, direction, schema, redaction map, egress destinations, and fixture evidence before any adapter-owned field mapping can return `manifest-declared`.

The current status deploy command-center pass is `docs/research/status-deploy-command-center-2026-06-13.md`. It rechecks Vercel interface guidance, Railway config, Vercel rewrites, and the readiness closeout ledger. The product requirement from that pass is: `/status` must behave like an operator deploy gate by reading `/health`, `/ready`, `/v1/product/graph`, and `/product-readiness-closeout.json`, while publishing the backend-first Railway and frontend Vercel deploy sequence without closing external readiness gates.

The current iconic unicorn research facelift is `docs/research/iconic-unicorn-research-facelift-2026-06-13.md`. It rechecks Workato, MuleSoft, Airbyte, Fivetran, OpenLineage, Akto, Drata, Langfuse, Pioneer Agent, Agent-First Tool API, Governance-Aware Agent Telemetry, MCPSHIELD, and Vercel interface guidance. The product requirement from that pass is: the homepage must use image-2 as a visible product artifact on mobile and desktop, and the proof board must show the competitor field as orchestration, context/data, lineage, security, trust, and agent-ops slices that Kolm turns into canonical envelopes, signed artifacts, and exportable proof.

The current iconic unicorn design/control audit is `docs/research/iconic-unicorn-design-and-control-audit-2026-06-13.md`. It rechecks Workato, MuleSoft, Airbyte, Fivetran, Vercel, Pioneer Agent, and Vercel Web Interface Guidelines. The product requirement from that pass is: image 2 must operate as a real first-viewport product artifact, API semantics must be promoted only through runnable evidence gates, and the UI must keep mobile hierarchy, form labels, focus states, and overflow handling tight enough for enterprise operators.

The current homepage command-deck design upgrade is `docs/research/homepage-command-deck-design-upgrade-2026-06-13.md`. It turns the homepage from a valid but generic SaaS page into a control-room surface: first-viewport product metrics, a dark command strip, source/kernel/proof map labels, a stronger API Control Center kernel, and a public-contract console action, while preserving readiness-gated and secret-safe claim boundaries.

The current integrations command-fabric upgrade is `docs/research/integrations-command-fabric-upgrade-2026-06-13.md`. It turns `/integrations` into a first-viewport source-to-proof switchboard: category leaders stay source systems, Kolm owns the canonical event and adapter evidence gates, and the page shows receipts, signed artifacts, governance packets, and external exports without claiming third-party certification or benchmark leadership.

The public category page is `/compare`. It should stay compiler/control-center-first and avoid audit-only positioning.

The public integration map is `/integrations`. It should show the 17 API/data-channel families, source/sink clusters, source-to-proof operator path, market-pressure context, policy posture, and adapter caveats that make the account API control center credible.

The public runtime target matrix is `/runtimes`. It should show serving engines, hosted GPU targets, local runners, portable inference, device edge, and enterprise fleet exports as readiness-gated target recipes, not unproven runtime ownership claims.

## Current Enforced Scope

The machine-readable source of truth is `docs/product-surfaces.json`; the generated public graph is `public/product-graph.json`.

Current generated graph:

| Area | Count |
| --- | ---: |
| Routes | 926 |
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
