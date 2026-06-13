# API Reference Operating Surface Gap - 2026-06-13

## Sources Reviewed

- Stripe API reference: https://docs.stripe.com/api
- Vercel AI Gateway docs: https://vercel.com/docs/ai-gateway
- Cloudflare API Shield docs: https://developers.cloudflare.com/api-shield/
- Supabase Data REST API docs: https://supabase.com/docs/guides/api
- Pioneer Agent paper: https://arxiv.org/abs/2604.09791

## Market Pattern

The strongest infrastructure docs do more than list endpoints:

- Stripe leads API consumers through base URL, auth, predictable resource behavior, response formats, HTTP codes, versioning, sandboxes, and quickstarts.
- Vercel AI Gateway connects one endpoint to provider compatibility, routing, fallbacks, usage, billing, BYOK, observability, and framework integrations.
- Cloudflare API Shield shows that API inventory, schema posture, and protection are part of the API product, not only security afterthoughts.
- Supabase treats generated APIs as a core product surface around auth, database, storage, functions, and realtime workflows.
- Pioneer Agent reinforces the closed-loop SLM lesson: production improvement is diagnosis, targeted data or curriculum construction, retraining, and regression verification.

## Product Implication

Kolm's generated API reference should not be only an endpoint dump. It must show the operating path that makes the backend credible:

1. Create a tenant workspace and first key.
2. Route provider-compatible model traffic.
3. Govern ingress, egress, redaction, retention, routing, eval gates, compile targets, and exports from the API Control Center.
4. Compile stable behavior into portable artifacts.
5. Export proof and readiness limits before claims are promoted.

This is the docs equivalent of the homepage proof board and account-side operator workbench.

## Local Delta

This pass upgrades `scripts/build-api-ref.cjs`, which regenerates `public/docs/api.html`.

The generated API reference now includes:

- ASCII page title and social title to avoid encoding drift in a critical generated artifact.
- An API operating proof surface with links to `/signup`, `/account/api-control-center`, `/openapi.json`, and `/product-readiness-closeout.json`.
- A source-to-proof API runbook spanning `POST /v1/signup`, `POST /v1/route/chat/completions`, `GET /v1/account/api-control-center`, `POST /v1/compile`, and `GET /v1/evidence/readiness`.
- Removal of the stale bridge from `/docs/api` to `/api`, because `/api` is a compatibility redirect back to `/docs/api`.
- Larger disclosure summary targets to preserve mobile touch ergonomics.

## Regression Requirement

`tests/site.test.js` must assert that the generated API reference remains an operating surface, keeps the enterprise control-center and proof endpoints visible, and never reintroduces stale audit packaging or `/api` self-redirect copy.
