# kolm.ai Launch Research Dossier - 2026-06-15

Authoritative launch deliverable synthesized from 32 fresh X-API (Grok) research
outputs: Wave 1 (`research/strategy-2026/raw4/`, 16 files, b1-o1) and Wave 2 deeper
follow-ups (`research/strategy-2026/raw7/`, 16 files, l1-l16). Read against the prior
corpus (LAUNCH-DECISION-MEMO.md, DEMAND-MATRIX.md, LAUNCH-KIT.md, 90-synthesis.md).

Confidence key: High = multiple primary or verbatim sources agree. Med = single decent
source or mixed. Low = inference or thin evidence.

Authority obeyed: PRICING is locked and flag-only (price contradictions are recorded as
FLAGS, never silently changed). COPY may be refined where research gives a clear cited
win. Contact is dev@kolm.ai only. Framework is NOT named "AIUC-1". ASCII-safe; no em or
en dashes; no smart quotes; middot allowed.

---

## 0. Executive summary

- Beachhead: AI-native B2B SaaS vendors at Series A (late-seed to ~Series B), ~20-100
  headcount, ~$1M-5M ARR, with a live enterprise deal stalled in security or vendor
  review. Lead vertical hypothesis = financial services first, healthcare second. The
  buyer of the readiness artifact is the founder/CTO below ~50 headcount and a GRC /
  compliance lead (often fractional) from ~50-100 headcount. Confidence: Med (l4 raised
  this from the prior Low ~35 to ~65 with primary firmographics).
- Verified urgency anchor: the EU AI Act. By statute, general high-risk obligations
  (Chapter III, Articles 8-27) and Article 12 logging apply 2 August 2026; Annex III
  Article 6(1) high-risk obligations apply 2 August 2027 (l8, primary). IMPORTANT
  RECONCILIATION: the live site (regulatory-clock.html) already reflects a newer fact the
  research corpus does not fully carry - a Digital Omnibus political agreement of 7 May
  2026 provisionally deferring Annex III high-risk to 2 December 2027 (Annex I embedded to
  2 August 2028), effective on publication in the Official Journal. The research (e1, e2,
  l8) still treats 2 August 2026 as operative because Grok did not surface the Omnibus
  deferral. The site is more current and more accurate; do not regress it. Budget owner to
  address in urgency copy: Chief Compliance Officer / Head of AI Governance / GRC lead
  (l8, Med).
- Pricing FLAGS (locked, for user approval only): (F2) $750 may read "too cheap to trust"
  for a signed deliverable (w1, l6); (F1) the $999/mo to $25k jump - NOTE the live site
  already inserts a $15,000 Full Readiness tier and a $3,500/mo Continuous-Plus tier that
  are NOT in the ladder named "locked" in this brief; this is itself a FLAG to reconcile.
  $25k credibility and +$10k red-team are confirmed well-priced (w2, l11), no change.
- Competitor / clone: Cyphrex is the one live direct threat and now has a PUBLIC pricing
  page (cyphrex.io/pricing, dated 25 May 2026) with named tiers as low as $49/mo and a
  $599/mo "Verify+" tier shipping 50 signed framework reports/mo. No exact clone of kolm's
  full wedge exists (k2). 
- Trademark: "Kolm" is arbitrary (registrable) but faces moderate in-lane confusion risk;
  formal clearance plus an intent-to-use filing remains a FLAG before scaling brand spend
  (n1).
- Copy changes proposed: 8 (see COPY-CHANGE-LIST-2026-06-15.md). All non-pricing.

---

## 1. Beachhead and ICP

### 1.1 The firmographic ICP (NEW, upgraded from inference)
Wave 1 b1 could not segment the pain by vertical/stage/deal-size from verbatim posts
(self-rated confidence ~35, all inference from regulatory intensity). Wave 2 l4 replaced
that inference with primary firmographics:

- First enterprise security questionnaire (SIG / CAIQ / custom TPRM) typically lands at
  the late-seed to Series A transition, ~20-50+ headcount, ~$1M-2M+ ARR. The a16z/SaaStr
  benchmark cited: median enterprise AI startup hits ~$2.1M ARR by month 12.
  [saastr.com a16z], [cybersecify.com]. Confidence: Med.
- $100k+ enterprise deals start at Series A (sometimes late seed), typical raise $4-10M+
  (median ~$4M). [saastr.com], [forbes.com 2026-04-08]. Confidence: Med.
