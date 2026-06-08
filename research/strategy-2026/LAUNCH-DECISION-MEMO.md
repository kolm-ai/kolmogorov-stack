# Launch decision memo - kolm.ai

Synthesized from 16 net-new X-API research queries (`research/strategy-2026/raw4/`, run 2026-06-08, 16/16 ok, 8-24 cited sources each). Confidence: High = multiple primary/verbatim sources agree; Med = mixed; Low = thin/anecdotal. Per the locked authority: PRICES are fixed (contradictions flagged for a human), COPY is refined where research gives a clear cited win.

## Decision table

| Gap | Finding | Conf | Decision | Strongest source |
|---|---|---|---|---|
| Beachhead segment (b1) | No verbatim posts segment the pain by vertical/stage/band; self-rated low. Best inference: seed/Series-A AI in regulated verticals, $100-500k deals. | Low | Adjust: name "regulated buyers, financial-services first" (lean on b2) | @clovrahq Mar 31 2026 "67% of B2B SaaS deals stall at security review" |
| Buyer demand (b2) | Finance is the clearest sector demanding AI-agent-specific evidence beyond SOC 2 (US Treasury FS AI RMF ~Feb 2026). Reviewer "cleared" artifacts = standards mapping + scoped signed evidence + scope statement + named human sign-off. | Med | Hold product; Adjust site to name financial-services buyers | armosec.io FS AI RMF; okta.com survey Jan 2026 |
| Free->paid benchmarks (f1) | No product-specific data; category proxy ~3% freemium->paid, 90-180 day lag. | Low | Hold (directional only) | firstpagesage ~3.3%; saasfactor 90-180d lag |
| Scan conversion trigger (f2) | Trigger is external pressure (reviewer asks for proof, deal deadline, board ask), not the finding. Show findings+score, GATE the signed report. Giving the signed report away cannibalizes. | Med | Hold gating (already correct); Adjust CTA copy to name the trigger | reddit "SOC 2 cost us a $40k deal"; @cyber_razz Jun 5 2026 |
| Co-signer supply (c1) | vCISO/CISA/CISSP abundant at $200-350/hr; an attestation co-sign is 4-15 hrs = $1.5-3k. $25k tier = ~88-92% gross margin. | High | Hold | cynomi.com; workstreet.com |
| Co-signer liability (c2) | Real liability (Ultramares; BDO ~$9M; Deloitte $34M). Signers demand engagement letter with "readiness not certification" scope, indemnification, E&O $1-2M+, liability cap. | High/Med | Flag-for-human: build legal/insurance scaffold before scaling $25k | icaew.com; bloombergtax (BDO/Deloitte) |
| EU AI Act Art.12 budget (e1) | Art.12 logging is preparatory/theoretical as a budget line; pressure is customer RFP/questionnaire-driven. Most Series-A in scope only via customers' Art.26. Digital Omnibus may delay some high-risk to Dec 2 2027 (not yet law). | Med | Adjust: reframe anchor from "your obligation" to "your buyer's questionnaire already asks"; add Omnibus caveat | kognitos.com RFP template May 26 2026 (cites "Article 12 - Record-keeping"); gibsondunn (Omnibus) |
| Regulatory substitutes (e2) | EU AI Act Aug 2 2026 remains the sharpest single budget-unlock. Colorado AI Act repealed/replaced, delayed to Jan 1 2027 (drop it). ISO 42001 is real spend; NIST AI RMF voluntary. | Med-High | Hold the Aug 2 2026 anchor; drop any Colorado urgency | artificialintelligenceact.eu timeline; mofo.com (Colorado reset) |
| Reviewer channels (g1) | Reviewers live in private CISO Slacks (CISO Society, Evanta), trust-exchange networks (SafeBase/Whistic/Conveyor), Vanta/Drata TPRM. New formats get accepted by INTEGRATING into existing workflows. | Med | Hold/build integration roadmap | whistic.com; conveyor.com; vanta.com partners |
| First-100 channel (g2) | Cheapest/fastest = YC/accelerator batches + founder Slacks, then AI-founder X. Vanta won ~600 via YC network. | Med | Hold (founder-led GTM) | review.firstround.com (Vanta PMF); Selin Kocalar |
| Price ladder (w1) | $299->$999 step sound. TWO problems: $750 sits in "too cheap to trust" zone (<$1.5-2.5k), and $999/mo -> $25k is a "dangerous gap" needing a $5-12k intermediate. | Gap: High; $750: Med | Flag-for-human (gap + intermediate tier); defuse "too cheap" in copy | x.com/polsia (EU AI Act tools "EUR 50k+/yr"); bluefire-redteam.com |
| $25k credibility (w2) | $25k flat is credibly priced: below full SOC 2 ($30-80k) and ISO 42001 first-year ($37.5-85k), above a pentest ($10-30k). +$10k Deep Red-Team is solid value. | Med-High | Hold | drata.com soc-2 cost; bluefire-redteam.com |
| Competitors (k1) | Cyphrex (@Cyphrexio) is the one direct, recent overlap: June 7-8 2026 pushing cryptographically signed agent-compliance reports. Vanta "Agentic Trust Platform" (+$150M) adjacent. | Med | Flag-for-human (monitor Cyphrex); differentiate on named co-signer + crosswalk + offline verify | @Cyphrexio Jun 8 2026; vanta.com |
| Direct clones (k2) | No 2026 product matches the EXACT wedge (signed readiness report + SOC2/ISO42001/NIST/EU AI Act/OWASP/MITRE mapping + fixed fee + optional named co-signer). Gap is defensible. | Med-High | Hold (defend the synthesis, move fast) | cyphrex.io/news; datatracker.ietf.org draft-messous-eat-ai |
| Trademark (n1) | "Kolm" arbitrary (low descriptiveness, favors registrability) BUT moderate confusion risk in-lane: Kolm Shield (quantum security for financial infra), Holm Security (phonetic, vuln mgmt), Kolm Solutions, Kolm Therapeutics. Open-web scan only, incomplete. | Med | Flag-for-human: formal clearance + intent-to-use filing before scaling brand spend | kolmshield.com; holmsecurity.com; uspto.report/TM/98541872 |
| Objections (o1) | Top 3 reasons a qualified buyer won't trust a $750 report: (1) distrust of cheap/templated small-vendor attestations, (2) preference for Vanta/Drata/SOC 2 reusable signals, (3) perceived depth gap vs a pentest. Verbatim: "You just know it's a template." | Med-High | Adjust copy to neutralize all three | Journal of Accountancy Feb 2026 ("template"); inspectiv.com |

