# Pricing Estimator Unicorn Control Pass - 2026-06-13

## Sources Rechecked

- Pioneer Agent, arXiv 2604.09791, submitted 2026-04-10: https://arxiv.org/abs/2604.09791
- Fivetran homepage and product navigation, checked 2026-06-13: https://www.fivetran.com/
- Confluent Stream Governance, checked 2026-06-13: https://www.confluent.io/product/stream-governance/
- Vanta homepage, checked 2026-06-13: https://www.vanta.com/
- Akto homepage, checked 2026-06-13: https://www.akto.io/
- OpenLineage homepage/spec surface, checked 2026-06-13: https://openlineage.io/
- Vercel Web Interface Guidelines, checked 2026-06-13: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Competitive Read

The unicorn bar is not more generic promise density. Pioneer pressures the closed-loop improvement story: production behavior must become diagnosed failures, guarded retraining/compile inputs, regression checks, and verification. Fivetran pressures connector breadth and measurable data movement. Confluent pressures governed streams and lineage over time. Akto pressures agent/MCP runtime discovery and guardrails. Vanta pressures proof workflows, framework breadth, and trust operations that buyers can inspect.

Kolm's differentiated claim is strongest when the site exposes an actual control surface: source traffic enters, policy gates it, compile produces an artifact, and proof leaves the UI. Pricing had been the weakest public page because it listed tiers but did not let a buyer map workload shape to a controlled plan.

## Product Decision

Add a public, secret-safe workload estimator backed by the same `PLAN_CATALOG` as `/v1/plans` and `/v1/billing/tiers`.

Inputs:

- Gateway calls per month.
- Compile credits per month.
- Seats.
- Control profile.
- Compliance posture.
- Private deployment requirement.
- SSO/SCIM requirement.

Outputs:

- Recommended plan id and serialized plan.
- Pricing label.
- Reasons.
- Next step link.
- Compared plan fit table.
- Readiness boundary and open external gates.
- `secret_values_included: false`.

## UI Decision

Use image 2 as the pricing visual anchor instead of a generic SaaS card stack:

- Light paper grid.
- Black technical control panel.
- Green proof state.
- Blue/yellow signal bars for non-green meter types.
- Actual `/compiler-brand-hero.png` in the first pricing viewport.
- Live estimator immediately after the hero, before static plan cards.

## Truth Boundary

This pass improves product specificity and local functionality. It does not close the eight external readiness gates, so public copy still must not claim public benchmark leadership, live certification, package-channel release, standards-body acceptance, or external runtime adoption proof.
