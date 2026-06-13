# Homepage Control Map Unicorn Pass - 2026-06-13

## Sources Rechecked

- Workato docs: https://docs.workato.com/
- MuleSoft docs: https://docs.mulesoft.com/general/
- Airbyte platform docs: https://docs.airbyte.com/platform
- Fivetran docs: https://fivetran.com/docs/getting-started
- Confluent Platform docs: https://docs.confluent.io/platform/current/overview.html
- OpenLineage docs: https://openlineage.io/docs/
- Akto docs: https://docs.akto.io/
- Vanta help center: https://help.vanta.com/en/collections/12575233-getting-started-hub
- Drata help center: https://help.drata.com/en/
- Pioneer Agent paper: https://arxiv.org/abs/2604.09791
- Vercel Web Interface Guidelines: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Product Pressure

Current competitors are strong at separate layers:

- Workato and MuleSoft frame enterprise orchestration, API management, MCP, automation, operations, and governance.
- Airbyte and Fivetran frame data movement around connectors, destinations, activations, APIs, SDKs, and managed/self-managed data planes.
- Confluent and OpenLineage frame event streams, jobs, runs, datasets, facets, and lineage collection.
- Akto frames API security around live traffic discovery, runtime posture, testing, and agentic/API threat detection.
- Vanta and Drata frame compliance operations around onboarding, account settings, frameworks, tests, audits, policies, event logs, and help-center workflows.
- Pioneer Agent frames the SLM improvement loop around failure diagnosis, targeted data construction, retraining, and regression constraints.

Kolm should not claim to replace those systems. The stronger claim is that Kolm is the source-to-proof control layer between them: it turns enterprise signals into governed control events, policy decisions, compile inputs, signed artifacts, runtime target receipts, and exportable evidence.

## Site Requirement

The homepage proof board must stop reading like internal ledger copy. It should show the category map visually:

1. Existing systems enter as source, sink, lineage, security, and GRC nodes.
2. Kolm sits in the center as the API Control Center and behavior-to-artifact compiler.
3. Outputs are canonical event envelopes, readiness-gated artifacts, and enterprise proof exports.
4. Readiness limits remain visible so the page does not imply unsupported certification, package, benchmark, or partner proof.

## Implementation Contract

- Keep the image-2 hero, restrained nav, paper surface, black primary CTA, green accent, and dark technical panel.
- Add a competitor-aware source-to-proof map to `public/index.html`.
- Use desktop three-column composition and mobile single-column stacking.
- Keep proof counters, public route contract, `secret_values_included: false`, unknown-schema caveat, and readiness gates on the page.
- Lock the map into `tests/site.test.js` so the homepage cannot regress to generic positioning.

