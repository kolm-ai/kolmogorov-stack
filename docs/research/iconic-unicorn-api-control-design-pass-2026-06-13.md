# Iconic Unicorn API Control And Design Pass - 2026-06-13

Scope: extend the existing unicorn research with a stricter product and visual bar for the image-2 site shell, API Control Center, data-plane coverage, and Pioneer comparison.

This is an internal quality bar. It is not a public claim that Kolm is objectively better than every competitor.

## Current-source pressure

- Pioneer Agent frames the production SLM improvement loop as data curation, failure diagnosis, regression avoidance, retraining, and verification from downstream feedback: https://arxiv.org/abs/2604.09791
- Vercel AI Gateway sets the gateway ergonomics baseline: one endpoint for many models, budgets, usage monitoring, load balancing, fallbacks, authentication, BYOK, observability, and ecosystem integrations: https://vercel.com/docs/ai-gateway
- Portkey shows the advanced gateway control baseline: universal API, cache, MCP support, fallbacks, conditional routing, automatic retries, circuit breakers, load balancing, canary testing, gRPC, request timeouts, budgets, rate limits, custom hosts, and routes to other provider APIs: https://portkey.ai/docs/product/ai-gateway
- LiteLLM shows the open proxy baseline: 100+ model access, virtual-key budgets, rate limits, caching, guardrails, policies, plugins, load balancing, routing, fallbacks, traffic mirroring, logging, alerts, metrics, secret managers, and spend tracking: https://docs.litellm.ai/docs/simple_proxy
- Langfuse shows the AI engineering workflow baseline: traces across LLM and non-LLM calls, sessions, user tracking, agent graphs, OpenTelemetry compatibility, prompt management, datasets, evaluations, experiments, human labels, and custom scores: https://langfuse.com/docs
- Braintrust shows the production eval workflow baseline: instrument, observe, annotate, evaluate, deploy, and administer, with traces, logs, human review, datasets, experiments, online scoring, gateway, monitoring, projects, providers, and access control: https://www.braintrust.dev/docs
- Airbyte shows the API/data ingress baseline: hundreds of sources and destinations, connectors, Python SDK, HTTP API, MCP server, managed credentials, data replication, and an agent context layer: https://docs.airbyte.com/
- Confluent shows the enterprise event/data-streaming baseline: connect, stream, govern, process, schema registry, connectors, stream governance, Flink processing, and on-prem/cloud deployment modes: https://docs.confluent.io/platform/current/overview.html

## Product requirement

Kolm only wins if the product surface shows and implements the control layer between these categories:

1. Gateway-like capture must ingest every credible API style without pretending every payload is semantically understood.
2. Observability/eval data must become governed objects: traces, events, prompts, completions, tool calls, agent steps, sessions, labels, datasets, eval suites, failure taxonomies, and regression sets.
3. Pioneer-style continuous improvement must be visible as a state machine: observe failure, classify, curate, replay, train or compile, verify, target-fit, promote, export.
4. Data-plane connectors are sources and sinks, not trophies. Kolm should preserve provenance, policy, retention, redaction, lineage, receipts, and export context when data moves in or out.
5. Artifacts must be portable proof, not dashboard-only state: manifest, recipe, hashes, target matrix, receipt, verifier key, and governance packet.
6. Readiness-gated items stay explicit until the ledger proves them.

## Image-2 design requirement

The primary site must feel like an iconic enterprise infra system:

- light paper shell, restrained grid, thin navigation, black primary action, green proof accent;
- one dark technical panel when the machine is being shown;
- no glow-heavy generic SaaS hero field;
- no clipped mobile text or buttons hidden by page-level overflow;
- route-specific social card `compiler-brand-hero.png`;
- status, trust, security, docs, pricing, enterprise, and homepage must share the same image-2 contract.

## Implementation lock from this pass

- `/status` was rebuilt from stale audit-pipeline positioning into a compiler/API-control status surface.
- `tests/site.test.js` now treats `status.html` as an image-2 paper route and rejects the retired audit social card URL on that route.
- The mobile homepage hero wrapper now constrains to the real viewport column so the lede, CTA buttons, and terminal no longer clip against the right edge.
- `scripts/ui-surface-audit.cjs` now fails mobile compiler pages when clipped hero content is hidden by overflow rather than exposed as page scroll.

## Next scope pressure

The next product pass should prioritize account-side API Control Center depth:

- make every ingress and egress family visible as a tenant-scoped object;
- expose adapter confidence for unknown vendor payloads;
- show policy decisions and redaction/retention evidence beside each source;
- show promotion gates from production failures to compile artifacts;
- export governance packets for SIEM, GRC, warehouse/catalog, audit, and verifier workflows.