- Who owns buying the readiness/attestation artifact: founder/CEO or CTO below ~50
  headcount; a dedicated or fractional GRC / compliance lead first appears ~50-100
  headcount and becomes common past 100. [cybersecify.com], [sprinto.com/blog/grc-team].
  Confidence: Med.
- TAM count: YC cohorts now run ~50-90% AI-labelled, ~150-250 companies/batch, multiple
  batches/year; PitchBook reports ~1 in 4 (~22%) of first-time VC financings are AI;
  Crunchbase tracks 10k+ AI startups. Addressable AI-native B2B vendors reaching
  enterprise sales: low-to-mid thousands globally. [pitchbook.com], [growthlist.co],
  [tldl.io]. Confidence: Med (directional, not a census).

ICP one-liner: an AI-native B2B SaaS vendor, Series A (~20-100 headcount, ~$1-5M ARR),
selling an agentic product into the enterprise, with a deal currently stalled in the
buyer's security review; the artifact buyer is the founder/CTO early and the GRC /
compliance lead from ~50-100 headcount.

### 1.2 Vertical lead
b2 (Med) is the strongest buyer-side signal: financial services is the clearest sector
demanding AI-agent-specific evidence beyond SOC 2 (US Treasury / banking coalition input
to NIST RFI NIST-2025-0035; EU AI Act high-risk applicability for credit/risk/insurance
pricing). The MightyBot CISO framework (updated 22 May 2026) enumerates six AI-specific
requirements a reviewer wants beyond SOC 2: multi-tenant model-context isolation,
field-level encryption, decision "why-trail" auditability, versioned/tamper-evident policy
governance, structured compliance exports, and a human override / kill switch.
[mightybot.ai], [labs.cloudsecurityalliance.org]. b1's own rank-order put
healthcare > fintech > legal on regulatory intensity, but all of b1 is inference
(Low). Net: lead financial-services first, healthcare second, as a hypothesis to validate
via the founder-Slack GTM, not settled fact.

### 1.3 Core-pain verbatim evidence (NEW)
l9 went hunting for named-company proof the pain is real and found it remains thin (no
seller named a company + exact deal size + timeline + unblocking artifact in one post),
but surfaced usable dated quotes for social proof, ranked by specificity:
- Vigilens.ai blog (10 Jan 2026): "We didn't lose the deal on product. We lost weeks
  proving we're safe, consistent, and in control. By the time we had the answers, the
  buyer had moved on." Framed around a $2M-scale deal. [vigilens.ai].
- SecureFLO (29 May 2026): "4-8 week security review per enterprise deal ... 1 in 6 deals
  stalls past the buyer's procurement window and dies." Also notes questionnaires now
  routinely exceed 300 questions vs 80-100 in 2022. [secureflo.net].
- @craigirwin (7 Jun 2026): "Spinning up a new model costs nothing. Getting it through
  security review for production takes months."
- @dancolta (28 May 2026): "most enterprise AI projects die at the security review, not
  the capability gap."
- @hassanscalveta (30 Apr 2026): "every big AI rollout right now is bottlenecked at the
  same place. enterprise security review ... slow shipping by 6 months."
- @sojimathewj (14 May 2026): a $10B buyer needs "security review, legal, DPA, board
  sign-off, a pilot, 6 months monitoring."
- @Cyphrexio (8 Jun 2026): "The enterprise deal does not go to the team with the most
  agents. It goes to the team that can hand procurement a signed record of what each agent
  was authorized to do - before it did anything."
Confidence: Low for exact named-company-plus-dollar proof; Med that the 4-8 week stall and
deal-death pattern is real and widely stated. Use these quotes only attributed and
caveated; do not invent customer logos.

---

## 2. Urgency and regulatory

### 2.1 EU AI Act dates (PRIMARY, verified)
From l8 (primary: artificialintelligenceact.eu / Regulation (EU) 2024/1689) and e1/e2:
- GPAI provider obligations (Chapter V, Arts 51-56): apply 2 August 2025 for new models;
  pre-2 August 2025 models must comply by 2 August 2027. Codes of Practice published July
  2025.
- High-risk obligations (Chapter III, Arts 8-27, incl. Article 12 logging): general
  application 2 August 2026. Article 12 logging applies 2 August 2026; deployers retain
  logs at least six months (Art 26). 
