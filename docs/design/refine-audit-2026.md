# Refine Audit 2026 — Fix Brief

**Date:** 2026-06-13 · **Scope:** kolm.ai marketing surface (`public/`) · **Goal:** close the gap between the current "sparse / faint / static-with-a-grid" homepage and a Series-C dark-forensic infra site (Linear / Vercel / Stripe / Cursor bar).

This is a prioritized, file-referenced synthesis of seven internal audits (grid-background, contrast-wcag, nav-ia, cta-clarity, datasheet-readability, dynamic-graphics-gap) plus four competitor teardowns. Each item lists **file:line**, the **problem**, the **fix**, and where relevant a **target contrast ratio (WCAG 2.1 AA: 4.5:1 normal text, 3:1 large/non-text)**.

> Ground-truth note: line numbers below were verified against the live tree on 2026-06-13 and are accurate to within ±2 lines. The same `.artifact` register markup is mirrored on `platform.html` and `pricing.html`; CSS fixes cover all three, but the per-file HTML `<b>`-wrapper fix (P0-3) must be applied to each.

---

## P0 — MUST-FIX FOR SERIES-C
These are the findings that read as "broken" or "unfinished" to a technical buyer: invisible data, vanishing CTAs, failing label contrast, the literal grid, and a 3-link nav. Ship all of P0 before any diligence demo.

### P0-1 — Kill the hero dot/line grid (the primary visual offender)
- **File:** `public/kolm-2026.css:569-577` (`.hero::after`).
- **Problem:** `.hero::after` stacks a 1.3px **dot grid** (L572), a horizontal **line grid** (L573), a vertical **line grid** (L574), tiled at **32px** (L575). This is the "grid background" the owner wants gone; the art-direction kill-list already bans dot-grids.
- **Fix:** Delete L572-575 entirely. Keep only the glow layer (L571) *for now*, but it gets replaced in P1-1. Rewrite the L567-568 comment ("masked dot/line grid") to describe the new field. Delete the dead token `--line-micro:rgba(255,255,255,.04)` at **L42** (grep confirms zero consumers).

### P0-2 — Stop the CTAs from vanishing (3 separate disappearance bugs)
The single most damaging cluster: the primary conversion controls are invisible exactly where users land.
- **a) Nav CTA ghosts over the hero.** `public/kolm-2026.css:542` `.nav__cta:not(.is-solid){background:transparent}` + the JS toggle (`kolm-2026.js` removes `is-solid` while hero is in view) means "Get an API key" is a transparent outline at top-of-page. **Fix:** nav CTA must ALWAYS be solid (`--cta-fill`). Drop the `is-solid` scroll-swap; never gate the primary on scroll state.
- **b) Hero CTA entrance trap.** `index.html` wraps the hero CTA in `data-enter`; `kolm-2026.css` `heroEnter` keyframe uses `from{opacity:0}` with `backwards` fill — if the IntersectionObserver/entrance stalls, the primary + ghost are held at `opacity:0`. **Fix:** never gate a *primary CTA's visibility* on an entrance animation. Remove `opacity` from `heroEnter` and the `backwards` fill for `.hero__cta`; animate `transform`/translate only, `opacity:1` at rest. Must be visible with JS off.
- **c) Ghost reads as invisible outline.** `public/kolm-2026.css:586` `.hero__cta .btn--ghost` = `--ink-2` text + `--line-2` (.12 alpha) border on `background:transparent`; the base `.btn--ghost` (~L297) is `rgba(255,255,255,.02)` fill. The .12 border fails the **3:1 non-text** bar. **Fix:** `background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.22); color:var(--ink)`; hover `.08` / `--line-top`. One solid primary + one clearly-bordered ghost, both visible at rest.

### P0-3 — Empty SIGNATURE row + failing datasheet labels
- **a) SIGNATURE renders blank.** `public/index.html:114` — the SIGNATURE value `sha256:a1f0…` has **no `<b>` wrapper** (rows 111-113 do), so it inherits `--sheet-ink-2` (6.9:1) as faint break-all mono and reads as absent; it is also subject to the `register__v{opacity:0}` default (`kolm-2026.css:627`) which only the JS un-seal race lifts. **Fix (markup, per file — index/platform/pricing):** `<dd class="register__v" data-val><b>sha256</b>:a1f0&hellip;</dd>`.
- **b) opacity-0 default is the real bug.** `public/kolm-2026.css:627` defaults values to `opacity:0`; a datasheet value must never default to invisible. **Fix:** make resting `opacity:1`, and scope the fade strictly to the one animating, motion-allowed case:
  ```css
  .artifact .register__v{color:var(--sheet-ink);opacity:1;}
  @media(prefers-reduced-motion:no-preference){
    [data-sweep] .artifact:not(.is-sealed) .register__v[data-val]{opacity:0;transition:opacity .12s;}
  }
  ```
