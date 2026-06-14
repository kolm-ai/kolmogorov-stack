# Rebuild Adversarial Review — Triage & Fix List (2026-06)

Triage of the consistency / tokens-css / wiring / a11y / brand-vs-benchmark adversarial
review of the kolm.ai rebuild. **P0 blockers have already been applied** to the working
tree (see "P0 — FIXED" at the bottom for the record). This document tracks the **remaining
P1 and P2 work**.

Scope reminder (per project MEMORY): kolm.ai = the **main site** (canonical shell =
`pricing.html`, `t-*` body class, `kolm-2026.css` tokens). **audit.kolm.ai** is a
**deliberately-separate** product (its own skin, `kolm-field.js` WebGL hero, Switzer/Spline
fonts, `--sheet*` on-light tokens). Findings against audit-site files are real but live
**outside this design system's authority**, so they are triaged lower (mostly P2) and must
not be "fixed" by forcing the main system onto them.

---

## P1 — should fix (real defect, in-scope or shared stylesheet)

### P1-1 — Undefined custom properties on audit-site app pages (broken `var()`)
`--sheet`, `--shadow-tint` are defined nowhere; the `var()` references silently drop the
gradient/shadow. These ship on audit-site surfaces (deliberately separate), so they are P1
not P0, but they are genuinely broken renders:
- `--sheet` → `public/account-billing.html:56`, `public/buyer.html:58`, `public/audit-pricing.html:48`
- `--shadow-tint` → `public/account-billing.html:56`, `public/buyer.html:58`, `public/roi.html:99-100`
- `--sheet` (badge) → `public/badge.html:114`

Fix: either define `--sheet`/`--shadow-tint` in the audit-site token block, or swap to
existing tokens (`--paper` for `--sheet`; a tinted shadow / `0 10px 28px rgba(17,22,19,.18)`
for `--shadow-tint`). (Note: `--shadow-lift` was the only one of the three that touched a
**main-site** page — `account/overview.html` — and was fixed in P0.)

### P1-2 — Near-invisible focus rings on audit portal inputs (WCAG 2.4.7)
`public/buyer.html:70,74` and `public/account-billing.html:65,73` override the global
`--focus-ring` with `box-shadow:0 0 0 3px var(--accent-soft)` (8% alpha) and key off
`:focus` not `:focus-visible`. The ring is effectively invisible on the dark field.
Fix: drop the local override and let the global `:focus-visible{box-shadow:var(--focus-ring)}`
apply, or use `--accent` at full strength. (The equivalent on the main-site
`account/overview.html` input was already moved to `--focus-ring` in P0.)

### P1-3 — Second/third hue in `docs/api.html` method colors (one-hue law §10.2)
`public/docs/api.html:100-104`: `.m-post{#7faedc}` (blue) and `.m-patch{#c89fdc}` (purple)
introduce a second and third hue, violating the one-hue law. `docs/api.html` IS a main-site
page (`t-docs`), so this is a real in-scope brand breach — held at P1 only because the
swatches are small inline HTTP-verb chips, not page chrome.
Fix: collapse the five method colors to a single-hue accent/ink ramp, or fence them to a
clearly-labeled token set that stays within the green↔ink range. The green-ish
`#5eb88b` (GET) is tolerable; the blue/purple are not.

### P1-4 — Weight system ships 5 weights, spec claims 3 (internal contradiction)
Law (§1) and Consistency Contract #5 say "the ONLY 3 weights" = 400/510/640
(`--w-body`/`--w-ui`/`--w-display`). The shipped CSS additionally uses `font-weight:600`
(~28 occurrences) and `620` (`b,strong`, `.tbl td b`, `.flow__t`, `.dg-*`). With the
variable Geist face these render as distinct weights. The design-system doc's own component
recipes (§8.2/§8.4/§8.6) specify `600`, so **the spec contradicts itself**.
Fix: collapse `600`/`620` → `640` (`var(--w-display)`) across `kolm-2026.css` and reconcile
the §8 recipes, OR amend the law to name the real weight set. Pick one; do not ship both
claims.

### P1-5 — Hardcoded hex bypassing tokens on audit pages (tokens-only §11)
Real color/background/border hex literals (audit-site scope):
- `public/account-billing.html:56-57` — `#0C100E`, `#FFFFFF` (×2). `#fff` is on the kill-list.
- `public/buyer.html:58-59` — identical `#0C100E`, `#FFFFFF` (×2).
- `public/audit-pricing.html:48,57` — `#F7F8F5`, `#1C2420` (×2).
- `public/report-viewer.html:195` — `.fsev{color:#fff}` is a **live screen rule** (the
  print-block `#fff`/`#555` at :260/:266 are acceptable print resets).

