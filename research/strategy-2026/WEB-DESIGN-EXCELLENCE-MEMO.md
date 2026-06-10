# WEB DESIGN EXCELLENCE MEMO - kolm.ai best-in-class plan

Date: 2026-06-10 · Author: synthesis lead (web-design + growth research pass)
Inputs: 5 of 8 research dimensions (design-trends-2026, cro-conversion, github-interaction-libs, github-quality-tooling, competitor-teardown [truncated]) + critic pass + direct repo verification.
Repo facts verified before writing: public/ contains 39 HTML pages (research said 28; every "all pages" task below is scoped to 39). JSON-LD already exists on 27 pages. verify-widget.js ALREADY ships working "Inflate the score" and "Forge with a rogue key" buttons (lines 168-187). contact.html is mailto-only on every CTA including "Run a free scan" (line 125). Nav CTA "Start an audit" -> /contact (index.html line 110) disagrees with hero "Run the free scan" -> /signup (line 131). data/x04-claim-fixtures.json contains only quantization/Trinity-era claims; none of the proposed homepage security numbers are fixture-backed yet.

---

## Thesis

For kolm, "best-in-class + sells off the shelf" does not mean a prettier dark-gradient SaaS site; it means the site IS the product demo: a visitor can verify a real Ed25519-signed report in their own browser within seconds of landing, see every price on the page (no competitor shows any), and check every claim themselves - rendered with Stripe-grade typographic restraint on the existing paper/ledger system that already differentiates kolm from a uniformly dark-navy category. The five biggest bets, in leverage order: (1) fix the broken funnel plumbing first - one CTA label = one destination sitewide, kill the mailto walls (verified leaks, hours to fix, zero design risk); (2) make the live verifier the homepage toy by promoting the tamper/forge buttons that already exist in verify-widget.js from ghost-small to discoverable hero affordances; (3) replace the customer logos kolm does not have with proof a skeptic can check (transparency-log live count, inspectable verifier, signed sample + key fingerprint) adjacent to every CTA; (4) take the zero-dependency platform wins (cross-document View Transitions, scroll-driven CSS, tokenized fluid type scale, spring easings) that give app-grade feel for 0 KB of new runtime JS; (5) expand the gate suite (axe, screenshot baselines, size budgets, Lighthouse assertions) so all of the above ships without re-living the W921 invisible-sections bug class.

---

## Section 1 · Adopt-now toolchain

License notes: only permissive licenses proposed for anything that ships to the browser. MPL-2.0 items are dev/build-only (file-level weak copyleft, never shipped). LGPL and non-OSI items are explicitly flagged. ALL npm additions are devDependencies unless marked RUNTIME; RUNTIME vendoring requires user ratification per the prior-pass scope note (see Section 7).

### Adopt now (dev/build-time, no runtime bytes)

