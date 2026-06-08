# kolm.ai Rebuild Spec — "Agent Security Evidence"

Plan of record for the complete site rebuild around the fast-leg meta (AI-agent
security-review readiness audit → cryptographically signed, offline-verifiable
evidence reports that unblock enterprise deals). Source: `wf7-positioning.json`
(26 best-in-class sites reviewed → unicorn playbook). Keep the kolm name, the
three-bar descending mark, and the wordmark; rebuild everything else.

Hard founder constraints (verbatim intent): **NO named researchers anywhere,
especially not the hero** — the product + site recruit elite researchers, so the
work must speak. Product-led credibility only. Domain stays kolm.ai. Never use
the word "honesty/honest" in copy. Real contact = dev@kolm.ai only. Nothing
ships to prod without explicit user go.

## Positioning (locked)
- **Hero (CANONICAL = Option E, verifiable-evidence/rigor-led — founder-chosen 2026-06-07):**
  - eyebrow: `Agent security evidence`
  - H1: **Verifiable security evidence for AI agents entering the enterprise.**
  - sub: *kolm audits your agent and issues a signed report your buyer's security team verifies offline, against your public key — no account, no trust in our servers. Clear the review in days, not months.*
  - primary CTA: **Verify a sample report** · secondary: **Talk to sales**
  - **Why E over A:** the page serves TWO audiences. The vendor wants the outcome; the *skeptic evaluating the stamp* (enterprise reviewer / elite researcher we recruit) is asking "is this rigorous or a growth-hack to game my review?" A sales-led hero erodes credibility with that second audience — fatal for an attestation brand. E leads with rigor (the moat), lands the outcome in the sub, and reads as authority to both (Wiz/Vanta/Drata idiom: capability-led, never "close your deal faster").
  - Alts kept for A/B: Option A (outcome-led: "Clear the security review blocking your enterprise deal."), Option G ("Security evidence your buyer can verify — not just trust."), Option D ("Sell your AI agent into the enterprise — without the months-long security review.").
  - **LESSON (carry to every page's copy):** lead with rigor/verifiability; treat the skeptic-evaluating-the-stamp as a first-class reader on every page, not just the vendor.
- **Category line (meta-layer, Wiz/Snyk/Drata idiom):** "The evidence layer for AI agents entering the enterprise."
- **The falsifiable claim that carries the brand:** *verify against our public key, offline, no account, no trust in our servers* — demonstrated on the page, not asserted.

## Visual direction (locked)
- Canonical theme flips warm-paper → **dark security-premium** (Wiz/HiddenLayer/Opaque idiom). Base `#0B0E12`, panels `#0E1116`, near-white text; light mode stays a toggle.
- **One semantic accent system:** verification green (`#34D399`/`#22C55E`) ONLY for verified/signature/CTA; red ONLY for tamper/failed-check. Color = meaning, never decoration.
- Type: premium sans for prose (Inter/Geist-like) + **mono (JetBrains/Geist Mono) for every hash, signature, report field** so crypto facts read as facts.
- Eyebrow (small uppercase tracked) → tight `clamp()` H1 → subhead → CTA. Generous whitespace = the credibility signal. Bento/card modular layout, alternating text-left/visual-right. Motion restrained + `prefers-reduced-motion` gated; the single "wow" = the live signature check resolving to green.
- New design system file: `public/kolm-2026.css` (self-contained tokens + components; does not depend on warm-paper/ks legacy).

## Sitemap (new)
`/` home · `/verify` (centerpiece public verifier) · `/how-it-works` (Audit→Sign→Verify) · `/platform` · `/checks` (risk catalog mapped to OWASP LLM Top 10 / MITRE ATLAS / NIST AI RMF) · `/report` (anatomy + real downloadable sample) · `/transparency-log` · `/solutions/ai-vendors` · `/solutions/enterprise-buyers` · `/pricing` · `/trust` · `/research` ("State of AI Agent Security" + methodology) · `/docs` (verifier CLI + library + CI/CD action) · `/changelog` · `/enterprise` · `/careers`.

## Homepage sections (14, in order)
1. Sticky nav — kolm mark + wordmark; IA: Platform · How it works · Solutions · Trust · Research; right: ghost "Verify a report" + primary "Start an audit"; theme toggle (dark canonical).
2. Hero — outcome H1 + compact **live verify widget** beside copy (real signed report → Ed25519 → green "Verified offline").
3. In-fold proof band — Halborn-audited badge, SOC 2 Type I available (Type II in progress — phrase to avoid banned substrings), transparency-log link, "Verify against our public key — offline, no account." Real artifacts only; if no public logos yet, lead with standards coverage.
4. The problem — the biggest deal is parked in security review; a CISO won't run an autonomous agent on their data on say-so; questionnaires no longer clear the bar.
5. How it works — Audit → Sign → Verify lifecycle (system, not tool).
6. **Live verify demo** — embedded verifier: load sample → green; "Tamper a field" flips one byte → red, real time. Recruits researchers + converts CISOs. Accent green reserved for verified state.
7. What we test (4 pillars) — (1) prompt injection & jailbreaks, (2) tool/action abuse & over-permissioned agents, (3) data exfiltration & leakage, (4) supply chain & model provenance; each mapped to OWASP/ATLAS.
8. Anatomy of a signed report — annotated real report, hashes + Ed25519 sig in mono; content hash, signature, scope (what was/wasn't tested), transparency-log inclusion proof; "Download sample."
9. Solutions by buyer — AI vendors ("hand your buyer evidence instead of a questionnaire — reviews in days, not months") + enterprise buyers ("verify any vendor's agent yourself, no dependency on kolm's servers").
10. Outcomes/metrics — real, bounded numbers only (review turnaround days vs weeks; share of questionnaire items pre-answered; time-to-first-evidence). Where not yet public, state the measurable promise, don't invent.
11. Trust — our own posture: SOC 2 status stated exactly, Halborn audit, transparency log, data handling (we don't retain agent data; BYOC/air-gap available); dev@kolm.ai.
12. Research & thought leadership — featured report + published methodology + disclosures; the asset that recruits researchers.
13. Final CTA — "Clear the review. Close the deal." + Verify a report / Start an audit / Talk to sales.
14. Footer — full IA + badge row (Halborn, SOC 2), kolm mark.

## Proof strategy (product-led, no people)
Live in-browser verifier (homepage + /verify) · Halborn 3rd-party badge (firm, not a person) · public append-only transparency log w/ per-report inclusion proofs · the signed artifact as focal object · offline/no-account verification as the central falsifiable claim · coverage mapped to OWASP/ATLAS/NIST · own SOC 2 posture stated exactly · bounded real metrics only · "State of AI Agent Security" research + methodology · open inspectable verifier (CLI + library + CI/CD action) · strictly real artifacts (no fabricated logos/customers/usage).

## Build assets already shipped (this gating pass)
- `public/kolm-verify.js` — REAL dependency-free WebCrypto Ed25519 receipt verifier; canonicalization byte-identical to `src/receipt-schema.js`; recomputes fingerprint; optional issuer-key pinning; no canned OK lines. Proven by `scripts/verify-browser-parity.mjs`.
- `public/sample-receipt.json` — a real builder-signed, self-verifying sample report (the live demo's payload).
- Crypto SOTA fixes: ed25519 key-type validation (`wave167`), `verifyInclusionProof` offline export + secrets-vault perm hardening (`wave168`), extension verifier theater killed.

## Engineering sequence (staging-first; "measure 1000×, cut 1×")
1. `kolm-2026.css` design system ✅ (Geist/Geist-Mono self-hosted, dark canonical).
2. `public/index-2026.html` staging homepage (14 sections) + `verify-widget.js` (REAL, auto-mounts `[data-verify-widget]`, streams genuine checks, Tamper button flips a byte → red) ✅. Sample made byte-reproducible (fixed demo key + id/timestamp in `verify-browser-parity.mjs`); anatomy block synced to live values. Forbidden-substring scan CLEAN; JS syntax-checked; PARITY OK ✅.
3. Build the rest of the sitemap on the same system ✅. Founder approved the aesthetic/positioning ("fan out the rest") and locked hero Option E. ALL staging pages now exist on `kolm-2026.css` + `kolm-2026.js` with a standardized nav (Platform · How it works · What we test · Trust · Research) + byte-identical footer: `index-2026`, `verify-2026`, `how-it-works-2026`, `platform-2026`, `checks-2026`, `pricing-2026`, `report-2026`, `trust-2026`, `research-2026`, `enterprise-2026`, `docs-2026`, `transparency-log-2026`, `changelog-2026`, `careers-2026`, `solutions/ai-vendors-2026`, `solutions/enterprise-buyers-2026`. Preview server (`scripts/preview-static.mjs`, port 4500) serves all 16 clean URLs 200; all assets 200; forbidden-substring + legacy-brand + encoding scans CLEAN; PARITY OK ✅ (sample verifies, tamper fails, fp `fcd91758…` stable & synced to anatomy blocks on `/` and `/report`).
   - **DECISION — pricing (`/pricing`):** tiers anchor on **turnaround** (~1 wk Express · ~2 wk Standard · ~3–4 wk Advanced · Custom Enterprise), NOT public dollar figures. Rationale: speed is the value prop; publishing the plan's exact fees ($15k/$25k/+$10k/retainer/contingency) is hard to reverse (cached/indexed) and enterprise security vendors rarely list prices. Page uses "fixed fee, quoted upfront / Get a quote." **Open for founder: publish exact figures? (default = keep quote-based).**
   - **DECISION — careers (`/careers`):** built as a soft-launch page ("no formal listings yet → email dev@kolm.ai"); deliberately NOT linked in the global footer/nav (kept byte-identical) so it's reachable by URL but not promoted until hiring is formalized. Researcher network described generically — NO named people (honors the hard constraint).
4. **Atomic swap + reconciliation:** replace `index.html` (+ other pages), preserve required hidden test anchors, **rewrite the website tests that encode the OLD positioning** (site.test.js, wave205/220/224/225/373…) to the new meta, honor `FORBIDDEN_PUBLIC_PATTERNS` (no "WASM runtime", "On-chain", "EU AI Act compliant", "Type I evidence available now", "SOC 2 Type II evidence"; my verifier is "in-browser WebCrypto", not "WASM").
5. Flip `nav.js` theme bootstrap to dark canonical; bump `sw.js` CACHE_VERSION; full `node --test` green.
6. Deploy (Vercel `vercel --prod --yes`) — **explicit user go required.**

## Forbidden-pattern guardrails (copy must avoid these exact substrings)
`WASM runtime` / `kolm WASM` → say "in-browser WebCrypto verification". `On-chain *` → transparency log is Ed25519/Merkle, not blockchain. `EU AI Act compliant` → "maps to EU AI Act Art.12/14" only. `Type I evidence available now` / `SOC 2 Type II evidence` → "SOC 2 Type I available; Type II in progress". `Your data never moves` / `data never moves` → "we don't retain your agent's data; BYOC/air-gap available". No `pip install kolm` etc. (install-from-source only).
