# Unicorn control-plane research refresh - 2026-06-13

## Sources checked

- Pioneer Agent, arXiv 2604.09791, submitted 2026-04-10: https://arxiv.org/abs/2604.09791
- Data Product MCP, arXiv 2601.08687 v2, revised 2026-05-11: https://arxiv.org/abs/2601.08687
- MuleSoft API Management page, checked 2026-06-13: https://www.mulesoft.com/api/management
- Workato Enterprise MCP market update, checked 2026-06-13: https://www.axios.com/sponsored/workato-delivers-industrys-first-enterprise-mcp-platform-for-ai-agents

## Competitive read

Pioneer Agent is the closest technical pressure point: its paper frames the production advantage as a closed loop around data curation, failure diagnosis, regression constraints, retraining, and verification. The correct Kolm response is not a vanity benchmark claim. The correct response is to show that the API Control Center can ingest production behavior, preserve provenance, gate promotion, compile artifacts, and export proof.

MuleSoft and Workato are converging on agentic API and MCP governance. MuleSoft publicly positions API management around governing APIs, LLMs, and agents from a control plane, with discovery, cataloging, API governance, gateway enforcement, and lifecycle controls. Workato is pushing fully managed enterprise MCP servers that connect agents to enterprise applications with governance. Kolm should not pretend those categories do not exist; it should position above and across them as the source-to-proof compiler layer that consumes their events and returns artifacts, receipts, readiness gates, and exports.

Data Product MCP shows the enterprise data angle: semantic discovery is not enough without data contracts and pre-query enforcement. Kolm's universal intake/export model should keep unknown payloads opaque until adapter evidence proves semantics, then require policy, retention, purpose, and egress declarations before compile or export.

## Product decisions locked by this pass

- Homepage proof board names Workato, MuleSoft, Airbyte, Fivetran, Confluent, OpenLineage, Akto, Vanta, and Drata as adjacent systems rather than replacement targets.
- The first viewport now uses the image-2 control-plane asset as a real visual layer, not just social metadata.
- Deep local surface smoke now accepts readiness-gated `503` responses only when the JSON envelope proves the gate is intentional and scoped.
- SDK distribution is restored locally: `public/sdk.js`, `public/recipe-worker.js`, `public/sdk-current.json`, and `public/sdk-versions.json` exist and syntax-check.

## Remaining truth boundary

Kolm cannot honestly claim to be production-final or objectively better than every company in this category until the eight readiness gates in `public/product-readiness-closeout.json` are closed: public benchmark data, live compliance certification, package releases, and external partner/adoption evidence.
