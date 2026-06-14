# kolm.ai — Premium Backdrop + Graphics Overhaul 2026

> Status: **BINDING for the backdrop/graphics layer.** Supersedes the "flat black / one-hue / no-grid" backdrop laws in prior art-direction notes for the *atmosphere layer only*. Type, palette semantics, and the forensic/datasheet soul from `docs/design/art-direction-2026.md` still rule everything else.
> Date: 2026-06-14. Owner: design.
> Grounding: main-loop screenshots of 8 premium sites (Stripe, Vercel, Railway, Resend, Linear, Cursor, Supabase) + forensic source teardowns of each backdrop (see §6 sources).

---

## 0. The problem, stated as ground truth

kolm today = near-flat `#08090A` + a too-faint green radial (`--accent-wash #3FE5A011`) that reads as **flat black**, plus repetitive rectangles. Next to the 8 reference sites it looks cheap. Every one of those sites shares three signals kolm is missing:

1. **The backdrop has real atmospheric depth** — color, falloff, layering. Never flat. Never a plain dot/line grid.
2. **Film grain / dither** over the dark field — the single highest-ROI "cheap → expensive" lever; it kills 8-bit banding on dark gradients.
3. **The hero centerpiece is a gorgeously-lit object or product UI** with real lighting (lit from below, contact shadow, one beam) — not a stack of rectangles.

What the screenshots actually showed, per site:
- **Stripe** — iconic flowing **multi-color gradient-mesh ribbon** (WebGL, noise-displaced plane, blend-mode layers). Signature, alive, memorable. Light bg.
- **Vercel** — colorful gradient + a **rendered 3D brand object** (the triangle) emerging from it.
- **Railway** — **dark night-sky / nebula** atmosphere: real texture, depth, a *sense of place*. Dark done right (blurred SVG blobs + low-alpha color washes + ellipse mask; no grain).
- **Resend** — near-black + a **rendered 3D floating-tiles object** + a soft diagonal **volumetric light beam** (baked raster floor + PNG beams + SVG grain). Premium minimal.
- **Linear** — near-black with **subtle depth** (4% white radial blooms, `lighten`/`overlay` blend, 64px-blurred SVG pill, 256px grain PNG) + the **real product UI** rendered as hero centerpiece.
- **Cursor** — warm painterly backdrop + product UI. **Supabase** — clean + green brand-color emphasis text.

**Binding ruling for this overhaul:** the backdrop MUST have real atmospheric depth + dynamic motion + a memorable signature. **`--accent #3FE5A0` stays THE accent** (verified / in-spec only; never a button fill; ~3% of pixels). A **fenced cool depth tone** — deep teal/indigo, very low saturation, e.g. `#0E1A22` or `rgba(60,120,140,low-α)` — is **ALLOWED in the backdrop atmosphere ONLY**. It must never touch text, buttons, badges, or become a second "verified"/semantic color. Add film grain everywhere. No lazy dot/line grid. GPU-only, reduced-motion-safe, accessible. Keep the forensic/instrument soul — premium, **not** a generic SaaS gradient.

---

## 1. The three strongest backdrop DIRECTIONS for kolm

Each is a complete, shippable atmosphere. All three use the same grain + depth recipe (§2) and the same fenced palette (§1.0). Ranked by fit to the forensic/instrument soul.

### Palette fence (applies to all three) {#1.0}
- **Room base:** lift off the floor — `--room-atmos: #0A0D0E` for the hero band (the `#08090A` floor stays the page default; the atmosphere sits *on top*, so the rest of the site is unchanged).
- **Accent atmosphere:** phosphor green `rgba(63,229,160, .10–.18)` blooms. This is the brand light.
- **Fenced cool depth tone (NEW, atmosphere-only):** `--depth-cool: rgba(60,120,140, .08–.12)` ≈ `#0E1A22` — a deep, desaturated teal/indigo. Its only job is to give the green a counter-tone so the field reads as *space*, not a single-color spotlight. **Never** on text/UI/semantics.
- **Grain:** monochrome, `opacity .04–.05`, `mix-blend-mode: overlay` (see §2).

---

