# Premium backdrop + graphics review — triage 2026-06-14

Adversarial Series-C review of the 2026 "premium backdrop + artisanal graphics"
overhaul (`public/kolm-2026.css` field/diagram layers, `public/*.html`). Findings
from four review passes (premium-judgment, consistency, perf-a11y, tokens-wiring)
triaged P0/P1/P2. P0 items were fixed directly; this file tracks the rest.

Overall verdict from the passes: **6.5/10** craft — genuinely above-average, hero
backdrop + SVG instrument kit are Series-C-grade, held back from 8+ by depth not
surviving the fold (P1.1), timid atmosphere tuning (P1.2), and a contrast/own-goal
trio (now partly fixed).

---

## P0 — FIXED in this pass (visible regression / breaks own laws)

These were applied directly to the working tree. Listed for the record.

### P0.1 — Broken SVG paint-server refs degraded `.pipe` nodes on 4 pages
`public/kolm-2026.css:1226,1228`. `.pipe .nd{fill:url(#ndFace)}` and
`.pipe .nd-art{fill:url(#ndArt)}` referenced `<defs>` that exist ONLY in
`index.html`. `docs.html`, `enterprise.html`, `security.html`, `platform.html`
render real `.nd`/`.nd-art` rects but ship **zero** `<defs>` (verified). With bare
`url(#id)` and no fallback, the paint server resolves to `none`:
- `.nd` plates collapsed to thin hollow outlines (fill -> transparent).
- `.nd-art` highlighted plates rendered **fully invisible** (fill unresolved +
  `stroke:none`).

**Fix applied:** added SVG2 fallback color to each paint —
`fill:url(#ndFace) var(--register)` and `fill:url(#ndArt) var(--paper)`. Where the
defs are present (index) the gradient still wins; where absent the plates now fill
with the correct flat material. The CSS header comment claiming "Falls back to flat
fills where defs are absent" is now actually true.

