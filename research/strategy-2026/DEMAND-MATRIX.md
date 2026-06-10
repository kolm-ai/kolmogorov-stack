# kolm.ai — Demand-Side Customer Matrix

Source: `research/strategy-2026/raw-demand/d1-d4` (X-API + web, 53 citations).
Purpose: lock exact positioning so the off-the-shelf product is sold to the segment
where kolm is structurally the best option, not just present.

Locked pricing (do not change): Scan free · Signed Readiness Report $750 one-time ·
Continuous $299 / $999 mo · Reviewed Attestation $25,000 flat (named co-signer) ·
+Deep Red-Team +$10,000.

---

## 1. The five demand segments

| # | Segment | Size signal | Urgency (1-5) | Buyer + budget authority |
|---|---------|-------------|:---:|--------------------------|
| S1 | Seed / pre-A AI startup selling to enterprise | Large; most YC / early cohorts ship agents by mid-2026 | **5** | Founder / CTO (same person), full authority, very price-sensitive |
| S2 | Series A-B AI-native SaaS | Post-PMF teams raising A/B, agentic workflows | 4 | Head of Security / GRC lead or CTO; approved when tied to pipeline |
| S3 | Incumbent SaaS bolting on an AI agent | Established SaaS adding AI features | 3 | Head of Security / GRC + CTO; existing compliance line item |
| S4 | AI agent platform / infra vendor | Runtime / sandbox / infra vendors | 4 | CTO or Head of Security; platform-attestation budget |
| S5 | Regulated-vertical AI (fintech / healthtech / legal) | Vertical AI under heightened scrutiny | **5** | GRC lead / compliance officer + legal / founder; high authority |

## 2. Job, trigger, status quo

| # | Job to be done | Trigger event | What they do today |
|---|----------------|---------------|--------------------|
| S1 | Pass the first enterprise security review and close the initial $50K+ ACV deal without derailing the round | First 200-600q SIG / CAIQ questionnaire lands; or a deal lost and blamed on "no audit artifact" | Fill by hand (founder loses a weekend), answer AI questions generically, refuse Vanta / Drata on cost |
| S2 | Standardize repeatable answers so sales cycles go from months to weeks | Repeated questionnaires across many prospects; first SOC 2 demand from a larger buyer | Manual fill 2-6 weeks each; start buying Vanta / Drata / Sprinto; begin SOC 2 (Type 2 first year $40K-$120K) |
| S3 | Extend existing SOC 2 posture to cover the new agent without restarting reviews | Buyers demand AI-specific controls / questionnaire addenda post-launch | Point at existing SOC 2 + hand-fill AI addendum; targeted pentest on the AI layer |
| S4 | Prove the platform itself meets enterprise bar so downstream customers clear reviews faster | Customer feedback that platform review is blocking their deals | Maintain SOC 2 + offer pentest / governance docs; customers still fill questionnaires by hand |
| S5 | Achieve AI-specific compliance (EU AI Act high-risk, sector regs) alongside security reviews | EU AI Act obligations (Aug 2026) or a regulated prospect demanding conformity + questionnaire | Heavy manual questionnaires + sector compliance; higher audit / red-team spend |

## 3. kolm fit — tier, willingness to pay, how kolm wins

| # | kolm motion | Best-fit tier + WTP | Why kolm wins here |
|---|-------------|---------------------|--------------------|
| **S1** | Self-serve, credit card. Land on free Scan, convert to one-time report | **Signed Readiness Report $750** (stated raw anchor lower, but ROI is a $50K+ deal-saver — see Caveats) | Vanta / Drata are too expensive and slow; questionnaire tools produce unsigned prose. kolm hands the buyer a signed, agent-specific object that verifies offline, same day |
| **S2** | Self-serve subscription. The recurring pain is the product | **Continuous $299 (Starter) / $999 (Growth)** — fits the $1.5K-$8K/mo budget with headroom | Re-attests on every deploy so the Trust link is always current; one signed artifact answers many buyers; cheaper than a single questionnaire-week of analyst time |
| **S3** | Add-on to existing posture | **$750 one-time** or **Continuous $299** | Maps each agent finding back into the SOC 2 / ISO 42001 / NIST work they already run, so the agent does not reopen the whole review |
| **S4** | Differentiator they resell downstream | **Continuous $999 (Growth)**, upsell **Reviewed Attestation $25,000** | A signed platform-level attestation unblocks many downstream customers at once; ecosystem leverage justifies premium |
| **S5** | Sales-assisted / contact | **Reviewed Attestation $25,000** + **Deep Red-Team +$10,000** | Named co-signer + agentic red-team battery + framework crosswalk maps to EU AI Act Art.12 logging and high-risk obligations on a hard external clock; WTP is existential, least price-sensitive |

## 4. Positioning conclusions (what we do with this)

- **Beachhead = S1 + S2, self-serve.** Widest top of funnel (S1, urgency 5, free Scan is viral) plus the highest-LTV self-serve fit (S2, recurring → subscription, budget already exceeds our price). The $750 one-time is the bridge: it saves the S1 deal and funnels into the S2 subscription. This is where kolm is structurally best and incumbents are weakest.
- **Self-serve ceiling holds.** Comparable dev-sec tools (Snyk, Semgrep) self-serve at ~$25-40/dev/mo or low-four-figures/yr; full compliance platforms (Vanta / Drata / Secureframe / Cobalt) are sales-led at ~$7.5K-$15K+/yr. So **$750 one-time and $299-$999/mo are credibly card-checkout**, and **$25,000 correctly forces a call** (S4 upsell, S5 primary).
- **Acceptance is engineered, not hoped for.** Reviewers (CISO / TPRM) already accept supplementary signed evidence in place of full questionnaires when it is (a) ingestible via a trust link, (b) mapped to their questionnaire / frameworks, (c) comprehensive on AI-specific risk. kolm now ships all three: the SIG / CAIQ + SOC 2 / ISO 42001 / NIST / OWASP-2025 crosswalk on every finding, a shareable Trust link, and an 8-control agent battery. Drop targets named: Whistic, UpGuard, VISO TRUST, SecurityScorecard, Bitsight.
- **Category language.** Lead acquisition copy with the budgeted terms buyers search: **"AI Security Assessment"** and **"AI Agent Security"** (these carry GRC / TPRM budget). Lead differentiation with **"Signed, buyer-verifiable AI audit."** De-emphasize "AI red teaming" / "AI pentest" as the headline (awareness, not consistent budget) — keep it as the +$10,000 add-on.

## 5. Caveats (flag, do not silently absorb)

- **S1 price tension.** Raw stated anchor for the seed segment skews to ~$99 one-time; our floor is $750. The justification is deal-ROI ($50K+ ACV), but expect the free Scan to do the heavy conversion work and the $750 to convert on demonstrated value, not on list price alone. Pricing is locked — this is a funnel-design note, not a price-change request.
- **S5 depends on the $25K co-sign supply.** Named-co-signer liability and supply are not yet wired; S5 ships as contact / waitlist until that is in place. Do not promise self-serve $25K.
- **Out of scope is part of positioning.** kolm assesses permission posture, redaction and audit-trail integrity, and tests injection (reported, not warranted). It does not cover LLM05 improper output handling, LLM09 misinformation, training-data poisoning, model extraction, and is not a substitute for a human pentest. Stating this up front is what makes the in-scope claims credible to a reviewer.
