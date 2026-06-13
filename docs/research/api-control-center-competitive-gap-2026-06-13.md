# API Control Center Competitive Gap Pass - 2026-06-13

This pass updates the enterprise API Control Center requirement after checking current external pressure from Pioneer Agent, Portkey, Langfuse, Respan, Braintrust, Humanloop, and Galileo-style product surfaces.

## Source-Backed Pressure

- Pioneer Agent frames the hard production loop as failure diagnosis, targeted supervision, retraining, and regression verification from judged production traces. Source: https://arxiv.org/abs/2604.09791
- Portkey's AI Gateway positions routing, cache, MCP, fallbacks, conditional routing, retries, circuit breakers, load balancing, canary testing, gRPC, budgets, rate limits, custom hosts, and governance as gateway primitives. Source: https://portkey.ai/docs/product/ai-gateway
- Langfuse groups observability, prompt management, evaluation, API/data platform, and enterprise administration. It also emphasizes traces, sessions, agent graphs, OpenTelemetry compatibility, prompt version deployment, datasets, production evals, and custom scores. Source: https://langfuse.com/docs
- Respan, formerly Keywords AI, presents tracing, monitoring, user analytics, evals, prompt management, gateway, MCP, provider keys, team management, and security programs as the product menu. Source: https://www.respan.ai/docs/documentation/getting-started/overview
- Braintrust, Humanloop, and Galileo reinforce the market norm that evaluations, experiments, observability, and production monitoring are not docs-only features; they must be inspectable product workflows.

## Kolm Product Requirement

Kolm cannot win by showing only a gateway, only traces, or only evals. The Control Center must expose the full enterprise data plane:

- Ingress: every credible source enters as a tenant-scoped governed event.
- Egress: every destination leaves with explicit policy, provenance, and receipt context.
- Closed-loop improvement: captured failures must be visible as a lifecycle from observation to taxonomy, curriculum, regression replay, compile, target fit, promotion, and export.
- Unknown-schema honesty: opaque vendor payloads can be accepted, but semantic understanding is not claimed until schema hints or an adapter manifest exist.

## Implementation Delta

This pass adds `closed_loop_improvement` to `GET /v1/account/api-control-center` and renders it in `public/account/api-control-center.html` as a first-class "Failure to artifact" control section.

The new contract deliberately avoids claiming autonomous production deployment. It marks the loop as `readiness-gated` and requires tenant fence, redaction, human review for high-risk labels, protected-slice regression checks, target-fit checks, and declared egress destinations.
