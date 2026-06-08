# Launch Kit — Agent Security-Review Readiness Audit (fast leg)

Ready-to-use assets to start selling this week. Positioning: **deal-unblocker, not compliance vendor.** Sell the recovered quarter. (Companion to the product plan; mirror of decisions there.)

---
## 1) One-page offer (the pitch)
**Headline:** Unblock your stalled enterprise deal in 2 weeks.
**Sub:** A cryptographically signed Agent Security-Review Readiness report your buyer's security team trusts on the first pass — mapped to SOC2 Type II, NIST AI RMF, EU AI Act Art.12, OWASP Agentic.
**The problem:** Your agent is in the buyer's security review and it's been 4–8 weeks. ~1 in 3 AI deals stall here. The buyer's 6-person group (Procurement/Security/Privacy/Risk/CTO/VP-Eng) all have to sign off, and your agent has no answer for "who can it act as / what can it touch / can you prove what it did."
**What you get (2–4 weeks):** (1) a least-privilege permission audit (what your agents/keys/tools can actually do vs need), (2) a tamper-evident audit-trail + PII-handling check, (3) a red-team pass (prompt-injection/jailbreak, OWASP ASI-01/02), (4) a signed, offline-verifiable evidence report mapped to the exact frameworks the buyer cites + a remediation roadmap. Your buyer's reviewer verifies the signature in their browser — no trust required.
**Outcome:** review compresses from 4–8 weeks back to 5–10 days; you recover the quarter.
**Price:** $25k fixed + 5–10% success fee if the deal closes within 60 days + optional $2.5–5k/mo re-attestation. **Design-partner rate $8k** (you give us a named case study).
**Scope honesty line:** attests permission posture + audit-trail integrity + redaction; prompt-injection is tested-and-reported, not warranted.

---
## 2) Free lead magnet — "Agent Exposure Scan" (the door-opener)
Async, <1 day, ~$200 to deliver, ~34% warm conversion. Founder uploads: a sample of recent agent logs (redacted, <100 spans) + a list of API/tool integrations.
Returns a 1-page PDF: "You call **23** APIs; your agent needs **7**. **4** have wildcard scopes (risk). Your logs lack tamper-evidence (Art.12 risk). Top 3 things the buyer's CISO will flag." CTA: "Fix this before your buyer sees it — book a 30-min readiness call." No pitch, pure diagnosis; if it finds nothing, they're not a fit (saves everyone time).

---
## 3) Design-partner target profile + where to find them
**Profile (lock 5 in weeks 1–2):** Series-A AI-native startup, sells an agentic product to enterprise, **has a specific deal in security review right now**, ≥$100k ARR (can pay), willing to be a named case study.
**Where:** your warm network first; YC/Techstars Slack (filter last-12-mo agentic Series-A); founder Discords (Latent Space, Builders); warm VC intros. Cold email is a week-5 backfill only.
**Qualifying questions:** "Are you selling to enterprises?" → "Is a deal stuck in their security review right now?" → "How big, and how long stuck?"

---
## 4) Outbound
**Warm intro ask (to a mutual):** "Do you know any AI founders with an enterprise deal stuck in security review? I built a 2-week audit + signed report that's unblocked that exact thing — happy to do one free for a design partner."
**Cold email (week-5 backfill):**
- Subj: *Your agent stuck in enterprise security review?*
- Body: "We helped [reference] compress their security review from 6 weeks to 9 days — their buyer's security team signed off in one round. We do a 2-week AI-agent security audit that ends in a signed report mapped to SOC2 / NIST AI RMF / EU AI Act Art.12, so the buyer's team sees completed evidence, not a new claim. Is a deal of yours stuck right now? Want a free 30-min readiness scan of your agent logs?"
- Day-7 follow-up (value): "EU AI Act Art.12 (enforcement Aug 2 2026) now requires tamper-resistant agent logging for EU buyers — most agents don't have it. We can close that gap in 2 weeks. Relevant to your buyer?"

