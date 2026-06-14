# kolm.ai — Authoritative Aesthetic Benchmark 2026

> Status: canonical reference. Supersedes ad-hoc design notes for cross-site comparison.
> Inputs: 27 source-level teardowns (typography, color/material, composition/density, motion/signature) + four per-angle syntheses. Raw teardowns are on record.
> Scope: how the best-in-class dark-infra sites of 2026 are built, scored axis-by-axis, and the exact, prioritized work for kolm to clearly out-design **pioneer.ai** and **cohere.com**.
> Date: 2026-06-14. Owner: design.

---

## 0. How to read this

Every site is scored 1–10 on seven axes. The axes are deliberately orthogonal so a high "coherence" can't paper over a weak "type."

| Axis | What it measures |
|---|---|
| **Type** | Typeface choice, weight discipline, size-responsive tracking, mono/numeral system, OpenType locking, CLS-safe loading |
| **Color** | Palette as a *system* (ramps, `color-mix`/OKLCH), single rationed accent, off-black base, atmosphere-only chroma |
| **Composition** | Max-width + clamped reading measure, quantized vertical rhythm, density discipline, grid bones |
| **Material** | Surface elevation by luminance steps, translucent-FG hairlines, top-light bevel, colored (not black) glow shadows |
| **Motion** | Restraint, shared easing curves, reduced-motion safety, GPU-only |
| **Signature** | One owned, brand-thesis-bearing, unfakeable moment — rationed against stillness |
| **Coherence** | Does the whole read as one designed system? The hardest 10 to earn. |

A "9" is execution-grade craft. A "10" is reserved for systems that are also *unfakeable* (proprietary type, or coherence so total it has no seams).

---

## 1. AESTHETIC MATURITY MATRIX

Scores are drawn from the source-level teardowns. The "why" is the single load-bearing reason for the number.

