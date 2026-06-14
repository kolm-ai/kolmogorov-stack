# Copy Review 2026 — Triage

Date: 2026-06-14
Source: adversarial copy-review pass (voice-consistency, no-overclaim, series-c-judgment, seo-wiring, cta-clarity)
Triage owner: copy-review subagent

Severity model:
- **P0** — jargon / overclaim / weak-hero that actively breaks the commercial voice, contradicts other pages, or exposes internal register to buyers. APPLIED in this pass.
- **P1** — credibility dents, packaging gaps, sitewide inconsistencies, broken/dead-end CTAs, SEO snippet truncation. Worth doing soon; needs a product or content decision.
- **P2** — minor / single-instance / cosmetic / borderline-defensible. Track, don't block.

---

## P0 — FIXED IN THIS PASS

1. **enterprise.html `#procurement-gates` (L287, L293, L294)** — Defensive internal "claim-ledger" voice ("What's shipping today is here; what isn't, we don't claim" / "what we don't claim yet" / "no overreach … you inherit that discipline"). Reframed to positive buyer value: lede now ends "Every claim on this page ships with proof you can check"; the two defensive rows collapsed into one positive "proof-gated claims" row linking to `/trust#open-gates`. The raw `/product-readiness-closeout.json` internal filename in body copy was removed in the same edit.

2. **platform.html eyebrow (L353)** — "What we hold ourselves to" (inward vendor-discipline framing, off-voice vs every other buyer-facing eyebrow on the page) → "What you can rely on".

