# KOLM_BLACK_UNICORN_SPEC
### The first-principles design language for kolm.ai — black + phosphor-green, nuclear retro-futurist, executed at tech-unicorn luxury tier.

> kolm.ai is **the AI compiler**: capture API traffic → compile signed `.kolm` artifacts → compose specialists → deploy to devices. The site must *feel* like the product: a dark instrument that turns chaotic traffic into one sealed, glowing, signed object.

---

## 0 · DIRECTION

One sentence: **a near-black instrument hall lit by a single bar of phosphor-green light, built entirely from hairlines and luminance steps, where one dramatic reactor moment per viewport earns its glow against quiet, expensive negative space.**

The reference set is fixed: **Linear / Vercel / Railway / Raycast / Supabase** at the dark tier — and the canonical motif already exists in `public/compiler-brand-hero.png` (dark instrument panel, monospace `INGEST / POLICY / COMPILE / EXPORT` rail, single green accent, hairline rows). The job is to make that panel's construction read as a $B brand **sitewide**.

Three non-negotiable pillars, in tension, all required at once:
1. **LUXURY** — off-white ink, surface-ladder depth, hairlines not boxes, generous air, one accent brutally disciplined.
2. **NUCLEAR RETRO-FUTURIST CHARACTER** — phosphor bloom, monospace instrumentation, containment rings, scanline/grain texture, a glowing reactor core. This is the *soul* and the differentiator vs. generic dark SaaS.
3. **CLEAN / BUTTONED-UP** — thin nav, tight content frame, calm everywhere the drama isn't.

The failure of every prior pass was **amplitude**, not direction. The tokens were already close to right (see `kolm-2026.css` L33–60). The pendulum swung: generic → too chunky → sterile. **This spec fixes the dial settings, not the palette.**

---

## 0.1 · ENFORCEMENT GATES (run these — claims are otherwise unverifiable)

Two leaks are systemic and were under-counted in prior passes. Each gets a **mechanical gate**, not a prose reminder, so "done" is grep-checkable.

### Gate A — Sage hex is repo-wide, not four lines. **Replace everywhere + assert zero.**
The de-saturated sage `#75d19f` / `#71e2a8` is **not** confined to `kolm-main.css` L432/485/547/601. The live grep finds it **34 times across six source files** (and one generator). Replacing only the four `kolm-main.css` greens leaves *most* of the site sage. The map:

| File | sage hits | typical home of the hit |
|---|---|---|
| `public/kolm-main.css` | 13 | console/result text, focus rings, key values |
| `public/account/api-control-center.html` | 6 | control-system bar/lane/footer, intake focus + route |
| `public/pricing.html` | 5 | command bar, result top/price/cta/boundary |
| `public/docs/api.html` | 5 | cockpit bar, command focus/status, toggles accent-color, code |
| `public/account/overview.html` | 3 | workspace console bar/row/footer |
| `public/status.html` | 2 | status-console bar, `.ok` |
| `scripts/build-api-ref.cjs` (generator) | 5 | **re-emits `docs/api.html`** — must be fixed too or the next build re-introduces sage |

**Mapping (apply globally, case-insensitive):**
- `#75d19f` → `#3FE5A0` (`--accent`); `#71e2a8` → `#7DF7C0` (`--green-bright`/`--accent-hi` winner, see §0.2).
- The matching rgba `rgba(117,209,159,.x)` (sage at .36/.12 etc.) → `rgba(63,229,160,.x)`.
- Where a CSS var exists in scope, prefer `var(--accent)` / `var(--accent-hi)` over a raw hex so it can never drift again.

**Gate (must print `0` before Phase 0 is "done"; also fix the generator so the gate stays at 0 after `node scripts/build-api-ref.cjs`):**
```bash
# repo-wide, case-insensitive, exclude this spec + node_modules
grep -rIina --include='*.css' --include='*.html' --include='*.cjs' \
  -e '#75d19f' -e '#71e2a8' -e 'rgba(117, *209, *159' public scripts \
  | grep -v 'KOLM_BLACK_UNICORN_SPEC' | wc -l   # expect: 0
```

### Gate B — Cool-void & sheet are a real second-accent / light system (~100 uses, 10 files). **Scope, don't ban.**
Two inherited token families look "off-brief" but are **legitimate when scoped**; the fix is to **fence** them, then assert nothing leaks outside the fence:

- **Cool void = the cool counterlight** `--cool:#6FA6E8` + `--cool-soft:rgba(111,166,232,.10)` + `--cool-edge:rgba(111,166,232,.28)` (`kolm-2026.css` L46–47). This is the periwinkle-blue the prompts already omit (§6.2). It is the *second light* read by the field shader — atmosphere, never chroma.
  - **ALLOWED:** the WebGL/canvas field shader only — `public/kolm-field.js` and the `:root` declaration + `@media` oklch fallback in `kolm-2026.css` (L46–47, L1294). It tints the hero grid's counter-light; it must never become a visible UI color.
  - **BANNED:** any `--cool*` token as `color` / `border-color` / `background` / `fill` on a DOM element, on any interior page, or as a CTA/link/active accent. Green (`--accent`) is the only chroma the user sees; `--cool` is light, not paint.
- **Sheet = the lit signed-artifact surface** `--sheet*` (`kolm-2026.css` L56–61): an intentionally **light/cream** surface (`#F3F5F2`) — the *one* bright object on a dark page (the `.kolm` report/seal). This is "TWO SURFACES: the room and the SHEET" by design (L15), **not** the inherited light theme the brief kills.
  - **ALLOWED:** the signed-artifact / report / seal / verify components only — `kolm-2026.css` `.rep*` / `.vw*` / `.seal*` / `.find*` blocks, and the artifact pages `verify.html`, `report-viewer.html`, `buyer.html`, `badge.html`, `account-billing.html`, `audit-pricing.html`. Inside these, light *is* the point.
  - **BANNED:** `--sheet*` as a page/section background, nav, footer, hero, or any non-artifact marketing surface. The artifact is matted *inside* a hairline panel on the black canvas (§6.1) — the sheet never becomes the page.