### P0.2 — Visible copy-paste: duplicate FAQ glyph on index
`public/index.html` FAQ. Two different questions ("Do I have to rewrite my SDK
calls?" and "Where do my secrets live?") shipped **byte-identical** "proxy" kglyph
SVGs. After championing "one glyph per concept," a repeated illustration is a
laziness tell a Series-C reviewer clocks.

**Fix applied:** the "Where do my secrets live?" card now carries a distinct
secrets/vault glyph (stripped input row -> padlocked vault with check + seal,
label "vault"). Drawn with the same `.reg/.dim/.flow/.ln/.fill/.ok/.seal/.t`
vocabulary so it stays on-system.

### P0.3 — `ramp-fit` keyframe animated `filter` (breaks GPU-only law)
`public/kolm-2026.css:1416`. The only keyframe in the file animating a
non-compositor property: `@keyframes ramp-fit{...filter:drop-shadow(...)}` on an
infinite 2.6s loop, forcing a per-frame filter repaint of the in-spec runtime rung.
Violates premium-overhaul §2/§5 and graphics-kit "GPU-only motion ... Never
`filter`."

**Fix applied:** swapped to a compositor-safe `opacity` pulse on the accent wash
(`.ramp .is-fit .bar`): `@keyframes ramp-fit{0%,100%{opacity:.16}50%{opacity:.34}}`,
composed alongside the existing `ramp-grow` transform. Base opacity matches the
keyframe endpoints (no jump). Still reduced-motion gated.

---

## P1 — High priority (real Series-C-bar failures; not applied)

### P1.1 — Backdrop is hero-only; the body is flat black (biggest issue)
Each flagship page has exactly **2** `.field` instances — `section.hero` and the
final `section.cta`. Everything between (proof strip, bento, every feature row,
FAQ) sits on flat `--room:#08090A` separated only by `border-top:1px solid
var(--line)` (`kolm-2026.css:229`). ~80% of the scroll is the exact "flat black +
hairline rules" the overhaul tries to escape; the atmosphere ships, vanishes for
the middle, then returns for the CTA glow (`:913`). Stripe/Linear sustain depth (or
deliberately reframe it) the whole way down. **This is the single change that would
move the score most.**
- *Direction:* introduce a quieter mid-scroll `.field` variant (or a sparse set of
  section-scoped blooms) on 2-3 interior bands per page, or reframe interior bands
  with a deliberate flat-by-design rhythm rather than accidental flat-black.

### P1.2 — Atmosphere tuned so faint it may not register as "memorable"
Token opacities (`kolm-2026.css:56-62`): `--field-pool-green:.14`,
`--field-pool-green-2:.09`, `--depth-cool:.10`, grain `.045`, and
`--room-atmos:#0A0D0E` is only ~2 luma points above the `#08090A` floor. On a
typical SDR laptop in a bright room this reads as "black," not "captured signal
field." Dynamic yes (it drifts), memorable no. Linear's aurora is subtle *and*
unmistakable; this errs fully toward subtle.
- *Direction:* nudge bloom opacities up ~30-50% and/or lift `--room-atmos` a few
  luma points; re-check against the AA contrast budget (body/caption/accent all
  currently pass comfortably even over the brightest bloom, so there is headroom).

### P1.3 — `trust.html` is the broken/under-built page (rebuild on canonical shell)
`public/trust.html` is a flagship marketing-equivalent surface (eyebrow +
`hero__h1` + lede + CTAs) but ships with **none** of the kit:
- No `.field` hero backdrop -> flat-black hero while every peer page is lit.
  Zero occurrences of `field` / `num-ghost` / `section--ink` in the whole file.
- Footer reimplements the tagline as an inline-styled
  `<p style="color:var(--ink-3);font-size:13px;max-width:34ch">` instead of the
  canonical `<p class="foot__tag">` / `.foot__copy` every other page uses.
- `<body class="evidence">` — every other marketing page is `t-marketing`;
  security uses `t-evidence`. Bare `evidence` breaks the `t-*` convention.

**Rebuild:** add `<span class="field" aria-hidden="true">` to the hero (and CTA if
present), swap the inline tagline for `<p class="foot__tag">`/`.foot__copy`, set
`<body class="t-evidence">`. One page, highest visible payoff.

### P1.4 — Diagram micro-labels use a token fenced against label text (contrast)
`--ink-4:#62666D` is commented "LARGE-TEXT-ONLY (>=24px) ... never body/labels"
(`kolm-2026.css:36`) yet fills `.pipe .tag` / `.icpt .tag` / `.cap-tag` at **8px**
and `.ramp .rs/.rt` at **8.5-9px** (`:1239,1373,1399,1401,1486`; also `.icpt .sub`,
`.kglyph .t`). On dark glass these sub-labels ("your api calls", "cost/1k · p50",
runtime sublines) are near-invisible at ~2.9-3.4:1 and violate the design system's
own rule.

NOTE — perf-a11y pass clarified this is **not a WCAG text-contrast failure**:
every one of these lives inside an `aria-hidden="true"` SVG whose data is restated
in the `<figure aria-label>`. So it is a *legibility/craft* defect, not an a11y
gate failure. Premium instruments with unreadable annotations read as decorative
mock, not real telemetry.
- *Direction:* introduce a dedicated micro-label token (e.g. lift to ~#7E828A /
  ~4.5:1) for these SVG sub-tags, keeping `--ink-4` reserved for its fenced
  large-text/non-text-mark use. Bumping P1.2's atmosphere also widens the margin.

### P1.5 — Spec'd D1-D4 diagrams never placed on the .com flagships
`docs/GRAPHICS-SPEC-2026.md` prescribes D1 for /platform + /docs, D2 for /security
(+ claims D2 "PLACED on /how-it-works already"), D4 for /pricing. Reality:
`class="diag"` appears on the .com side **only** in `trust-center.html` (audit
family). `platform.html`, `docs.html`, `security.html`, `pricing.html`,
`how-it-works.html` carry **zero** `.diag` figures. The shared D1-D4 vocabulary is
effectively unimplemented on the main site.
- *Decision needed:* either place the D1-D4 figures on those pages, or formally
  retire the D1-D4 spec. (how-it-works ships a high-quality *parallel* bespoke SVG
  system — `.cap`/`.anat`/`.pipe.ramp` — so the gap is "two graphic systems," not a
  lazy-rectangle defect.)

---

## P2 — Polish / craft / latent (not applied)

### P2.1 — Cross-page repetition dilutes the hero "signature"
how-it-works and enterprise heroes both drop the live SVG organ and reuse the same
static `.artifact is-sealed` datasheet (`how-it-works.html:115-135`,
`enterprise.html:113-129`) with near-identical REG-04/claims-redactor content. The
"wow" is real once; by the third page it's wallpaper. Give each page a distinct
organ (index has `.pipe`, platform has `.icpt`).

### P2.2 — Card glyphs exposed to AT duplicate adjacent visible text
`public/index.html` bento — each `.card__glyph` uses `role="img"
aria-label="Capture|Compile|Deploy"` sitting directly beside `<span
class="card__k">Reg · capture</span>` etc. A screen reader announces "Capture, Reg
capture, ...". The glyph is decorative ornamentation for a card that already names
itself. Make these `aria-hidden="true"` (the standalone `role="img"` pattern is
fine in isolation, just not when shadowing a visible label). Noise, not a hard
failure.

### P2.3 — Body theme-class naming mismatch (latent, no live visual impact)
`security.html:44` = `t-evidence`; `trust.html:45` = `evidence` (no prefix). None
of the `t-*`/`evidence` classes are referenced in `kolm-2026.css`, so there is **no
render impact today** — inert JS/legacy hooks. Standardize to `t-evidence`
(folded into the P1.3 trust rebuild).

### P2.4 — `--vl-void` is a literal duplicate, not an alias
`kolm-2026.css:1301` `--vl-void:#E0A89F` duplicates the canonical fail tone
`--void:#E0A89F` (`:1192`) by value instead of `var(--void)`. On-brand (sanctioned
fail color) but forks the value -> drift risk if `--void` ever changes. Prefer
`--vl-void:var(--void)`.

### P2.5 — Two undefined group-wrapper classes (cosmetic)
`cap-led` and `vl-verdict` are used in HTML but have no CSS rule. Both are pure
`<g transform=...>` positioning wrappers; all visual children are defined. Harmless
layout hooks — flagged only because "every class defined in CSS" was the bar.

### P2.6 — `stroke-dashoffset` animations are technically paint, not pure compositor
Six diagram animations (`pipe-pulse`, `icpt-flow`, `vl-seal`, `anat-scan`,
`cap-run`, `kg-flow`) animate `stroke-dashoffset`, which is a paint in real
browsers. The project explicitly sanctions it as "compositor-safe," so it is
in-spec by definition; each is reduced-motion-gated and `[data-art-reveal]`-scoped
and the "one signature moment per page" rule keeps the count low. Impact
negligible. Noting only that the spec's "compositor-safe" claim is technically
imprecise.

### P2.7 — WebGL audit field lacks `prefers-reduced-data` gating (out of scope)
`public/kolm-field.js` (loaded **only** on audit.kolm.ai surfaces, not any
main-site page) caps DPR<=1.5, pauses on IntersectionObserver/visibilitychange,
self-degrades, handles context-loss, honors `prefers-reduced-motion` — but does
**not** honor `prefers-reduced-data`, which premium-overhaul §2 lists as mandatory
("Honor `prefers-reduced-data`; skip canvas"). Outside this overhaul's scope
(deliberately-separate audit surface) but a live reduced-data gap there.

---

## Verified clean (from the passes — no action)
- No CLS: `.field{position:absolute;inset:0}` (zero intrinsic size); hero SVG has
  fixed viewBox; glyphs have aspect-ratio/fixed dims.
- Backdrop GPU-only + fully gated: `field-drift` animates only `transform`;
  reduced-motion / reduced-transparency / forced-colors / high-contrast /
  reduced-data fallbacks all present.
- No heavy assets: grain is inline `feTurbulence` data-URI; no PNG/WebP/font added.
- Contrast: body `--ink` 15.6:1, `--ink-2` 11.4:1, caption `--ink-3` 5.1:1, accent
  10.2:1 — all hold AA even over the brightest bloom.
- Palette fenced: `--depth-cool` used only in `.field::before`; green stays
  accent-only (~3% of pixels).
- Nav + footer shells byte-identical across the marketing cluster (only trust.html
  is a structural outlier — P1.3).
- All 42 `.plate` occurrences are legitimate data tables / populated tier cards; no
  empty placeholder where a graphic belongs; no empty `.card__art` slots.
- `[data-art-reveal]` (25 attrs) observed in `kolm-2026.js` with a fail-open
  contract (adds `.in` under reduced-motion or no IntersectionObserver). All guards
  intact.

---

## Counts
- **P0: 3** (all fixed: SVG paint-server fallbacks, duplicate FAQ glyph, ramp-fit
  filter animation)
- **P1: 5** (backdrop hero-only; atmosphere too faint; trust.html rebuild; micro-
  label contrast token; D1-D4 diagrams unplaced)
- **P2: 7** (hero repetition; card-glyph aria redundancy; theme-class naming;
  `--vl-void` literal dup; undefined wrapper classes; dashoffset paint note; audit
  WebGL reduced-data gap)