| Site | Type | Color | Comp | Material | Motion | Signature | Coherence | Why (the one thing) |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| **Linear** | 9 | 8 | 8 | 9 | 7 | 9 | **10** | Custom 510/590 Inter weights + size-scaling negative tracking + edge-light depth (no drop-shadows). Coherence is total; the only knock is the 1024px / weight-300 *whisper*. |
| **Cohere** | **10** | 8 | 7 | 8 | 6 | 9 | 9 | Bespoke Pentagram/NaN superfamily where display + text + mono share monospace DNA, and the type concept (Voronoi cells ↔ machine precision) *is* the brand. Unfakeable. Composition/motion are merely calm, not exceptional. |
| **Vercel** | 9 | 8 | 8 | 8 | 7 | 8 | 9 | Geist system: 9 weights, named `heading-72…copy-13` scale, native tabular numerals. Dinged on material/color for true `#000` (smears on OLED, kills depth) — the lone black holdout. |
| **pioneer.ai** | 9 | 8 | 8 | **9** | 7 | 8 | 9 | The dual-inset bevel (`inset 0 0 0 1px /.08` ring + `inset 0 1px 0 /.16` top-light) over warm near-black `#0c0608` turns every dark div into machined glass. Two-axis tracking. Hurt by 11px-dominant micro-type (legibility/Series-C buyer mismatch). |
| **Stripe** | 9 | 9 | 9 | 9 | 8 | 9 | 10 | The live WebGL mesh gradient as the *single* indulgence against total stillness — Söhne + Söhne Mono, iris accent rationed. The reference standard for "win by subtraction." |
| **Raycast** | 9 | 9 | 8 | 9 | 7 | 9 | 9 | 4-layer embossed keyboard-key shadow + brand color reserved for identity (CTA is inverted light-on-dark). `saturate`-lifted glass. The restraint is the craft. |
| **Cursor** | 9 | 9 | 8 | 9 | 7 | 8 | 9 | `color-mix(in oklab, fg, N%)` borders + off-grid 450/550 weights + saturated glass. Color is a true *system*, not a palette. |
| **Supabase** | 8 | 8 | 8 | 8 | 6 | 7 | 8 | Disciplined `#121212→#1F1F1F→#242424` luminance ramp + green accent, dual-mode docs. Strong and consistent but few owned moments. |
| **Mintlify** | 8 | 8 | 9 | 9 | 7 | 8 | 9 | Masked dotted-grid hero that dissolves at the edges; `inset 0 0 0 1px` material; P3 color; air treated as the luxury signal. Wide shell, clamped 40–48rem measure. |
| **Railway** | 8 | 8 | 9 | 8 | 8 | 9 | 8 | Pixel-rule track lattice + `animate-train` — a signature that *means* "infra moving." Plex Serif is a brand-specific bet. 1696px shell with a clamped 544–620px measure. |
| **Resend** | 9 | 9 | 8 | 9 | 7 | 9 | 9 | Surfaces self-illuminate via emanating inner-glow (`#ffffff0b`); `#ffffff0d` hairlines; `saturate` glass. Domaine serif display is the counter-bet. |
| **Browserbase** | 8 | 8 | 8 | 8 | 6 | 7 | 8 | GT grotesk + translucent-FG hairlines, clean 1440px shell. Correct but quiet — few unfakeable moments. |
| **Modal** | 8 | 8 | 9 | 8 | 6 | 7 | 8 | Textbook wide-shell / 600–640px-measure discipline, translucent hairlines. Composition is the standout; signature is thin. |
| **Clerk** | 8 | 8 | 8 | 8 | 7 | 7 | 8 | Multi-stop radial atmospheres + tight `-0.015→-0.035em` tracking + top-sheen cards. Polished, slightly generic-premium. |
| **Anthropic** | 8 | 8 | 8 | 7 | 6 | 7 | 8 | Tiempos serif as a deliberate humanist counter-bet; warm paper tones. Brand-distinct but softer/less "engineered" than the infra cohort. |
| **kolm (now)** | **7** | **8** | **7** | **8** | 6 | **8** | **7** | Real system, not a theme: off-black `#08090A→#0F1011→#191A1B` ladder, translucent hairlines (`.07/.12/.14`), single phosphor accent `#3FE5A0`, `--line-top` specular + `--ring-inset` bevel, tabular-nums, and a genuinely top-tier two-world signed-artifact. Held back by a timid 590 display weight + Switzer's non-proprietary feel (type), decorative-device sprawl + unclamped prose measure (composition), and a *static* signature surrounded by a dozen lesser tricks (motion/coherence). |

### Reading the matrix
- **Nobody wins on features.** The 9s and 10s win by *subtraction and rhythm* (Linear, Vercel, Stripe).
- **Type is the cheapest separator.** Cohere's only 10 is type; it carries the brand alone. kolm's lowest axes (type, composition, coherence) are exactly where the median elite site is strongest.
- **Material is nearly solved across the board.** Translucent-FG hairlines + top-light bevel + luminance-step elevation is now table stakes; kolm already has the recipe (`--line-top`, `--ring-inset`) — it's at 8 because the bevel is occasional, not the default.
- **kolm's signature (8) is its highest non-color axis** and is the single biggest opportunity: the artifact out-concepts every competitor's owned moment, but it's a still life, not a moment.

---

## 2. BEST-IN-CLASS INFRA AESTHETIC 2026 — distilled principles

The consensus across 27 teardowns, stated as rules. These are the bar kolm must meet to score ≥9 on an axis.

### Typography
1. **Self-hosted variable grotesk + tabular mono companion that share metrics.** Geist (Vercel), Inter+features (Linear), or bespoke (Cohere, Cursor). Serifs are a brand-specific *risk*, not a default.
2. **Two-axis tracking is the expensive tell.** Negative tracking that *tightens as size grows* (Linear `-0.012→-0.022em`) **and** positive `+0.08→+0.1em` on uppercase mono eyebrows. You feel it before you read it.
3. **Off-grid weights.** Variable-only cuts (510/590, 450/525, 450/550) read as "emphasis without heaviness" and are unfakeable with static fonts. Marketing uses ~3 weights.
4. **Mono is load-bearing.** It carries all code, labels, and *every numeral* via `tabular-nums`. No metric, price, or hex escapes it.
5. **Lock OpenType features globally** (`cv01/ss03`-style) and ship **metric-matched fallbacks** (`size-adjust`/`ascent-override`) for zero CLS.

