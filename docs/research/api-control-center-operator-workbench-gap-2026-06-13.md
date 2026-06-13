# API Control Center Operator Workbench Gap Pass - 2026-06-13

This pass checks the current competitive pressure around AI gateways, eval/observability platforms, and agent protocols, then turns the gap into a concrete Kolm product requirement: the account control center must show an operator how a source becomes governed proof, not only list broad channel coverage.

## Current Source Pressure

- Pioneer Agent shows the production SLM improvement loop is diagnosis, curriculum/data construction, retraining, and regression verification around production-style failures. Source: https://arxiv.org/abs/2604.09791
- Portkey's AI Gateway exposes the buyer expectation for gateway primitives: universal API, cache, MCP, fallbacks, conditional routing, automatic retries, circuit breakers, load balancing, canary testing, gRPC, budget limits, rate limits, custom hosts, and self-hosting. Source: https://portkey.ai/docs/product/ai-gateway
- Vercel AI Gateway positions one endpoint for hundreds of models with budgets, usage monitoring, load balancing, fallbacks, retries, embeddings, BYOK, and OpenAI/Anthropic compatibility. Source: https://vercel.com/docs/ai-gateway
- LiteLLM sets the open-source gateway baseline: OpenAI-compatible input/output across 100+ LLMs, proxy server, authentication/authorization, multi-tenant cost tracking, budgets, guardrails, caching, virtual keys, and an admin dashboard. Source: https://docs.litellm.ai/
- Langfuse shows that traces, prompt management, evals, datasets, experiments, user feedback, annotation queues, custom scores, OpenTelemetry, sessions, agent graphs, and enterprise admin are now expected as one AI-engineering lifecycle surface. Source: https://langfuse.com/docs
- Braintrust frames the lifecycle as instrument, observe, annotate, evaluate, deploy, and administer, with production tracing, human feedback, datasets, experiments, regression catching, and monitoring. Source: https://www.braintrust.dev/docs
- LangSmith positions observability, evaluation, deployment, prompt engineering, CLI access, Studio, self-host/hybrid setup, and security/compliance as an integrated agent/LLM workflow. Source: https://docs.langchain.com/langsmith/home
- Galileo positions observability, evaluation, production guardrails, experiments, annotations, agent control, A2A, OpenTelemetry, and popular agent-framework integrations as the reliability surface. Source: https://docs.galileo.ai/what-is-galileo
- MCP is now the broad protocol for connecting AI applications to tools, data sources, and workflows, with broad client/server ecosystem support. Source: https://modelcontextprotocol.io/docs/getting-started/intro
- A2A is now the protocol pressure for agent-to-agent interoperability, including opaque agents, streaming/asynchronous operations, multi-tenancy, and explicit complementarity with MCP. Source: https://a2a-protocol.org/latest/
- OpenTelemetry has moved GenAI semantic conventions into a dedicated repository and exposes GenAI, MCP, GraphQL, JSON-RPC, messaging, database, and log conventions as standards gravity for instrumentation. Source: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## Gap

The existing API Control Center already exposes broad coverage: 17 data-channel families, 12 ingress modes, 10 export modes, 8 governance stages, and a readiness-gated failure-to-artifact loop. That is necessary but not enough.

Competitors have trained buyers to expect a live workflow, not a claim list. A category-leading Kolm control center needs a top-level operator workbench that answers:

1. What source am I declaring?
2. What policy gates apply before persistence or egress?
3. What failure signal moves into the improvement loop?
4. What artifact and runtime target are being compiled?
5. What proof leaves the UI, and where can a buyer verify it?

## Product Delta

This pass adds `operator_workbench` to `GET /v1/account/api-control-center` and renders it above the dense coverage sections in `public/account/api-control-center.html`.

The workbench is deliberately source-to-proof:

- Declare Source & Schema
- Set Egress Policy
- Diagnose Failure Loop
- Compile Target Receipt
- Export Governance Packet

Each step must declare trigger, action, proof, and route. The UI also adds channel filters for all, ingress, egress, protocol, and opaque/custom channels so broad coverage is operable on small and large screens.

## Strategic Rule

Kolm should keep saying it is not a replacement for every gateway, eval platform, GRC platform, runtime, or protocol. The strongest claim is narrower and more defensible: Kolm turns those sources into governed, signed, portable runtime artifacts and proof exports.

