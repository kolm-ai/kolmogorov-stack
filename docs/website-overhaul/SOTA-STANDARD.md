# kolm — SOTA Standard (the bar every surface must meet)

The goal is not fewer pages. It is that **every** surface that earns its place is upgraded to read like a $25–60M category-defining company: current, on-brand, jargon-free, intuitive, conversion-oriented, simple. Keep what's useful (programmatic-SEO `compile/*`, docs, verticals all stay); make all of it SOTA. This file is the standard the audit measures against and the generators must encode.

## 1. Positioning — one source of truth (use these strings verbatim everywhere)

- **Category:** The AI Compiler.
- **One-liner:** Own your AI. Compile frontier-model quality into a small, private model you run anywhere — with a signed receipt for every call.
- **Three pillars (always in this order):** **Own it** (distill frontier quality into a small model you run anywhere) · **Prove it** (a signed receipt for every call — the moat) · **Govern it** (SSO/SCIM/RBAC/BYOC/residency/audit).
- **The moat sentence (the thing no competitor ships):** a cryptographic, offline-verifiable receipt for every call.
- **Never** lead with internal nouns: "wrapper", "studio", "surface", "evidence-to-artifact". Name the outcome; the mechanism comes after.

A machine-readable copy lives at `docs/website-overhaul/positioning.json` — generators import it; no page hard-codes a competing tagline.

## 2. Brand system (standardize; one look)

- **Palette:** cool-slate monochrome — ink `#111` on slate `#f3f5f7`, dark `#0e1116`. ONE accent (precise cobalt) reserved for the moat (receipts/verify/primary CTA), never decorative. (Accent token rollout is the screenshot-verified pass; tokens already centralized in `ks.css` `--ks-accent*`.)
- **Type:** Inter (display/UI) + JetBrains Mono (every hash, receipt, command — it reads "cryptographic"). No serif.
- **Components:** one nav (Product · Proof · Docs · Pricing · Enterprise), one footer, one card, one button hierarchy, one receipt artifact, one code block. Defined in the shared CSS; pages compose, never re-skin.
- **Motion:** one reveal curve, one duration scale; all gated on `prefers-reduced-motion`.

## 3. Copy voice (from `voice-rubric.md`, enforced)

Lead from the reader's situation, not the mechanism. Outcome-first. One idea per sentence. Every number bounded + linked to data. No filler ("powerful/seamless/unlock/leverage/robust/world-class"); never the word "honest". Real contact only (`dev@kolm.ai`); no fabricated traction; SOC 2 = "Type I; Type II in progress" only.

## 4. Per-page SOTA checklist (the gate)

A page is SOTA only if ALL hold:
1. **On-brand:** shared tokens/components; no warm-paper remnant; mono for hashes/commands.
2. **On-positioning:** uses the canonical category/one-liner/pillar language; no contradicting tagline.
3. **No jargon / current:** no wrapper/studio/surface/evidence-to-artifact; current model names + claims; nothing stale.
4. **Conversion-oriented:** exactly one clear primary CTA above the fold; a secondary path; proof near the claim; an obvious next step (no dead ends).
5. **Intuitive IA:** canonical nav + footer; correct breadcrumb/canonical; the reader always knows where they are and where to go.
6. **Simple + scannable:** one big idea per section; short sentences; skimmable headers; no wall-of-text; meta title 12–78 / description 50–220.
7. **Accessible + responsive:** skip link, focus rings, alt text, heading order; clean at 390 / 820 / 1440, light + dark; no horizontal overflow.

## 5. Conversion model (every surface routes to value)

- Each persona has a friction-minimal path: dev → `/quickstart` (own a model free); team → `/pricing`/`/product`; enterprise → `/enterprise` (talk to sales) + `/proof` (verify). 
- Programmatic-SEO pages (`compile/*`, `compare/*`) must convert the long-tail visitor: a one-line answer to their query, then the canonical CTA into the product. Not dead SEO leaves.
- Proof is one click from any claim (`/verify`, the benchmark JSON, `/proof`).

## 6. How this gets applied (leverage, not hand-edits)

- **Generators encode the standard:** `build-account-pages`, `build-seo-pages`, `build-comparison-seo`, `build-marketplace-pages`, `build-docs-*`, `build-cli-docs` import `positioning.json` + emit pages that pass §4. Fix the generator → regenerate → the whole family is SOTA.
- **Shared CSS** carries the brand; pages inherit.
- **Hand-authored spine** (home/product/proof/solutions/pricing/enterprise/security) already upgraded; held to the same checklist.
- **Every change keeps its family's tests green** (grep `tests/` first); generators are re-run idempotently; `sw.js` bumped.

## 7. Done = exhaustiveness gate

Reconcile the page manifest: every kept page passes §4; positioning strings are consistent site-wide; no jargon token survives a global grep; every family's tests green; screenshots clean at 3 breakpoints × 2 themes. That is "all of it, upgraded."
