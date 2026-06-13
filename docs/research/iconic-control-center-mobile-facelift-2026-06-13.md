# Iconic control-center mobile facelift - 2026-06-13

## Sources checked

- Pioneer Agent, arXiv 2604.09791, submitted 2026-04-10: https://arxiv.org/abs/2604.09791
- Vercel AI Gateway docs, checked 2026-06-13: https://vercel.com/docs/ai-gateway
- Portkey docs, checked 2026-06-13: https://portkey.ai/docs
- Langfuse docs, checked 2026-06-13: https://langfuse.com/docs
- Braintrust docs, checked 2026-06-13: https://www.braintrust.dev/docs
- Airbyte docs, checked 2026-06-13: https://docs.airbyte.com/
- Confluent docs, checked 2026-06-13: https://docs.confluent.io/
- Workato docs, checked 2026-06-13: https://docs.workato.com/
- Vanta developer docs, checked 2026-06-13: https://developer.vanta.com/docs
- Model Context Protocol docs, checked 2026-06-13: https://modelcontextprotocol.io/docs/getting-started/intro

## Competitive read

Pioneer is the sharpest technical bar because it frames production improvement as a loop: collect failures, diagnose them, synthesize targeted supervision, retrain, and verify against regressions. Kolm should answer by showing the source-to-proof path around production API behavior, not by claiming an unearned benchmark lead.

Vercel AI Gateway, Portkey, Langfuse, and Braintrust make gateway routing, provider abstraction, observability, evals, prompts, and monitoring table stakes. Kolm needs to show why the API Control Center is a higher-order control layer: it must connect capture, policy, eval gates, compile artifacts, runtime targets, and proof exports.

Airbyte, Confluent, Workato, MCP, and Vanta widen the category from model calls to enterprise data movement, event streams, agent tools, orchestration, and compliance evidence. Kolm should not claim to replace those systems. It should ingest and export across them through governed envelopes, adapter confidence states, and destination-aware receipts.

## UI decisions locked by this pass

- The API Control Center first viewport must expose a dark source-to-proof console before mobile metric tiles. A mobile fold that only shows headline, stats, and buttons under-sells the product.
- The homepage should keep the image-2 paper/nav/terminal language and use `compiler-brand-hero.png` as a technical artifact layer, not as a half-clipped decorative card.
- Control-center copy must stay concrete: 17 channel families, 12 collection modes, 10 export modes, 8 governance stages, `secret_values_included: false`, readiness-gated promotion.
- Claims remain scoped. Kolm can say the local backend contract exists and is verified; it cannot say it is objectively better than all companies or production-final until public benchmark, certification, package release, and partner-adoption gates close.

## Backend posture required

- `GET /v1/account/api-control-center` remains the operator contract.
- `POST /v1/account/api-control-center/events` remains the universal intake path for prompt/response tuples, payloads, events, data, request bodies, ingress, and egress signals.
- Unknown vendor payloads can be accepted as opaque governed events only when tenant policy allows them.
- Semantic understanding requires an adapter manifest, schema hints, or native connector evidence.
- Every public envelope must keep secret values out.