- **c) Labels fail AA.** `public/kolm-2026.css:114` `--sheet-ink-3:#6B746E` on `--paper #F4F2EC` ≈ **3.6-4.31:1 → FAILS 4.5:1** (the "near-invisible LATENCY/ARTIFACT/TARGETS"). **Fix:** `--sheet-ink-3:#5A615C` (target **≈5.0:1**) or `#545B56` (≈5.4:1). Also bump `--sheet-ink-2` toward `#3C443E` so any non-`<b>` value clears 7:1.
- **d) Verdict label.** `public/kolm-2026.css:629` `.artifact__verdict span{color:var(--ink-4)}` = `#62666D` on paper → fails badly; only `.is-sealed` lifts it. **Fix:** base `color:var(--sheet-ink-2)`; sealed → `--sheet-accent`. Bump `--sheet-accent:#0B7A4C → #0A6E45` (L116) so "In spec" clears **5.4:1**.

### P0-4 — The nav is only 3 links (reads empty; hides the whole product)
- **Files:** `public/index.html:65-66` ff. (nav markup, only `Product / Docs / Pricing`); `public/kolm-2026.css:530-535`.
- **Problem:** The nav surfaces ~0% of the IA the footer already exposes (~28 destinations). "Product" (`index.html:66`) dead-ends at the `/#pipeline` scroll anchor while `/platform`, `/compare`, `/integrations`, `/runtimes`, `/capabilities`, `/spec` exist as real pages with no nav entry.
- **Fix — promote the footer IA into grouped menus:**
  - **Platform ▾** (mega-menu, replaces dead `/#pipeline`): Capture/Compile/Compose/Deploy (`/docs#…`) · Overview `/platform` · How it works `/how-it-works` · Runtime targets `/runtimes` · Integrations `/integrations` · Spec `/spec`.
  - **Developers ▾**: Docs `/docs` · API control `/account/api-control-center` · Verify `/verify` · Changelog `/changelog`.
  - **Pricing** `/pricing` (flat) · **Trust** `/trust` (flat, high-signal for infra buyers).
  - **Status** as `● Operational` (dot `--accent` + word), replacing the bare lonely icon (`nav__icon`, L544).
  - **Sign in** `/account/overview` (ghost) · **Get an API key** `/signup` (always solid — see P0-2a).

