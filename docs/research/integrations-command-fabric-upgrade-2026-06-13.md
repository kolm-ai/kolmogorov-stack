# Integrations Command Fabric Upgrade

Date: 2026-06-13

## Sources Rechecked

- Workato homepage, checked 2026-06-13: https://www.workato.com/
- MuleSoft homepage, checked 2026-06-13: https://www.mulesoft.com/
- Fivetran homepage, checked 2026-06-13: https://www.fivetran.com/
- Confluent homepage, checked 2026-06-13: https://www.confluent.io/
- OpenLineage homepage, checked 2026-06-13: https://openlineage.io/
- Akto homepage, checked 2026-06-13: https://www.akto.io/
- Vanta homepage, checked 2026-06-13: https://www.vanta.com/
- Drata homepage, checked 2026-06-13: https://drata.com/
- Pioneer Agent paper, checked 2026-06-13: https://arxiv.org/abs/2604.09791
- Vercel Web Interface Guidelines, checked 2026-06-13: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Gap

The integrations page had the right claims and coverage, but the first viewport still read like a generic SaaS integration page. It did not immediately show the buyer where adjacent category leaders fit or how Kolm turns their signals into secret-safe receipts, gated semantics, signed artifacts, and exportable proof.

## Product Decision

The first viewport now treats integrations as a command fabric:

- Workato and MuleSoft are orchestration/API sources.
- Airbyte, Fivetran, and Confluent are data movement and streaming sources.
- OpenLineage, Akto, Vanta, and Drata are lineage, security, risk, and trust systems.
- Kolm sits between those systems as the API Control Center, with `POST /v1/account/api-control-center/events` for canonical events and `/adapter-manifests/validate` for semantic promotion.
- Outputs are receipts, signed `.kolm` artifacts, governance packets, verifier receipts, OTLP/JSONL, warehouse exports, and ticket/GRC sinks.

## Design Rule

This page should feel like a real infrastructure switchboard, not a list of logos. The hero must show source systems, the Kolm kernel, and proof outputs above the fold, while preserving mobile wrapping for long API route strings and code identifiers.

## Truth Boundary

The page must not claim live third-party certifications, public benchmark leadership, or objective superiority. It can claim the local product contract, route coverage, adapter evidence gate, secret-safe receipts, and readiness-gated exports because those are covered by repo tests and product-surface audits.