### Color
6. **One chromatic accent, rationed to ~95% of all chroma.** The most expensive move is *not* using it as the CTA — invert to light-on-dark and reserve the hue for identity/status (Raycast, Cohere, Vercel).
7. **Borders are translucent foreground, never grey hex.** `rgba(255,255,255,.05–.14)` or `color-mix(in oklab, fg, N%)` — light catching an edge.
8. **Off-black, never `#000`.** Tinted near-blacks (`#08090a`, `#0c0608`, `#091717`). Pure black smears on OLED and kills depth (Vercel is dinged for it).
9. **Color is a *system*, not a palette.** `color-mix`/OKLCH/HSL-mirrored ramps so the whole canvas shares one hue temperature.
10. **Chroma beyond the accent appears only as atmosphere** — radial/conic glows and masked dot-grids — never flat fills.

### Composition / density
11. **Wide outer shell, narrow reading measure.** Containers run 1024–1700px but **prose is always clamped to 540–640px** (Railway 544–620, Modal 600–640, Mintlify 40–48rem). The container grows; the measure does not.
12. **Vertical rhythm is large, tokenized, and non-uniform.** 64–96px floor; 2–3 alternating named values so breathing is *composed*, not constant.
13. **Density is low and selective.** Air is the luxury signal. Reserve density for exactly one "engineered" object (code panel / proof artifact); breathe everywhere else.
14. **4/8px base unit, mostly 1–2 centered columns,** with the hero as the one place composition gets bold (asymmetric split).

### Material
15. **Elevation = luminance stacking, not drop-shadow.** 3–5 surface steps each only ~3–6% lighter, plus a 1px top-edge highlight. Dark UI has no overhead light — you *fake the lamp*.
16. **The signature material recipe:** flat surface + 1px translucent ring + `0 1px 0 rgba(255,255,255,.12–.16)` top-light bevel **or** a `linear-gradient(180deg, rgba(255,255,255,.04), transparent)` top sheen. This single move turns "dark div" → "machined glass."
17. **Glass with saturation lift:** `backdrop-filter: blur(Xpx) saturate(1.1–1.8)` — richness no one notices but everyone feels.
18. **No black drop-shadows.** Use colored (accent-tinted) glow — emitted light.

### Motion / signature
19. **Restraint is the norm.** `.12–.2s` hover/focus, `.3–.6s` entrances; two shared curves (`cubic-bezier(.165,.84,.44,1)` easeOutQuart, `cubic-bezier(.4,0,.2,1)` Material). No bounce, no spring, no scroll-jacking. All gate on `prefers-reduced-motion`.
20. **Exactly ONE signature moment,** owned and rationed against total stillness. It must be **(a) brand-thesis-bearing** (the motion *means* something about the product), **(b) singular**, **(c) unfakeable** (tied to proprietary type, real material physics, or a genuine data moment), **(d) performant** (GPU-only, killed off-viewport, reduced-motion-safe).

### The meta-rule
**The premium tell is subtraction.** Every 9 and 10 in the matrix wins by *removing*, not adding. Type and tracking carry hierarchy; the accent does less work than weight.

---

## 3. WHERE KOLM SITS, AND HOW TO OUT-DESIGN PIONEER + COHERE

### 3.1 The honest position
kolm is **one tier below the 9s on execution, not on concept.** The infrastructure is real:

- **Color (8):** cool off-black ladder `#08090A → #0F1011 → #191A1B`, translucent-white hairlines `--line .07 / --line-2 .12 / --line-top .14`, a single rationed phosphor accent `#3FE5A0`, and an OKLCH accent already present (`oklch(83% 0.155 163)`). This is a *system*, not a theme.
- **Material (8):** the bevel exists — `--ring-inset: inset 0 1px 0 0 rgba(255,255,255,.06)` and `--line-top` specular — and the nav already ships `backdrop-filter: saturate(140%) blur(12px)`. The two-world paper artifact is genuinely top-tier.
- **Signature (8):** the `.rep` signed-artifact (milled-metal bar, laid-paper sheet, guilloche watermark, perforated tear into a crypto signature strip) *out-concepts every owned moment in the matrix.* It is literally the product — proof, witnessed.

