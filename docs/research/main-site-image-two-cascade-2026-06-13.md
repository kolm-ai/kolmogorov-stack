# Main Site Image-2 Cascade Pass - 2026-06-13

## Local visual reference

The local reference remains `_audit/test/ev2.png`: light paper surface, quiet grid, thin navigation, black primary action, green accent, and one dark technical panel carrying the machine proof.

## Current-source pressure

- Pioneer Agent frames the important product loop as production failure diagnosis, data curation, retraining, and regression verification for small language models: https://arxiv.org/abs/2604.09791
- Portkey's AI Gateway shows the buyer baseline for routing, cache, MCP, fallbacks, retries, circuit breakers, load balancing, canary testing, budgets, rate limits, custom hosts, and gateway-to-provider paths: https://portkey.ai/docs/product/ai-gateway
- Vercel AI Gateway sets a developer-infra docs bar around one endpoint, model/provider controls, fallbacks, caching, observability, usage, billing, authentication, BYOK, and ecosystem integrations: https://vercel.com/docs/ai-gateway
- LiteLLM positions proxy/gateway expectations around unified provider access, budgets, rate limits, caching, guardrails, policies, plugins, load balancing, routing, fallbacks, traffic mirroring, logging, and spend tracking: https://docs.litellm.ai/docs/simple_proxy
- Braintrust sets expectations for instrumentation, traces, logs, human feedback, datasets, evals, prompts, online scoring, deploy controls, and continuous improvement workflows: https://www.braintrust.dev/docs

## Gap

Before this pass the homepage carried the new visual identity, but the buyer and developer surfaces still presented the product with the older dark visual system and retired audit-oriented social card. That made the product feel split: stronger positioning on the homepage, weaker continuity on docs, pricing, signup, integrations, compare, runtimes, enterprise, platform, capabilities, research, changelog, contact, security, and trust.

## Product requirement

The primary compiler site must render as one enterprise infra system:

- light paper shell for product pages;
- dark technical panels only where they expose the operating machine;
- black primary action, green proof accent, restrained borders, and no glow-heavy hero field;
- route, data-channel, policy, eval, compile, artifact, target, receipt, and export proof visible across pages;
- social metadata points at `compiler-brand-hero.png`;
- audit-host pages remain separate and must not be merged back into the compiler claim surface.

## Implementation lock

`public/kolm-main.css` now provides the reusable `compiler-site--paper` cascade. The primary compiler files carry `data-design-reference="image-2"`, and `tests/site.test.js` verifies the shared paper class, design marker, paper browser theme, compiler social card, and absence of the retired audit social card on primary product surfaces.

## Claim discipline

The visual and positioning upgrade does not create a public claim that Kolm is objectively better than every competitor. The defensible claim stays narrower: Kolm should own the transition from captured API behavior into governed, signed, portable runtime artifacts, while readiness-gated items remain explicit.
