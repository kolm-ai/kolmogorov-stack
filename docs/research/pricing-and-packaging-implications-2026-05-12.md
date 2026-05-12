# Pricing And Packaging Implications

Date: 2026-05-12

Backlog target: RB-050, "Which pricing model avoids charging for local runtime while monetizing governance?"

The row-level source-backed matrix is `pricing-competitor-matrix-2026-05-12.csv`.

## Main Pricing Finding

Kolm should avoid monetizing generic gateway traffic, token pass-through, trace storage, or raw fine-tuning compute as the primary paid unit.

Those markets already have strong price anchors:

- gateways are free, open source, cheap monthly SaaS, or no-markup pass-through,
- observability/eval tools price by units, retention, seats, security, and enterprise support,
- fine-tuning providers price by tokens and GPU hours,
- model marketplaces monetize credit fees, BYOK fees, and enterprise commitments.

Kolm's paid unit should be artifact governance:

- compile jobs that produce accepted artifacts,
- private registry seats/orgs/projects,
- receipt retention and verification service,
- conformance/K-score gates,
- artifact promotion workflows,
- enterprise controls: SSO, RBAC, audit logs, retention policies, VPC/on-prem support,
- integration packs for gateways/eval platforms.

## Competitive Price Anchors

### Gateway Pressure

Portkey has a low public production plan. Cloudflare makes core gateway features free on all plans. Vercel AI Gateway is pay-as-you-go with no model markup. OpenRouter exposes a marketplace with explicit platform and BYOK fees.

Implication: a Kolm plan that charges a meaningful gateway markup will look expensive unless it replaces model calls with artifacts and proves savings.

### Observability Pressure

Langfuse has a free open-source self-host path and low cloud entry pricing. Helicone and Braintrust price production observability/eval workflows with clear SaaS tiers. PromptLayer prices prompt operations per user/request/retention.

Implication: Kolm should not sell "logs and evals" as the product. It should sell artifact release decisions that use logs and evals as inputs.

### Fine-Tuning Pressure

Predibase and Together publish token/GPU-based customization economics. Their pricing makes LoRA and hosted fine-tuned endpoints easy to compare.

Implication: Kolm should not price or market as a fine-tuning platform until it ships a real `model-adapter` artifact tier. Before that, fine-tuning is an integration/export path.

## Recommended Kolm Packaging

| Package | Buyer Value | Suggested Unit | Notes |
| --- | --- | --- | --- |
| Developer | Try artifact compile/run locally. | Free or low monthly. | Include public fixtures, local recipe compile, limited registry usage. |
| Team | Shared private registry and receipt history. | Per org/month plus artifact/receipt allowance. | Avoid per-local-run tax; charge for retained proof and collaboration. |
| Production | CI gates, K-score policy, artifact promotion, gateway/eval importers. | Platform fee plus compile/retention volume. | Best fit for AI-native SaaS and regulated pilots. |
| Enterprise | VPC/on-prem, SSO/RBAC, audit logs, custom retention, support, deployment architecture. | Annual contract. | Must be matched to real deployment readiness and legal review. |

## Pricing Rules

1. Do not charge a markup on model-provider tokens unless Kolm is actually brokering model calls.
2. Do not charge for artifact-local runtime calls; that undercuts the "compile once, run locally" story.
3. Charge for compiles, accepted artifacts, registry retention, receipt verification, policy gates, and enterprise controls.
4. Make JSON-store/single-node profiles cheaper and clearly limited; charge enterprise only when durable storage, support, and controls exist.
5. Tie any savings claim to measured avoided model calls from a capture-to-artifact proof loop.

## Immediate Copy Implications

- Replace "save 90 percent on tokens" style claims with "measure avoided model calls from accepted artifact runs" until proof exists.
- Put "no local runtime tax" in pricing once artifact-local run proof is stable.
- Package receipt retention as a governance feature, not as public-chain proof.
- Use gateway integrations as distribution, not as a paid gateway replacement.

## Open Questions

1. What is the smallest paid unit: compile job, accepted artifact, registry artifact-month, receipt-month, or org seat?
2. How much receipt history do regulated buyers need by default?
3. Should public artifacts be free but private registry and retained proof be paid?
4. What discount does a team expect if it self-hosts storage but uses Kolm verification tools?
5. Which pilot metric is easiest to prove: lower token spend, lower latency, deterministic compliance behavior, or auditability?
