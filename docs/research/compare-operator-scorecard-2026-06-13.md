# Compare Operator Scorecard Pass - 2026-06-13

This pass updates `/compare` from a category narrative into an operator scorecard. The goal is to show how Kolm can become category-leading without pretending to replace every specialist product.

## Sources Checked

- Pioneer Agent: production failure diagnosis, targeted data curation, supervision, retraining, and regression verification for small language models. Source: https://arxiv.org/abs/2604.09791
- Portkey AI Gateway: gateway primitives now include routing, fallbacks, cache, retries, budgets, rate limits, canary behavior, governance, and provider abstraction. Source: https://portkey.ai/docs/product/ai-gateway
- Langfuse: the observability/eval market expects traces, sessions, prompt versions, datasets, custom scores, production evals, and administration. Source: https://langfuse.com/docs
- Respan: the product menu around LLM observability includes tracing, monitoring, user analytics, evals, prompt management, gateway, MCP, provider keys, team management, and security programs. Source: https://www.respan.ai/docs/documentation/getting-started/overview

## Product Decision

Kolm should not claim to be a better gateway than every gateway, a better eval dashboard than every eval platform, or a better model host than every serving platform. The stronger claim is narrower and more durable:

- Use gateway events as governed compiler inputs.
- Turn traces and evals into regression slices, training/eval bundles, compile inputs, and artifact evidence.
- Make Pioneer-style failure improvement enterprise-owned: failure queue, taxonomy, curriculum, replay gates, compile, target, promotion, and export inside the tenant control plane.
- Package behavior into signed `.kolm` artifacts instead of only hosting a model endpoint.
- Export proof without overclaiming certification or readiness.
- Accept every credible API data path as a governed event, with opaque-safe intake for unknown schemas and declared egress for exports.

## Implementation Delta

`public/compare.html` now includes `#operator-scorecard`, a responsive buyer checklist spanning gateway/routing, observability/evals, Pioneer-style improvement, fine-tuning/serving, security/GRC, and data/ops plane pressure.

`tests/site.test.js` now asserts the scorecard, representative sources, closed-loop vocabulary, data movement counts, and anti-overclaiming language.