| Tool | License | What | Wiring into the stack | Perf cost |
|---|---|---|---|---|
| @axe-core/playwright | MPL-2.0 (dev-only) | WCAG 2.1/2.2 engine | New scripts/gate-a11y.mjs cloned from render-review.mjs chromium loop; scan all 39 pages, fail on serious/critical, allowlist file for accepted findings | 0 KB shipped; ~1 min gate |
| Playwright toHaveScreenshot | Apache-2.0 (already installed, 1.60.0) | Pixel-diff visual regression | Promote render-review screenshots to committed baselines for 8 money pages at 1440px AND 390px, maxDiffPixelRatio ~0.01, mask dynamic bits; baselines generated on this machine (font rendering differs across OSes) | 0 new deps |
| @lhci/cli | Apache-2.0 | Lighthouse perf/SEO/a11y score gate | lighthouserc.json, ci.collect.staticDistDir='./public'; assert perf>=0.90, seo>=0.95, a11y>=0.95 on /, /pricing, /verify, /how-it-works, /signup, /solutions/* | 0 KB; ~3 min for 8 URLs |
| size-limit + @size-limit/file | MIT | Asset growth budgets | .size-limit.json: kolm-2026.css < 50KB brotli, kolm-2026.js < 30KB, money-page HTML < 40KB; npm run gate:size | 0 KB; seconds |
| HTMLHint | MIT | Static HTML lint (dup ids, missing alt, mismatched tags) | .htmlhintrc tuned to the design system; earliest gate in the chain, runs in ms | 0 KB |
| Stylelint | MIT | CSS lint; no-descending-specificity directly targets the W921 specificity-war bug family | Lint public/kolm-2026.css only; add stylelint-value-no-unknown-custom-properties | 0 KB |
| sitemap (sitemap.js) | MIT | Generate sitemap.xml FROM public/*.html | scripts/build-sitemap.mjs walks public/, excludes 404/account pages; verify mode asserts both-direction orphan coverage (complements audit-orphans.mjs) | 0 KB |
| linkinator | MIT | External link rot checking (internal already covered by audit-links.mjs) | Weekly/report-only, NEVER in the blocking deploy gate (network flake) | 0 KB |
| SVGO | MIT | SVG optimization (logo, diagrams, guilloche) | One-shot pass + dry-run gate; preserve viewBox and ids referenced by CSS/JS; deliberately re-bake verify-editorial BASELINE if inline bytes change | Smaller pages |
| sharp | Apache-2.0 | Build-time image optimization to WebP/AVIF | scripts/optimize-images.mjs + gate failing images >150KB or missing .webp sibling | Faster LCP |
| satori + @resvg/resvg-js | MPL-2.0 both (dev-only) | Build-time branded OG cards | scripts/build-og.mjs renders per-page 1200x630 PNGs into public/og/ using the self-hosted brand fonts (needs tools-only TTF copies outside public/); wire through existing add-twitter-card.cjs; new gate asserts every og:image resolves to a real file | Static PNGs, cacheable |
| web-vitals | Apache-2.0 | RUNTIME (vendored ~6KB raw): field LCP/INP/CLS | Copy dist file into public/js/, import from kolm-2026.js, sendBeacon to new POST /v1/telemetry/vitals on Railway (SQLite on the existing volume) | ~2 KB brotli; flagged for vendoring ratification |

### Trial (scoped, one page or one run before committing)

| Tool | License | Scope | Why trial not adopt |
|---|---|---|---|
| GSAP + ScrollTrigger | GreenSock Standard License (free incl. commercial since Apr 2025; NOT OSI - flag) | ONE pinned signature sequence on /how-it-works only, per-page script tag, other 38 pages pay 0 KB | License is permissive-in-practice but non-SPDX; never describe as open source; un-animated DOM must read as a complete static diagram for render gates |
| schema-dts | Apache-2.0 | AUDIT-FIRST: JSON-LD already exists on 27 pages (research claim of "no JSON-LD" is FALSE, verified). Type-check existing blocks, add priceSpecification on locked tiers + FAQPage on /pricing, run FORBIDDEN list over structured data | The gap is validation/coverage, not greenfield |
| Open Props (values only) | MIT | Copy ~30 easing/shadow custom properties (incl. linear() spring curves) into kolm-2026.css :root; vendor values, not the package | Cheapest "feels expensive" win; ~1-2 KB CSS |
| Unlighthouse | MIT | Weekly full-site sweep of all 39 pages against prod; lhci stays the per-commit gate | Heavy puppeteer install; discovery, not gating |
| Shiki | MIT | Build-time syntax highlighting for docs.html/spec.html code samples; 0 client JS | The code IS the demo; needs a light theme tuned to paper #F6F7F4 |
| subset-font | BSD-3-Clause | Subset the three self-hosted families (ASCII + U+00B7 makes this unusually safe); expect 60-80% size cut | FLAG: changes shipped font FILES + @font-face src + verify-editorial BASELINE; Windows-safe (pure-JS HarfBuzz, avoids the documented Python cp1252 trap) |
| capo.js rules | Apache-2.0 | Port the ~10 head-order rules into gate-constraints.cjs (no dep at all) | 39 hand-built heads accumulated across waves; ordering affects FCP/LCP |
| lychee | Apache-2.0 | If/when GitHub Actions CI exists: weekly external link cron | Rust binary install on Windows; linkinator covers local |
| motion (motion.dev mini) | MIT | RUNTIME ~3 KB (animate 2.3KB + inView 0.5KB), vendored to public/vendor/; slots into existing wireReveal() + reduced-motion gate | Flagged: new runtime dependency; native CSS may cover enough that this is never needed |
| @floating-ui/dom | MIT | RUNTIME ~5 KB vendored; glossary-sourced tooltips on /pricing tier matrix + /checks jargon | First evaluate native Popover API + CSS anchor positioning (0 KB endgame); floating-ui is the today-bridge |
| countUp.js | MIT | RUNTIME ~2 KB vendored; animate ROI calculator + numbers band | BLOCKED until X04 fixtures exist for every animated figure; final value must live in static DOM for render gates |
| ogl | Unlicense | ONE lazy-loaded hero shader (guilloche field), static SVG fallback, post-LCP dynamic import, pointer:fine + no-preference + hardwareConcurrency>4 only | Taste risk; prototype before committing |
| Lucide icons | ISC | Inline SVG / single sprite (NOT a webfont, so no font-constraint conflict); ~25 icons for nav markers, check lists, verify-flow steps | Re-baseline render-review once; pick ONE set (audit Tabler's catalog first for security glyph coverage) |

### Skip (and why)

| Tool | Why skip |
|---|---|
| html-minifier-terser | Breaks verify-editorial.cjs exact byte BASELINE and gate-constraints literal-substring matching; Vercel brotli already captures most of the win. NEVER without a deliberate source->dist refactor |
| Phosphor Icons (webfont) | Webfont delivery directly conflicts with the no-new-fonts constraint; Lucide/Tabler inline SVG supersede |
| glyphhanger / fonttools | Python in the text pipeline on Windows = the documented cp1252 corruption trap in this repo; subset-font covers it in pure JS |
| three.js | ~150 KB+ for a hero accent; ogl or raw shader does it at <20% the weight |
| Lenis / locomotive-scroll | Scroll hijacking reads as marketing theater to enterprise security buyers and hurts INP perception on dense evidence pages |
| AOS, Splitting.js | Stale since 2019-2020; existing wireReveal() + native scroll-driven CSS strictly dominate |
| Swiper / carousels | Depress B2B conversion; CSS scroll-snap covers the compare.html mobile table for 0 KB |
| vanilla-tilt / Atropos | kolm already lived W604 tilt cards; gimmicks undercut "evidence, not theater" |
| bundlesize, webhint, BackstopJS, squoosh CLI | All superseded or dormant (size-limit, lighthouse/axe, Playwright native snapshots, sharp respectively) |
| pa11y-ci | LGPL-3.0 and 90% overlap with the axe gate on the existing Playwright install |
| modern-normalize | Forces a full render-review re-baseline for cosmetic-only diff; current reset is green 28/28 |
| Fontsource | Only covers Spline Sans Mono of the three families; subset-font supersedes; new font-asset source = flag anyway |

Zero-dependency platform features (adopt now, no ratification needed, no bytes):
- Cross-document View Transitions: `@view-transition { navigation: auto; }` in kolm-2026.css wrapped in `@media (prefers-reduced-motion: no-preference)`, plus view-transition-name on .nav__brand. Chrome/Edge 126+, Safari 18.2+, silent no-op elsewhere (MDN: developer.mozilla.org/en-US/docs/Web/API/View_Transition_API). MUST verify against the theme-bootstrap inline script (snapshot is taken pre-swap, expected fine, but test dark-mode toggle mid-navigation).
- CSS scroll-driven animations: `animation-timeline: view()` behind `@supports`, keyframes authored visible -> visible so render gates pass with animations unexecuted; existing IntersectionObserver fail-open reveal stays EXACTLY as the fallback (do not touch the W921 structure).
- Native Popover API + CSS anchor positioning for tooltips before reaching for floating-ui.

---

## Section 2 · Design system upgrades (kolm-2026.css + kolm-2026.js)

Priority order. Every item must leave render-review.mjs, render-verify.mjs, verify-editorial.cjs (dashes=0), gate-constraints.cjs green.

1. (S) One filled CTA per band. File: public/index.html .hero__cta + #pricing plate + .cta-final; pattern-check all 39 pages. Hero currently stacks a filled primary + ghost + inline download link + nav CTA. Rule: one .btn--primary per band, everything else ghost or text link. Stripe never places two filled buttons in one band (designmd.run/blog/stripe-design-system-breakdown); single-CTA studies are directional but consistent.
2. (S) View Transitions block (above). File: kolm-2026.css, one block at end. Effort S, app-grade page-to-page continuity for the whole MPA.
3. (S) Spring easings. File: kolm-2026.css :root. Copy Open Props --ease-spring-3/--ease-out-5 linear() VALUES; remap .btn, .nav__cta swap, theme toggle, card hover transitions. linear() supported Chrome 113+/Safari 17.2+/Firefox 112+, degrades to existing ease.
4. (M) Tokenized fluid type scale (Utopia pattern, utopia.fyi/type/calculator). File: kolm-2026.css :root + type section. Define --step--1..--step-5 clamp() vars (min scale at 360px, max at 1140px, max <= 2.5x min for WCAG zoom); remap h1/h2/h3/.lede/.metric__n/.tier__price. Replaces 6+ hand-tuned clamp() expressions that drift across 39 pages.
5. (S) Tabular numerics sweep. File: kolm-2026.css. font-variant-numeric: tabular-nums already on .metric__n/.tier__price/.vw__score; extend to .register__v, .vw__sub fingerprints, any .tbl numeric cell missing it. Audit Cabinet Grotesk weight 800 so it appears only at hero size.
6. (M) Verifier affordance promotion. Files: public/verify-widget.js (lines 168-187) + .vw styles in kolm-2026.css. The buttons EXIST ("Inflate the score", "Forge with a rogue key", btn--ghost btn--sm). Work: raise visual weight on the hero instance (chip style with a subtle pulse-once on reveal), add an explicit "Restore" state label, move the "Try to break it" microcopy from 13px caption to a MACHINE-voice mono label directly above the buttons. Do not change the verify path; it is the product.
7. (M) Asymmetric evidence bento for #problem. Files: public/index.html #problem + new .bento rules in kolm-2026.css (grid-template-areas). One large 2-col cell = a REAL finding from the sample report (mono register rows, severity chip, ASR mapping); 4-5 smaller text cells. Cells stay --paper-2 with --line borders. Anchoring the big cell with a real artifact keeps it evidence, not template (bento trend: pravinkumar.co/blog/bento-grids-b2b-saas-homepage-design-trend-2026).
8. (M) Scroll-driven reveal upgrade behind @supports (Section 1). Files: kolm-2026.css .reveal + kolm-2026.js wireReveal(). PRESERVE the fail-open .js-reveal mechanism byte-for-byte as fallback.
9. (S) Ledger rhythm discipline. Files: all pages using .section--ink. Cap dark bands at two per page; the verifier plate (.vw on dark) must remain the most-lit object via its elevated shadow. Resist dark-everything: every competitor ships the dark terminal cliche; paper/ledger is kolm's most ownable visual position.
10. (M) Icon language (pending icon-set audit + flag ratification). Files: inline SVG or public/icons.svg sprite + small CSS. Lucide ISC, stroke=currentColor inherits theme tokens. Scope: nav section markers, pricing checklists, checks.html 28-control list, verify-flow steps.
11. (S) Numbers band styles are ALREADY BUILT (.metrics/.metric__n, unused on the homepage). CSS effort zero; the blocker is copy: every figure must land in data/x04-claim-fixtures.json first (verified: current fixtures are all quantization/Trinity-era; none of the proposed security numbers exist). Fixture creation precedes copy.

---

## Section 3 · Conversion + copy (page by page)

The funnel today, verified: nav says "Start an audit" -> /contact (mailto wall); hero says "Run the free scan" -> /signup (works); /contact's own free-scan button opens an email client; /pricing claims "No account needed to read your results" while routing to /signup. Three contradictory free-scan stories. Fix plumbing before any aesthetic work.

### / (index.html)
- CTA unify: nav CTA becomes "Run the free scan" -> /signup on all 39 pages (shared nav block). Lines 110 vs 131 currently disagree. "Talk to us" -> /contact demoted to consistent secondary everywhere (also lines 395, 420).
- Hero compression to ONE reading block. Before (H1): "Every enterprise deal needs a security audit. Run yours in minutes." After (sketch, ASCII-only, gate-run before shipping): "Your deal is waiting on a security review. Run it in minutes." Lede before: ~70 words + hero__claim + hero__who (three reads before the CTA). After (~25 words): "kolm audits your AI agent and signs the evidence with Ed25519. Your buyer verifies the report in their own browser, offline, without trusting us." Fold the sample-download line into the verifier aside; compress hero__who to one line.
- Audience switcher under the hero: two cards, "I ship an AI agent" -> /solutions/ai-vendors, "I review one" -> /solutions/enterprise-buyers. These pages are ORPHANED today (verified: reachable only from sitemap.xml); also add both to the shared footer Product column on all 39 pages.
- Verifiable-proof row below hero (the logo substitute): (a) threshold-gated live count from the transparency log ("N reports anchored in a public, append-only log. Inspect it yourself." via existing /v1 endpoint, static fallback, ship only past a non-embarrassing N); (b) "Inspect the verifier" promoted from footer ("one readable file, no dependencies"); (c) sample report + key fingerprint. Never placeholder logos.
- Numbers band (after X04 fixtures exist): use the built .metrics styles; candidate figures to FIXTURE FIRST: minutes-to-signed-report, 2 verification tiers in the buyer's browser, 0 servers in the trust path, N controls mapped to SOC 2 / ISO 42001 / NIST AI RMF (mapping language only, never cert claims).
- cta-final: add the badge row (Ed25519-signed · Offline-verifiable · sample link) + one Caveats line under the buttons. Apply to the shared cta-final on all 39 pages.
- Homepage pricing plate (FLAGGED, Section 7): keep $15,000 featured, add one ladder line beneath: "Self-serve starts free. Signed report $750. Continuous from $299/mo." -> /pricing. Amounts byte-identical; display-only; requires ratification.

### /pricing
- Replace both "Subscribe" buttons with outcome copy. Before: "Subscribe". After: "$299 Keep evidence fresh weekly" tier -> "Keep my evidence fresh"; $999 tier -> "Re-attest every deploy". First-person CTA lifts are directional (Unbounce/ContentVerve) but "Subscribe" names the payment, not the outcome - weakest words on the money page.
- Anchor visibility (FLAGGED): surface the $25,000 Reviewed Attestation in or beside the main tier row (compact full-ladder strip "Free / $750 / $299 / $999 / $25,000" above the tiers) instead of two sections below. Amounts and tier contents byte-identical; ordering/visibility only; requires ratification.
- Under the two enterprise plates ($15,000 / $3,500/mo): visible secondary link "Prefer to scope it on a call first? Talk to us" -> /contact (currently the human path appears only on Stripe error).
- Fix the contradiction: free-tier bullet "No account needed to read your results" vs /signup routing. Standardize: "One email address gets you a key in seconds. Your buyer never needs an account to verify."
- Truthful urgency near money CTAs: "Signed report inside an SLA: days, not the 4 to 8 weeks a from-scratch review takes" (wording must match /sla; the 4-8 week figure needs a fixture or third-party citation). No countdowns, no stock counters, ever: fake scarcity measurably backfires with security buyers.
- FAQPage JSON-LD with the locked prices as priceSpecification (audit existing blocks first).

### /how-it-works
- One filled CTA. Candidate home for the GSAP trial: a pinned, scrubbed "scan -> findings -> Ed25519 signature -> offline verify" sequence; static diagram must be complete without JS.
- Shiki-highlighted verify transcript (build-time): the code is the demo.

### /verify (the highest-stakes unaudited surface; the buyer-side reviewer lands HERE from a shared report link)
- Top line sketch: "Paste a kolm report. Verification runs in your browser. Nothing uploads." Two-tier verdict explained in one mono caption (tier 1 signature, tier 2 issuer provenance).
- Persona bridge: "Reviewing a vendor's agent? Start here" -> /solutions/enterprise-buyers.
- Mobile pass mandatory (see Section 5): this page must verify flawlessly at 390px because reviewers open shared links from email/Slack on phones.

### /trust + /trust-center
- MERGE into one branded trust surface: self-serve artifacts (sample report, issuer keys + fingerprints, verifier source, subprocessors, DPA/BAA links), the transparency-log live count, and a named-accountability block (REAL user-provided credentials only, never fabricated; contact exclusively dev@kolm.ai). Gate only genuinely sensitive artifacts behind a lightweight email-identify step (lead capture). Pattern: Drata/SafeBase trust-center research (drata.com/learn/assurance/trust-center-overview).

### /contact
- "Run a free scan" (line 125) mailto -> /signup. Headline plate CTA stays "Email dev@kolm.ai" for audit scoping.
- Add a 4-field form (name, work email, what the agent does, target date) POSTing to the Railway API and delivering ONLY to dev@kolm.ai, mailto kept as visible fallback. FLAGGED: the page's "email keeps a clear record, no chat widget" philosophy copy needs user sign-off to soften.

### /solutions/ai-vendors + /solutions/enterprise-buyers
- De-orphan (nav "Who it's for" or footer + homepage switcher). The buyer-side reviewer page feeds the flywheel: reviewers who verify one report demand kolm from the next vendor.
- ai-vendors: add the design-partner block ("We are onboarding a limited number of design partners this quarter: full audit at the listed price, direct line to the team, your reviewer's questions shape the checks") -> truthful scarcity + manufactures the named quotes the site lacks. No discounts implied; listed prices only.
- enterprise-buyers: cite third-party industry stats with attribution (e.g., trust-center vendors report security reviews up to 5x faster with proactive evidence, SafeBase 2025) - drafted against the FORBIDDEN substring list since these vendors' names sit near compliance vocabulary; always external data, never kolm capability claims.

### /signup (activation)
- Verified gap: success card hands a curl snippet requiring the user's own redacted JSONL logs; first value is hours away. Build "Run it on sample logs" one-click path (bundled demo logs, output watermarked tier:scan so the paid loop is not undercut). Largest activation lever in the research set; L effort, Railway demo-mode flag.

### Instrumentation (prerequisite for every "A/B" claim above)
- First-party events beaconed to Railway (same endpoint family as web-vitals): signup_start, signup_complete, verifier_tamper_click, verifier_forge_click, pricing_tier_click, scan_cta_click, scroll depth on /. Without this none of the CRO changes can be validated post-ship. No third-party analytics script (keeps the trust story clean and the no-CDN posture intact).

---

## Section 4 · Competitive wedge

Verified category facts: all 12+ direct competitors hide pricing behind "Book a demo"; none can demo their deliverable in under a minute; the runtime-security independents are gone (Lakera -> Check Point, Protect AI -> Palo Alto, Robust Intelligence -> Cisco, CalypsoAI -> F5 redirect). Vanta/Drata own seller-side trust pages but their evidence is verifiable only by trusting their monitoring.

Site moves that express the wedge:

1. Neutral evidence layer. Band on / and /compare: "The verifier is not the vendor. kolm runs nothing in your stack and grades nothing it sells." Name no acquirer; the buyer knows. The consolidation wave makes this the only independent position left on the evidence side.
2. Prices on the page. Make it explicit and aggressive on / and /pricing: "Every price is on this page. No demo wall." kolm is the ONLY player in the category that can say this; it is a conversion weapon for self-qualifying buyers bouncing off demo-gated competitors.
3. The artifact is the demo. No competitor's deliverable can be verified by the visitor; kolm's can, in seconds, offline. Hero verifier + tamper/forge chips + /verify reviewer landing express this. Lakera built category awareness with Gandalf; kolm's free Scan + in-browser tamper toy is the equivalent with the actual product.
4. Per-control grid + diff, no vanity score. Express the no-score position: "Findings per control, with a signed diff between runs. Not a grade we made up." checks.html 28-control grid + report-viewer diff view are the proof surfaces; link them from the bento's large cell.
5. The badge growth loop (unresearched by every dimension; plausibly the strongest viral channel). Every vendor that embeds the kolm verification badge (badge.html exists) advertises kolm to its buyers' security teams, and the badge click-through lands on /verify with a real verdict. Productize: embed snippet, brand guidelines, badge -> /verify -> "I review one" -> enterprise-buyers -> next vendor. This is Vanta's 5,000-hosted-trust-pages loop, except the artifact is independently verifiable.
6. Claim discipline as a feature. kolm gates its own website copy against fixtures (X04). Say so on /trust: "Every number on this site traces to a measurement. The gate that enforces it is in the repo." No competitor can credibly claim this; Drata ships "0 hours / $0M" placeholder stats in production.

Aesthetic wedge: the category is homogeneous dark-navy gradient SaaS. Deepen paper/ledger, do not converge: light is the editorial page, dark is the machine, the verifier plate is the most-lit object on dark. Keep the three-voice type system; ration green to one verified-semantic object per viewport.

---

## Section 5 · A11y / SEO / performance (testable fixes -> CI catcher)

Nothing below is currently measured; the FIRST task is baselines (run axe + Lighthouse against local AND prod for the 8 money pages, record scores in research/strategy-2026/baselines/). Until then, priorities within this section are provisional.

| Fix | Where | Caught in CI by |
|---|---|---|
| Contrast on dark .section--ink bands + cta-final + green-on-dark accents | All pages with ledger beats | @axe-core/playwright gate (wcag2aa), new scripts/gate-a11y.mjs |
| Focusable content hidden by reveal states; focus order; aria on the verify widget controls | kolm-2026.js reveal + verify-widget.js | axe gate + manual keyboard pass on /verify |
| Duplicate ids, missing alt, mismatched tags across 39 hand-edited pages | public/*.html | HTMLHint (ms-fast, first in chain) |
| Specificity regressions of the W921 class (rule loses to a competing selector, section invisible) | kolm-2026.css | Stylelint no-descending-specificity + Playwright toHaveScreenshot baselines (1440px AND 390px) |
| Render-blocking 44KB CSS + three font families = LCP ceiling | kolm-2026.css + public fonts | lhci LCP assertion + size-limit budgets; later: subset-font (flagged) |
| Silent CSS/JS growth per wave | kolm-2026.css, kolm-2026.js | size-limit gate |
| Head order (preloads after CSS, early sync scripts) | 39 heads | capo.js rules ported into gate-constraints.cjs (trial, zero-dep) |
| OG/social cards generic or missing -> links shared by champions to CISOs look unbranded | head meta on all pages | satori/resvg build + new gate: every og:image resolves to an existing file in public/og/ |
| JSON-LD validity, locked-price priceSpecification coverage, FORBIDDEN substrings inside structured data | 27 pages with existing ld+json | schema-dts type-checked generator + gate-constraints extension (parse + FORBIDDEN scan of ld+json) |
| sitemap drift / orphan pages both directions | sitemap.xml vs public/ | sitemap.js build+verify script |
| External link rot on standards/OWASP/NIST references | research, security, legal pages | linkinator weekly report-only (lychee-action if CI moves to GitHub) |
| Field CWV unknown (corporate VPNs, old laptops) | All pages | web-vitals beacon -> /v1/telemetry/vitals (flagged vendoring) |
| Image weight on evidence-heavy pages | report.html, /report-viewer, og/ | sharp build step + oversized-image gate |
| Mobile: hero/verifier/pricing-table at 390px never audited; mailto failure mode is worst on mobile | /, /pricing, /verify, /signup | Add 390px viewport to render-review loop + screenshot baselines; manual device pass once |

---

## Section 6 · Sequenced plan

Gates that must stay green after EVERY task: scripts/render-review.mjs, scripts/render-verify.mjs, scripts/verify-editorial.cjs (dashes=0), scripts/gate-constraints.cjs. New gates join the chain as they land. All new copy is gate-run before commit (ASCII + middot only; no banned word family; no cert-claim substrings).

### NOW (days; leak-stopping + baselines + zero-ratification wins)
- [ ] Unify CTAs sitewide: nav "Start an audit" -> "Run the free scan" -> /signup on all 39 pages; demote /contact to secondary "Talk to us" (index.html 110/395/420 + shared nav everywhere).
- [ ] contact.html line 125: free-scan mailto -> /signup.
- [ ] Reconcile the free-scan story on /pricing, /contact, /signup to one sentence: key in seconds; buyer never needs an account to verify.
- [ ] De-orphan /solutions/*: footer Product column on all 39 pages + two-card audience switcher under the homepage hero.
- [ ] Hero compression on index.html (one reading block, one filled CTA, download folded into verifier aside).
- [ ] Promote verifier tamper/forge buttons (verify-widget.js 168-187): chip prominence, Restore label, mono microcopy above.
- [ ] Run baselines: axe + Lighthouse on 8 money pages, local + prod; record in research/strategy-2026/baselines/.
- [ ] Ratification batch to user (Section 7): devDependency list, runtime vendoring list, pricing-display bundle, contact-form copy, font subsetting.
- [ ] Land the zero-dep platform CSS: @view-transition block, spring easing values, scroll-driven reveals behind @supports (W921 fail-open preserved byte-for-byte). Test theme-bootstrap interaction.
- [ ] cta-final badge row + Caveats line on the shared component (all 39 pages).
- [ ] Gate suite v1 (on devDep ratification): gate-a11y.mjs (axe), screenshot baselines 1440+390 on 8 money pages, size-limit, HTMLHint, Stylelint.

### NEXT (1-2 weeks; proof + polish + measurement)
- [ ] X04 fixtures for every proposed homepage number; THEN the .metrics numbers band (styles already built).
- [ ] Verifiable-proof row: transparency-log live count (threshold-gated, static fallback), "Inspect the verifier" promotion, sample + fingerprint.
- [ ] Asymmetric evidence bento for #problem (real finding in the large cell).
- [ ] Tokenized fluid type scale + tabular-nums sweep in kolm-2026.css.
- [ ] Pricing page changes on ratification: outcome-copy buttons, anchor-visibility restructure, enterprise "scope it on a call" links, urgency lines matched to /sla.
- [ ] Merge /trust + /trust-center into one self-serve portal; named-accountability block awaits real credentials from user.
- [ ] /verify reviewer-landing polish + persona bridge + full mobile pass at 390px.
- [ ] Contact form -> Railway -> dev@kolm.ai (on copy ratification), mailto fallback kept.
- [ ] OG pipeline: satori + resvg-js -> public/og/, wired via add-twitter-card.cjs + og-resolves gate.
- [ ] JSON-LD audit-first pass (schema-dts): validate 27 existing blocks, add priceSpecification + FAQPage, extend gate-constraints to FORBIDDEN-scan ld+json.
- [ ] sitemap.js build+verify; lhci assertions on money pages; first-party event beacons + web-vitals (on vendoring ratification).
- [ ] Tooltips: native Popover API first; floating-ui only if anchor positioning falls short (on ratification).
- [ ] Design-partner block on / and /solutions/ai-vendors.
- [ ] Third-party stat citations on enterprise-buyers + section 01, drafted against the FORBIDDEN list.

### LATER (weeks+; signature moments + loops + re-research)
- [ ] "Run it on sample logs" one-click activation path (signup success card + dashboard + Railway demo-mode, watermarked tier:scan).
- [ ] Badge growth loop productization: embed snippet, guidelines, badge -> /verify funnel, instrumented.
- [ ] GSAP how-it-works pinned sequence (license-flagged, per-page script, static-complete fallback).
- [ ] Shiki build-time highlighting for docs/spec.
- [ ] subset-font font subsetting (flagged; deliberate verify-editorial baseline re-bake).
- [ ] ogl hero shader prototype (static guilloche fallback, post-LCP, capability-gated); ship only if it clears taste review.
- [ ] Icon language rollout after Lucide-vs-Tabler audit (flagged).
- [ ] Dynamic @vercel/og verdict share cards (deferred; over-claiming risk, MAP-not-CERTIFY applies to generated images).
- [ ] Unlighthouse weekly sweep + linkinator/lychee external-link cron.
- [ ] Re-run the missing research dimensions: the original pass delivered only 5 of 8 dims and the competitor teardown truncated mid-finding. Outstanding: voice/copy benchmark, SEO/AEO strategy (llms.txt, answer-engine presence for "AI agent security audit" queries, research.html as organic surface), analytics/experimentation design, audit-firm comps whose reports ARE the product (Trail of Bits, Cure53, NCC Group, Latacora), AI-agent-eval newcomers (Gray Swan, Haize Labs, Pattern Labs, Apollo Research), SafeBase/Vanta trust-page teardowns with screenshots, and post-signup email lifecycle via dev@kolm.ai.

---

## Section 7 · Flags + constraint conflicts (user must ratify; nothing here ships silently)

1. PRICING DISPLAY BUNDLE (locked pricing; amounts byte-identical, presentation only):
   a. Homepage ladder line under the $15,000 plate ("Self-serve starts free. Signed report $750. Continuous from $299/mo.").
   b. /pricing restructure surfacing the $25,000 Reviewed Attestation beside/above the tier row.
   c. Which locked tiers appear on the homepage at all.
2. RUNTIME VENDORED JS/CSS (prior-pass scope note "no new fonts/CDN; no new dependency"): web-vitals (~2KB), motion mini (~3KB), @floating-ui/dom (~5KB), countUp.js (~2KB), Lucide SVG assets, SplitType, GSAP (how-it-works only), ogl (hero only), Open Props VALUES (copied custom properties, not a package; lowest-risk of this list). All would be self-hosted in public/vendor/, never CDN. Approve individually or as a batch; the zero-dep platform features in Sections 1-2 need no approval.
3. DEVDEPENDENCY BATCH (tooling only, nothing ships to the browser): @axe-core/playwright, @lhci/cli, size-limit, sharp, satori, @resvg/resvg-js, sitemap, htmlhint, stylelint, linkinator, svgo, subset-font, schema-dts, shiki. One yes/no covers the set.
4. LICENSES: GSAP = GreenSock Standard License, free for commercial use but NOT OSI/SPDX; never describe as open source in any kolm OSS inventory. MPL-2.0 (axe-core, satori, resvg-js, lightningcss if ever) = weak copyleft, dev/build-only here, fine but inventoried. pa11y = LGPL-3.0, skipped partly for this reason.
5. FONT FILES: subset-font changes the shipped Cabinet Grotesk/Switzer/Spline Sans Mono woff2s and @font-face src lines, and perturbs the verify-editorial byte BASELINE. Explicit confirmation + deliberate baseline re-bake required. Fontsource and Phosphor webfont remain skipped (new font-asset source / new webfont).
6. CONTACT FORM: dev@kolm.ai stays the only address (compliant), but adding a form softens the page's stated "email keeps a clear record, no chat widget, no ticket queue" philosophy; confirm the copy revision.
7. THIRD-PARTY STATS (SafeBase/Vanta/Drata citations): vendor names sit adjacent to certification vocabulary that gate-constraints.cjs forbids as substrings. Every borrowed stat gets drafted against the FORBIDDEN list, attributed as external industry data, never implying kolm holds any certification. We MAP to standards, never certify, including inside JSON-LD and generated OG images.
8. NUMBERS BAND + countUp: BLOCKED until each figure exists in data/x04-claim-fixtures.json (verified absent today). The "4 to 8 weeks" review claim is currently self-asserted; fixture it or attribute it.
9. NAMED-HUMAN TRUST BLOCK: requires real, user-provided credentials; never fabricated.
10. DYNAMIC OG VERDICT CARDS (@vercel/og): deferred; machine-generated "trusted: true" imagery risks implying certification. Static pipeline first; revisit with explicit copy review.
11. NEVER ITEMS (re-affirmed): html-minifier-terser (breaks verify-editorial BASELINE + gate-constraints substring matching); service-worker re-activation; countdown timers or fake scarcity anywhere; the word family covered by the Caveats/Constraints/Limitations directive; em/en dashes (all copy sketches above are ASCII + middot and must be gate-run before commit).
12. RESEARCH CAVEATS: vendor-published conversion statistics cited in the research (3.5x demo engagement, 13.5% vs 10.5% single-CTA, +90% first-person CTA, 2-3x pricing transparency, ~40% anchor lift) come from low-authority growth-content domains and are DIRECTIONAL only; no numeric outcome is promised. Three of eight research dimensions never arrived and the competitor teardown is truncated; Later includes the re-run.

-- end of memo --
