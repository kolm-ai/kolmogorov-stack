# kolm.ai Copy Change List - 2026-06-15

Concrete copy and positioning changes ONLY. No pricing changes (pricing is locked and
flag-only; price discrepancies are recorded as FLAGS in LAUNCH-DECISIONS-2026-06-15.json,
not here). Every change is cited to a research source. All text is ASCII-safe (no em or en
dashes, no smart quotes; middot allowed), contact is dev@kolm.ai only, framework is NOT
named "AIUC-1", the word "honest"/"honesty" is never used, and the kolm name + three-bar
logo are preserved.

Each change gives the file, the location (with the exact existing text), the BEFORE, the
proposed AFTER, and the cited reason. BEFORE strings are verbatim from the live files as
read on 2026-06-15; apply with the Edit tool against those exact strings.

Confidence key: High / Med / Low (per the dossier).

---

## Change 1 - audit.html: name the beachhead in the hero lede
File: public/index.html is the compiler landing; the wedge hero lives in public/audit.html.
Location: hero lede, line 167-169 (the `<p class="lede" data-enter="3">` block).

BEFORE:
```
kolm audits your AI application - the agent and every tool, identity and data flow around it - from the logs you already have, and signs the findings with Ed25519. Your buyer verifies the report in their browser, offline. kolm is never in the trust path.
```
AFTER:
```
You are an AI-native vendor with an enterprise deal stalled in security review. kolm audits your AI application, the agent and every tool, identity and data flow around it, from the logs you already have, and signs the findings with Ed25519. Your buyer verifies the report in their browser, offline. kolm is never in the trust path.
```
Reason: l4 (Med) places the buyer firmly at Series A AI-native vendors with a live deal
stalled in security review; b2 (Med) names this as the wedge moment. Leading with the
buyer's situation (not the mechanism) follows the durable copy rule. Also removes the two
spaced hyphens used as dashes for ASCII-safety. Confidence: Med.

---

## Change 2 - audit.html: defuse the "too cheap / templated PDF" objection in the problem section
Location: problem section lede, line 225 (`<p class="lede">` under "The reviewer wants proof").

BEFORE:
```
Three findings from the signed sample. Every claim below sits inside the signature, so a buyer checks the evidence, not our summary.
```
AFTER:
```
Three findings from the signed sample. Every claim below sits inside the signature, so a buyer checks the evidence, not a templated PDF. This is evidence a reviewer can verify against a key, not a self-attested answer.
```
Reason: o1 (Med-High) ranks "too cheap / lightweight, lacks real testing, you just know
it is a template" as the number-one objection to a $750 signed report; the rebuttal is
evidence a reviewer can independently check. This mitigates pricing FLAG F2 in copy without
touching the price. Confidence: Med-High.

---

## Change 3 - audit-pricing.html: reframe the regulatory trigger toward the buyer's questionnaire
Location: self-serve section head, line 263 (`<h2>Start free. Sign when the deal needs it.</h2>`).

BEFORE:
```
<h2>Start free. Sign when the deal needs it.</h2>
```
AFTER:
```
<h2>Start free. Sign when your buyer's questionnaire asks.</h2>
```
Reason: f2 and l13 (Med) identify the dominant conversion trigger as an enterprise
reviewer / procurement demanding proof in a live deal; e1 shows 2026 vendor questionnaires
already ask the EU AI Act Article 12 logging question. Reframing urgency from "your
obligation" to "your buyer's questionnaire already asks" matches the verified anchor.
Confidence: Med.

---

## Change 4 - audit-pricing.html: name the conversion trigger in the "who it is for - Report" card
Location: scope card, line 347 (`Who it is for &middot; Report`).

BEFORE:
```
<p>One deal that needs proof now. A single signed report, tied to a stable ID, that your buyer verifies offline.</p>
```
AFTER:
```
<p>A reviewer is asking for proof on one live deal. A single signed report, tied to a stable ID, that your buyer verifies offline.</p>
```
Reason: l13 (Med) ranks "enterprise reviewer / procurement demand" as the highest
frequency-times-urgency trigger; naming it converts on the moment the buyer is actually in.
Confidence: Med.