Fix: replace with tokens (`#FFFFFF`→`--cta-fill-hover`/`--paper`; `#0C100E`→`--cta-ink`/`--room`;
`#1C2420`→`--sheet-ink`). For `report-viewer.html:195` verify the JS-set chip background
clears 4.5:1 against white text for low/info severities, not just high.

---

## P2 — cleanliness / debt (no user-visible defect, or out-of-authority audit site)

### P2-1 — Dead kill-list vocabulary still resident in the "single source of truth" CSS
`kolm-2026.css` still **defines** §10.11 kill-list classes even though no canonical page
references them: `.num-ghost` (:876), `.rule--ticks` (:890), `.seam` (:883),
`.microprint` (:873), `.dither-edge` (:881), `.field`/`.field--band` (:893). Dead CSS, not
an active breach, but a single-source stylesheet should not carry its own banned vocabulary.
Fix: delete the six dead rule sets.

### P2-2 — Deprecated aliases retained in `:root`
`kolm-2026.css:117-133` keeps the §13 back-compat aliases (`--surface-1`→`--panel`,
`--mono`→`--font-mono`, `--display`→`--font-sans`, `--accent-text`, `--accent-hi`,
`--weight-text/ui/display`, `--ease-exp`, `--dur-fast`, etc.). They resolve correctly and
exist only as shims for inline styles that still reference old names. §13 says "do not
author NEW rules against these." Tolerable as compat, but every page that still authors
against them is debt.
Fix (gradual): migrate remaining inline-style references to canonical names, then drop the
aliases. The main-site `account/overview.html` was already migrated off `--mono`/`--display`/
`--surface-1` in P0; the audit-site pages still use them.

### P2-3 — `.ui__step` ordinal contrast (decorative)
`kolm-2026.css:753` — step counters in `--ink-4` at 10px. Sub-AA but decorative numbering.
Low severity; bump to `--ink-3` if these ever carry meaning beyond ordering.

### P2-4 — Placeholder-as-label on audit portal inputs
`public/buyer.html:69` (and `account-billing.html`) — `input::placeholder{color:var(--ink-faint)}`
(~1.8:1, "decorative only" per §3). Combined with P1-2's weak ring, the `.add-row` inputs
rely on a near-invisible placeholder for their affordance. Placeholders are technically
exempt from 1.4.3, but this is unreadable.
Fix: `--ink-faint`→`--ink-3` for the placeholder AND give the inputs a real `<label>` or
`aria-label`. Audit-site scope.

### P2-5 — Stale `outline:0` on audit textareas (fragile, not yet broken)
`public/report-viewer.html:60`, `public/verify.html:53`, `public/roi.html:95` set
`outline:0` on focus without a co-located replacement. The global
`:focus-visible{box-shadow:var(--focus-ring)}` still cascades in, so keyboard focus is
*probably* indicated — but verify in-browser that Tab focus shows the ring and that no local
`:focus{}` rule shadows it. Audit-site scope.

### P2-6 — Audit-site kill-list forks (known, by design)
`kolm-field.js` (the Bayer-dither WebGL ambient field, §10.11 kill-list) and the
Switzer/Spline/Cabinet font preloads survive on ~18 audit-site files. Per MEMORY these
audit.kolm.ai surfaces are deliberately a separate skin, so this is a **known fork**, not a
regression — but it contradicts the binding "one design system" claim and should be
acknowledged explicitly in the design doc. Also: `kolm-field.js:75` reads `--paper` (the
light artifact token) as its shader "room" base — a token misuse, visually masked by the low
alpha cap.
One ambiguous case worth a quick clean: `public/trust.html:28-30` loads `kolm-2026.css` (the
canonical kolm.ai shell) yet still preloads the three banned faces — a harmless dead preload,
but it is the single canonical-shell page carrying kill-listed preloads. Remove those three
`<link rel=preload>` lines from `trust.html`.