- Annex III high-risk (Article 6(1)) obligations: 2 August 2027 by statute.
- Penalties (Art 99): up to EUR 35,000,000 or 7% turnover (prohibited practices); up to
  EUR 15,000,000 or 3% (high-risk breaches); enforcement from 2 August 2025.

### 2.2 The Digital Omnibus deferral (RECONCILIATION - site is ahead of research)
The live regulatory-clock.html records that the Digital Omnibus agreement of 7 May 2026
provisionally defers Annex III high-risk to 2 December 2027 (Annex I embedded systems to
2 August 2028), taking legal effect on Official Journal publication, expected before
2 August 2026. e1 only notes Omnibus "discussions" and "proposed postponements"; l8 says
"no date shifts confirmed". The research therefore lags the site. The site's framing is
both more current and a credibility asset: regulatory-clock.html already argues that
"vendors still pitching the August 2026 date as settled, with no mention of the
provisional deferral, tell reviewers exactly how closely they track the rules they cite."
DO NOT revert the site to a flat "August 2026" claim. Confidence: High (the site's own
dated sourcing) over the research's Med-stale Aug-2026 framing.

### 2.3 What this means for the anchor
The sharpest single budget-unlock is still the EU AI Act, but the honest anchor is now
two-pronged: (a) GPAI obligations and penalties are LIVE since 2 August 2025; (b) general
high-risk + Article 12 logging hit 2 August 2026, while the Annex III tail is provisionally
2 December 2027. The pressure that actually drives a Series A purchase is customer-driven:
the buyer's 2026 RFP / vendor questionnaire already asks the Article 12 logging question
(e1 cites kognitos.com agentic RFP template 26 May 2026 and cequence.ai sample question).
Reframe urgency from "your obligation" to "your buyer's questionnaire already asks", which
the site largely does. Drop any Colorado urgency: the Colorado AI Act was repealed and
replaced by a narrower ADMT regime effective 1 January 2027 (e2: troutmanprivacy.com,
hunton.com). ISO/IEC 42001 is the concrete deliverable buyers are actually purchasing
(Microsoft, Anthropic, BCG, UiPath, Crypto.com certified per e2). Confidence: Med-High.

### 2.4 Budget owner
l8: ownership is not uniform but most consistently sits with the Chief Compliance Officer
/ Head of AI Governance / GRC lead (overlapping General Counsel and CISO). 72% of orgs
expect GRC budget growth (optro.ai). Address urgency copy to the GRC/compliance owner,
not a generic "security team". Confidence: Med.

---

## 3. Pricing and willingness-to-pay

All pricing is LOCKED. Findings below are FLAGS for user approval, never silent changes.

### 3.1 Entry tier: $750 signed Readiness Report - FLAG F2 (too cheap to trust)
- w1 (Med): 2026 SOC 2-style readiness/gap assessments cluster $3,000-15,000; $750 sits
  below observed floors for anything "signed/reviewed", a Van-Westendorp "too cheap to
  trust" signal; floor for trust ~$1,500-2,500.
  [soc2auditors.org], [dsalta.com], [x.com/polsia 2065016603901898762].
- l6 (Low) went looking for HARD A/B or Van-Westendorp data in the $300-5,000 band and
  found NONE. Only anecdote: e.g. @brucefloyd (Jun 2026) charged $999 with a visible 75%
  "discount" to anchor up; @chriswiser (Jun 2026) priced audits at $997 to ladder into
  $2.5-5k/mo retainers. l6 records an explicit FLAG: $750 likely converts WORSE than
  $1,500-2,500 for a signed deliverable, but this is anecdotal, not controlled.
- o1 (Med-High) corroborates sub-$1k skepticism: "It's too cheap/lightweight and lacks
  the depth/independence of SOC 2 or real testing." [x.com/CredShields 2065117877523673428].
- VERDICT: Record as FLAG F2. The locked $750 stands; mitigate in copy (live methodology,
  transparency log, offline verify, "evidence a reviewer can check, not a templated PDF").
  Counterweight: $750 functions as a deal-ROI entry against a $50k+ ACV save and as the
  funnel into Continuous; the free Scan does the conversion heavy-lifting (DEMAND-MATRIX
  S1 note). Confidence on the flag: Med (consistent direction, zero controlled data).

