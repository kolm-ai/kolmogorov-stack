# kolm.ai SITE REBUILD — FIRST-PRINCIPLES BRIEF (binding)

## 0. The verdict on the current site
Competent, generic, forgettable. Every section has the same visual weight. The type is
timid. The copy is walls of justified-gray paragraphs. The single ownable asset of this
company, the signed cryptographic artifact, is rendered as a small gray card in the
middle of the page. Nothing on the site could not belong to forty other B2B tools.

## 1. Product truth (what kolm actually is)
kolm sells **evidence**. An AI vendor's enterprise deal is stuck in security review.
kolm audits the agent's actual behavior (permissions, audit trail, egress, prompt
injection), then issues an **Ed25519-signed report the buyer verifies offline in their
own browser** against a public key. kolm is never in the trust path. The artifact is
the product. The verification moment is the demo. Everything else is commentary.

## 2. Category teardown (who we must beat, and how)
- Vanta / Drata / SafeBase / Delve: friendly light compliance SaaS. Rounded, pastel,
  illustration-heavy, "trust" as vibes. They sell PROCESS. We sell PROOF.
- Pentest boutiques: dark, edgy, skull-adjacent. They sell FEAR.
- AI-security startups (Lakera, Prompt Security): gradient-techno. They sell DEFENSE.
**The open position: forensic certainty.** Nobody in the category looks like the thing
a cryptographer would sign. The site must feel like the artifact: precise, inevitable,
machine-verified, expensive. "A unicorn that spent too much on design, in a good way."
Benchmarks for craft: Linear, Stripe, Vercel marketing pages. Not their look, their LEVEL.

## 3. Personas and message hierarchy
PRIMARY: founder / eng-lead at an AI vendor, deal stuck in security review, wants it
unstuck this week. Reads at 11pm. Screenshots things into Slack.
SECONDARY: the enterprise reviewer / CISO on the other side, decides if the evidence
is credible in 90 seconds.
Message order (PAS): 1) your deal is waiting on a security review (their situation,
never our mechanism) 2) hand them signed evidence they verify themselves, in minutes
3) SHOW the artifact and the verification, live 4) flat public prices, no sales call.

## 4. Voice rules (hard)
- Declarative. Average sentence under 14 words. A lede is at most 2 sentences.
- Cut 40-60% of current word count on every page. If a sentence does not move a buyer
  or a reviewer, it dies. No throat-clearing, no "In a world where".