### 3.2 What's holding each axis down (verified against live source)
- **Type (7):** `--weight-display: 590` is a *whisper* next to Linear's heavier cut and pioneer/Cohere's bold display. Switzer + Spline Sans Mono is correct instinct (variable, `-0.022em`, tabular-nums shipped) but lacks the proprietary feel of Geist/Inter+features, and **display + mono don't share a designer** the way Cohere/Cursor/Vercel do. Plus real drift: dead `CabinetGrotesk-Variable.woff2` preload in `index.html` (the face is already dropped in CSS) and unreferenced `Geist.woff2` / `GeistMono.woff2` preloads in `pricing.html`.
- **Composition (7):** the grid is on-spec (`--maxw:1200px`, `--gutter:24px`, `--section-y:clamp(80–128px)` with three named rhythms, asymmetric footer) — but **there is no clamped reading measure applied to prose** (only a latent `--maxw-prose:680px`, wider than the 540–640px every top site enforces, and not used as the body column), and decorative-device sprawl (dot-grid, stage-lights, WebGL field, guilloche, ruler ticks) competes with the air.
- **Motion (6) / Coherence (7):** the signature is a beautiful **still life, not a moment**, and it's diluted by a dozen lesser tricks. The accent is currently the CTA fill *and* the verdict color, so it can't mean "verified" exclusively.

### 3.3 To beat **pioneer.ai** specifically
pioneer wins on **material (9)** via the dual-inset bevel and on **type (9)** via two-axis tracking, but its Achilles' heel is **11px-dominant micro-type** (legibility, wrong for a Series-C buyer) and a generic Helvetica Neue display face.

**The play:** match its bevel, beat its type confidence and its body legibility.

### 3.4 To beat **cohere.com** specifically
Cohere wins almost entirely on **type (10)** and **signature (9)** — a bespoke superfamily whose concept *is* the brand. You will not out-type a Pentagram/NaN custom face. **Don't try.** Cohere is weaker on **composition (7)** and **motion (6)**.

**The play:** out-compose and out-*move* it. kolm's signature is a verb (the seal closing) where Cohere's is a texture (Voronoi cuts). A rationed, brand-thesis-bearing *motion* moment plus tighter composition discipline beats a static-superfamily competitor on the two axes it neglects — and the artifact concept is at least Cohere's equal on signature.

### 3.5 PRIORITIZED CHANGE LIST

Ordered by impact-per-effort. P0 items move the most axes for the least work.

**P0 — Adopt the Geist system + assert the display weight** *(Type 7→9; helps Coherence)*
- Swap to **self-hosted Geist Sans + Geist Mono** variable woff2. Same open/self-host license posture as Switzer, but display and code share a designer and metrics — you inherit Cohere/Cursor's "one system" feel for free. Native tabular numerals (the fintech/infra tell, no hacks).
- Push **display weight to 620–680** (you have a variable axis — stop whispering at 590). Keep UI at an off-grid **510**.
- Ship **metric-matched fallbacks** (`size-adjust`/`ascent-override`) for zero CLS.
- *Why first:* this single swap closes the largest gap to pioneer/Cohere and is the cheapest path off the lowest axis.