### 3.2 The ladder gap: $999/mo to $25k - FLAG F1 (already partly resolved on site)
- w1 (High on the gap): called the jump from ~$12k/yr recurring to a $25k one-time a
  "dangerous gap", recommended a $5-12k intermediate.
- l15 (Med): the $300-1k/mo continuous band and $10k-30k attestation band both hold
  against 2026 data; competitor mid-tiers exist (Drata Advanced ~$15k-25k/yr, Vanta Plus
  ~$15k-30k/yr, Secureframe Complete ~$20k-45k/yr) but NO verbatim buyer demand for a
  lighter human-reviewed intermediate was found. l15 issues a FLAG: missing/untested
  intermediate, user approval before any change.
- RECONCILIATION: the live audit-pricing.html ALREADY ships a "Full Readiness $15,000"
  one-time tier and a "Continuous-Plus $3,500/mo" tier between $999/mo and $25k. These are
  NOT in the ladder this brief calls "locked" ($750 / $299 / $999 / $25k / +$10k). So the
  gap FLAG is structurally addressed on the site, but the on-site ladder and the brief's
  "locked" ladder DISAGREE. This is itself FLAG F1: confirm whether $15,000 and $3,500/mo
  are part of the official locked ladder. Confidence: High that the discrepancy exists
  (read directly from audit-pricing.html lines 89-95, 282-389).

### 3.3 $25k Reviewed Attestation - HOLD, well-priced
- w2 (Med-High): $25k flat sits credibly between a pen test ($10-30k) and full SOC 2 Type
  II ($20-80k+) / ISO 42001 first-year ($15-50k+ audit, more with prep). The +$10k Deep
  Red-Team brings the total to $35k, below many full red-team quotes. [securitywall.co],
  [bluefire-redteam.com], [sprinto.com], [drata.com], [certbetter.com].
- No change. Confidence: Med-High.

### 3.4 +$10k Deep Red-Team - HOLD (possibly underpriced)
- l11 (Med): named AI red-team vendors are nearly all "contact sales". Reported anchors:
  Bishop Fox AI pentest from ~$10,800; NCC Group red team $60-90k+; general AI/LLM red
  team $10-100k+. A $10k fixed add-on sits at the LOW end - market or slightly underpriced,
  possibly leaving margin/credibility on the table for larger scopes. l11 explicitly logs
  NO contradiction and NO required change. [softwaresecured.com], [bluefire-redteam.com].
- No change; note headroom if scope expands. Confidence: Med.

### 3.5 Free-to-paid funnel math (NEW)
- f1 and l12 (Low on company-specific, Med on proxies): NO disclosed company-specific
  free-to-paid rate exists for Snyk/Socket/Semgrep/Aikido/Vanta/Wiz/etc. Best proxies:
  cybersecurity freemium ~3.6% (firstpagesage 2026); devtools 5-10%, security 6-12% in
  some analyses; PLG B2B median ~9% (productled). Lag 90-180 days. Aikido reports ~60% of
  initial customers via freemium-to-premium (no rate).
- l12 funnel math to first 100 paid $750 reports: at 2% need 5,000 free scans; at 4% need
  2,500; at 8% need 1,250. This sizes the top-of-funnel channel target. Confidence: Med
  (proxies, not product data).

---

## 4. Channels and first-100 motion

### 4.1 Channel ranking (Wave 1 g2, confirmed and quantified by Wave 2 l5/l7)
- g2 (High on top two): YC / accelerator batches + founder Slacks are cheapest and
  fastest; cold founder outreach second; AI-founder X third (thinner evidence);
  marketplaces / Vanta-Drata partner listings / design-partner programs slower for the
  first 100. [review.firstround.com Vanta PMF], [reddit YC W24 500-customers].
- l5 (Med, benchmark proxies, numbers not product-specific): blended CAC and cycle by
  channel - YC/warm intro $50-300 CAC, 7-30 days; community (CISO Slacks, AI-founder X)
  $100-400, 7-45 days; self-serve/PLG $200-600, 1-14 days; partner/marketplace $300-800,
  14-60 days; content/SEO $480-942, 30-90 days; cold outbound $400-2,000, 30-90 days.
  Vanta-specific: ~16-day average startup sales cycle, sometimes one-call close
  [unusual.vc], [gtmnow.com]. At $750 one-time, cold outbound is the channel most likely
  underwater; the $299/$999 Continuous tier rescues an underwater channel with ~3-7 month
  ($299) or 1-3 month ($999) payback.
