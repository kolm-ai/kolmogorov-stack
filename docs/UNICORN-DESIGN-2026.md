# UNICORN-DESIGN-2026 - the kolm.ai design language (BINDING)

Status: BINDING for the 2026 unicorn rebrand wave. This document overrides taste.
A build agent implements exactly what is written here; where this file is silent,
the v2.2 instrument rules and v2.3 richness rules in docs/GRAPHICS-SPEC-2026.md
remain in force. All hard constraints from the wave directive apply verbatim
(ASCII punctuation, no "honest"/"honesty" in any form, dev@kolm.ai only, locked
pricing, locked scope line, evidence-locked strings, forbidden substrings,
preserved structural surfaces, hero <= 68px computed, no external requests, no
new font files, no theme toggles, kolm name + three-bar mark untouched).

---

## 1. IDENTITY THESIS

kolm is a forensic instrument, not a SaaS brochure. The site is a dark
examination room in which exactly one object is fully lit: the signed artifact.
Everything else exists to make that light legible - the chamber, the
instruments on its walls, the mono voice of the machine reading out hashes.
The unicorn evolution is NOT a new metaphor; it is the same room photographed
by a better cinematographer. Three upgrades carry the whole rebrand: (1) the
light becomes REAL - a hand-written generative light volume whose brightness is
literally quantized into discrete, checkable dots, the brand thesis rendered as
physics; (2) the geometry becomes EDITORIAL - asymmetric rails, ghosted
oversized ordinals, variable section rhythm, magazine pacing instead of
centered SaaS slabs; (3) the materials become EXPENSIVE - silver-struck ink,
laid paper, graphite glass, one phosphor accent spent like foil stamping.
Cohere bought a Voronoi motif and propagated it through everything; kolm's
equivalent motif is QUANTIZED LIGHT - dither dots, graticule ticks, perforation,
the three bars - one mathematical idea (continuous claims broken into discrete
verifiable units) propagated through the hero field, dividers, charts, seals
and chrome. Do not genericize. Do not brighten the room. Do not add a second
metaphor.

---

## 2. SIGNATURE VISUAL - THE EVIDENCE FIELD