**Audit pass (confirms scope; run before Phase 6 sign-off):**
```bash
# 1) cool-void must appear ONLY in the field shader + token decl/fallback:
grep -rIin --include='*.html' --include='*.css' --include='*.js' '\-\-cool\b\|--cool-soft\|--cool-edge' public \
  | grep -v -e 'kolm-field.js' -e 'kolm-2026.css'     # expect: 0 lines (no leak outside the shader/decl)
# 2) within kolm-2026.css, every --cool* use must be a declaration or the field/oklch lines, never a UI property:
grep -nI 'var(--cool' public/kolm-2026.css            # eyeball: only field-shader / counter-light context, no .btn/.nav/.card
# 3) sheet must appear ONLY in artifact components + artifact pages:
grep -rIin --include='*.html' '\-\-sheet' public \
  | grep -v -e 'verify.html' -e 'report-viewer.html' -e 'buyer.html' -e 'badge.html' \
            -e 'account-billing.html' -e 'audit-pricing.html'   # expect: 0 lines
```
If any line prints, the second-accent / light system has escaped its fence — pull it back to `--accent` (cool) or to the matted artifact panel (sheet) before sign-off.

## 0.2 · CSS TOKEN NAMESPACE — spec vocabulary ↔ LIVE tokens (READ FIRST)

**Critical:** the spec's token names (`--canvas`, `--surface-*`, `--green*`, `--hairline*`, `--ink-mute`, `--on-green`) **do not exist in the live CSS** — grep confirms `var(--canvas)` = 0 uses, `var(--green)` = 0 uses. The live system uses a *different namespace*. Pasting the §2 / "Drop-in token starter" block as-is adds **dead variables no rule references** — Phase 0 would *appear* done while changing nothing. **Every phase below edits the LIVE token, named via this table.** Treat the spec names as documentation aliases only.

| Spec name (this doc) | LIVE token (edit THIS) | Live value | Where |
|---|---|---|---|
| `--canvas` / `--obsidian` | `--paper` | `#08090A` | `kolm-2026.css` L36 |
| `--surface-1` | `--paper-2` | `#0F1011` | L36 |
| `--surface-2` | `--paper-sink` | `#0C0D0E` | L36 |
| `--surface-3` | `--raised` | `#191A1B` | L36 |
| `--green` | `--accent` (= `--reactor`) | `#3FE5A0` | L42 / L1374 |
| `--green-bright` | `--accent-hi` (= `--reactor-hi`) | see §0.2 conflict ↓ | L42 / L1374 |
| `--green-deep` / pressed | `--accent-press` | `#33CC8C` | L42 |
| `--green-core` | `--reactor-core-c` | `#CFFFEE` | L1374 |
| `--on-green` | `--on-accent` | `#062A1D` | L44 |
| `--hairline` | `--line` | `rgba(255,255,255,.07)` | L49 |
| `--hairline-strong` | `--line-2` | `rgba(255,255,255,.12)` | L49 |
| `--hairline-top` | `--line-top` | `rgba(255,255,255,.14)` | L49 |
| `--ink-mute` | `--ink-3` | `#8A8F98` | L39 |
| `--ink-dis` | `--ink-4` / `--ink-faint` | `#62666D` / `#3A3D42` | L39 |

**Two valid ways to reconcile — pick (a):**
- **(a) Edit live tokens directly (recommended).** Wherever a phase says "set `--green`," it means **edit `--accent`** at `kolm-2026.css` L42; "set `--canvas`" means edit `--paper` L36; etc. No new namespace is introduced. The §2 hex values are correct — they just live under the live names.
- **(b) Alias-and-migrate (only if you want the spec names to be real).** In `:root`, add `--accent: var(--green); --paper: var(--canvas); …` *after* defining the spec tokens, then migrate rules over time. Higher churn, more risk; do not do this mid-Phase-0.

**Unflagged conflict the spec must resolve — pick a winner for the bright green:**
There are **three live green sets** and they disagree on the bright stop:
- `kolm-2026.css` L42: `--accent-hi:#6BF0B8`
- `kolm-2026.css` L1374 (reactor block): `--reactor-hi:#7DF7C0`
- this spec (§2.3): `--green-bright:#7DF7C0`

