# Adapter Manifest Control Workbench

Date: 2026-06-13

## Gap

The API Control Center could already accept broad API/data events through `POST /v1/account/api-control-center/events`, but semantic promotion was still mostly descriptive. The product spec says unknown vendor payloads stay opaque until adapter evidence proves understanding. Without a runnable manifest validator, that was a trust gap.

## Competitive Pressure

- Workato and MuleSoft make app/API orchestration feel governed because recipes, APIs, and MCP surfaces have explicit contracts.
- Airbyte and Fivetran make connectors credible because schemas, sync state, destinations, and operational metadata are first-class.
- OpenLineage makes lineage useful because jobs, datasets, runs, and facets are normalized rather than free-text.
- Akto and current MCP security research show that agent/tool/API integrations need explicit runtime policy, threat posture, and evidence before trust.
- Vanta and Drata make trust operational by turning controls into evidence, not just dashboard labels.

## Decision

Add a backend-owned adapter manifest validation route:

`POST /v1/account/api-control-center/adapter-manifests/validate`

The route promotes an adapter only when required evidence is present:

- adapter id
- adapter version
- channel family
- direction
- input schema
- redaction map
- egress destinations
- test fixture

If evidence is missing, the route returns `422` and a secret-safe missing-evidence report. If evidence passes, it returns `manifest-declared`, a manifest hash, a receipt id, normalized non-secret fields, fixture redaction status, and `secret_values_included: false`.

## Product Effect

This turns "we support arbitrary API data" into a safer staged contract:

1. Unknown event: accepted only as opaque governed payload.
2. Schema-hinted event: bounded field hints, unknown fields remain opaque.
3. Manifest-declared adapter: field mapping can be used for typed policy, trace joins, eval rows, and export receipts.
4. Native connector: still requires contract tests and connector ownership.

The account UI now exposes a live adapter manifest validator beside the universal intake workbench so operators can prove semantic promotion without leaving the API Control Center.

## Verification Required

- Backend contract test covers valid manifest promotion and missing-evidence rejection.
- Static UI test checks the workbench, route, result output, and setup functions.
- API docs and product graph must be regenerated so route count and OpenAPI contract include the new endpoint.
- Focused account UI audit must pass on desktop and mobile.