### P0-5 — Nav links sit at the legibility floor
- **File:** `public/kolm-2026.css:532` `.nav__links a{color:var(--ink-3)}` (`#8A8F98`, the file's annotated "floor for legible").
- **Problem:** Resting nav at the floor on the glass bar is why it reads faint/sparse (5.86:1 — passes but thin).
- **Fix:** rest state `--ink-2` (`#D0D6E0`, 13:1); reserve `--ink` for hover/`aria-current`. One-line change, high perceived-quality lift.

---

## P1 — HIGH PRIORITY (depth, motion, the "alive" signal)
P0 makes the site correct; P1 makes it read Series-C.

### P1-1 — Replace both bleeding glows with one controllable "Phosphor Field" canvas
- **Files:** delete/retighten `public/kolm-2026.css:145-146` (body fixed-wash) and `:569-571` (hero glow); wire the unused `.field` hook (~L896-898) in `kolm-2026.js`.
- **Problem (the "sections blend / monotone / top-edge bleed"):** body L145 paints a `background-attachment:fixed` glow **320px above** the viewport that bleeds across every section seam; the hero glow (L571, origin `at 50% -4%`) sits **above** the box and washes off the top edge into the nav. Same `--accent-wash` layered twice = doubled bleed at the fold.
- **Fix:** a single masked `<canvas class="field">` — a slow aurora/plasma drift (2-3 low-frequency radial blobs in `--accent` at 4-8% alpha, 40-60s `requestAnimationFrame` loop), composited over `--room`, `pointer-events:none`, capped to the hero viewport. Render at 0.5× DPR to an offscreen buffer, blur once. Couple brightness to the existing `--mx/--my` pointer vars (L263) so the lit `.paper` sheet looks like it emits the glow. **Reduced-motion:** JS already reads `matchMedia('(prefers-reduced-motion: reduce)')` — paint one static frame and stop the RAF loop. This removes the double-bleed by consolidating to one layer.

### P1-2 — Make the signature sweep actually fire (it ships pre-sealed/dead on first paint)
- **Files:** `public/index.html:103` (`class="artifact is-sealed"`), `kolm-2026.css:614` (`artifact__scan`), `:631` (check dashoffset), JS un-seal (`index.html` inline ~L423-436).
- **Problem:** ships `is-sealed` (good fail-open) but the scan-line + register-fill described in the spec are dead on load; the only animation is a fragile timer race that can blank rows.
- **Fix:** keep `is-sealed` as the fail-open end-state, but on reveal: remove it → run a `translateY` scan over `--dur-sweep` → stagger `register__v` opacity in read-order via `transition-delay` → flip verdict → stroke the check (dashoffset already wired). End-state must be `opacity:1` independent of JS (covered by P0-3b). One earned moment, not a screensaver.

### P1-3 — Glass nav like Linear/Vercel/Stripe (frosted, materializes on scroll)
- **File:** `public/kolm-2026.css` nav block (~L520-547) + scroll-state JS.
- **Fix (verbatim-grade targets):** sticky bar, `~64px`, fill `rgba(11,11,11,.8)` (or `rgba(10,10,10,.7)`), `backdrop-filter:blur(20px)`, 1px hairline `rgba(255,255,255,.08)`, **no shadow until scroll**. Animate blur/opacity in on scroll over `.12s` ease-out-quad so it "thickens" as you leave the hero. Add a hairline divider before `.nav__actions` (L535) and `justify-content`/center so links float between brand and actions instead of clamping into two clumps (fixes the "void in the middle").

### P1-4 — Adopt a restrained motion vocabulary (the Series-C tell)
- **File:** `public/kolm-2026.css` `:root` tokens.
- **Fix:** add an easing + duration ladder and use it everywhere: `--ease-out-quart:cubic-bezier(0.165,0.84,0.44,1)` and `--ease-out-expo:cubic-bezier(0.19,1,0.22,1)` for entrances; `--ease-out-quad` for UI. Durations `0.1s / 0.15s / 0.25s`. Transition **border/elevation/transform only — never layout**. Expo/quart out-curves read "expensive"; bounce does not.

### P1-5 — Lift hierarchy + hairline-etched panels (Vercel "Materials")
- **Files:** `public/kolm-2026.css` card/panel rules (`.card,.step,.tier,.flow__node` ~L256-263; `.register`/`.plate` ~L247).
- **Fix:** codify 4-5 elevation tiers (radius 6/6/12/12/16 + escalating blur/shadow). Hover/active = **+1 tier** (luminance step `--register`→`--engraved` + 1px `translateY`, ~150ms). Use hairline borders `rgba(255,255,255,.06-.10)` instead of dividers so panels read "forensic / etched."

---

## P2 — POLISH (do after P0/P1)

### P2-1 — Secondary repeating textures audit
- `public/kolm-2026.css` `.dither-edge` (~L885), `.seam::before` (~L887-892), `.rule--ticks` (~L893-895) all use dot/tick repeats that read as "grid gimmick." Evaluate per-element; remove or soften. **Keep** `.spark i` (~L738) — it's a data sparkline, not background.

### P2-2 — Enforce non-text tokens in CSS, never on real text
- `--ink-faint` (`#3A3D42`, 1.83:1) and `--accent-idle` (`#23493B`, 1.98:1 as text) are decorative-only. Assert this in comments; route any `.pill--idle`/`.badge--idle` *text* to `--ink-3`, keep the dot as accent-idle.
- `--ink-4` (`#62666D`): fails normal text on every surface (2.9-3.45:1). For `.well .ln` line-numbers (~L282) bump to `--ink-3`; document `--ink-4` as large-only.

### P2-3 — Mask-faded section seams + secondary reactivity
- Replace hard dividers with `mask-image:linear-gradient(...)` + light `backdrop-filter:blur` strips (Linear pattern) so sections fade into each other "engineered," not clipped.
- Extend existing `.reveal`/`[data-art-reveal]` to `.proof__cell` and feature plates with staggered `transition-delay`; add an animated register fill-bar (scaleX phosphor pip) on verified metrics, reusing the count-up IntersectionObserver.

### P2-4 — Active-route nav indicator
- Add a thin `::after` scaleX underline on `[aria-current="page"]` (`kolm-2026.css:534`) for substance without clutter.

---

## Acceptance checklist (gate for "done")
- [ ] No dot/line grid anywhere; one dynamic field layer, reduced-motion safe.
- [ ] All four datasheet labels and the SIGNATURE value legible (≥4.5:1) with JS disabled.
- [ ] Primary + nav CTAs visible at top-of-page, JS off, over the lit hero.
- [ ] Nav exposes Platform/Developers/Pricing/Trust + Status dot + always-solid CTA; rest-state `--ink-2`.
- [ ] Glass nav materializes on scroll; restrained expo/quart motion ladder in use.
- [ ] `prefers-reduced-motion` honored on field, sweep, and reveals.