## Copy changes applied to the live site (high-confidence, cited)
1. Beachhead line (index.html): name regulated/financial-services buyers as the lead (b2).
2. Objection-1 (pricing.html, near the $750 tier): "evidence a reviewer can check, not a templated PDF" - live methodology + transparency log + offline verify (o1 #1; defuses w1 "too cheap").
3. Objection-2 (how-it-works.html): "does not replace your SOC 2 or trust center; it is the agent-specific evidence that clears the deal now, and every finding maps into the SOC 2 / ISO 42001 / NIST AI RMF work you already do" (o1 #2).
4. EU AI Act Art.12 reframe (how-it-works.html): from "your obligation" to "your buyer's 2026 questionnaire already asks"; added the Digital Omnibus caveat to keep the date claim accurate (e1, e2).
5. Conversion CTA framing (pricing.html Scan tier): name the trigger ("Reviewer asking for proof?") while keeping the gate (f2).

## Flagged for a human (NOT auto-applied)
- **F1 Pricing - $999/mo -> $25k gap (High).** w1 calls it "dangerous"; suggests a $5-12k intermediate (e.g. quarterly reviewed). Prices are locked; this is a structural decision.
- **F2 Pricing - $750 "too cheap to trust" (Med).** w1 floor for trust is ~$1.5-2.5k; o1 corroborates sub-$1k skepticism. Mitigated in copy (change 2), but a real WTP signal. Counter: w2 says $25k is well-priced and c1 confirms ~90% margin, so only the $750 entry + the gap are at issue.
- **F3 Trademark (Med).** Moderate likelihood-of-confusion in-lane (Kolm Shield, Holm Security). Commission a formal clearance + intent-to-use filing before scaling brand spend.
- **F4 Competitor - Cyphrex (Med).** The one live threat marketing signed agent-compliance reports. No exact clone (k2). Defend on named co-signer + multi-standard crosswalk + offline/no-server verify. Do NOT mirror Cyphrex's "SOC 2 / HIPAA / EU AI Act" compliance claims (kolm maps to, does not certify).

## Cross-cutting caveat
b1, f1, and the exact-moment evidence in f2 are thin (self-rated 5-6/10). The finance beachhead leans on b2's stronger buyer-side signal, not b1. Treat the vertical lead as a hypothesis to validate via the YC/founder-Slack GTM (g2), not settled fact.
