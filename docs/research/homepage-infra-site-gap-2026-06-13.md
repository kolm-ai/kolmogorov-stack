# Homepage Infra Site Gap - 2026-06-13

## Sources Reviewed

- Vercel homepage: https://vercel.com/
- Cloudflare Developer Platform: https://www.cloudflare.com/developer-platform/
- Supabase homepage: https://supabase.com/
- Stripe homepage: https://stripe.com/
- Workato homepage: https://www.workato.com/
- Vanta homepage: https://www.vanta.com/
- Drata Developer Portal: https://developers.drata.com/

## Market Pattern

The strongest infrastructure homepages do not rely only on a positioning sentence. They make the product concrete quickly:

- Vercel exposes product families, docs, changelog, AI Gateway, workflow, observability, security, customer proof and deployment CTAs.
- Cloudflare frames the developer platform as primitives for compute, data, storage, media and AI, with pricing/demo paths.
- Supabase leads with a precise platform primitive: Postgres plus auth, instant APIs, functions, realtime, storage and vector.
- Stripe makes scope credible with product families, API/dashboard language, uptime and volume proof.
- Workato positions around orchestration, Enterprise MCP, developer portal, docs, sandbox, CLI and integrations.
- Vanta makes trust the first product message and supports it with resources, customer proof and compliance categories.
- Drata exposes developer-facing API, custom connections, workflows, evidence automation, MCP and trust automation.

## Product Implication

Kolm's homepage must show the contract behind the claim. The key gap is not another visual flourish; it is the lack of a compact proof board that shows:

1. The public product graph and route inventory.
2. The API endpoints behind the UI.
3. The explicit readiness gates that prevent unsupported claims.
4. The source-to-proof path from existing enterprise systems into artifacts and governance packets.
5. The competitor-aware stance: specialized platforms stay sources, controls, sinks or targets; Kolm owns the governed behavior-to-artifact chain.

## Local Delta

This pass adds a homepage infra proof board backed by static fallbacks and public API hydration:

- `GET /v1/product/graph` for route graph and journey counts.
- `GET /v1/product/capabilities` for product surfaces.
- `GET /v1/evidence/readiness` for open proof gates.
- `GET /v1/account/api-control-center` as the tenant control-center contract.

The section intentionally states that Kolm should not claim to replace Workato, MuleSoft, Airbyte, Fivetran, Confluent, OpenLineage, Akto, Vanta or Drata. The product requirement is to turn their signals into governed receipts, artifacts, lineage and exportable proof.

## Regression Requirement

`tests/site.test.js` should keep the homepage proof-led by asserting the proof board, public contract endpoints, route counts, readiness gates, competitor-aware caveat, and no-overclaim language.