- CAC-efficiency rank for first 100: 1 YC/warm intro, 2 community, 3 self-serve/PLG,
  4 partner/marketplace, 5 content/SEO, 6 cold outbound. Confidence: Med.

### 4.2 The comparable playbook (l7, well-documented for Vanta)
Vanta (YC W18) is the clearest template: founder-led sales, no website/marketing hire
until late 2020, first ~600 customers via YC network and word-of-mouth, founder personally
sold the first ~$500k ARR; the Figma security-questionnaire insight was the inflection.
Drata hit 100 customers in ~45 days post-launch via beta trust + referrals. Secureframe,
SafeBase, Sprinto, Oneleet, Delve are thinly documented (Delve carries a public
fabricated-report allegation - a cautionary contrast). Transferable steps: founder-led
discovery (talk to 50-100 targets), wedge on one painful verifiable proof point, mine
networks for the first 20-50, build a referral flywheel before hiring sales, keep entry
low-friction. Conditions kolm lacks vs Vanta: first-mover timing in a now-crowded
category, deep integrations, and YC-scale warm-intro density. Confidence: High for Vanta,
Low for the rest. [review.firstround.com], [saastr.com], [drata.com/blog].

### 4.3 Conversion trigger (f2 Wave 1, l13 Wave 2)
The dominant trigger is external pressure: an enterprise reviewer / procurement explicitly
demands proof during a live deal (f2: "SOC 2 cost us a $40k deal", reddit). l13 ranks
triggers by frequency x urgency: 1 enterprise reviewer/procurement demand, 2 named deal
with a close-date, 3 EU AI Act deadline, 4 board/investor ask, 5 incident. Verbatim:
@ladyinvisibl (17 May 2026) "Nobody bought SOC 2 audits until enterprise procurement
required it"; @subham11 (12 Jun 2026) "Most AI startups approach SOC 2 ... Late. Rushed.
Driven by a blocked enterprise deal. By then, they've already lost." Design implication
(already correct on site): free Scan shows findings + score and a failing line-item, then
GATES the signed report behind the trigger. Confidence: Med.

### 4.4 Reviewer-side acceptance (g1 Wave 1, l14 Wave 2 - NEW depth)
g1: reviewers live in private CISO Slacks (403 Circle, Evanta/Gartner, CyberRisk
Collaborative), trust-exchange networks (SafeBase, Whistic, Conveyor), and Vanta/Drata
TPRM. l14 adds the exact reuse mechanic: a kolm report gets accepted-and-reused when it is
uploaded to a Trust Center / exchange and AI-driven evidence parsing auto-maps its controls
to the buyer's SIG/CAIQ answers with citations back to the signed file. Ranked surfaces by
lowest friction: 1 Whistic Profile/Exchange (Assessment Copilot parses to SIG/CAIQ with
confidence scores), 2 Vanta Trust Center + TPRM (cross-center evidence pulls), 3
OneTrust/Shared Assessments (owns SIG, native depth), 4 SafeBase-powered centers, 5 Drata,
6 Conveyor, 7 UpGuard. The single best "distribution-by-attachment" move: get kolm reports
attachable in Whistic/Vanta Trust Centers so reviewers see the signed artifact plus
auto-mapped answers in one view. Access barrier: most require vendor paid tiers and
buyer-side NDA/approval. Confidence: Med. [whistic.com], [vanta.com Trust Center].

### 4.5 Questionnaire line-items (l2) and procurement artifacts (l16 - NEW)
- l2: primary questionnaires (SIG, CAIQ, VSA, HECVAT, Whistic/OneTrust templates) do NOT
  publish verbatim text publicly; only CSA's AICM / AI-CAIQ (released ~07/2025, updated
  10/2025, 243 controls / 18 domains) is freely downloadable. So kolm cannot pre-map to
  verbatim SIG AI line-items today; it can map to the public AI-CAIQ and attach as
  supplemental evidence elsewhere. Confidence: High that the text is non-public.