### DIRECTION A — **"Captured Signal Field"** *(RECOMMENDED — most on-brand)*
A near-still **flow-field of phosphor signal-motes** drifting through a noise field, over a two-pool green+cool atmosphere, under grain. It literally renders kolm's thesis: *continuous behavior, captured.* The motes read as live telemetry being recorded — the instrument soul made visible, not a marketing gradient.

- **L1 (CSS, always on):** two off-center radial pools + vignette — `radial-gradient(60% 50% at 18% 12%, rgba(63,229,160,.10), transparent 70%)`, `radial-gradient(70% 60% at 88% 0%, var(--depth-cool), transparent 72%)`, `radial-gradient(120% 90% at 50% 120%, #08090A, #050606)`.
- **L2 (one `<canvas>`, the signature):** ~120 particles (60 on mobile) advected by cheap value-noise; phosphor-green, `globalCompositeOperation:'lighter'`, **trail-decay via translucent fill** (no `clearRect`), 1.4px rects, DPR≤2. ~0.4–0.8ms/frame. JS fail-open (L1+L3 render if JS dies).
- **L3:** grain (§2).
- **Why it wins:** it is the *only* direction whose motion *means something* (telemetry capture). Restraint-compatible (green ≈ 3% of pixels, barely-perceptible drift), GPU-cheap, degrades to a beautiful still under reduced-motion. Pairs with the lit `.kolm-art` / `.instrument` centerpiece on top.
- **Rationale vs references:** this is kolm's answer to **Railway's "sense of place"** and **Stripe's "alive but un-loopable,"** earned through the brand's own vocabulary rather than a borrowed liquid ribbon.

### DIRECTION B — **"Forensic Nebula"** *(safest, zero-JS, Railway-tier depth)*
Pure-CSS **dark night-sky atmosphere**: 2–3 large, off-center, partly off-screen blurred blooms (one green, one fenced-cool) that slowly drift, over a lifted base, under grain. This is Railway's recipe ported to the green palette.

- **Base `#0A0D0E`** (lifted off black — critical).
- **`::before`** = the blooms: `radial-gradient(40% 50% at 70% 25%, rgba(63,229,160,.14), transparent 60%)`, `radial-gradient(45% 55% at 20% 80%, var(--depth-cool), transparent 60%)`, `radial-gradient(60% 60% at 50% 50%, rgba(18,70,58,.25), transparent 70%)`; `filter:blur(40px)`; `animation:drift 38s ease-in-out infinite alternate` (transform-only).
- **`::after`** = grain (§2).
- **Why pick it:** zero JS, zero network, ~0 main-thread, ships in <1KB, degrades perfectly. The blooms held **off-center and partly off-screen** read as "a window into something larger," not a spotlight — the exact Railway/Stripe tell.
- **Rationale vs references:** **Railway "dark done right."** Use this if the canvas particle layer (A) is deemed too heavy to maintain or risks any jank on the LCP path.

### DIRECTION C — **"Lit Artifact + Volumetric Beam"** *(most product-forward, Resend/Linear-tier)*
Make the **hero centerpiece the star** and the backdrop its lighting rig. Keep depth modest; add **one warm-white + one green volumetric sliver beam** that grazes the lit `.kolm-art` artifact, so reflection + beam align and it reads as *real* lighting.

- **Depth `::before`:** `radial-gradient(120% 80% at 50% -10%, rgba(63,229,160,.10), transparent 60%)` + bottom fill toward `--room`.
- **Beams `.hero__beams`:** two thin (~2°) conic slivers — one `#EAFFF6` core, one `#3FE5A0` — `background-blend-mode:screen`, `filter:blur(40px)`, masked to fade top→bottom. **Additive on near-black** (`screen`, never `normal`).
- **Centerpiece lit from below:** accent halo behind + blurred contact-shadow ellipse beneath the artifact + a 1px green top-edge "scan line."
- **Grain** (§2) over all.
- **Rationale vs references:** **Resend's "Linear lamp" silhouette** + **Linear's product-UI-as-hero.** Use this on pages where a single artifact (the exploded `.kolm`, the attestation report) is the whole story.

**Recommendation:** ship **A** on the homepage hero (signature), **B** as the global section atmosphere (cheap, everywhere), **C** on artifact-centric pages (docs/attestation/compare). A and B share L1+L3; C reuses the same grain. One grain recipe, one fenced palette, three intensities.

---

