# Iconic Unicorn Design and Control Audit

Date: 2026-06-13

## External Research

- Workato is positioning its public homepage around Enterprise MCP and agent orchestration, with platform navigation for API Management, MCP Gateway, Data Orchestration, Agent Studio, and security/governance. Source: https://www.workato.com/
- MuleSoft is positioning around a single AI/API control plane, Agent Fabric, Omni Gateway, API Governance, API Manager, and agent observability. Source: https://www.mulesoft.com/
- Airbyte has moved its homepage toward agent context: MCP, SDK, CLI, business-entity context store, source tagging, and cross-system answers. Source: https://airbyte.com/
- Fivetran is still the connector and movement proof bar: hundreds of sources, trusted data movement, managed data lake, transformations, and security/compliance proof. Source: https://www.fivetran.com/
- Vercel is the developer-platform design bar: compact navigation, explicit product taxonomy, AI Gateway, SDK/code surface, performance proof, and a first-screen product claim. Source: https://vercel.com/
- Pioneer Agent is the product-functionality bar for closed-loop small-model improvement: data curation, failure diagnosis, retraining under regression constraints, and verification. Source: https://arxiv.org/abs/2604.09791
- Vercel Web Interface Guidelines are the interaction-quality bar: explicit image dimensions, form labels, aria-live updates, visible focus, no blocked paste, responsive overflow handling, and no broken mobile text. Source: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Product Implication

Kolm should not claim to replace every category winner. The stronger wedge is to control the proof flow across them:

1. Treat Workato and MuleSoft as orchestration/API-control sources and sinks.
2. Treat Airbyte and Fivetran as connector, context, warehouse, and egress evidence sources.
3. Treat Pioneer Agent as the closed-loop improvement standard, but bind claims to readiness-gated evidence instead of public overclaiming.
4. Treat Vercel as the developer-platform UX bar: product-specific first viewport, real artifact imagery, compact navigation, code/API proof, and low-friction docs.

## Execution This Pass

- The backend now has a runnable adapter-manifest validation route, `POST /v1/account/api-control-center/adapter-manifests/validate`, so arbitrary API payloads are not promoted from opaque to semantic unless adapter evidence is present.
- The API Control Center UI now exposes a live adapter manifest validator beside universal intake.
- Route inventory regenerated to 926 routes and the public docs/homepage counters were aligned.
- The homepage image-2 artifact is now the full-bleed first-viewport stage on desktop and mobile, with the product/category H1, direct API Control Center CTA, and readiness gated caption layered over it.
- The account control page uses image 2 as a subdued artifact layer behind the source-to-proof console and adds spacing/min-width guards for dense workbenches.

## Non-Negotiable Bar

- Real product artifact in the first viewport, not abstract decoration.
- Dense but readable infrastructure UI, with no card-in-card bloat.
- Mobile first viewport cannot clip or smush headline, image, console, or actions.
- Backend claims must have a route, a test, a generated doc artifact, and a secret-safety invariant.
- Public copy must avoid "100x" or objective superiority claims until external benchmark, partner-adoption, certification, and package-release gates close.