- l16: the procurement bundle a small AI vendor must clear in 2026 = security questionnaire
  + DPA/sub-processor list + AI/model-use addendum + TPRM scorecard + SOC 2/ISO mapping
  letters + an "AI vendor" MSA rider. kolm should (b) MAP its report to each, GENERATE
  only its own signed report, and STAY OUT of drafting DPAs/MSAs/insurance. Strongest
  primary clause example: GSA proposed GSAR 552.239-7001 "Basic Safeguarding of Artificial
  Intelligence Systems" (Feb/Mar 2026) - "eyes off" data handling, no training on
  Government Data, logical segregation, deletion certification, 72-hour CISA incident
  reporting. Minimum artifact set kolm's report must reference to clear a typical gate:
  (1) questionnaire alignment, (2) SOC 2/ISO control mappings, (3) sub-processor / data
  non-training attestations, (4) AI-specific controls per addendum/rider, (5) TPRM
  scorecard evidence categories. Confidence: Med. [pwc.com], [buy.gsa.gov], [atlassystems.com].

---

## 5. Competitors and direct clones

### 5.1 Cyphrex - the one live direct threat, now with PUBLIC pricing (NEW, sharper)
k1 + l3 (High on the public page): cyphrex.io/pricing dated 25 May 2026 lists:
- Starter FREE: 3 agents, 10K checks/mo, 7d logs, blockchain self-custody (user pays gas).
- Startup $49/mo: 10 agents, 500K checks/mo, 90d logs.
- Scale $199/mo: 50 agents, 5M checks/mo, 1yr logs, compliance reports, CSV+JSON export.
- Verify+ $599/mo: 200 agents, 5M checks/mo, 3yr logs, signed evidence packages, hourly
  Solana anchoring, 50 signed framework reports/mo (SOC 2, EU AI Act, HIPAA, SR 11-7),
  PDF export, overage $49/report.
- Enterprise: custom, sub-1-week time-to-live.
Cyphrex positioning: "cryptographically signed compliance reports", continuous/real-time
enforcement, Solana-backed anchoring, agent identity + trust scoring. This directly
overlaps kolm's signed-report + standards-mapping wedge and validates the model while
pressuring differentiation. @Cyphrexio is also active on X (8 Jun 2026, see 1.3).
Differentiate kolm on: a NAMED human co-signer (Cyphrex has none visible), multi-standard
crosswalk in one report, and offline verify with NO server (and no blockchain/gas
dependency) in the trust path. Do NOT mirror Cyphrex's "certifies SOC 2 / HIPAA / EU AI
Act" claim - kolm MAPS to, does not certify. Confidence: High (verbatim public page).

### 5.2 Competitor pricing transparency contrast (l3, NEW)
Nearly every other competitor gates pricing behind "contact sales": Vanta, Drata,
SafeBase, Whistic, Conveyor, Secureframe, Sprinto, Lakera Guard, Prompt Security. Reported
(not official) ranges: Vanta ~$10-20k/yr entry to $50-100k+; Drata ~$7.5k/yr entry to
$30-100k+; Whistic ~$12.7-43.6k/yr (Vendr); SafeBase paid from ~$5k/yr. Three sharpest
pricing-page contrasts kolm can claim: (1) transparent one-time/flat fees vs opaque
custom recurring; (2) low-barrier entry with explicit limits vs hidden scaling; (3) flat
attestation + red-team package vs add-on creep (VRM/TPRM/questionnaire automation often
$3-15k/yr reported add-ons). Confidence: High (public pages) / Med (reported ranges).

### 5.3 Adjacent / non-threats
Vanta "Agentic Trust" / AI Agent features (Feb-Mar 2026, +$150M raised) - adjacent GRC
automation, not a fixed-fee signed-report clone. Lakera acquired by Check Point (Sep 2025
announce) - runtime AI security, not attestation. Drata-SafeBase (Feb 2025, $250M) -
trust-center, category-supportive. No new moves in the late-Apr to mid-Jun 2026 window for
these (k1). Confidence: Med.

### 5.4 Direct clones
k2 (Med-High): no 2026 product matches kolm's exact intersection - cryptographically
signed readiness/attestation artifact + offline verifiability + inclusion proofs + granular
multi-standard mapping (SOC 2 / ISO 42001 / NIST AI RMF / EU AI Act / OWASP / MITRE ATLAS)
in one report + fixed fee + optional named human co-signer. The gap is defensible but will
erode; move fast. Confidence: Med-High.

---

## 6. Co-signer economics