## 2. The film-grain + depth recipe (use EVERYWHERE)

This is the universal layer. Every backdrop direction sits on top of it. **Grain's real job is anti-banding** on dark gradients — that's what makes them look expensive.

### Depth (the floor under everything)
Never one faint radial. Always: **(a) a lifted base** (`#0A0D0E`, not `#08090A`/`#000` in the atmosphere band), **(b) two off-center, unequal blooms** — one accent-green, one fenced-cool — for asymmetry = depth, **(c) a vignette** toward the floor. Asymmetry and the cool counter-tone are what separate "space" from "spotlight."

### Grain (the richness multiplier)
```css
/* attach to ::after of the atmosphere layer; pointer-events:none; decorative */
.grain::after{
  content:""; position:absolute; inset:0; z-index:-1; pointer-events:none;
  opacity:.045;                       /* 0.03–0.05 ONLY; >0.07 reads as a dirty screen */
  mix-blend-mode:overlay;             /* rides ON the gradient; soft-light is gentler on near-black */
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```
**Knobs that matter:**
- `baseFrequency .9` = fine 35mm grain. Lower (0.3–0.5) = chunky/cheap; higher = static.
- `feColorMatrix saturate 0` = monochrome → never tints the green.
- **`opacity` is the whole game:** 0.04 ± 0.01.
- **Crispness (the #1 mistake):** generate noise at device pixels (`inset:0`, no `background-size` upscaling). **For production, bake the SVG once to a 256px PNG/WebP tile** (`background-repeat:repeat`) — older Safari rasterizes `feTurbulence` at 1× then upscales on HiDPI, softening it; the PNG is pixel-exact at every DPR and essentially free (pure GPU compositing).
- **Never animate the grain** (per-frame regen = CPU sink + gimmicky).

### Performance contract (all layers)
- **Animate `transform`/`opacity` ONLY.** Never animate `background-position`, blob coords, `filter`, or `backdrop-filter` (per-frame repaint → tanks <30fps).
- Keep all atmosphere on `::before`/`::after`/dedicated layers at `z-index:-1/-2` + `isolation:isolate` on the hero, so hero text **never** repaints.
- Cap blooms at `inset:-20%` overscan (fill-rate-bound; don't paint far offscreen). Keep blurred element count ≤ 1–2.
- `will-change:transform` only on the one animated layer.
- Canvas (Dir A): cap DPR≤2, halve N on mobile, no `shadowBlur`, pause via `visibilitychange` + `IntersectionObserver` when hero scrolls out.
- Target: **60fps, <2ms/frame** on integrated GPUs. Hero artifact `<img width height>` + `fetchpriority="high"` → zero CLS, no LCP regression.

### Accessibility (mandatory)
```css
@media (prefers-reduced-motion:reduce){ .field::before,.nebula::before,.hero__beams{animation:none} }
@media (prefers-reduced-transparency:reduce),(forced-colors:active){ .grain::after{display:none} }
@media (prefers-contrast:more){ .hero__beams{opacity:.25} /* dim glows, drop grain */ }
```
- All atmosphere is **decorative** → CSS backgrounds / `aria-hidden="true"` / `pointer-events:none`. Never an `<img>`, no ARIA needed for CSS layers.
- Reduced-motion users keep the **still** L1+L3 (depth without motion stays beautiful).
- **Verify hero/body text ≥ WCAG AA 4.5:1 against the *brightest* point of the field** (not the base) and against the *darkest* point for light-on-dark — grain/glow must not drop foreground contrast. Never place readable copy inside a bright beam shaft.
- Honor `prefers-reduced-data` (skip canvas; serve L1+L3).

---

## 3. Artisanal-graphics principles (every diagram & card to Linear/Stripe quality)

The backdrop is 80% of the premium signal; the other 20% is that **every diagram, card, and chart is *crafted*, not defaulted.** The rule: a graphic is finished when it looks *machined*, like a panel on an instrument — not when it merely renders. Keep + extend the existing good organs: the glass **`.instrument`/`.pipe`** pipeline and the ASCII exploded **`.kolm-art`**; the **`.field`** is the backdrop layer we are upgrading.

1. **Light has one source, consistently.** Top-light bevel is the default plate (already law). Every card/diagram is lit from the same direction; contact shadows fall the same way. Mixed light directions are the #1 amateur tell.
2. **Depth is layered, never flat.** Three z-planes minimum per composition: atmosphere (back) → surface/plate (mid) → data/label (front). Each plane gets its own subtle shadow/edge. No element floats with no relationship to the light.
3. **Edges are engineered.** 1px hairlines use the `--line` token ramp (top-light highlight + bottom shadow = bevel), never a flat `1px solid #333`. Radii are consistent (`--r-*` scale). Corners get registration marks on the signature artifact (forensic-editorial organ).
4. **Grain & glow on graphics too.** A card sitting on a grained field but itself perfectly flat looks pasted-on. Let the field grain show through translucent plates; give the one signature artifact a faint accent halo + contact shadow so it *occupies space*.
5. **Data is the protagonist.** Every numeral mono + `tabular-nums`; every control-ID, unit, hex, price in mono. Charts label their own axes as if on a datasheet (`REG-04 · TOL ±0.2 · v3.3`). Green appears **only** on verified/in-spec data — never as decoration.
6. **Motion is barely-perceptible and meaningful.** Headline blur→sharp focus-pull reveal (Linear). Mono labels may use the `background-clip:text` shine loop, sparingly. The signature is **one** moment per page, not a screensaver.
7. **Restraint is the craft.** 90% monochrome; the green is instrument-glow, not neon; the cool depth tone is atmosphere-only. Subtraction wins — one signature object, big confident type (Display 640), generous silence.
8. **Pixel-exact rendering.** Prefer baked WebP for any 3D/complex object (Resend/Vercel ship rasters, not runtime 3D): baked lighting, transparent alpha, `width`/`height` set, ~40–120KB, zero jank. CSS-3D only for simple tile-stacks.

**The test for any graphic:** would it look at home as a labeled panel on a precision instrument? If it looks like a default Tailwind card or a generic SaaS gradient, it fails.

---

## 4. Per-moment graphic plan

| Moment / surface | Backdrop direction | Centerpiece | Notes |
|---|---|---|---|
| **Homepage hero** | **A — Captured Signal Field** (canvas motes + green/cool pools + grain) | Lit `.instrument`/`.pipe` glass pipeline (KEEP/extend) with green top scan-line + contact shadow | The signature moment. Drift barely perceptible; green ≈3% pixels. Reduced-motion → still field. |
| **"What is a .kolm" section** | **C — Lit Artifact + Beam** | ASCII exploded `.kolm-art` (KEEP), lit from below, one white + one green sliver beam grazing it, accent halo + contact ellipse | Beams `screen`-blended, additive. Registration marks at corners. |
| **Global section bands** (features, how-it-works, pricing) | **B — Forensic Nebula** at low intensity (one drifting green bloom + grain) | Datasheet register cards (existing `.card`/`.plate`/`.step`) | Cheap, everywhere. Grain shows through translucent plates so cards aren't pasted-on. Alternate `--well` bands stay. |
| **Docs / attestation report / compare** | **C — Lit Artifact + Beam** | The attestation report / signed receipt / `.report` rendered as the lit hero object (Linear "product-UI-as-hero") | One artifact = the whole story. Below-light + 1px green scan line + contact shadow. |
| **Pricing tiers** | **B** (very low, static blooms) | Tier plates with mono `tabular-nums` prices, green only on the in-spec/recommended tier | Restraint; green = verified, not decoration. |
| **Nav / HUD / `.ui`** | (no field) — keep rationed real glass (`backdrop-filter`) | — | Glass stays rationed to nav/HUD/`.ui` only (existing law). Grain does NOT go on glass chrome. |
| **Footer / legal / `.well` consoles** | base floor `#08090A`, no atmosphere | — | Atmosphere is a hero/section affordance, not page-wide wallpaper. Keep the calm floor where content is dense. |
| **Reduced-motion / reduced-data / forced-colors** | L1 depth + (grain off under reduced-transparency) | static centerpiece | Everything degrades to a still, beautiful, accessible state. No motion, no canvas, full contrast. |

**Files to touch (implementation):**
- `public/kolm-2026.css` — replace the line ~273 `.field` radial with the L1 depth pools (§2) + add the `::after` grain layer + the Dir-B `.nebula` and Dir-C `.hero__beams` classes; reuse existing tokens `--room`, `--accent`, `--accent-glow`, `--accent-wash`, `--well`; add `--room-atmos` and `--depth-cool` (fenced).
- `public/index.html` — ~30-line inline `aria-hidden` canvas script for Dir-A motes in the hero (fail-open).
- Optionally bake one 256px grain WebP tile for Safari pixel-exactness (§2).

---

## 5. What is explicitly REJECTED (so the soul survives)

- No lazy dot/line grid (the old `.field` repetition).
- No flat `#000` / flat `#08090A` in any hero or featured-section atmosphere.
- No second semantic color: the fenced cool tone is **atmosphere-only**, never text/buttons/badges, never a second "verified."
- No green button fills, no neon, no decorative accent fills — green stays ~3% of pixels and means *verified/in-spec*.
- No frosted-everywhere glass (rationed to nav/HUD/`.ui`).
- No grain above 0.07, no animated grain, no upscaled grain tile.
- No animating `filter`/`backdrop-filter`/`background-position`; no per-frame repaint of hero text.
- No borrowed Stripe liquid ribbon as-is — the signature must speak kolm's telemetry vocabulary, not a generic SaaS gradient.

---

## 6. Sources (forensic teardowns)
Stripe (minigl WebGL noise-mesh + GLSL blend modes); Railway (`globals.css` blurred SVG blobs + low-alpha washes + ellipse mask, no grain); Resend (baked `bg-hero-1.jpg` floor + `bg-light.png` beams + SVG grain); Linear (4% white radial blooms, `lighten`/`overlay`, 64px-blurred SVG pill, 256px grain PNG, blur→sharp reveal); plus the recipe teardowns: gradient-mesh, film-grain-noise, dark-nebula-aurora, volumetric-light, signature-3d-object, generative-field. Referenced techniques: CSS-Tricks "Grainy Gradients," Kevin Hufnagl Stripe teardown, Alex Harri WebGL gradients, Aceternity lamp/beams.

---

## 12-LINE SUMMARY
1. Problem: kolm's near-flat `#08090A` + faint green radial + repeated rectangles reads cheap next to 8 premium sites.
2. The premium signals all 8 share: backdrop depth/atmosphere/color, film grain over dark, and a gorgeously-lit centerpiece — never flat, never a dot grid.
3. Binding ruling: backdrop now MUST have depth + motion + a memorable signature; `#3FE5A0` stays THE accent (verified-only, ~3% of pixels).
4. A fenced cool depth tone (`~#0E1A22 / rgba(60,120,140,low-α)`) is allowed in BACKDROP ATMOSPHERE ONLY — never text, buttons, or a second semantic.
5. Direction A "Captured Signal Field" (RECOMMENDED): canvas phosphor flow-field motes + green/cool pools + grain — motion that *means* telemetry capture; reduced-motion → still.
6. Direction B "Forensic Nebula": pure-CSS Railway-tier blurred off-center blooms (green + cool) drifting under grain — zero JS, ships everywhere.
7. Direction C "Lit Artifact + Beam": Resend/Linear — modest depth + one white + one green volumetric sliver beam grazing the lit artifact centerpiece.
8. Universal recipe: lifted base `#0A0D0E` + two off-center unequal blooms + vignette, then SVG `feTurbulence` grain at `opacity .04`, `mix-blend-mode:overlay`, monochrome — baked to a 256px PNG for Safari crispness.
9. Grain's true job is anti-banding on dark gradients; opacity 0.03–0.05 is the whole "cheap→expensive" lever; never animate or upscale it.
10. Perf: animate transform/opacity only, atmosphere on `::before/::after` at `z-index:-1/-2`, cap DPR≤2, pause canvas off-screen; 60fps <2ms/frame, zero CLS.
11. Artisanal graphics: one light source, three z-planes, engineered bevel edges, registration marks, mono `tabular-nums` data, green only on verified, ONE signature moment, baked WebP for 3D.
12. Plan: Dir A on homepage hero (KEEP/extend `.instrument`+`.kolm-art`), Dir B on section bands, Dir C on artifact pages; touch `kolm-2026.css` (replace ~line 273 `.field`) + a ~30-line inline canvas script in `index.html`; full reduced-motion/contrast/forced-colors fallbacks.