3. **Runtime-target count contradiction (5 vs 6 vs 7)** — Reconciled platform.html down to the dominant, customer-facing number **5** (used on index, how-it-works, compare): register L124 `7 → 5`, RUN & PROOF row L302 `7 targets → 5 targets`, plate foot badge L307 `7 targets → 5 targets`. (Note: enumerated lists at platform L182 / enterprise L386 still visibly list six items — see P1 #1 to fully reconcile the prose list to the stated number.)

4. **Secrets-handling phrasing — standardized to one exact promise** ("stripped before anything is written to disk", short form "stripped before write"):
   - how-it-works.html L164 ("redacted before anything is stored" → "stripped before anything is written to disk"), L194 (same), L207 ("secrets never stored" → "secrets stripped before write").
   - index.html L114 ("stripped before anything is stored" → "…written to disk"), L170 (same).
   - integrations.html L332 ("Redaction before anything is stored · secrets never persisted" → "Secrets stripped before anything is written to disk").

5. **Footer tagline jargon "specialist composition"** — Removed from all 26 footer taglines sitewide. The off-brand internal-feature-list line ("The AI compiler for API capture, signed artifacts, specialist composition and device deployment.") is replaced everywhere with the on-brand customer-voice line already used on index/platform/compare: "Own the AI you're renting — a signed model from your live API calls, run on your own hardware." All seven primary pages (and the other 19 footers) now carry one unified tagline. ("specialist composition" survives only in compiler-terms.html L97 legal service-scope prose — intentionally left; see P2 #5.)

---

## P1 — DO SOON (needs a product/content decision; not applied)

1. **Enumerated runtime list still shows six items.** platform.html L182 and enterprise.html L386 both spell out "Hosted, local, your private cloud, edge, offline, or a restricted fleet" (6) while the page now states **5 runtimes**. Pick the canonical five and edit the prose list to match, or change the stated number to 6. Stated-number was reconciled in P0; the prose enumeration is the remaining mismatch.

2. **Pro pricing tier has no value story (pricing.html L174 vs L161).** Pro ($49) and Indie ($29) both ship "500K gateway calls · 1 seat." Pro buys +40 compile credits for +$20/mo and nothing structural; it's the featured plan (`tier--feat`) with the muddiest story. Adjacent comparison rows (L259–265) read identical on gateway/seats. This is a packaging problem copy can't fix — needs product to differentiate Pro or re-feature a clearer tier.

3. **"142 MB median model" is an unsourced stat (index.html L153).** Promoted to a headline proof number, but the same 142 MB appears as a single artifact's size (index L132, L238 and how-it-works L126), suggesting one sample, not a median over a population. Either source the median or reframe as "example model ~142 MB". A diligence reviewer will probe the one stat the rest of the site is scrupulous about.

4. **Unhedged cost claim (enterprise.html L344).** "cheaper than the bill you pay now" — the only unhedged quantitative-feeling promise on an otherwise disciplined page, with no number, range, or "typically". Sits oddly next to the page's own proof-gated posture. Add a hedge ("typically") or a defensible range, or tie it to a calculator/source.

5. **Sitewide CTA split-brain for the same `/signup` action.** Nav CTA is "Get an API key" on the main shell (~27 pages) and "Run the free scan" on the audit shell (~20 pages). Same destination, two names. Per MEMORY the audit surface is deliberately separate, so this may be intentional segmentation — CONFIRM intent. If not intentional, unify.

6. **Pages with no marketing primary CTA (dead ends).**
   - buyer.html — hero has zero visible `btn--primary`; only legacy app controls (hidden by default) and a nav CTA ("Run the free scan") that's the wrong action for a buyer page. Add a hero primary (e.g. "Talk to us about a buyer seat" → /contact, which body copy already points to).
   - docs/api.html — no in-content primary; only the nav "Get an API key". An API reference that dead-ends after reading should have a "Get a key / Start building" primary.

7. **Duplicate CTA label in the first viewport (self-cannibalizing).**
   - index.html — nav "Get an API key" (L90) + hero primary "Get an API key" (L109), same `/signup`, stacked at top. Differentiate the hero primary (the closing band already does this well with "Run a capture").
   - signup.html — nav "Get an API key" → `/signup` (the page you're on) + hero primary "Get an API key" → `#create-workspace`. The nav button is a near-self-link on the conversion page; suppress it or relabel to "Sign in".

8. **Cold-traffic heroes pointing into the authenticated app.** security.html L101, enterprise.html L101, runtimes.html L99 use primaries aimed at `/account/api-control-center` ("Open API control" / "See where your model runs"). These read like logged-in actions for cold marketing visitors. Verify the funnel; a `/signup` primary usually converts cold traffic better.

9. **Meta descriptions exceed SERP snippet limit (~155–160 chars).** Worst: platform.html (238), contact.html (236), compiler-product.html (224), runtimes.html (214), compare.html (202). Pre-existing pattern (not a regression), but front-load the value prop in the first ~155 chars or trim. capabilities.html (165) / research.html (165) are borderline-fine.

10. **Marketing-chrome jargon badges/headlines (no-overclaim).** User-facing, not disclaimers — candidates for rewording:
    - security.html L306 badge "Control-plane security" → plainer security claim.
    - security.html L17 og:description "API control plane" (SERP-visible) → plainer phrasing.
    - trust.html L166 headline "…is honest about what is not done." ("honest" as a virtue-hedge) → state the thing plainly.
    - trust.html L305 + security.html L307 badge "Readiness-gated claims" (×2) → "Claims backed by proof" or similar.
    - privacy.html L145, L148 "hosted control plane" (legal prose; lower stakes).

---

## P2 — TRACK (minor / cosmetic / borderline-defensible; not applied)

1. **research.html hero primary "See why Kolm" → /compare (L101).** Vague, non-committal, points sideways to another marketing page instead of an action. The secondary ("Open the API control center") has the stronger verb. Consider swapping or relabeling.

2. **compare.html "point tool" / "point-tool" phrasing (L153–163).** Light industry jargon, used consistently and arguably defensible as positioning, but procurement/compliance readers may not parse it. Low priority.

3. **badge.html hero primary "Copy a snippet" → `#snippets` (L173).** Soft as a hero primary; the real conversion CTA "Start free" sits at L525. Acceptable given page purpose.

4. **index.html FAQ intro "answered the way they'd want to hear them" (L331).** Slightly precious/self-congratulatory in an otherwise plain, confident voice.

5. **"specialist composition" in compiler-terms.html L97.** Legal service-scope enumeration ("…compiler workspace, signed artifacts, specialist composition, deployment tooling…"). Same orphaned taxonomy term, but changing contractual service-scope prose is out of copy scope — left intentionally. Have legal confirm/replace if the term is being retired everywhere.

6. **enterprise.html H2 "an answer for every team in the room" (L151).** Borderline cliché; survives because the concrete five-question list follows it. Softest H2 on the page.

7. **Long core sentence (enterprise.html L99 / index.html L107).** "…forever to re-run behavior you've already established" stacks three abstractions; the homepage variant adds two em-dashes in one breath. Good idea, dense sentence — consider a light trim. (Not voice-breaking; readability only.)

---

## Defensible — NO ACTION (flagged for completeness)

- **SOC 2 / ISO 27001 / HIPAA / GDPR / FedRAMP / SBOM / SLSA mentions** (trust.html, security.html, account/api-control-center.html) are explicit **disclaimers** stating these are NOT certified / require live artifacts. Not overclaims.
- **"never leaves the signer"** (docs/api.html L2043) — accurate, scoped cryptographic statement about a private key.
- **air-gap / air-gapped** (docs/api.html) — real endpoint/flag docs (`/v1/airgap/jobs`, `KOLM_AIRGAP`), not a hero claim.
- **"egress" (60+ hits)** — the product's named ASR-3 Data Egress control + CSS/JS identifiers. Load-bearing taxonomy, not a hedge or overclaim. Flag as a naming-policy question only, not a copy fix.
- **"honest envelope / honest 501 / honesty contract"** in docs/api.html — engineering term for structured non-throwing error responses, not a marketing hedge.

---

## Counts

- P0: 5 finding-groups (all FIXED across enterprise.html, platform.html, index.html, how-it-works.html, integrations.html + 26-footer sitewide tagline swap)
- P1: 10
- P2: 7
