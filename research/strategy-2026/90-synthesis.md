# kolm — Strategy: Final Synthesis & Decision (4 deep rounds, 2026-06-07)

Status: DECISION. Built from 60 cited Grok/web evidence files + 4 adversarial workflow rounds (~280 agents, ~10M tokens). Artifacts in `research/strategy-2026/`.

## The real finding (read this first): the structural trap
After two independent greenfield idea-rounds (104 + 70 ideas → diligence → red-team) **every single idea was red-teamed to KILL**, and the reason is a *structural* fact about the founder's position in mid-2026, not a failure of ideation:

- **Founder-fit zone** — AI-native dev/infra/security tooling, sold to the founder's startup network, using the founder's real skills (distill, quantize, eval/replay verification, gateway capture, signed receipts) — is **exactly where the bulldozer is fastest.** Whatever you build there, a lab or hyperscaler or funded incumbent has already shipped or will in months. Confirmed live: Okta-for-AI-Agents GA (Apr 30 2026) + Vorlon Flight Recorder (Mar 2026) = AgentAudit; Anthropic free Tool Search (85% cut, Jan 2026) = the cost optimizers; WitnessAI ($85M, 500% ARR) + AWS Bedrock = the model-compliance layer; HF Community Evals = the eval auditors.
- **Bulldozer-safe zone** — regulated/physical verticals (title, anesthesia, customs, housing, GovCon, healthcare RCM) with proprietary data + workflow lock-in + liability — is genuinely durable, **but requires a domain network/credibility the founder does not have**, and several cells already have funded vertical players or commodity incumbents (SoftPro/Qualia title curative; 17-yr-old anesthesia billing).

**No idea satisfies BOTH founder-fit AND bulldozer-safety at once.** That is the finding. In 2026 the founder's *technical* edge (distill/verify/sign) is **not, by itself, a moat — it is precisely what's being commoditized.** Durability now comes from **proprietary data + regulated workflow + domain access**, which must be *acquired* (co-founder, domain hire, exclusive data/distribution partnership), not coded.

## The convergence (why I stopped at 4 rounds)
Three-to-four independent deep runs (the earlier "ShipGate" run, the WF1/WF2 greenfield run, the WF3/WF4 harder-novelty run) all gravitated to the **same center**: a neutral **AI trust layer — verification / audit / forensics / compliance** on the founder's signed-receipt + replay + capture stack, sold to security/compliance/regulated buyers, with contingency fast-cash wedges. The convergence + the universal red-team kills mean further idea-search is diminishing returns. The constraint is structural (domain access), not idea supply.

## Recommendation: two-speed — use the commoditizing edge as FUEL to buy a real moat
This is a compromise the diligence supports, not a clean flywheel — stated plainly.

### Fast leg (weeks 1–8, hard revenue gate): "pass-your-customer's-security-review" attestation for AI-native startups
Reframed to dodge Okta/Vorlon, which sell IAM/flight-recorder tooling to **enterprise security teams**. The founder's wedge is the opposite buyer and a different job-to-be-done: a **seed/Series-A AI startup is losing or delaying enterprise deals because its agentic product can't pass the buyer's security review** (over-permissioned agents, no audit trail, prompt-injection exposure, no SOC2/EU-AI-Act story). Sell them a fast **"agent security audit + signed attestation report"** they hand to their prospect to **unblock the deal**. This is sales-enablement/deal-unblocking (acute, budgeted, fast-buying, contingency-friendly — tie fee to deal close), not "security tooling" where Okta wins. $5–12k fixed-fee → $3–5k/mo continuous-attestation retainer (re-issued each time they ship). Fits the founder's network (AI startups), skills (capture/replay/sign), and the time-boxed urgency (post-Mercor Apr 2026; EU AI Act Aug 2; Colorado AI Act Jun 2026). **Honest caveat:** this is the cash-and-learning fuel with a hard 8-week revenue gate, NOT the durable company.

