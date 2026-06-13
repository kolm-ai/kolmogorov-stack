# Integrations Data Plane Gap - 2026-06-13

## Sources Reviewed

- Workato connectors: https://docs.workato.com/connectors.html
- MuleSoft API Manager and platform docs: https://docs.mulesoft.com/api-manager/latest/
- Airbyte integrations: https://docs.airbyte.com/integrations/
- Fivetran connectors: https://fivetran.com/docs/connectors
- Confluent Kafka Connect: https://docs.confluent.io/platform/current/connect/index.html
- OpenLineage docs: https://openlineage.io/docs/
- Akto docs: https://docs.akto.io/
- Vanta Developer Hub: https://developer.vanta.com/
- Drata Developer Portal: https://developers.drata.com/

## Market Pressure

Workflow and iPaaS platforms have already trained enterprise buyers to expect broad application coverage, triggers, actions, authentication management, and universal API options. Workato documents connectors as the base of automation strategy, with authentication, triggers, actions, more than 1,000 connectors, and universal connectors for HTTP, OpenAPI, GraphQL, and SOAP. MuleSoft positions Anypoint as an integration and API platform with API management, connectors, governance, monitoring, MCP support, and agent-ready API assets.

Data movement platforms have already normalized source and destination coverage. Airbyte frames connectors as the mechanism that pulls from sources and pushes to destinations, with source, destination, marketplace, enterprise, and custom connector paths. Fivetran documents pre-built connectors for applications, databases, event streams, files, functions, logs, destinations, transformations, and automatic handling for schema changes, API updates, and incremental syncs.

Streaming infrastructure already owns source/sink operational primitives. Confluent Kafka Connect describes scalable and reliable streaming between Kafka and other systems, source and sink connectors, converters, single-message transforms, distributed workers, and dead-letter queue handling.

Catalog and lineage platforms already own dataset/job/run metadata. OpenLineage defines an extensible lineage model around dataset, job, and run entities, plus facets and integrations with data processing systems.

Security and GRC platforms already own API inventory, compliance evidence, remediation, and trust workflows. Akto documents AI, MCP, and API security, traffic data sources, API inventory, testing, issues, compliance, threats, API protection, and integrations. Vanta exposes APIs for documents and evidence plus MCP paths for compliance data. Drata exposes a public API, custom connections, custom workflows, evidence automation, MCP, and trust-questionnaire automation.

## Product Implication

Kolm should not describe integrations as a generic connector catalog or claim to replace every specialized tool. That would weaken the category position and create unsupported claims.

The stronger position is:

1. Import source signals from systems buyers already trust.
2. Normalize them into tenant-scoped, policy-governed events.
3. Keep unknown vendor payloads opaque until adapter manifests or schema hints prove semantics.
4. Attach redaction, retention, egress, eval, compile, target, and export policy.
5. Emit signed artifacts, receipts, manifests, lineage references, and governance packets that remain useful outside the Kolm UI.

The public `/integrations` page must therefore show:

- A source-to-proof operator path, not only a list of names.
- Workflow/API, data movement, catalog/lineage, security/GRC, gateway/provider, trace/eval, and runtime/release clusters.
- Clear market-pressure copy explaining what specialized systems already do.
- A readiness-gated caveat that Kolm is not claiming live certification, public benchmark leadership, or third-party runtime adoption before the readiness ledger supports it.

## Local Delta

This pass updated `public/integrations.html` with:

- A hero that says every API signal becomes governed proof.
- A source-to-proof map aligned to `GET /v1/account/api-control-center`.
- An operator workbench loop: source, schema, policy, improve, compile, export.
- Expanded source/sink clusters for workflow/API and catalog/lineage systems.
- A market-pressure section that explains how Workato, MuleSoft, Airbyte, Fivetran, Confluent, OpenLineage, Akto, Vanta, and Drata shape buyer expectations.
- An explicit no-overclaim compiler note.

## Regression Requirement

`tests/site.test.js` should assert that `/integrations` keeps the source-to-proof map, the expanded competitor pressure set, the operator workbench/API reference, and the anti-overclaim copy. It should also reject stale audit CTAs and unsupported "100x" or "better than everyone" language on the public page.