`#6BF0B8` ≠ `#7DF7C0`. **Winner: `#7DF7C0`** (the brighter reactor-hi — it's the hero-bloom peak the nuclear character needs). **Action in Phase 0:** set `--accent-hi:#7DF7C0` at L42 so `--accent-hi` and `--reactor-hi` are identical, and `--reactor` can simply read `--accent` family. After this, `--accent`/`--reactor` and `--accent-hi`/`--reactor-hi` are one family; the two declarations are kept only as scoped aliases, never as a second palette.

---

## 1 · FAILURE MODES TO AVOID (the two ditches) + DO-NOT-REPEAT

This brand lives on a knife-edge between two documented failures. Both are death.

### Ditch A — TOO CHUNKY (the "radioactive reactor" pass)
- Thick chrome bezels, 2–4px strokes, heavy boxes, glossy plastic, drop-shadow-as-structure.
- Green splashed across backgrounds/borders/highlights → reads "free template," not "precious."
- Glow on *everything at rest* → radioactive soup, no focal hierarchy.
- **Guard:** structure is carried by **1px hairlines** (`rgba(255,255,255,.07)`-class) + luminance steps. Radii stay 8/12/16px, never thick strokes. Glow is an *active-state* event, not a resting attribute.

### Ditch B — STERILE MINIMALISM (the "0.02/10 / hideous / killed it" pass)
This is the **current live state** and the more urgent enemy. Root cause, from the live audit:
- The nuclear signature was **deleted, not refined.** The CSS reactor core (`kolm-2026.css` L1412–1422) sits at `top:42% left:66%`, ~0.08–0.22 alpha → a barely-perceptible smudge in the right gutter. No reactor reads at 1m.
- **Every texture layer pushed below the perception floor simultaneously:** scanlines at `opacity:.22 × .012 alpha` ≈ .003 effective (invisible, L1397–1399); grid 0.026–0.036; core glow 0.08. When *everything* is subliminal at once, nothing anchors the eye → flat, empty, cheap-clean.
- **H1 shrunk and de-weighted** by a cascade-winning override (`kolm-main.css` L3792) to `clamp(38px,4.5vw,66px)` / weight 500 → polite, mid-size, no command of the viewport.
- **Green rationed to garnish** + slightly de-saturated to sage `#75d19f` / `#71e2a8` → reads soft, not uranium. This is **not** four stray lines — the live grep finds the sage hex **34 times across six source files** (`kolm-main.css` ×13, `account/api-control-center.html` ×6, `pricing.html` ×5, `docs/api.html` ×5, `account/overview.html` ×3, `status.html` ×2; plus the generator `scripts/build-api-ref.cjs` ×5 that re-emits `docs/api.html`). So **most of the site stays sage** even after the four `kolm-main.css` greens cited in earlier passes are fixed. See §0.1 for the repo-wide replace + grep gate.
- **No material catches light** — one flat translucent card on black reads "default dark-mode component," not "expensive instrument."

### DO-NOT-REPEAT (hard list)
- ❌ Do **not** run the CSS core AND an image hero both faint. Pick **one** loud focal object; make it unmistakable.
- ❌ Do **not** push all texture below ~3% effective. Texture must be *felt* (subliminal-but-present, ~3–7%), with **one** high-contrast hero object on top.
- ❌ Do **not** ship the L3792 H1 override. Headline renders at full display scale (≥ clamp 56→100px, weight 560–620, line-height ~0.9).
- ❌ Do **not** use `#75d19f` / `#71e2a8` anywhere — **repo-wide, across all six source files** (not just `kolm-main.css`). **One** green family: `#3FE5A0` / `#7DF7C0`. Enforced by the grep gate in §0.1.
- ❌ No pure `#000` canvas (crushes the green's bloom). No pure `#fff` body text.
- ❌ No drop shadow for structure. No gradients on core UI. No more than **one** animated focal element per page. No glossy plastic, no warm tones, no gold, no periwinkle/sage.
- ❌ Do **not** ship `compiler-brand-hero.png` as the hero — it is **light/cream-backed** and contradicts BLACK THEME. Replace with the dark `kn-hero-reactor-panel` render (§6).

### The acceptance test (apply to every screen)
> A stranger glancing at the hero for **1 second** says *"glowing green reactor / nuclear instrument panel — expensive, dark"* — **not** "another dark SaaS landing page." Four axes must pass: **focal core, headline presence, green saturation+amplitude, texture/edge catching light.**

---

## 2 · COLOR

### 2.1 The black surface ladder (luminance steps, never shadows)
Luxury-dark depth comes from a 4–5 step ladder where each raised surface is ~5–8% lighter, separated by a 1px hairline. Pure `#000` is avoided; the canvas is a near-black with a **faint green-cool cast** to feel uranium-adjacent. These align with the live tokens (`kolm-2026.css` L36) and the cross-validated Linear/Raycast/Supabase ladders.

> **Namespace note (do not skip):** the token *names* below (`--canvas`, `--surface-*`, `--hairline*`) are **spec aliases** — they are **not** the names in the live CSS. The live page already ships these *values* under different names (`--paper`, `--paper-2`, `--line`, …). Always edit the **LIVE** token from the §0.2 table; pasting these names verbatim creates dead variables. The hexes here are the source of truth; the live names are the edit targets.

```css
--canvas:        #05070A;  /* page. near-black, faint green-blue cast. NOT #000 */
--surface-1:     #0B0F12;  /* cards, the instrument-panel body */
--surface-2:     #11161A;  /* raised / featured panels, active rows (one step up) */
--surface-3:     #161C20;  /* topmost / hover */
--hairline:       rgba(255,255,255,.07);  /* 1px card edges — the workhorse */
--hairline-top:   rgba(255,255,255,.14);  /* engraved top edge — catches light, reads luxe */
--hairline-strong:rgba(255,255,255,.12);  /* dividers, section breaks */
--hairline-green: rgba(63,229,160,.22);   /* containment rings, active keyline */
```
**Rule:** every panel = **one surface step UP + one hairline**. Translucent-white hairlines (`rgba(255,255,255,.07/.12/.14)`) over solid surfaces beat solid-hex borders — they float on glass and brighten cleanly on hover. Drop shadows are reserved for **true floating overlays only** (menus/toasts): `0 24px 64px -34px rgba(0,0,0,.72)`.

### 2.2 Ink (off-white, never pure white for prose)
```css
--ink:      #F4F6F7;  /* primary headings + interactive ink */
--ink-2:    #C7CDD2;  /* body copy — paragraphs live here */
--ink-mute: #8A9097;  /* metadata, captions, rail labels */
--ink-dis:  #5A6066;  /* disabled */
```
Pure `#fff` is reserved for the single hottest data value / on-hover ink. Body paragraphs **never** exceed `#C7CDD2`.

### 2.3 Green — the radioactive accent (CTA-discipline)
The `#3FE5A0` family sits exactly between Supabase Green `#3ECF8E` (premium, 6.8:1 on `#171717`) and neon `#22C55E` (reads "code," 7.1:1 AAA). Keep it saturated; the sage drift is the cardinal sin.
```css
--green:        #3FE5A0;  /* primary accent / CTA fill */
--green-bright: #7DF7C0;  /* hover, hot core, hero bloom peak */
--green-core:   #CFFFEE;  /* the single hottest live value (near-white-green) */
--green-deep:   #33CC8C;  /* pressed / on-light / ring edge */
--green-soft:   rgba(63,229,160,.12);  /* tinted chips, active-row wash */
--green-glow:   rgba(63,229,160,.10);  /* ambient bloom */
--on-green:     #04140D;  /* near-black text ON solid green — the high-end move */
```
**The one law (Supabase mantra):** green appears on, and **only** on — the **primary CTA**, links, the **active/selected** state, the focus ring, the **single key data value** you want to pop (a count, the `.kolm` token), and the **one hero bloom**. Everything else is the black ladder + off-white ink. This restraint is what makes green read *radioactive/precious* instead of theme-y. Black-on-green (`--on-green`) on the CTA, not white-on-green — it's the expensive choice and lets the pill pop hardest.

### 2.4 Status / armed (rare, scoped)
Amber for armed/warning states only (interior heroes, gated rows): `--amber:#FFC062`, `--amber-glow:rgba(255,192,98,.5)`. Severity ramp (`--sev-*`) stays scoped to audit/report finding rows — **never** in shared marketing. No third ambient accent on the page.

### 2.5 Glow discipline
A green element may carry **at most**:
`box-shadow: 0 0 0 1px rgba(63,229,160,.35), 0 0 24px -6px rgba(63,229,160,.45)` — on the **active/hovered** state only, never at rest on every button. Phosphor bloom appears **once per page** (the hero). Text-glow on green ink is two-stop and tight: `text-shadow: 0 0 8px var(--green-glow), 0 0 24px var(--green-soft)`.

---

## 3 · TYPE

Two validated dark-unicorn philosophies converge: **negative tracking at display sizes** (engineered/compressed/urgent) and **positive tracking at micro sizes** (instrument metadata scannability). The live build already self-hosts three faces (CSP-safe woff2): **Cabinet Grotesk** (display), **Switzer** (text), **Spline Sans Mono** (machine). Keep them — they are correct and already shipped. Mono is **load-bearing**: it carries the nuclear-instrument identity (rail labels, receipts, `.kolm`, route counts).

> Optional swap if a more "Vercel" register is wanted: Geist Sans + Geist Mono (free, engineered). But Cabinet/Switzer/Spline are already installed and on-brief — do not churn fonts without reason.

### 3.1 Scale (clamp, dark-tuned)
| Token | Size | Weight | Line-height | Tracking | Color |
|---|---|---|---|---|---|
| **hero / display-xl** | `clamp(56px, 7.2vw, 100px)` | 600 | **0.92** | **-0.025em** | `--ink` |
| display-lg | `clamp(40px, 5vw, 64px)` | 600 | 1.02 | -0.02em | `--ink` |
| section head | `clamp(32px, 4vw, 44px)` | 600 | 1.12 | -0.018em | `--ink` |
| headline | 28px | 600 | 1.20 | -0.012em | `--ink` |
| card title | 22px | 500 | 1.25 | -0.008em | `--ink` |
| body-lg (lede) | `clamp(17px, 1.4vw, 20px)` | 400 | 1.55 | -0.005em | `--ink-2` |
| body | 16px | 400 | 1.6 | -0.005em | `--ink-2` |
| **eyebrow / rail label (MONO)** | 11–12px | 500 | 1.3 | **+0.26em** (uppercase) | `--ink-mute` |
| receipt / code (MONO) | 13px | 400 | 1.5 | +0.02em | `--green` (key) / `--ink-mute` |
| micro metadata | 10px | 500 | 1.4 | +0.3em (uppercase) | `--ink-mute` |

### 3.2 Rules
- **Display headlines dominate.** The hero H1 must occupy the upper-left and command the viewport — weight 560–620, line-height ~0.9, tight -0.025em. The accent word (`.go`) glows green (§2.5). **Delete/raise** the `kolm-main.css` L3792 override that shrinks it.
- **Eyebrows and rail labels are mono, uppercase, tracked +0.26em, mute-colored.** This is the single biggest "atomic control panel" signal — it's already in the hero render.
- **Numbers are tabular mono.** Counts (`922 routes`, `8 gates`), versions, the `.kolm` token. The one value you want to pop gets `--green` + tight bloom.
- Enable `font-feature-settings: "calt","kern","liga"` globally; `tnum` on all numeric instrument readouts.
- Restraint belongs in **body copy length**, not headline size. Lede = one tight paragraph.

---

## 4 · SPACING / GRID

- **Content frame:** `--content: 1240px` (max 1280). The black canvas *mats* the content like matting frames a print. Gutters: `max(28px, env(safe-area-inset-left))`.
- **Section rhythm:** `padding-block: clamp(88px, 11vw, 150px)`. Air is the luxury — this generous rhythm is already correct (`kolm-2026.css` L1402); keep it.
- **8px base spacing scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128. Component internal padding: cards 24px, panels 20–22px rows, nav 0 20px.
- **Radius house style:** `8px` chrome (buttons, inputs, nav pills) · `12px` cards · `16px` hero mockups/instrument panels · `9999px` pills/badges/tabs/LEDs. **Never** heavy 2–4px strokes anywhere.
- **One dramatic moment per viewport.** Each scroll-stop earns exactly one focal element (a panel, a number, a bloom); everything around it stays quiet near-black. Drama is *concentrated*, never distributed.
- **Grid:** 12-col within the frame; hero is asymmetric (headline left ~7 cols, instrument panel / reactor right ~5 cols). Below the fold, prefer 2–3 up card rows with equal hairline gutters.

---

## 5 · COMPONENTS

### 5.1 Thin nav (chrome, not a feature)
- **Height 56px** (max 60). Already thin at 62px (`kolm-2026.css` L291) — tighten toward 56.
- Layout L→R: wordmark `kolm.ai` + small green glyph · thin centered link cluster (Product, Platform, Pricing, Docs, Research) at **14px / 500 / `--ink-mute`**, hover → `--ink` · right: ghost **Sign in** + **solid green CTA pill** ("Start compiling").
- Treatment: `background: rgba(5,7,10,.72)` + `backdrop-filter: blur(12px) saturate(120%)`; **1px bottom hairline `rgba(255,255,255,.07)`** that **brightens toward green on scroll** (active-state only). No drop shadow. Keep quiet.

### 5.2 Buttons
- **Primary CTA:** solid `--green`, text `--on-green` (`#04140D`), height 40–42px, padding 11px 18px, radius 8px, weight 500. Top bevel `inset 0 1px 0 rgba(255,255,255,.4)`. Hover → `--green-bright` + soft green glow (§2.5). **The only green-filled element on the page** — it pops because nothing competes.
- **Secondary:** transparent bg, 1px hairline `--hairline-strong`, text `--ink`, same metrics. Hover → `--surface-2` fill + hairline brightens.
- **Tertiary/ghost:** no border, `--ink-mute` text → `--ink` on hover.

### 5.3 Cards
- `--surface-1` bg (or `rgba(255,255,255,.025)` glass), **1px `--hairline`** with `border-top-color: --hairline-top` (engraved light-catching top edge — the luxe tell), radius 12px, padding 24px, **no shadow**.
- Featured card = `--surface-2` (one step up). Hover = hairline brighten + one surface step + ≤2px translateY — **never** scale/lift-bounce.
- Key value per card (`.card__k`, `.metric__n`) gets `--green` + `text-shadow: 0 0 18px var(--green-soft)`.

### 5.4 The instrument / reactor panel (THE core asset — where the brand lives)
This is the `compiler-brand-hero.png` construction, extended sitewide. Two parts:

**(a) The reactor readout (the data panel):**
- Container: `--surface-1`, radius **16px**, 1px `--hairline`, `border-top-color: --hairline-top`, `box-shadow: var(--lift)` only (`inset 0 1px 0 rgba(255,255,255,.06)`), faint top-bloom `radial-gradient(140% 130% at 50% 0%, var(--green-glow), transparent 56%)`.
- Header bar: mono uppercase mute, tracked +0.3em (`API CONTROL CENTER — workspace/prod-ai-loop`) + green LED (6px, pilot-pulse) + amber armed LED right.
- Rows: transparent default; **active/selected row = `--surface-2` fill + left 2px `--green` keyline**; dividers = `rgba(255,255,255,.045)`.
- Left rail tags (`INGEST / POLICY / COMPILE / EXPORT`): mono, mute, step-grouped vertical rail — **strongest atomic-control-panel signal**.
- Counts mono tabular; the **live** row value glows hottest at `--green-core` + tight bloom.
- Status line: `ok receipt: rcpt_… readiness-gated target matrix` in mono, green-tinted terminal readout.

**(b) The reactor core (the focal glow — fix amplitude):**
The current core is invisible. Make it a **genuine focal element**:
- Enlarge to `clamp(440px, 42vw, 620px)`; move toward `left:72% top:40%`.
- **Lift alpha ~2–2.5×:** inner stop `rgba(125,247,192,0.32)`, ring stops `0.18`.
- Add **2–3 crisp concentric containment hairline rings** at `--hairline-green` + a faint slow rotating tick/dial. This is the atomic-age character that's currently absent.
- One ambient loop only: a slow breathe (9s, opacity .9→1, scale .98→1.02). It must read as a glowing reactor at 1m — **not a smudge**.

### 5.5 Pricing
- 3-tier row inside the `--content` frame, cards on `--surface-1`, the **recommended tier = `--surface-2`** (one step up) + 1px `--green` top keyline + a single green "Most teams" pill — **not** a full green card (that's chunky).
- Price number: display-lg, `--ink`, tabular. Per-unit + cadence in `--ink-mute`. Feature ticks: 14px `--ink-2`, check glyph in `--green`. CTA per card uses the button ladder (recommended = primary green, others = secondary).
- Hairline dividers between feature groups; no heavy boxes; equal-height cards.

### 5.6 Footer
- `--canvas` bg, 1px top `--hairline-strong`. Multi-column link grid (mono-mute column heads tracked +0.26em, `--ink-2` links). Wordmark + glyph top-left, one-line positioning statement, status pill (`all systems nominal` + green LED), copyright + legal in `--ink-mute`. A single faint `kn-containment-texture` band may sit behind the CTA strip directly above the footer (§6 asset #5) at ≤ the subliminal-but-present level. No green except links, LED, and the final CTA.

### 5.7 Motion (subtle, physical, never bouncy)
- Durations 150–250ms, easing `cubic-bezier(0.2, 0, 0, 1)` (decisive ease-out).
- Hover = 1px hairline brighten + 1 surface step (no scale).
- Reveal-on-scroll = 8–12px translate-up + fade, staggered ~40ms. Nothing flies in.
- Exactly **one** ambient loop per page (the breathing core). CTA glow intensifies ~120ms on hover — the only "energy" cue. No parallax, no autoplay carousels. Calm = expensive.

---

## 6 · IMAGERY + FINAL gpt-image-2 PROMPTS

### 6.1 Role of imagery
`public/img/` is **empty** — all assets are net-new. gpt-image-2 (FAL `fal-ai/gpt-image-2`) renders premium brand objects that the CSS cannot: machined obsidian instruments, the sealed `.kolm` artifact, containment textures. They live **matted inside hairline panels** (16px radius, faint top-edge green light-line) — a raw render never bleeds onto the canvas. One render is the hero "hero-shot," reused as a motif down-page.

The existing `compiler-brand-hero.png` is **light/cream-backed** — it violates BLACK THEME and must be **replaced** by `kn-hero-reactor-panel`.

### 6.2 Palette lock (use these exact hexes in every prompt)
- Obsidian field: `#08090A` → `#0F1011` → `#191A1B`
- Phosphor green: `#3FE5A0` (glow) · `#7DF7C0` (hot core — the §0.2 bright-green winner) · `#33CC8C` (deep edge)
- Engraved-shadow green: `#062A1D`
- Hairline metal: brushed graphite / gunmetal — no warm tones, no gold.
- The cool counterlight `#6FA6E8` is deliberately **omitted** from prompts (kept for CSS field shaders only) so renders stay mono-accent and don't muddy.

### 6.3 Universal style suffix (append to EVERY prompt)
> Photoreal product render, medium-format studio capture, 5600K cool key + soft 2:1 fill to hold detail in the blacks, single phosphor-green rim light tracing the edges. Deep obsidian field #08090A, rich true blacks, no banding. Phosphor/uranium green #3FE5A0 used surgically as the ONLY chroma — a glow, not a flood. Brushed graphite and gunmetal hardware, satin not glossy. Premium, expensive, buttoned-up, restrained. No text, no letters, no numbers, no logos, no UI labels, no watermark, no people. Atomic-age retro-futurist instrument character, editorial, monolithic.

Run config (already set in `scripts/fal_generate_v6.py`): `quality:"high"`, `background:"auto"`, `num_images:1`. Drop prompts into the `RENDERS` list as `(slug, image_size, prompt)` tuples (L32). Output writes to `public/img/_generations/<slug>.png`; promote the chosen render to `public/img/<slug>.png`. **The script's `RENDERS` list must be replaced** — it still ships the OLD periwinkle prompts (`#7C8CFF`, monolith/wax-seal/horizon) the §1 DO-NOT-REPEAT list forbids; see §6.6 for the exact six-tuple replacement and the `image_size` handling.

### 6.4 The asset set + final prompts (FULL — paste-ready)

Slugs / sizes / roles first, then the **six complete prompts inline** below. Each final prompt = **scene paragraph + the universal suffix from §6.3**. These are the exact strings that go into `scripts/fal_generate_v6.py` `RENDERS` (see §6.6 for the file's tuple list). They replace the OLD periwinkle prompts entirely — **no `#7C8CFF` anywhere.**

| # | slug | image_size | role | placement |
|---|---|---|---|---|
| 1 | `kn-hero-reactor-panel` | custom `1200×632` (see §6.5) | Primary hero / og:image | replaces `compiler-brand-hero.png` as `<img>` + og + twitter |
| 2 | `kn-artifact-core` | `square_hd` | the signed `.kolm` object | capabilities/platform "what you get", pricing glyph |
| 3 | `kn-runtime-shrink` | `landscape_16_9` | device-fit / runtime-shrink | platform "deploy to devices" |
| 4 | `kn-anatomy-stack` | `portrait_16_9` | exploded artifact anatomy | docs "anatomy of a .kolm" |
| 5 | `kn-containment-texture` | `landscape_16_9` | section accent / ambient band | full-bleed dividers, CTA band, trust header |
| 6 | `kn-verify-seal` | `square_hd` | verification seal / proof mark | trust/security/attestation surfaces |

> **Text-rendering reality (corrected).** gpt-image-2 has **near-perfect text rendering** — it does **not** randomly hallucinate signage (that was the gpt-image-1 era failure). On a strong-text model the real risk is the **opposite**: any control-panel/instrument noun ("seal", "binding stitch", "control center", "readout", "INGEST/POLICY/COMPILE/EXPORT", "dial") gets drawn as a **literal, legible label or etched word** unless firmly negated. So: keep the suffix's `No text, no letters, no numbers, no logos, no UI labels` constraint (it's correct and load-bearing), and additionally **avoid prompt words that imply written content** — the panel-style prompts (#1, #3, #4) below say **blank / unlabeled / no engraved characters** explicitly, and name lit zones as *glowing indicator lights* and *blank etched lanes* rather than "readouts" or named rails.

**Prompt #1 — `kn-hero-reactor-panel`** *(custom 1200×632 · primary hero + og:image)*
> A machined obsidian instrument panel photographed dead-on in a near-black studio, hairline-thin gunmetal seams dividing four stacked horizontal data lanes that are **blank and unlabeled — no text, no characters, no engraved words**, a single phosphor-green #3FE5A0 rim light tracing the top edge and one glowing green pilot LED at the upper left, the lanes lit only by faint green indicator dots, deep field #08090A → #0F1011 → #191A1B, satin not glossy, one soft volumetric green bloom behind the panel's right shoulder, fine containment grooves milled into the bezel, expensive and restrained. [+ §6.3 universal suffix]

**Prompt #2 — `kn-artifact-core`** *(square_hd · the signed `.kolm` object)*
> A single small dense matte-black artifact the size of a fist resting on a polished obsidian plinth in a void, its faces milled with concentric containment rings and one phosphor-green #3FE5A0 core seam glowing from a hairline gap as if sealed under pressure, a tiny abstract geometric core-mark embossed at center — a glyph, **not letters, not a logo, no text**, deep field #08090A → #0F1011 → #191A1B, rich true blacks, satin gunmetal edge catching a single green rim light, monolithic, watch-movement precision. [+ §6.3 universal suffix]

**Prompt #3 — `kn-runtime-shrink`** *(landscape_16_9 · device-fit / runtime-shrink)*
> A black architectural diptych in one frame: on the left a large machined obsidian instrument slab, on the right the identical object shrunk to a small handheld matte-black device, both in the same satin gunmetal material with **blank unlabeled faces — no text, no buttons with writing, no screens with characters**, connected by a single thin glowing phosphor-green #3FE5A0 line of light tracing from the large object to the small one, deep field #08090A → #0F1011 → #191A1B, single key light, deep shadows, the same artifact at two scales, monolithic minimalism. [+ §6.3 universal suffix]

**Prompt #4 — `kn-anatomy-stack`** *(portrait_16_9 · exploded artifact anatomy)*
> A precision exploded-view of a small black sealed artifact opened in cross-section — five horizontal paper-thin obsidian layers floating with knife-edge spacing, each a different microtexture (woven, etched, gridded, pierced, brushed), all faces **blank and unlabeled with no engraved text, no numbers, no callouts, no annotation marks**, one single phosphor-green #3FE5A0 thread of light running vertically through all five layers like a binding line, deep field #08090A → #0F1011 → #191A1B, studio macro, top light, soft shadows, watch-movement precision, editorial restraint. [+ §6.3 universal suffix]

**Prompt #5 — `kn-containment-texture`** *(landscape_16_9 · ambient section band)*
> A full-bleed near-black field of finely machined obsidian — softly milled concentric containment rings and a faint scanline grain, lit by one low phosphor-green #3FE5A0 glow rising from the lower edge like reactor light through a vent, no focal object, pure texture and atmosphere, deep field #08090A → #0F1011 → #191A1B, true blacks with no banding, the green a faint rim not a flood, restrained, monolithic, used as an ambient band behind a CTA. [+ §6.3 universal suffix]

**Prompt #6 — `kn-verify-seal`** *(square_hd · verification seal / proof mark)*
> A macro of a single matte-black pressed seal in satin obsidian, a tiny abstract geometric proof-mark embossed dead center — a glyph, **not letters, not a logo, no text, no readable characters** — its recessed channels glowing with one thin phosphor-green #3FE5A0 line as if freshly verified, light raking from the upper left casting fine shadow grain across an enormous surrounding field of texture-rich black, deep field #08090A → #0F1011 → #191A1B, museum-grade still life, contemplative, precise. [+ §6.3 universal suffix]

### 6.5 Integration notes (concrete)
- **og:image size — real px, one path.** Per current fal.ai gpt-image-2 docs, `landscape_16_9` actually renders at **1024×576** (plain 16:9, 1.78:1) — **not** 1536×864. 1024×576 **cannot** be upscaled to 630px tall without softening, so the old "crops cleanly to 1.91:1" instruction rested on a wrong source size. **Chosen path for the hero/og card:** request a **custom `image_size: {width:1200, height:632}`** for `kn-hero-reactor-panel` (both multiples of 16, within fal limits; 1.90:1 ≈ the 1.91:1 OG target). Render at native 1200×632, then the `<img>`/og/twitter `width="1200" height="630"` differs by 2px — center-crop 2px off the bottom in the promote step (lossless). *Alternative (only if custom size is unavailable):* render `landscape_16_9` at 1024×576 and center-crop/pad to 1200×630 in a build step, **accepting the upscale** — not preferred for a hero. Use the custom-size path.
- **Hero swap:** render `kn-hero-reactor-panel` → `public/img/kn-hero-reactor-panel.png`, update the three refs in `public/index.html` (`og:image` ~L21, `twitter:image` ~L29, `<img src>` ~L90) from `/compiler-brand-hero.png` to `/img/kn-hero-reactor-panel.png`. Keep the `width="1200" height="630"` attributes (the native 1200×632 render is cropped 2px to match).
- **Anti-sterile guard:** brushed-graphite + containment grooves + volumetric haze + green rim restore the nuclear character the minimalist pass stripped — without chunky bezels.
- **Anti-chunky guard:** every prompt names `#3FE5A0` as the *only* chroma and a *glow not a flood*; satin-not-glossy + 2:1 fill keeps it expensive.
- **Text safety (corrected rationale):** gpt-image-2 **renders text accurately**, so the failure mode is **not** random signage hallucination (that was gpt-image-1). The real risk is that any control-panel/instrument noun ("seal", "binding stitch", "control center", "readout", "INGEST/POLICY/COMPILE/EXPORT", "dial") gets drawn as a **readable label**. Therefore: **keep** the suffix's no-text/no-letters/no-logo constraint **and** strip prompt words that imply written content — the panel prompts (#1, #3, #4) say *blank / unlabeled / no engraved characters* and call lit zones *glowing indicator lights* / *blank etched lanes*, and the glyph assets (#2, #6) say *not letters, not a logo, no readable characters*. The constraint stays; the reasoning is now right.

### 6.6 The `RENDERS` replacement (do this — the named pipeline ships the wrong prompts)
**Blocker:** `scripts/fal_generate_v6.py` (the §6 drop target, `RENDERS` at L32) still contains the **OLD periwinkle prompts** — six tuples (`v6-monolith`, `v6-compile`, `v6-anatomy`, `v6-verify`, `v6-runtime`, `v6-horizon`) all using `#7C8CFF` periwinkle on `#0a0a0a`, exactly the periwinkle §1 forbids. An implementer told to "drop the 6 prompts into `RENDERS`" finds there are no spec prompts there to drop. **Action:** replace the entire `RENDERS` list with the six §6.4 prompts under their `kn-*` slugs, each = scene paragraph **+ the §6.3 universal suffix appended** (concatenate the suffix string onto each prompt). **No `#7C8CFF` may remain in the script** — grep `scripts/fal_generate_v6.py` for `7C8CFF` and `periwinkle` and expect 0.

Shape (build each `prompt` as `SCENE + " " + SUFFIX`, where `SUFFIX` is the §6.3 string):
```python
SUFFIX = ("Photoreal product render, medium-format studio capture, 5600K cool key + soft 2:1 fill to hold detail in the blacks, "
          "single phosphor-green rim light tracing the edges. Deep obsidian field #08090A, rich true blacks, no banding. "
          "Phosphor/uranium green #3FE5A0 used surgically as the ONLY chroma — a glow, not a flood. Brushed graphite and gunmetal "
          "hardware, satin not glossy. Premium, expensive, buttoned-up, restrained. No text, no letters, no numbers, no logos, "
          "no UI labels, no watermark, no people. Atomic-age retro-futurist instrument character, editorial, monolithic.")

RENDERS = [
    ("kn-hero-reactor-panel", {"width": 1200, "height": 632}, SCENE_1 + " " + SUFFIX),  # custom OG size, see §6.5
    ("kn-artifact-core",      "square_hd",      SCENE_2 + " " + SUFFIX),
    ("kn-runtime-shrink",     "landscape_16_9", SCENE_3 + " " + SUFFIX),
    ("kn-anatomy-stack",      "portrait_16_9",  SCENE_4 + " " + SUFFIX),
    ("kn-containment-texture","landscape_16_9", SCENE_5 + " " + SUFFIX),
    ("kn-verify-seal",        "square_hd",      SCENE_6 + " " + SUFFIX),
]
```
where `SCENE_1..6` are the six §6.4 scene paragraphs verbatim (minus the `[+ §6.3 universal suffix]` marker). Note tuple position 2 is now a **dict** for the hero (custom size) and a **string** elsewhere — the `submit()` body sets `"image_size": size`, which fal accepts as either a named enum or a `{width,height}` object, so no other code change is needed. Promote `public/img/_generations/kn-hero-reactor-panel.png` → crop 2px → `public/img/kn-hero-reactor-panel.png` (§6.5).

---

## 7 · HOMEPAGE BLUEPRINT

Top→bottom. Each block = one dramatic moment, surrounded by quiet near-black.

1. **Nav (56px)** — §5.1. Wordmark+glyph · centered links · Sign in + green CTA pill. Hairline brightens green on scroll.
2. **Hero** — asymmetric. **Left (~7 cols):** eyebrow (mono, `ENTERPRISE AI / API CONTROL PLANE`), H1 at full display scale ("**API behavior in. `.go`Device-fit models out.**" — accent word glows green), one tight lede (`--ink-2`), primary green CTA + secondary ghost, hero command strip (mono counts `922 routes · 214 groups · 17 channels · 8 gates`, hairline-divided). **Right (~5 cols):** the **reactor readout panel** (§5.4a) matted in a 16px hairline card, with the **reactor core** (§5.4b) glowing behind/beside it as the single loud focal object. Behind it all: one phosphor bloom + vignette to near-black corners + subliminal scanline/grain (~3–7%, *felt*). **This viewport must pass the 1-second test.**
3. **The compile loop** — 4-step horizontal rail (INGEST → POLICY → COMPILE → EXPORT), mono rail labels, each step a hairline card on `--surface-1`, the active/center step one surface up + green keyline. Optionally `kn-anatomy-stack` matted on one side.
4. **The artifact** — split: copy left, `kn-artifact-core` render matted right (the sealed `.kolm` object). One green data value glows.
5. **Capabilities grid** — 2×3 hairline cards, each: mono micro-label, 22px title, `--ink-2` body, one green key value. Hover = hairline brighten + surface step.
6. **Runtime / deploy-to-devices** — `kn-runtime-shrink` render matted full-width-ish, copy beside it (cloud-scale model → handheld).
7. **Proof / trust strip** — `kn-verify-seal` + signed/attested copy, status pill (`all systems nominal`), customer/standard logos in mute mono.
8. **Pricing** — §5.5, 3 tiers, recommended one step up + green keyline.
9. **CTA band** — full-bleed `kn-containment-texture` behind (≤ subliminal), one headline + primary green CTA centered.
10. **Footer** — §5.6.

Down-page discipline: cards = hairline + engraved top edge, **no heavy chrome**; green only on CTAs/links/active/one key value per block; one accent only; ≤ one animated element total (the hero core).

---

## 8 · CASCADE-SAFE BUILD PHASES

The codebase has **two cascading stylesheets** — `kolm-2026.css` (design system, incl. `THE REACTOR v3` L1366–1493) and `kolm-main.css` (loads second, **wins the cascade**, holds the home-hero overrides). Most fixes are **amplitude/CSS**, not markup (`index.html` hero markup L85–119 already wires reactor-core, reactor-readout, hero-image-two). Sequence so each phase ships green and reversible:

- **Phase 0 — Token unification (lowest risk, highest leverage).** Three sub-steps, each grep-checkable:
  - **(0a) Kill sage repo-wide (Gate A, §0.1).** Do **not** stop at the four `kolm-main.css` lines — replace `#75d19f`→`#3FE5A0` and `#71e2a8`→`#7DF7C0` (and `rgba(117,209,159,.x)`→`rgba(63,229,160,.x)`) across **all six files** (`kolm-main.css`, `account/api-control-center.html`, `pricing.html`, `docs/api.html`, `account/overview.html`, `status.html`) **and the generator** `scripts/build-api-ref.cjs`. Run the §0.1 Gate A grep; it must print `0` (also after `node scripts/build-api-ref.cjs`).
  - **(0b) Reconcile to ONE green family via the live namespace (§0.2).** The spec names `--green*`/`--canvas`/etc. **do not exist** — edit the LIVE tokens. Set `--accent-hi:#7DF7C0` at `kolm-2026.css` L42 so it matches `--reactor-hi` (the §0.2 winner); confirm `--paper/--paper-2/--accent/--line/--ink-3/--on-accent` already carry the §2 values (they do — L36/42/44/49). No new variables; **no dead `--canvas/--green` block.**
  - **(0c) Fence the second-accent / light system (Gate B, §0.1).** Confirm `--cool*` appears only in the field shader (`kolm-field.js` + `kolm-2026.css` decl/oklch) and `--sheet*` only in artifact components/pages. Run the §0.1 audit pass. **No layout change in any of 0a–0c.**
- **Phase 1 — Headline presence.** Delete or raise the `kolm-main.css` L3792 H1 override so H1 renders at `clamp(56px,7.2vw,100px)` / weight 560–620 / line-height ~0.9 / -0.025em. Verify the accent `.go` glow. (CSS-only.)
- **Phase 2 — Restore the focal core.** Pick ONE: (a) the dark `kn-hero-reactor-panel` render as a sharp right-anchored hero object behind the left scrim, OR (b) boost the CSS core (`kolm-2026.css` L1412–1422) to `clamp(440px,42vw,620px)`, `left:72% top:40%`, alpha ~2–2.5× (inner `0.32`, rings `0.18`) + 2–3 containment rings + slow tick. **Do not run both faint.** (Prefer (b) first — pure CSS, no asset dependency; layer (a) once renders land.)
- **Phase 3 — Texture from invisible → felt.** Raise scanlines to the subliminal-but-present band (effective ~3–7%, fix the `.012 × .22` collapse at L1397–1399); hero grid `rgba(63,229,160,.05–.07)` radial-masked at edges; add a fine grain/noise overlay ~3–4%; strengthen the hero vignette so corners fall to near-pure-black.
- **Phase 4 — Material craft.** Push engraved top-edge tokens (`--edge-top` → ~.14–.18, `--lift`) on reactor-readout + primary cards so the 1px top edge catches light (hairline-foil luxe). Keep bezels 1px — *light on the edge* sells luxury, not thickness.
- **Phase 5 — Imagery pipeline.** **Replace** `scripts/fal_generate_v6.py` `RENDERS` (L32) with the six §6.4 `kn-*` prompts (scene + §6.3 suffix) per §6.6 — the old periwinkle list is still there; grep the script for `7C8CFF`/`periwinkle` and expect `0`. Use the §6.5 custom `{width:1200,height:632}` size for the hero. Render; promote chosen renders to `public/img/<slug>.png` (hero cropped 2px → 1200×630); swap hero + og + twitter refs in `index.html` (L21/29/90) off `compiler-brand-hero.png`; mat each render in a hairline panel.
- **Phase 6 — Propagate sitewide.** Apply the panel/card/button ladder to platform, pricing, docs, capabilities, trust, footer. Every panel = surface step + hairline + engraved top. **Re-run §0.1 Gate B audit** (cool/sheet must still be fenced after the interior pages change). Run the 1-second acceptance test per page.
- **Phase 7 — Polish & guard.** Tighten nav to 56px; **re-run §0.1 Gate A** (sage = 0 repo-wide) and audit green for any non-CTA/non-active leak; confirm `--cool*`/`--sheet*` never escaped their fence (Gate B); verify motion is ≤1 ambient loop + 150–250ms hovers; `prefers-reduced-motion` kills animations; check AA contrast (green 6.8:1+, ink ramps). **Wire Gate A + Gate B greps into CI** so sage/cool/sheet can't regress.

**Cascade rule for every phase:** because `kolm-main.css` loads last and wins, make hero changes there (or remove the conflicting override) — don't edit `kolm-2026.css` and expect it to win the home hero. Ship phase-by-phase; each is independently revertible.

---

### Token reference — LIVE values (do NOT paste spec names as a new `:root` block)
> **Trap, restated:** an earlier draft of this block declared `--canvas/--surface-*/--green*` — **none of those names exist in the live CSS**, so pasting them adds dead variables and changes nothing. This block instead documents the **live `:root` you edit** (the values already shipped in `kolm-2026.css` L36–67). The spec names from §2 are aliases for these; see §0.2 for the full mapping. Edit *these* names.
```css
/* LIVE — kolm-2026.css :root (these names are real; edit here) */
:root{
  --paper:#08090A; --paper-2:#0F1011; --paper-sink:#0C0D0E; --raised:#191A1B;   /* canvas / surface-1 / surface-2 / surface-3 */
  --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.12); --line-top:rgba(255,255,255,.14); /* hairline / -strong / -top */
  --ink:#F7F8F8; --ink-2:#D0D6E0; --ink-3:#8A8F98; --ink-4:#62666D;             /* ink / ink-2 / ink-mute / ink-dis */
  --accent:#3FE5A0; --accent-hi:#7DF7C0; --accent-press:#33CC8C; --on-accent:#062A1D; /* green / green-bright(WINNER) / green-deep / on-green */
  --reactor:#3FE5A0; --reactor-hi:#7DF7C0; --reactor-core-c:#CFFFEE;            /* scoped reactor aliases — SAME family as --accent */
  --cool:#6FA6E8;  /* FIELD-SHADER ONLY (counter-light) — never a UI color, see §0.1 Gate B */
  /* --sheet* (light artifact surface) live at L56–61 — scoped to the .kolm/report/seal only, see §0.1 Gate B */
  /* fonts/radii/nav already shipped: --sans Switzer · --display Cabinet Grotesk · --mono Spline Sans Mono · nav-h→56 · --content 1240 */
}
```
**The one edit Phase 0 actually makes here:** `--accent-hi` is live `#6BF0B8`; set it to **`#7DF7C0`** (the §0.2 winner) so `--accent-hi == --reactor-hi`. Everything else above already matches §2 — confirm, don't re-declare.

**Files referenced:** `public/compiler-brand-hero.png` (canonical motif; light-backed → replace), `public/kolm-2026.css` (L36–67 LIVE tokens, L1366–1493 reactor v3, L46–47 `--cool*`, L56–61 `--sheet*`), `public/kolm-main.css` (cascade-winning home-hero overrides: **13 sage hits** incl. L432/462/485/547/601/751/759/926/1123/1226/2057/3639, L3785–3824 incl. L3792 H1, L344–367 scrim), `public/index.html` (hero markup L85–119, og/twitter/img L21/29/90), `scripts/fal_generate_v6.py` (RENDERS L32 — **still the old `#7C8CFF` periwinkle list; replace per §6.6**), `public/img/` (empty → render target).
**Sage-leak files (Gate A, §0.1 — fix all):** `public/kolm-main.css`, `public/account/api-control-center.html`, `public/pricing.html`, `public/docs/api.html`, `public/account/overview.html`, `public/status.html`, generator `scripts/build-api-ref.cjs`.
**Cool/sheet scope files (Gate B, §0.1):** `--cool*` allowed only in `public/kolm-field.js` + `public/kolm-2026.css` (L46–47, L1294); `--sheet*` allowed only in `kolm-2026.css` artifact blocks + `public/{verify,report-viewer,buyer,badge,account-billing,audit-pricing}.html`.