**P0 — Fix the font drift** *(Type; correctness)*
- Delete the dead `CabinetGrotesk-Variable.woff2` preload in `public/index.html`.
- Delete the unreferenced `Geist.woff2` / `GeistMono.woff2` preloads in `public/pricing.html` (they become *correct* once Geist lands — re-point them, don't just remove).
- Preload only the faces actually rendered above the fold.

**P0 — Clamp the prose measure** *(Composition 7→8; single highest-leverage spatial change)*
- Introduce `--measure: 38rem` (~608px) and apply it to **all body/lede/prose columns** inside the 1200px shell. Today `--maxw-prose` is 680px and is not the enforced body column — bring it to the 540–640px band every top site holds.
- Selectively widen the shell to **1280–1320px for bento/feature rows only**, keeping text clamped — the "expensive wide canvas" without hurting readability.

**P1 — Lock the tracking ladder** *(Type)*
- Make tracking size-responsive: hero `-0.035em`, h1 `-0.028em`, h2 `-0.02em`, body `-0.01em`, mono eyebrows uppercase `+0.08em`. Lock OpenType features + `tabular-nums` globally on every metric/price/hex.

**P1 — Promote the bevel to the default card recipe** *(Material 8→9; beats pioneer)*
- Make `0 1px 0 rgba(255,255,255,.14)` top-light + `linear-gradient(180deg, #ffffff0a, transparent)` top sheen the **default** `.card`/`.plate` recipe, not the occasional `--line-top`. This is the exact pioneer move; applied everywhere it equals or beats their material.
- Convert fixed-alpha white borders/secondary text to **`color-mix(in oklab, var(--ink), N%)`** (Cursor's move) for hue-coherence.
- Replace any black drop-shadows with **phosphor-tinted glow** (`#3FE5A033`) — emitted light, on-brand for compute. (Nav `saturate` is already done — leave it.)

**P1 — Make the signature a MOMENT** *(Motion 6→8/9, Signature 8→9, Coherence 7→9; beats Cohere)*
- The signature becomes **the act of verification**, fired once on scroll-into-view: a hairline scan-line sweeps the artifact → the perforated tear *cuts* (mask reveal) → the hex signature strip types in via mono → a single phosphor `--accent` checkmark settles. ~600ms, easeOutQuart, fired once, GPU-only, killed off-viewport. Reduced-motion shows the sealed end-state.
- This is **unfakeable** (it is literally the product) and **brand-thesis-bearing** (proof, witnessed). It out-moves Cohere on the axis it neglects.

**P2 — Win by subtraction** *(Composition 8→9, Coherence 7→9)*
- **Kill the device sprawl:** guilloche, crop marks, dither, ghost ordinals, ruler ticks, sparks, dual stage-lights, WebGL field as ambient decoration. Keep the artifact + the verify-seal moment. One paper-white lit object against the forensic dark room.
- **Buy density back as contrast:** concentrate *all* density into the `.rep` artifact and the footer — let the proof object be the only crowded thing. The two-world thesis, spatially enforced.
- **Quantize and exaggerate rhythm:** widen the three named rhythms (e.g. 80 / 112 / 144px) so section transitions read as deliberate breath.
- **One asymmetric hero split** (e.g. `1fr 1.2fr` copy/artifact) instead of stacked centered shaders — let composition carry the hero.

**P2 — The accent is the verdict, not the button** *(Coherence; beats Raycast/Cohere logic)*
- Make `--accent #3FE5A0` mean **"verified" exclusively.** Move the primary CTA to **inverted light-on-`#08090A`** (Raycast/Cohere/Vercel logic). The phosphor then reads as a *status*, which is the whole brand thesis.

### 3.6 Projected scores after the change list

| Axis | Now | After P0–P1 | After P0–P2 | Bar to beat |
|---|:--:|:--:|:--:|---|
| Type | 7 | 9 | 9 | pioneer 9 / Cohere 10 |
| Color | 8 | 8 | 9 | Cursor/Raycast 9 |
| Composition | 7 | 8 | **9** | Cohere 7 / pioneer 8 |
| Material | 8 | 9 | 9 | pioneer 9 |
| Motion | 6 | 8 | **9** | Cohere 6 / pioneer 7 |
| Signature | 8 | 9 | 9 | Cohere 9 / pioneer 8 |
| Coherence | 7 | 8 | **9** | both 9 |

**Net:** P0–P2 puts kolm at or above pioneer.ai on every axis, and above Cohere on composition, motion, and material while matching it on signature — without trying to out-type a bespoke Pentagram face. kolm wins where the artifact lives: **proof, witnessed, in a quiet room.**

---

## 4. One-line thesis
kolm's signature moment is *the seal closing* — evidence witnessed in real time, once, then still. Everything else subtracts toward it.