### 6.1 Supply and rates (c1 Wave 1, l1 Wave 2 - NEW named firms)
c1 (High): credentialed co-signers (vCISO, CISSP/CISA, ex-SOC 2 auditors, GLG/Catalant
experts) are abundant at $200-350/hr; a 6-15 hr co-sign = ~$1,500-3,750, leaving ~85-90%
margin on a $25k tier. l1 adds NAMED suppliers with quoted/reported numbers:
- vCISO.com: published "SOC 2 Sprint" $2,500 (2-week fixed, pentest included) or $5,000/mo
  Strategic retainer. Strongest published fixed price. At $2.5k cost on a $25k tier = ~90%
  margin. Confidence: High (verbatim site).
- SideChannel: $3,000-12,000/mo retainer; named former CISO. At ~$6k cost = ~76% margin.
  Confidence: High (published range).
- Prescient Assurance (or Vanta-network e.g. Johanson): ~$10-20k readiness assessment/letter,
  CPA-style. At ~$13.5k = ~46% margin. Confidence: Med-High.
- Expert networks (GLG client rates ~$750-1,500/hr; Dialectica/Guidepoint/Catalant expert
  ~$100-600/hr): viable for lighter expert review, less ideal for a full standalone letter.
- Build-vs-buy roster (l1): vCISO.com (best published fixed price + speed), SideChannel
  (named ex-CISO depth), Prescient/Johanson (CPA-style letter). Confidence: High that
  named supply exists at margin-positive rates.

### 6.2 Liability and the legal/insurance scaffold (c2 Wave 1, l10 Wave 2 - NEW costed)
c2 (High/Med): real liability precedent (Ultramares; CMMC criminal case US v Hillmer;
auditor malpractice). Signers demand: scope language ("readiness, not certification"),
indemnification/hold-harmless, E&O insurance, and a liability cap. l10 puts real 2026
numbers on it:
- E&O / tech professional liability premium for a solo security-attestation practitioner,
  $1-2M limits: estimated ~$2,000-5,000/yr (Hiscox base ~$515-1,025/yr for IT consultants
  scales up for higher-risk attestation work). Named carriers: Hiscox, Chubb, Coalition,
  At-Bay, Cowbell, Crum & Forster (CISO-specific). Confidence: Low-Med (no firm niche quote;
  estimates).
- Verbatim scope-limiting language to reuse (Blaze Information Security pentest attestation
  letter, Jul 2022): "DISCLAIMER: This document presents the high-level description of a
  grey-box security review ... As a time-boxed and best effort exercise, it does not
  guarantee there are no other security issues in the platform, or that intrusions will not
  happen in the future." Pair with the SOC 2 framing "SOC 2 is not a certification. It is an
  attestation report." Confidence: High (direct from public documents).
- No publicly cited E&O lawsuit specifically against an auditor/vCISO for an AI/security
  sign-off was found (l10) - risk is real but litigated precedent is thin.
- Minimum costed package to recruit a named co-signer at $25k: $1-2M E&O at ~$2-5k/yr +
  ~$1-3k one-time legal drafting + indemnification capped to insurance limits + verbatim
  "readiness not certification / time-boxed / point-in-time" scope language. Loads ~8-20%
  onto the $25k tier as COGS; margin stays healthy. This remains a build-before-scale FLAG.
  Confidence: Med (costed estimate). [hiscox.com], [blazeinfosec.com], [icaew.com].

---

## 7. Trademark clearance

n1 (Med): "Kolm" is arbitrary/coined (low descriptiveness, favors registrability in Nice
classes 9/42) BUT faces moderate-to-high in-lane likelihood-of-confusion. Notable:
- kolm.ai itself (the active product) and Kolm Solutions (Kenya IT/security services) -
  same-lane overlap.
- Kolm Therapeutics Inc (filed ~May 2024, pharma; acquired by Roche ~2025) - different
  field, same name; USPTO ser. 98541872.
- EUIPO "THE KOLM" (class 42) expired ~28 Sep 2025.
- ~63 "kolm*" results on Trademarkia, mostly unrelated (KOLMAR cosmetics, etc.).
Verdict: registrable in principle, but do not scale brand spend before a formal clearance
search + attorney opinion + an intent-to-use filing to secure priority. This is a FLAG, not
a copy change. Keep the kolm name + three-bar logo (per authority). Confidence: Med (open-web
scan only, incomplete). [trademarks.justia.com/985/41/kolm-98541872.html], [kolmsolutions.com].

---

## 8. Objections and rebuttals

