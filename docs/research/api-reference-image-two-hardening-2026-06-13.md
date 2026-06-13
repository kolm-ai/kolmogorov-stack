# API Reference Image-2 Hardening - 2026-06-13

## Current Sources Checked

- Vercel AI Gateway docs: https://vercel.com/docs/ai-gateway
- LiteLLM proxy quick start: https://docs.litellm.ai/docs/proxy/quick_start
- Airbyte platform docs: https://docs.airbyte.com/platform
- Confluent Platform docs: https://docs.confluent.io/platform/current/overview.html

## Competitive Pressure

Top infrastructure products make docs part of the product surface. Gateway docs expose model/provider routing, supported APIs, observability, usage, billing, BYOK, and ecosystem integrations as a navigable operating contract. Data-plane docs make source, destination, connector, stream, and governance concepts explicit.

Kolm's generated API reference already had the right machine content: 923 wired routes, route groups, proof cards, source-to-proof runbook, OpenAPI, readiness ledger, and account control center links. The gap was presentation: it used the older dark shell and felt detached from the image-2 public site.

## Implemented Requirement

`/docs/api` must now render as a first-class image-2 infra page:

- Paper page shell with the same light browser theme and compiler social card as the primary site.
- Shared `compiler-site--paper` and `data-design-reference="image-2"` markers.
- Dark technical panel only for the API surface map and code examples.
- White proof cards and route cards so the page reads as documentation, not a terminal dump.
- Generated source remains `scripts/build-api-ref.cjs`; `public/docs/api.html` is not hand edited.
- Site tests pin the page shell so future route-reference regeneration cannot regress to the old dark docs look.