### Durable bet (months 3–18): a regulated proprietary-data vertical — gated on acquiring domain access
The only bulldozer-proof end-state is a regulated vertical where proprietary data + liability + workflow lock-in form the moat (the diligence's least-bad pick was **TECA/TitleOS** — title-exception curing — *purely because* its services revenue manufactures the proprietary cure-pair dataset that becomes the model moat). **But its #1 risk is the founder's missing title-domain network** — so the durable bet is only real if you **recruit a domain co-founder / land an exclusive data or distribution partnership** in the chosen vertical. The fast leg funds exactly that hire, and the reusable signed-attestation infra transfers as the "liability-comfort" layer the regulated buyer needs.

### Build-a-model answer (consistent across all 4 rounds)
- **Foundation model: NO** — open weights (Nemotron 3 550B+data, Qwen3.5, DeepSeek V4, gpt-oss) are at parity under permissive licenses; zero edge, zero near-term cash.
- **Fast leg: NO model** — deterministic policy/rules (OPA/Rego) + cryptographic signing; an off-the-shelf API LLM only for human-readable explanations.
- **Durable leg: YES, one model — a proprietary-data FINETUNE/DISTILL** on the vertical's exclusive data (e.g., cure-pairs + 50-state law), distilled to 3–8B for on-prem/data-sovereignty. Justified *only* because the proprietary data is the moat. Never distill-only (it hallucinates domain facts — fatal in a liability domain).

## 8-week plan (fast leg, ~$25k/mo run-rate)
1. Reuse the existing capture/sign/verify stack → MVP: signed agent-action + OAuth-delegation capture + replay + least-privilege diff. Package "Agent Security & Least-Privilege Audit," $5–8k, 1-week turnaround, signed attestation report.
2. Hand-sell 30 AI-native startups in-network; hook = post-Mercor / EU-AI-Act urgency; book 6–8 free 20-min exposure scans.
3. Run scans live (surface over-permissioned agents, exposed secrets, unscoped OAuth); convert 3–4 to paid audits (~$15–20k booked).
4. Deliver first 2 with verifiable signed reports; capture a named case study + referrals.
5. Productize into a $3–5k/mo continuous-audit + monthly signed-attestation retainer; upsell delivered logos.
6. Work referrals → 3–4 more audits + 2 retainers; ~$15k/mo run-rate; publish case study for inbound.
7. Land one $8–12k design-partner; push mix toward ~$25k/mo; start a waitlist.
8. Lock 5–6 paying logos at ~$25k/mo run-rate; freeze the reusable signing infra as a shared asset; **open recruiting for a domain co-founder for the durable vertical.**

## What to shelve
Everything red-teamed dead: TokenRecap (Anthropic Tool Search killed it), BenchAudit (HF Community Evals free), ModelMix (WitnessAI/Bedrock own it), Anesthesia (commodity bundled free), CacheForensics (demote to an AgentAudit adjacency; replay is free OSS). Foundation models; generic finetune-as-a-product; gateways/routers/eval-dashboards/vector-DBs. The website-overhaul/platform-polishing reflex.

## Why now
Two clocks: (1) urgency for the fast leg — agents in production at ~80% of enterprises, +466% YoY, breaches + EU AI Act Aug 2 + Colorado AI Act Jun 2026 = acute time-boxed willingness to pay; (2) closing window for the durable bet — open weights at parity means proprietary data + regulated workflow + liability is the only moat left, and vertical incumbents are colonizing it now.

## The hard truth (candid)
None of the 23 surfaced ideas is, as-is, the invention-grade, magnitude-from-commoditization business the brief demands. The ideas with strong founder-fit are on/beside the kill-list; the only bulldozer-safe ones need a domain network the founder lacks. So the highest-EV move is NOT "pick the idea" — it's **resolve the missing ingredient**: either (a) the founder already has an unfair domain advantage we haven't used (then target that vertical directly), or (b) deliberately acquire one (domain co-founder / exclusive data or distribution partnership), funded by the agent-audit cash wedge. The single biggest unknown that changes everything is the founder's actual domain access — which the analysis so far assumed away by treating the founder as generic.

## Decision (locked 2026-06-07)
- **Founder profile:** mainly technical depth + AI-startup network (no pre-existing regulated-domain access). => the durable bet's domain moat must be **acquired** (co-founder / exclusive data or distribution partnership), not assumed.
- **Direction:** TWO-SPEED NOW. Build the fast-leg attestation wedge immediately (hard 8-week revenue gate); use the cash to fund the domain hire for the durable regulated bet.

### Durable-vertical selection (decide via co-founder availability, not in the abstract)
Because the founder has no domain access, the vertical is chosen by **which credible domain co-founder/partner can actually be recruited** — that person IS the moat-unlock. Rank candidates on: TAM × strength of proprietary-data flywheel × contingency-friendly entry × how cleanly the fast-leg's signed-attestation infra transfers × co-founder recruitability. Shortlist from the diligence (all have incumbents — the co-founder + execution is the edge, not novelty):
- **Title-exception curing (TitleOS)** — IC's pick; $17B market, service revenue manufactures the cure-pair data moat; co-founder = title underwriter/escrow exec; signing-infra transfers as the underwriter liability-comfort layer. Watch: SoftPro/Qualia curative, offshore BPO.
- **Healthcare RCM (denials/under-coding, contingency)** — biggest TAM + cleanest contingency cash + denial/appeal data flywheel; co-founder = RCM/coding exec; HIPAA/BAA friction. Watch: Optum/athena/PointClickCare.
- **Customs/trade & GovCon/DCAA** — deep regulatory moats; narrower or slower; co-founder = licensed broker / GovCon controller. Watch: WiseTech, Deltek.
**Action:** run the co-founder search in parallel with the fast leg; let the first credible domain partner pick the vertical.

### Co-founder profile to recruit (the #1 hire)
A respected operator/executive in the chosen regulated vertical with (a) the buyer network, (b) liability/credibility the founder lacks, and (c) access to the proprietary data (customer relationships) that becomes the model moat. The founder brings the AI/verification/distill stack + the signed-attestation trust layer; the co-founder brings the domain moat. Neither half is a company alone — that pairing is the whole thesis.

## Artifacts
`research/strategy-2026/`: `queries.json` + `queries2.json` (research query sets) · `raw/*.json` (44 cited round-1 files) + `raw2/` (round-2 attempted; blocked when xAI credits ran out — re-run after top-up) · `wf1-ideate-output.json` (104 ideas + bulldozer/whitespace/winner-pattern) · `wf2-diligence-output.json` (round-1 16 memos) · `wf3-novel-output.json` (matrix + openings + 70 ideas) · `wf4-diligence-output.json` (round-2 memos + IC) · `90-synthesis.md`. Tooling: `scripts/grok-research.mjs`, `grok-batch.mjs`, `scripts/strategy/wf1..wf4`.
Note: xAI account hit its credit/spend limit during round 2 → that round + WF3/WF4 ran web-only. Top up at console.x.ai to restore live-X grounding.