### P2-7 — Craft gaps vs. the benchmark tier (Linear/Stripe/Raycast) — not bugs
For the record, the brand reviewer's verdict: the rebuild clears the maturity bar and
out-crafts pioneer.ai/cohere-grade work, but does **not yet** out-craft the named benchmark.
Held back by: (a) the only "wow" (Calibration Sweep) is static on arrival while the feature-
row `.plate--rows` mockups are flat/inert — the `.ui` glass mockup component
(`kolm-2026.css:741-765`) exists but `index.html` doesn't use it; (b) dense, multi-clause
hero copy (`index.html:89`, platform hero) vs. terser benchmark heroes; (c) heavy reliance on
count-strings ("17 channels", "929 routes", "8 stages") as the repeated proof device.
These are craft/product decisions, not spec violations — parked here for a future polish pass.

---

## P0 — FIXED (applied to the working tree, recorded here for completeness)

1. **`public/account/overview.html` rebuilt onto the canonical system.** Removed the per-page
   `:root{--r-md/--r-lg}` override; swapped the light `var(--paper)` page background (the
   "paper skin" regression) to `var(--room)`; replaced the undefined `--shadow-lift` (×4 —
   was rendering as nothing) with `--plate`; replaced `--surface-1`→`--panel`,
   `--mono`→`--font-mono`, `--display`→`--font-sans`; replaced `rgba(0,0,0,.28)` black fill
   with `--well`; replaced raw `700`/`font:700` weights with `var(--w-display)`; replaced the
   off-ladder `#050608` with `--well`; moved the input focus to the global `--focus-ring`
   (`:focus-visible`); corrected the stale `--paper`/`--surface-1` doc comment; body class
   `app-shell`→`t-app`.
2. **Body-class template drift corrected (8 pages).** `dpa`, `sla`, `subprocessors`, `baa`,
   `acceptable-use` → `t-legal` (were bare, mis-templated `marketing` on legal docs);
   `404` → `t-marketing`; `account-billing` → `t-app`; `account/overview` → `t-app`.
3. **Footer column headings AA contrast** (`kolm-2026.css:818` `.foot__col h3,h4`):
   `--ink-4` (#62666D, ~3.3:1, large-only) → `--ink-3` (#8A8F98, ~5.5:1). Shipped on every
   page; the single most widespread a11y fix.
4. **`.tbl .no` AA contrast** (`kolm-2026.css:464`): `--ink-4`→`--ink-3` so "No"/"None" word
   cells clear AA normal-text on compare/pricing tables.
5. **Proof-strip numerals moved to mono** (`kolm-2026.css:790` `.proof__cell b`):
   `var(--font-sans)`→`var(--font-mono)`, honoring Law #3 ("every numeral is Geist Mono"). The
   `.is-mono` variant kept only its smaller size for long alphanumeric tokens (`Ed25519`).
6. **Deleted dead banned `public/kolm-main.css`** (`git rm`). The entire old "paper" design
   system (3847 lines, `compiler-site--paper*`, `image-2`, `--obsidian`) was still git-tracked
   in the web root though no page linked it.

### Triaged as NOT issues (verified clean by the reviewers)
- All six named wiring flows (pricing→/v1/plans + /signup?plan; signup→/v1/signup;
  docs→/docs/api; account/overview JS + demo payload; dashboard triple-redirect;
  api-control-center JS) resolve to real backend handlers / files with fail-open
  preview/redirect fallbacks. No broken fetch, mismatched route, or dead CTA.
- Plan slugs (`indie/pro/teams/business`) all match `PLAN_CATALOG` keys; `teams` is canonical.
- Main-site nav (`Product · Docs · Pricing`) and footer (`Compiler · Surfaces · Trust ·
  Company · Legal`, Legal last) are clean across ~30 pages with correct `aria-current`.
- `signup.html` `#00000040` inset-well shadows and the `.well` recipe are spec-sanctioned (§5),
  not banned black drop-shadows.
- Reduced-motion handling (CSS hero `.hero::after`, Calibration Sweep early-return + sealed
  end-state, `kolm-field.js` single static frame) is correct and fail-open.

### Counts
- **P0 (fixed): 6** fix groups (1 page rebuild, 8-page body-class sweep, 2 CSS contrast fixes,
  1 CSS mono fix, 1 dead-file deletion).
- **P1 (remaining): 5** (undefined `--sheet`/`--shadow-tint`; audit focus rings; docs/api hues;
  weight-system 3-vs-5 contradiction; hardcoded hex).
- **P2 (remaining): 7** (dead kill-list CSS; deprecated aliases; `.ui__step` contrast;
  placeholder labels; stale `outline:0`; audit-site kill-list fork incl. `trust.html` preloads;
  benchmark craft gaps).