- Numbers in mono. Claims anchored to the signed sample, never vague ("grants 10
  tools, uses 4" not "over-permissioned agents are common").
- Section kickers stay short ("01 / The problem"). No generic-AI eyebrow kickers.

## 5. Design mandates (hard)
- Fonts stay: Cabinet Grotesk (display), Switzer (text), Spline Sans Mono (facts).
  No new font files, no CDNs, no new JS libraries. CSS-only drama.
- Cool-toned palette ONLY (W850 redline: no warm paper). The current #F6F7F4 family is
  allowed but must be ART-DIRECTED, not default. Dark ink sections are encouraged as
  primary, not garnish.
- The three-bar kolm logo stays and should become a SYSTEM (bars as seal, as progress,
  as section punctuation).
- Typographic scale must be brave: hero display at clamp(72px..140px) territory,
  oversized mono numerals, hairline rules. Scale contrast IS the aesthetic.
- The signed report register (mono key/value rows) is the signature component. Render
  it LARGE, beautiful, and early. It is our hero image. No stock anything.
- Motion: restrained, physical, fast (reveals, register rows ticking in, signature
  draw). Respect prefers-reduced-motion. No parallax soup.
- Mobile 390px: zero horizontal overflow, type scales down gracefully (fluid clamp).
- WCAG AA contrast everywhere, including on dark.

## 6. Non-negotiable site contract (gates enforce these; violating = rejected)
- Every page keeps: the pre-paint arming script (js-reveal / data-reveal-armed W921
  fail-open), /kolm-2026.css + /kolm-2026.js refs, `<header class="nav">` with
  `<nav class="nav__links">` carrying EXACTLY these five links in order:
  /how-it-works "How it works", /checks "What we test", /pricing "Pricing",
  /trust "Trust", /docs "Docs". `<footer class="foot">`. Classes .section--ink,
  .cta-final, .idx, .reveal remain in use (advisory checks + reveal system).
- NEVER the word "honest"/"honesty" (use Caveats/Constraints/Limitations). NO em/en
  dashes anywhere (ASCII + middot only). Only contact email: dev@kolm.ai. No personal
  names. FORBIDDEN substrings (case-sensitive, must not appear): pip install kolm,
  .kolm bundle, 3B INT4, Arweave, On-chain, Air-gap mode, WASM runtime, kolm WASM,
  EU AI Act compliant, Type I evidence available now, SOC 2 Type II evidence,
  Your data never moves, data never moves, inside your VPC, BAA boundary,
  PHI never leaves, HIPAA-ready, Mobile SDK, AIUC-1.
- kolm MAPS to standards, never certifies. No blockchain language in the critical path.
- LOCKED pricing (display verbatim, never invent): Scan free · Signed Readiness Report
  $750 one-time · Continuous $299/$999 per month · Full Readiness $15,000 ·
  Continuous-Plus $3,500/mo · Reviewed Attestation $25,000 flat · Deep Red-Team +$10,000.
- EXACT scope line, verbatim, on relevant pages: "Scope is contractual. Permission
  posture, redaction and audit-trail integrity are assessed. Injection is tested and
  reported, not warranted."
- X04 evidence-locked strings that must survive on the site (exact, incl. markup where
  shown): "eight controls" / "Eight controls" / "eight ASR controls"; "Six frameworks";
  "6 frameworks"; "two verification tiers"; "fa562154f99c95f4";
  "grants 10 tools, uses 4"; the register findings line
  "13 · <b>7 high</b> · 4 medium · 1 low · 1 info"; signature excerpt "9kWQBu5kLl" and
  "aG9aDw"; sample key fingerprint "410302c93becdcc3".

## 7. Structure (information architecture)
All 39 routes stay (no broken links). Marketing core gets the full treatment:
index, how-it-works, checks, pricing, verify, trust, report, compare, solutions/2,
enterprise, security, contact, signup, docs. Homepage beats (6, not 10):
  1 HERO: situation headline + the artifact itself (live register) + 2 CTAs + proof row
  2 THE PROBLEM: 3 evidence-anchored cards (from the signed sample)
  3 HOW: audit -> sign -> they verify (3 monumental steps)
  4 THE ARTIFACT: register at full scale + offline-verify moment
  5 PRICING: one plate + "every price public" + design-partner line
  6 FINAL CTA: dark, huge, two buttons. Done.
Legal/ops pages (privacy, terms, dpa, baa, sla, acceptable-use, subprocessors, status,
changelog, careers, 404...) inherit the system via shared CSS, light touch.

## 8. Quality bar
A CISO trusts it in 90 seconds. A founder screenshots it into Slack because it looks
expensive. A designer asks who did it. If a section could ship on any other SaaS site
unchanged, it is not done.

## 9. USER VERDICT ON ROUND 1 (2026-06-10, binding amendments)
The three concepts were rejected as "uninspired tear sheets". Direction locked:
EVIDENCE ROOM (dark forensic) wins, but the execution rules change:
- TYPE DISCIPLINE. The "brave scale" mandate in section 5 OVERSHOT and is amended:
  hero display caps at clamp(40px, 4.6vw, 68px). Section heads clamp(30px, 3vw, 44px).
  No 100px+ numerals. Confidence comes from weight, tracking, spacing and contrast,
  never from billboard sizes. Linear-grade restraint.
- THE REGISTER IS A PRODUCT, NOT A DUMP. Mono key/value tear-rows are rejected. The
  signed report must be rendered as a beautiful, intuitive document artifact: visual
  severity breakdown (stacked bar), real finding rows with severity pills, a signature
  block with faded middle and a verified check, layered elevation. Legible at a glance
  to someone who has never seen kolm.
- VISUAL EDGE IS MANDATORY. Flat equal-weight bands are rejected. Required moves:
  layered light (radial spotlights, gradient hairline borders lighter at top), subtle
  grid/noise texture, glass elevation on cards, one disciplined phosphor-green accent,
  severity color used surgically. Depth and light do the work decoration used to.
- Sections need RHYTHM (alternating density, connective tissue), not stacked bands.