---
## 5) Signed evidence report — table of contents (10 pages)
1. Executive summary (readiness %, key risks, est. time-to-closure) · 2. Agent & tool inventory (every agent/version/scope/data-flow) · 3. Least-privilege findings (Scope 1–4 vs actual; over-perm + shared-key list) · 4. Audit-trail & retention (append-only, tamper-evidence chain, Art.12) · 5. PII/data-handling · 6. Red-team results (OWASP ASI-01/02; pass/fail; mitigations) · 7. Data-egress & MCP supply-chain · 8. Framework mapping (one spread each: SOC2 CC1-9 / ISO 42001 / NIST AI RMF / EU AI Act 12+14 / OWASP) with the buyer-group's top controls flagged · 9. Remediation roadmap (prioritized) · 10. **Signature block** (Ed25519 fingerprint + verify URL + scope/disclaimer). Delivered as signed PDF + JSON envelope; offline-verifiable.

---
## 6) Pricing sheet
| Package | Scope | Price |
|---|---|---|
| Exposure Scan | lead magnet, 1-pg | Free |
| Express | permission + audit-trail, no injection | $15k |
| Standard | full triplet + framework mapping + signed report | $25k |
| + Advanced red-team | ASI-03..10, custom fuzzing | +$10k |
| + Named co-signer | fractional CISO/Big-4 co-sign (credibility tier) | +$3–5k |
| Success fee | deal closes ≤60 days, cited in review | 5–10% ACV (cap $50k) |
| Retainer | monthly delta re-attestation + drift + framework updates | $2.5–5k/mo |
| Design partner | Standard, for a named case study | $8k |

---
## 7) Contingency terms (the clauses that must be watertight)
- Success fee = 5–10% of ACV, **owed only if the deal closes within 60 days of report delivery AND the founder confirms the audit was cited in the buyer's review close-out.**
- Proof = signed MSA/PO + a one-line founder confirmation; tracked via a Stripe invoice + a dated note. Payment due 30 days post-close.
- Disputes → expedited binding arbitration, not litigation. Closes >60 days = $0 (new deal = new engagement).
- **Liability cap = fee paid.** Point-in-time assessment; config/model/deployment changes after the audit date may invalidate findings (→ re-attestation). Injection resistance tested-and-reported, not warranted.

---
## 8) ASR readiness checklist (condensed control set → maps to standards)
Publish openly (CC0) as lead-gen/brand; it maps INTO SOC2 / EU AI Act / real AIUC-1 (do **not** name it "AIUC-1"). Three layers:
- **Govern:** agent registry (enumerate all) · per-agent authority/scope · change mgmt · data classification · incident/fallback.
- **Evidence:** append-only log of every tool call · tamper-evident hash chain · PII-redaction proof · injection detection signal · permission-enforcement-at-call-time proof · human-in-loop proof for Scope 3–4.
- **Supply-chain:** MCP server inventory (authenticated/signed) · third-party tool audit · model provenance · key rotation · least-privilege matrix vs AWS scope · red-team results · encryption · vendor certs (SOC2/ISO fingerprints).
Each control → a deterministic pass/fail check + the SOC2/ISO42001/NIST/EU-AI-Act/OWASP section it satisfies.

---
## 9) 8-week execution checklist
- **W1–2:** build MVP (reuse signing/trace/redaction/import; build permission-analyzer + control-mapper + report-builder + verify widget). Draft offer, scan, contract (lawyer review), E&O quote. **Lock 5 design partners** via warm network.
- **W3–4:** deliver first 2 audits → signed reports; collect 2 named case studies + testimonials; publish the ASR checklist + first Red-Team Report; start contingency tracking.
- **W5–6:** audits #3–5; land first contingency close; publish case studies; begin warm outreach to accelerators/networks; introduce retainers.
- **W7–8:** convert 2+ retainers; reach ~$25k/mo run-rate; decide named-co-signer + co-founder search trigger; document the durable-bet bridge.

---
## Top 3 things that will make or break it
1. **Warm pipeline** — lock 5 design partners before anything else (cold ~5%, warm ~34%).
2. **Credibility** — map to standards the buyer already cites + add a named co-signer for the deals that matter; never sell a self-minted "cert."
3. **Speed + proof** — 2-week turnaround and named case studies, before Vanta/Cyphrex/fast-followers fill the niche.