---

## Change 5 - audit-pricing.html: defuse the "we already have Vanta/Drata + a trust center" objection
Location: Signed Readiness Report tier, line 286 (the frameworks-mapping `<li>`), append a clause.

BEFORE:
```
<li><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Findings mapped to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM Top 10 and MITRE ATLAS.</li>
```
AFTER:
```
<li><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Findings mapped to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM Top 10 and MITRE ATLAS, so every finding maps into the framework work you already do. kolm does not replace your trust center; it is the agent-specific evidence that clears this deal now.</li>
```
Reason: o1 (Med-High) ranks "we already have / are building Vanta/Drata + a trust center,
why another artifact" as objection number two; the rebuttal is that kolm does not replace
SOC 2 or the trust center and every finding maps into existing framework work. Confidence:
Med-High.

---

## Change 6 - audit.html: differentiate against Cyphrex with "maps, not certifies" in the artifact finding line
Location: hero artifact mapping line, line 202 (`ASR-1 least privilege -> SOC 2 CC6`), and
the proof line 176. Strengthen the standards claim to "maps to", never "certifies".

BEFORE (line 176):
```
<span><i class="dot" aria-hidden="true"></i>Eight controls · Six frameworks</span>
```
AFTER (line 176):
```
<span><i class="dot" aria-hidden="true"></i>Eight controls mapped to six frameworks</span>
```
Reason: k1/l3 (High) show Cyphrex publicly markets "cryptographically signed compliance
reports" and effectively claims to certify SOC 2 / HIPAA / EU AI Act. kolm must MAP to, not
certify; "mapped to" is the safe and differentiating verb and avoids mirroring the
competitor's overclaim. Confidence: High.

---

## Change 7 - audit-pricing.html: turn the transparency contrast into an explicit wedge line
Location: the flat-pricing claim, line 337 (`<p class="hero__claim">`).

BEFORE:
```
All prices flat and final. The figure on this page is the figure at checkout. <a href="/roi">Estimate what a stalled review costs</a>.
```
AFTER:
```
All prices flat and final. The figure on this page is the figure at checkout, while most security-review tools quote only "contact sales". <a href="/roi">Estimate what a stalled review costs</a>.
```
Reason: l3 (High on public pages) documents that Vanta, Drata, SafeBase, Whistic, Conveyor,
Secureframe and Sprinto all gate pricing behind "contact sales"; transparent flat fees are
a defensible wedge. Confidence: High.

---

## Change 8 - audit.html: address the GRC / compliance owner, not a generic "reviewer"
Location: problem section head, line 224 (`<h2>The reviewer wants proof. You have a questionnaire.</h2>`).

BEFORE:
```
<h2>The reviewer wants proof. You have a questionnaire.</h2>
```
AFTER:
```
<h2>Compliance wants proof. You have a questionnaire.</h2>
```
Reason: l8 (Med) places budget ownership for this artifact most consistently with the
Chief Compliance Officer / Head of AI Governance / GRC lead, who increasingly drives the
review (72% of orgs expect GRC budget growth). Speaking to the budget owner sharpens the
hook. Confidence: Med. NOTE: lower-confidence than the others; keep as a candidate if the
team prefers to retain the neutral "reviewer" framing already used elsewhere on the page.

---

## Not changed (deliberate)

- regulatory-clock.html: NO change. It already carries the most current EU AI Act framing,
  including the 7 May 2026 Digital Omnibus deferral of Annex III to 2 December 2027, which
  is ahead of the research corpus (e1/e2/l8). Regressing it to a flat "August 2026" claim
  would reduce credibility. See dossier section 2.2.
- All prices: unchanged. FLAGS F1 (the live $15,000 / $3,500/mo tiers vs the brief's locked
  ladder) and F2 ($750 too-cheap perception) are recorded in
  LAUNCH-DECISIONS-2026-06-15.json for user approval, not actioned here.