o1 (Med-High) ranks the top three objections a qualified Series-A buyer raises against a
$750 signed report, each with a rebuttal kolm copy should carry:
1. "Too cheap / lightweight, lacks SOC 2 depth or real testing."
   Rebuttal: evidence a reviewer can independently CHECK (live methodology + transparency
   log + offline Ed25519 verify), not a templated PDF; eight named controls across six
   frameworks. Verbatim risk: "You just know it's a template" (Journal of Accountancy);
   @CredShields "don't mistake the certificate for a locked door."
2. "We already have / are building Vanta/Drata + a Trust Center, why another artifact?"
   Rebuttal: kolm does NOT replace SOC 2 or your trust center; it is the agent-specific
   evidence that clears THIS deal now, and every finding maps INTO the SOC 2 / ISO 42001 /
   NIST AI RMF work you already do. Drata startup tiers ~$7.5k/yr+ (complyjet); the $750
   report is the bridge, not a competitor.
3. "A readiness report is a snapshot; we need ongoing evidence."
   Rebuttal: that is exactly what Continuous is - re-attested weekly (Starter) or on every
   deploy (Growth), so the trust link never serves stale evidence.
Substitute behaviours and frictions (o1): full SOC 2 ($25-150k, 3-12+ months), pen test
($5-25k), Vanta/Drata ($7.5-30k/yr), self-built trust center, whitepaper, push back on the
reviewer. kolm's wedge is the fast credible BRIDGE, not a substitute for any of these.
Confidence: Med-High. [x.com/CredShields], [complyjet.com], [workstreet.com].

---

## 9. What changed since the prior corpus

- ICP firmographics moved from inference (b1, conf ~35) to primary data (l4, conf ~65):
  Series A, 20-100 headcount, $1-5M ARR, GRC/compliance lead buyer from ~50-100 headcount.
- EU date precision: the prior corpus anchored on a flat "Aug 2 2026". Research confirms
  the statutory split (general high-risk + Art 12 = 2 Aug 2026; Annex III = 2 Aug 2027),
  and the LIVE SITE is already further ahead with the 7 May 2026 Digital Omnibus deferral
  of Annex III to 2 Dec 2027. Net: keep the site's two-pronged framing; do not regress.
- Cyphrex went from "pushing signed reports on X" (prior) to a PUBLIC named pricing page
  (25 May 2026) with a $599/mo signed-report tier. The threat is now concrete and priced.
- Named co-signer suppliers identified with quoted rates (vCISO.com $2,500 sprint,
  SideChannel $3-12k/mo, Prescient $10-20k) - prior corpus had ranges only.
- Co-signer liability scaffold now costed: ~$2-5k/yr E&O + verbatim Blaze disclaimer
  language - prior corpus had qualitative only.
- The live ladder already contains a $15,000 Full Readiness and $3,500/mo Continuous-Plus
  tier NOT named in the "locked" ladder of this brief - structurally resolves the w1/l15
  "dangerous gap" but creates a ladder-definition discrepancy to confirm (FLAG F1).
- Per-channel CAC/sales-cycle benchmarks now attached (l5); first-100 GTM playbook
  documented from Vanta/Drata (l7); reviewer reuse mechanic (auto-map to SIG/CAIQ in
  Trust Centers) specified (l14); procurement artifact bundle + GSA clause specified (l16).
- Still unresolved / thin: company-specific free-to-paid rates (none exist; proxies only),
  controlled price-anchor A/B data for $750 (none exist), verbatim named-company deal-loss
  proof (thin), verbatim SIG AI line-item text (non-public except CSA AI-CAIQ).

---

## 10. Source index (by lever)

Beachhead/ICP: raw4/b1, raw4/b2, raw7/l4, raw7/l9. Urgency/regulatory: raw4/e1, raw4/e2,
raw7/l8, raw7/l13. Pricing/WTP: raw4/w1, raw4/w2, raw4/f1, raw7/l6, raw7/l11, raw7/l12,
raw7/l15. Channels/first-100: raw4/g1, raw4/g2, raw4/f2, raw7/l5, raw7/l7, raw7/l14,
raw7/l2, raw7/l16. Competitors/clones: raw4/k1, raw4/k2, raw7/l3. Co-signer: raw4/c1,
raw4/c2, raw7/l1, raw7/l10. Trademark: raw4/n1. Objections: raw4/o1.
Full citation URLs are inline in each raw JSON "citations" array.