THE one thing no other site has: the homepage hero light is a living volume of
phosphor fog rendered entirely through an 8x8 Bayer dither - continuous light
quantized into discrete dots, each dot either on or off, nothing in between.
It reads simultaneously as darkroom fog, print halftone and instrument
phosphor. The metaphor is exact: kolm takes a continuous claim ("we are
secure") and quantizes it into discrete checkable units. The light is made of
evidence grain.

### 2.1 Technique (exact)

- File: `public/kolm-field.js`, self-contained, zero dependencies, loaded with
  `defer` ONLY on pages that mount it. Target <= 150 LOC total (JS + inline
  GLSL strings). No three.js, no libs, no fetches.
- Raw WebGL1. Fullscreen triangle (positions `[-1,-1, 3,-1, -1,3]`), one
  program, `gl.drawArrays(gl.TRIANGLES, 0, 3)` per frame. Vertex shader is the
  3-line passthrough.
- Fragment shader pipeline (per fragment):
  1. `p = uv * vec2(aspect, 1.0) * 2.6` working space.
  2. Value-noise fbm, 4 octaves, per-octave `mat2(cos(.5),sin(.5),-sin(.5),cos(.5))`
     rotation, amplitude x0.5, frequency x2.0. Hash:
     `fract(sin(dot(p, vec2(12.9898, 78.233)) + u_seed) * 43758.5453123)`.
  3. Domain warp: `q = fbm(p + u_time*0.030); f = fbm(p + 1.6*q + u_time*0.018);`
  4. Brightness field `b`:
     `b = f * 0.62`
     `+ keylight: 0.30 * exp(-2.4 * length(uv - vec2(0.30, 0.18)))`  (top-left phosphor key)
     `+ counter:  0.14 * exp(-3.0 * length(uv - vec2(0.86, 0.10)))`  (top-right cool counter)
     `+ pointer:  0.12 * exp(-9.0 * length(uv - u_mouse))`           (fine pointers only)
     then `b *= smoothstep(1.05, 0.25, uv.y)` so the volume dies before the fold.
  5. Quantize: `cell = floor(gl_FragCoord.xy / u_px)` with `u_px = 3.0 * min(dpr, 1.5)`.
     Recursive Bayer: `Bayer2(a)=fract(a.x/2.+a.y*a.y*.75)` after `floor`,
     `Bayer4(a)=Bayer2(.5*a)*.25+Bayer2(a)`, `Bayer8(a)=Bayer4(.5*a)*.25+Bayer2(a)`.
     `on = step(Bayer8(cell), b)`.
  6. Color: `col = mix(u_room, mix(u_cool, u_phos, smoothstep(0.25, 0.85, b)), on)`.
     Output alpha-composited at max 0.34 over the page (`gl_FragColor.a = on * b * 0.34`,
     premultiplied; canvas context `{ alpha: true, antialias: false }`).
     The field is ATMOSPHERE. If a screenshot looks like a candy background,
     the intensity is wrong - the dots should be barely individually visible
     at arm's length and obvious when you lean in.

### 2.2 Palette inputs

Read at init from computed styles, passed as uniforms (never hardcode hex in JS):
- `u_room`  = `--paper` (the chamber base).
- `u_phos`  = `--accent` (phosphor green).
- `u_cool`  = `--cool` (new token, section 3 - the blue counterlight).
- `u_seed`  = `0.6315` literal constant. NEVER seed from evidence-locked strings.

### 2.3 Mount, density, masking

- Mount: `<div class="field" aria-hidden="true"><canvas></canvas></div>` as the
  FIRST child of `.hero` on the homepage only (other pages: section 8 says
  which two additional pages get it). Position absolute, inset 0, z-index -3
  (below `hero::after` color field at -2 and `hero::before` grid at -1 - the
  existing layers stay and become the no-JS fallback).
- CSS mask on `.field`: `mask-image: radial-gradient(120% 90% at 50% 0%, #000 40%, transparent 78%)`
  so the field is a ceiling volume, never a wallpaper.
- Dot pitch 3 CSS px. Drawing buffer at `min(devicePixelRatio, 1.5)`.

### 2.4 Motion + pointer

- Drift only: `u_time` advances at 1.0x wall clock; the warp speeds above make
  a full visual period ~45s. No loops, no pulses, no scroll coupling.
- Pointer: `u_mouse` lerps toward the cursor at 0.06/frame; gated on
  `matchMedia('(hover: hover) and (pointer: fine)')`. On touch, the pointer
  term is a constant `vec2(0.5, 0.3)`.
- Draw budget: <= 1.5 ms/frame on midrange hardware (4-octave fbm + warp is
  ~12 noise calls/fragment at capped DPR - well inside budget). If frame time
  exceeds 8 ms twice in a row, halve the drawing-buffer resolution once
  (CSS scales it back up; the content is dots, it survives).

### 2.5 Fallbacks (all mandatory)

- prefers-reduced-motion: render EXACTLY ONE frame with `u_time = 7.0`, never
  start rAF, listen for `change` to start/stop. The static dither field still
  reads as designed.
- No JS / WebGL null / context-lost: canvas stays `opacity: 0`. A `.ready`
  class (added after the first successful frame) fades it in over 600ms. The
  existing `hero::before` grid + `hero::after` radial light field ARE the
  fallback and must not be removed.
- Pause: IntersectionObserver stops rAF when the hero leaves the viewport;
  `visibilitychange` stops it in background tabs.
- The script must never throw past its own IIFE: whole init in try/catch.

### 2.6 Motif propagation (the Cohere lesson)

Quantized light appears OUTSIDE the hero as static CSS/SVG only:
- `.rule--ticks` (exists) is the divider voice everywhere a section break
  wants measurement.
- New `.dither-edge` (section 9): a 6px strip of CSS dot-gradient used on the
  top of `.cta-final` and the bottom of `.section--ink` - the light entering
  and leaving the chamber is quantized too.
- The `.sev__bar` graticule, the `.rep__sig` perforation, the three bars: all
  already speak it. No new ornament families.

---

## 3. PALETTE (token-exact)

Keep every var name. Values move as below. The soul stays: near-black
green-cool chamber, paper sheet, one phosphor accent. The evolution: a deeper
blue-cool counterweight, a visible two-hue lighting model, and accent
discipline pushed to foil-stamp scarcity.

### 3.1 Changed values in `:root`

```css
--paper: #090C0D;        /* was #080B0A - half a step toward blue-cool, per the
                            tinted-near-black finding; still reads green-black */
--paper-2: #0F1416;      /* was #0E1311 */
--paper-sink: #0C1011;   /* was #0B0F0D */
--ink-deep: #0D1213;     /* was #0C100E */
--ink-deep-2: #131A1B;   /* was #121714 */
--ink-deep-sink: #090C0D;
--ink: #EDF2EF;          /* a hair brighter for the silver ink to bite */
--ink-faint: #49524F;
```
Accent family: UNCHANGED hex (`#3FE5A0` et al). The verdicts already landed
on it; recognition lives here. What changes is BUDGET: accent may cover at
most ~3 percent of any viewport (chips, ticks, dots, the .go span, the .rep
filing edge, dg-flow paths). Never on backgrounds wider than 2px, never on
borders of non-verification chrome, never as a text block color.

### 3.2 New tokens (add to `:root`)

```css
/* the second light - cool counterlight, now a first-class token */
--cool: #6FA6E8;
--cool-soft: rgba(111, 166, 232, 0.10);
--cool-edge: rgba(111, 166, 232, 0.30);

/* metallic ink stops (the silver-struck headline gradient, tokenized) */
--ink-hot: #FFFFFF;
--ink-silver: #EAF0ED;
--ink-shadowed: #A4B2AB;

/* graphite - the dark-metal mid surface for instrument chrome on the sheet */
--graphite: #1A2123;
--graphite-2: #232B2D;

/* lighting model */
--light-top: rgba(238, 246, 242, 0.30);   /* top-edge specular, replaces ad-hoc values */
--shadow-tint: rgba(4, 8, 9, 0.55);       /* tinted drop shadow base */

/* rhythm tokens (section 5) */
--rhy-1: clamp(40px, 4.5vw, 64px);
--rhy-2: clamp(64px, 7.5vw, 104px);
--rhy-3: clamp(96px, 11vw, 160px);
```

### 3.3 Body atmosphere (replace the body background stack)

Two-hue lighting, slightly stronger than v2.3, blue gains parity below the fold:

```css
background:
  radial-gradient(900px 520px at 16% -8%, rgba(63, 229, 160, 0.11), transparent 62%),
  radial-gradient(1100px 640px at 88% -12%, rgba(111, 166, 232, 0.10), transparent 62%),
  radial-gradient(1400px 760px at 50% 118%, rgba(111, 166, 232, 0.05), transparent 64%),
  var(--paper);
```
The conic aurora (`body::before`) survives but recolors its second lobe to
`--cool` at 0.07. The grain sheet (`body::after`) is untouched.

### 3.4 P3 upgrade

At the end of the file, once:
```css
@supports (color: oklch(0% 0 0)) {
  :root { --accent: oklch(83% 0.155 163); --cool: oklch(72% 0.10 258); --paper: oklch(13% 0.01 200); }
}
```
(Visually identical on sRGB; deeper on P3. Do not oklch-ify anything else.)

---

## 4. TYPE SYSTEM

Faces are FROZEN: Cabinet Grotesk (display), Switzer (text), Spline Sans Mono
(machine). No new files, no new weights beyond the variable ranges already
shipped.

### 4.1 Scale (replace the fluid tokens)

```css
--fs-hero: clamp(40px, 4.6vw, 66px);   /* computed cap 66px - under the 68px gate */
--fs-h1:   clamp(34px, 4vw, 54px);
--fs-h2:   clamp(28px, 3vw, 42px);
--fs-h3:   clamp(17px, 1.4vw, 19px);
--fs-lede: clamp(16px, 1.4vw, 17.5px);
--fs-metric: clamp(30px, 3.2vw, 44px);
--fs-price:  clamp(26px, 2.6vw, 34px);
--fs-ghost: clamp(96px, 14vw, 200px);  /* NEW - the ghosted ordinal, section 5 */
```

### 4.2 Rules

- Hero h1: weight 650, letter-spacing -0.035em, line-height 1.02, max-width
  16ch. Presence comes from the field behind it and the silver ink on it,
  never from size.
- h2: weight 620, -0.028em, line-height 1.06.
- Tracking tightens with size, never loosens: anything >= 34px is <= -0.025em;
  body stays at +0.002em.
- Display NEVER appears below 17px. Mono NEVER appears above 15px except
  `.num-ghost` (which is display, not mono - see 5.4).
- MONO SPEAKS ONLY AS THE MACHINE: hashes, signatures, key IDs, control IDs,
  registers, eyebrows/idx tags, table heads, figure captions, scope line,
  prices' small print, microprint. If a human is talking, it is Switzer. If
  the machine is talking, it is Spline Sans Mono. No exceptions, no mono prose.
- Gradient ink (v2.3) stays binding and re-tokenizes:
  `h1, h2, .metric__n` gradient becomes
  `linear-gradient(180deg, var(--ink-hot) 0%, var(--ink-silver) 52%, var(--ink-shadowed) 100%)`.
  `.go` spans keep their own phosphor gradient + clip. New rule: gradient ink
  applies ONLY on dark surfaces; any heading inside `.rep__sheet`/`.vw` keeps
  flat `--sheet-ink` (already enforced; keep enforcing).
- Numerals: `font-variant-numeric: tabular-nums` on every metric, price,
  table and register (already mostly true; make it total).
- Lede stays Switzer 400; em-italic allowed once per page maximum.

---

## 5. LAYOUT GEOMETRY

The current site is competent and templated: centered `.section__head`, then a
symmetric grid, repeated. That dies. Pages become art-directed spreads.

### 5.1 First viewport (homepage pattern, adapted per group)

- `.hero__grid` goes asymmetric: `minmax(0, 1.08fr) minmax(0, 0.92fr)`, and the
  copy column gets `padding-right: clamp(0px, 3vw, 48px)`. The artifact column
  shifts down 28px (`margin-top: 28px` desktop only) so the two columns stop
  top-aligning - offset, not mirrored.
- The Evidence Field (section 2) occupies the hero ceiling. The grid +
  radial layers remain beneath it.
- `.hero__proof` stays verbatim in structure; restyle: the dots become 3px
  squares (quantized light, not bullets).

### 5.2 Rail + ghost ordinals (the editorial spine)

Every major section on marketing pages adopts the RAIL layout:
- `.sect-rail`: CSS grid `grid-template-columns: minmax(56px, 120px) minmax(0, 1fr)`
  (collapses to one column under 720px). Column 1 is the rail.
- In the rail: the existing `.idx` exhibit tag rotates to vertical
  (`writing-mode: vertical-rl`) and sits sticky (`position: sticky; top: 96px`)
  - the page reads like a filed dossier with edge tabs. The `.idx` CLASS and
  its text content do not change (gates count them); only presentation moves.
- `.num-ghost`: an oversized ordinal (01, 02...) in Cabinet Grotesk at
  `--fs-ghost`, weight 700, color `transparent`, `-webkit-text-stroke: 1px var(--line-2)`,
  positioned absolute behind the section head, `z-index: 0`, `aria-hidden="true"`,
  clipped by the section. One per 1-2 sections, never adjacent to the hero.
  This is the oversized-numeral moment; it is OUTLINE only, never filled,
  never accent-colored.

### 5.3 Rhythm (kill the uniform drum)

Section padding is no longer one clamp. Three densities via tokens:
- `.sect--dense` padding-block `--rhy-1` (tables, registers, FAQ).
- default `.section` padding-block `--rhy-2`.
- `.sect--air` padding-block `--rhy-3` (one per page max: the thesis moment,
  the artifact showcase, the closing band).
A page alternates: dense cluster, air, dense, air. If three consecutive
sections share a density, re-cut the page.

### 5.4 Full-bleed bands

- `.band--bleed`: a full-viewport-width slab (`width: 100vw; margin-inline: calc(50% - 50vw)`)
  whose inner content stays in `.wrap`. Used for: `.section--ink` (always
  full-bleed now), logo/microprint strips, and the crosswalk table band.
- Max content width stays `--maxw: 1148px`. Do not widen.

### 5.5 Hairline discipline

1px rules at `--line` carry all division. Borders never thicken to signal
importance; importance = light (top-edge highlight) + space. Tables and
registers keep the WIRED hairline voice.

---

## 6. MATERIALS + LIGHT

One lighting model, stated once, applied everywhere: a cold overhead lamp
slightly left of center, a faint blue counterlight from the right, no other
sources. Every surface treatment derives from it.

- CARDS / PLATES / STEPS / TIERS (graphite glass): keep the v2 recipe, retoken:
  background `linear-gradient(180deg, rgba(255,255,255,0.032), rgba(255,255,255,0.01))`;
  border `--line` with top `--line-top`; shadow becomes
  `inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 36px var(--shadow-tint)`;
  the centered top-light `::after` (v2.3) now uses `--light-top`. Hover lifts
  -2px with the pointer sheen (existing). NO backdrop-filter on cards (the
  page behind is near-black; blur buys nothing and costs paint).
- THE .rep ARTIFACT (engraved instrument): untouched anatomy (gate-asserted).
  Three refinements only: (1) the plinth (`.artifact::before`) widens to
  `inset -56px -64px` and gains a faint floor reflection - a second radial,
  `radial-gradient(50% 22% at 50% 102%, rgba(233,243,238,0.05), transparent 70%)`;
  (2) the sheet's laid-paper lines stay, plus a 0.04-opacity `--grain` overlay
  on `.rep__sheet` for tooth; (3) the title bar background becomes `--graphite`
  with a 1px `--light-top` top edge - dark metal, not gray glass.
- .section--ink (the raised proof chamber): full-bleed (5.4), overhead
  spotlight at 0.09 phosphor (v2.3 value), PLUS the new `.dither-edge` strip on
  its bottom border - quantized light leaking out. Cards inside keep their
  brighter fill (existing rule).
- .cta-final (the lit doorway): keep the doorway radial (0.13) + cool top
  light; add `.dither-edge` on its top border; the `.bars` mark above the h2
  gains the only permitted animation-on-load: the three bars draw up once,
  120ms staggered, spring-soft (reduced-motion: none).
- GRAIN: the body grain sheet is the only animated-feeling texture. Never add
  per-card grain except `.rep__sheet` (above). Never animate grain.
- METALLIC INK: silver-struck headlines (4.2). One additional licensed use:
  `.num-ghost` stroke. Nothing else gets foil.
- GLOWS: still banned. Light is positional (radials in the environment,
  top-edge speculars on chrome), never emissive (box-shadow color halos).

---

## 7. MOTION

Stack: CSS first, the existing IntersectionObserver reveal as spine, scroll-
driven `animation-timeline` as progressive enhancement. GSAP et al stay banned
(zero-dependency rule).

- TIMING TOKENS: add `--dur-1: 160ms; --dur-2: 320ms; --dur-3: 560ms;
  --ease-exp: cubic-bezier(0.23, 1, 0.32, 1);`. UI state changes use
  dur-1/dur-2 + ease-exp; reveals use dur-3; the springs (`--ease-spring*`)
  stay for the brand-mark breathe and seal press only.
- HERO ENTRANCE (homepage + the two field pages): h1, lede, CTAs, proof line
  enter once on load: `opacity 0 -> 1, translateY(14px) -> 0, filter blur(6px) -> 0`,
  640ms ease-exp, 70ms stagger, CSS-only via a `.js-reveal .hero [data-enter]`
  rule armed by the existing bootstrap. Reduced motion: everything visible
  immediately (inherits the W921 fail-open contract - never gate visibility on
  JS success).
- SCROLL: the existing `.reveal`/`js-reveal` mechanism is PRESERVED VERBATIM
  (gate). The `@supports (animation-timeline: view())` cardrise stays and
  extends to `.sect-rail .card` and `.num-ghost` (ghost ordinals drift
  translateY(24px) -> 0 over `entry 0% entry 80%` - quiet parallax). All under
  the existing supports + reduced-motion + .js-reveal triple gate.
- VIEW TRANSITIONS: the cross-document `@view-transition` + brand-mark morph
  stays. Add `::view-transition-old(root) / ::view-transition-new(root)` fades
  at 200ms/240ms ease-exp. Reduced motion: `navigation: none` (wrap the whole
  block in the existing no-preference media query - already true).
- MICRO: buttons keep the specular sweep (one pass per hover). Links keep
  underline-color transitions. `.dg-flow` dash drift and `.dg-dot` pulse stay
  the only looping motion outside the field. NOTHING ELSE LOOPS.
- BANNED: scroll-jacking, pinned sections, marquee logos, hover scale > 1.02,
  parallax on text columns, count-up on evidence-locked numbers (existing
  rule; `data-count` stays opt-in on safe metrics only).

---

## 8. PER-PAGE ART DIRECTION MAP (38 pages; homepage is the core agent's)

The Evidence Field mounts on: index at full intensity (0.34 default), verify
(0.20) and 404, AND - by user directive 2026-06-11, "it definitely stands out" -
every product/marketing page hero at sub-page intensity `data-intensity="0.18"`
(24 pages: pricing, report, how-it-works, trust, platform, security, enterprise,
docs, compare, research, contact, changelog, trust-center, checks, badge, spec,
regulatory-clock, roi, glossary, transparency-log, careers, both solutions
pages, security/threat-model). It stays OFF legal pages (privacy, terms, dpa,
baa, sla, acceptable-use, subprocessors), signup (entrance choreography is its
only flourish), status, dashboard and the report-viewer app surface - ops and
contract surfaces stay still. The index hero alone runs above 0.20; the field
must read as atmosphere on subpages, never wallpaper.
Every page keeps: exactly one `.eyebrow`, >= 1 `.section--ink` per major page,
`.cta-final` close, the locked strings where they already live.

### GROUP A - PROOF CORE (the mechanism pages)
Files: how-it-works.html, platform.html, checks.html, report.html,
report-viewer.html, spec.html
Direction: the dossier register. Rail layout (5.2) on every section; ghost
ordinals pace the lifecycle. how-it-works is the flagship spread: three
`.sect-rail` acts (Audit / Sign / Verify), each with its diagram (D1/D2/D3
from GRAPHICS-SPEC) inside a `.band--bleed` ink section. checks.html renders
the control table as the hero object (the table IS the design - Crusoe
pricing lesson): `.sect--dense`, hairline table, mono heads, severity used
semantically only. report.html and report-viewer.html stage the `.rep`/`.vw`
artifact on an `.sect--air` plinth with the floor reflection; the verify
widget states (seal, VOID tamper demo) untouched. spec.html is the machine
spec sheet: registers, `.report` wells, zero decoration beyond the rail.

### GROUP B - VERIFICATION INSTRUMENTS (live tools)
Files: verify.html, transparency-log.html, status.html, badge.html,
dashboard.html, signup.html
Direction: instrument panels, minimum prose. verify.html gets the Evidence
Field at HALF intensity (`gl_FragColor.a` cap 0.20) above the widget - the
one page where the brand physics and the product physics meet; widget mount
and states preserved exactly. transparency-log and status are dense ledgers:
`.sect--dense`, tabular-nums everywhere, live dots as the only accent.
badge.html shows the badge on a plinth like the rep. dashboard and signup are
chrome-light: one column, graphite cards, paper primary button, no ghosts, no
field; signup's only flourish is the entrance choreography.

### GROUP C - COMMERCIAL (the money pages)
Files: pricing.html, roi.html, compare.html, enterprise.html,
solutions/ai-vendors.html, solutions/enterprise-buyers.html
Direction: confidence through plainness. pricing.html: the tier grid keeps
locked values verbatim; `.tier--feat` keeps its accent wash as the page's
single accent moment; the scope line sits in `.scope` exactly as written.
roi and compare are editorial arguments: two-beat contrast headlines (Mercury
pattern: pain sentence, turn sentence), `.sect-rail` with ghost ordinals,
hairline comparison tables, no checkmark confetti. enterprise and the two
solutions pages are dossier covers for a persona: hero states the situation
in the persona's words, one ink band of proof, pricing rows, close. Solutions
pages may each carry ONE diagram (D3 for enterprise-buyers, D1 for
ai-vendors).

### GROUP D - TRUST + SECURITY (the scrutiny pages)
Files: trust.html, trust-center.html, security.html,
security/threat-model.html, regulatory-clock.html, sla.html
Direction: written for a hostile reader; the design must look like it expects
an auditor. Registers over cards: key IDs, rotation policy, disclosure terms
as `.register` rows with mono keys. threat-model gets the rail treatment with
ghost ordinals per threat class; severity colors appear ONLY in its tables.
regulatory-clock is the one editorial-timeline page: a vertical hairline
spine with dated nodes (D4 vocabulary, vertical). Mapping language only -
kolm MAPS to standards, never certifies; no certification iconography
anywhere in this group. sla is `.sect--dense` contractual plainness.

### GROUP E - COMPANY + KNOWLEDGE
Files: docs.html, research.html, glossary.html, changelog.html, careers.html,
contact.html, account-billing.html
Direction: the reading room - the quietest group. docs: two-column with a
sticky mono TOC rail (the rail layout repurposed for navigation), `.report`
code wells, no ghosts. research and changelog are hairline index lists
(date, mono tag, title) - volume as proof, magazine contents-page energy.
glossary: definition list with mono terms, dense rhythm. careers and contact:
single column, `.sect--air` thesis, paper CTA, dev@kolm.ai as the only
contact surface. account-billing matches dashboard chrome.

### GROUP F - LEGAL + UTILITY
Files: privacy.html, terms.html, dpa.html, baa.html, subprocessors.html,
acceptable-use.html, 404.html
Direction: legal pages are typeset, not designed: one column 64ch, Switzer
prose, mono section numbers, hairlines between articles, NO diagrams (binding
GRAPHICS-SPEC rule), no ghosts, no ink sections beyond the standard close.
subprocessors is a hairline table. 404 is the one permitted art piece: the
Evidence Field at full intensity over a near-empty page - eyebrow, "Exhibit
not found." h1 (with a `.go` span), one paper button home. The lost page is
the most atmospheric page; people screenshot 404s.

---

## 9. NEW CSS VOCABULARY (the complete additive class list)

Page agents may use these and ONLY these new classes (plus everything already
in kolm-2026.css):

- `.field` / `.field.ready` - Evidence Field mount + first-frame fade-in.
- `.sect-rail` - rail grid wrapper (5.2). Children: `.sect-rail__rail`,
  `.sect-rail__body`.
- `.num-ghost` - outlined oversized ordinal, aria-hidden, one per 1-2 sections.
- `.sect--dense` / `.sect--air` - rhythm modifiers on `.section` (5.3).
- `.band--bleed` - full-viewport slab wrapper (5.4).
- `.dither-edge` - 6px quantized-light strip:
  `background: radial-gradient(circle at 1.5px 1.5px, var(--accent-edge) 1px, transparent 1.5px) 0 0 / 7px 3px repeat-x;`
  top of `.cta-final`, bottom of `.section--ink`, max 2 per page.
- `[data-enter]` - hero entrance choreography opt-in (7).
- `.plinth` - the artifact stage: `.sect--air` + centered max-width 720px +
  floor reflection (6); wraps `.artifact` on report/badge pages.
- `.ledger-index` - hairline index list (research/changelog): rows of
  `date (mono) / tag (chip) / title (text)`.
- `.toc-rail` - docs sticky mono table of contents inside `.sect-rail__rail`.
- `.spine` - vertical timeline for regulatory-clock: hairline + node dots.
- `.register--keys` - register variant with copy affordance styling for key
  material (no JS copy needed; styling only).

Nothing else may be invented. If a page needs a treatment not listed, it uses
an existing class or the page agent escalates.

## 10. WHAT DIES (remove on sight)

1. Uniform section rhythm: the single `clamp(64px, 7.5vw, 104px)` drum.
   Replaced by the three-density system (5.3).
2. Centered `.section__head` as the default. Heads left-align inside
   `.sect-rail__body`; only `.cta-final` centers.
3. Symmetric `grid--3` card walls as the default argument shape. Cards are
   for genuinely parallel items (problem trio, steps); everything else
   becomes registers, tables, or rail spreads.
4. The green-tinted pointer sheen reading as candy: drop the phosphor stop in
   the pointer-tracked card light to `rgba(63,229,160,0.03)`; the white stop
   carries it. (Accent budget, 3.1.)
5. Pill-shaped anything that survived v2.2 (audit pass; stamps are 2-3px).
6. `.theme-toggle` dead code and the localStorage theme branch in kolm-2026.js
   (no theme toggles is a hard constraint; the toggle path is dead weight).
7. Decorative use of severity colors anywhere outside findings, tables, and
   the `.sev__bar`.
8. Stock iconography growth: no new icon families; the existing inline SVG
   set + dg-* vocabulary is the ceiling.
9. Any box-shadow with a chromatic color (glow). Tinted-dark shadows
   (`--shadow-tint`) only.
10. The hero dots in `.hero__proof` as round bullets (become 3px squares, 5.1).

## GATES SELF-CHECK (build agents run before shipping any page)

- hero h1 computed font-size <= 68px at 1920w (66px by token).
- Exactly one `.eyebrow` per page; >= 4 `.idx` on the homepage.
- `.hero__proof`, `.artifact > .rep > .rep__sheet`, `.sev__bar`, sig rows,
  `.plate--rows` with >= 4 `.prow`, `.cta-final`, one `.section--ink` per
  major page: present and classed exactly.
- `.reveal` / `js-reveal` mechanism untouched in kolm-2026.js.
- Verify widget mounts + seal/VOID states on /report and /verify.
- Evidence-locked string counts unchanged; forbidden substrings absent;
  scope line verbatim; pricing verbatim; ASCII punctuation only; no
  "honest"/"honesty"; dev@kolm.ai only; zero external requests; no new fonts.
