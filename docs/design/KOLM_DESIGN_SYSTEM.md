# kolm.ai — KOLM DESIGN SYSTEM (THE Single Source of Truth)

> **Status: BINDING & AUTHORITATIVE.** This document is the one design system for `public/kolm-2026.css` and every page on kolm.ai. It is assembled from the locked art direction (`docs/design/art-direction-2026.md`, "The Datasheet Machine") and the 12 subsystem specs, with all values reconciled, exact, and copy-pasteable.
> **It SUPERSEDES** the five older specs (see banner at the foot of this file). Where they conflict with this document, **this document wins.**
> Date: 2026-06-14. Owner: design. Grounding benchmark: `docs/design/aesthetic-benchmark-2026.md`.

**One-line thesis:** *kolm is not a website; it is the instrument's datasheet — a strict Swiss register of citable controls in a forensic dark room, where one calibration sweep settles the proof and the only green ever printed means "in spec."*

**Five inviolable laws (every rule below is a consequence of these):**
1. **Off-black room, never `#000`, never grey.** Elevation = luminance ladder only. No black drop-shadows, anywhere.
2. **One hue.** `#3FE5A0` means *verified / in spec*, rationed to ~3% of pixels. It is **never a button fill**. Error desaturates it; idle dims it. The room never gains a second color.
3. **Mono is load-bearing.** Every numeral, price, hex, unit, control-ID, and register label is Geist Mono with `tabular-nums`. No metric ever escapes mono.
4. **The plate bevel is the default**, not a flourish: translucent ring + top-light bevel + top sheen, applied to every surface. The artifact (`--paper`) is the *one* lit object.
5. **Near-total stillness.** Two curves, four durations, one signature moment (the Calibration Sweep). Everything is `prefers-reduced-motion`-safe and JS-fail-open.

---

## 1. TOKENS — the one `:root` (paste verbatim into `public/kolm-2026.css`)

This is the complete, canonical token table. **No agent invents a value; every decision pulls a token below.** Names are canonical (the art direction's `--room/--panel/--register/--engraved/--well` vocabulary); legacy aliases are deprecated (§13).

```css
:root{
  /* ── ROOM & SURFACES — luminance ladder (never #000, never grey) ── */
  --room:#08090A;        /* floor / page bg — locked brand equity        */
  --panel:#0F1011;       /* default plate the artifact rests on           */
  --register:#15171A;    /* raised register-fill / lifted/hovered card    */
  --engraved:#1B1E22;    /* engraved-label plate / keyline-fill (highest) */
  --well:#0C0D0E;        /* sunk code/console floor (the one darker step) */
  --paper:#F4F2EC;       /* the ONE lit object — artifact sheet only      */

  /* ── INK RAMP — cool-white readout ── */
  --ink:#F7F8F8;         /* primary text / brightest UI value             */
  --ink-2:#D0D6E0;       /* secondary / lede / body                       */
  --ink-3:#8A8F98;       /* muted, captions, units (floor for legible)    */
  --ink-4:#62666D;       /* faint labels, registration marks (large only) */
  --ink-faint:#3A3D42;   /* microprint, near-floor (decorative only)      */

  /* ── HAIRLINES — translucent foreground, never grey hex ── */
  --line:rgba(255,255,255,.07);       /* default rule                     */
  --line-2:rgba(255,255,255,.12);     /* register divider / ring          */
  --line-top:rgba(255,255,255,.16);   /* top-light specular bevel         */
  --line-micro:rgba(255,255,255,.04); /* hairline micro-grid              */

  /* ── ACCENT — verdict / in-spec ONLY, ~3% of pixels ── */
  --accent:#3FE5A0;                                  /* VERIFIED / IN SPEC, full only */
  --accent-scan:color-mix(in oklab,#3FE5A0 22%,transparent); /* live scan-line */
  --accent-idle:#23493B;                             /* dimmed-phosphor inert sibling */
  --accent-dead:oklch(83% 0.04 163);                 /* out-of-tolerance / error */
  --accent-glow:#3FE5A033;                            /* the ONLY glow on the page */
  --accent-wash:#3FE5A011;                            /* single atmospheric backlight */
  --accent-soft:#3FE5A014;                            /* verified chip fill (faint)    */
  --accent-edge:color-mix(in oklab,#3FE5A0 30%,var(--line-2)); /* verified ring */

  /* ── CTA — inverted ink-on-room (accent is NOT a button fill) ── */
  --cta-fill:#EAF2EE; --cta-ink:#08090A;
  --cta-fill-hover:#FFFFFF; --cta-fill-press:#D7E0DB;

  /* ── TYPE — families & weights ── */
  --font-sans:Geist,system-ui,"Segoe UI",Arial,sans-serif;
  --font-mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --w-body:400; --w-ui:510; --w-display:640;          /* the ONLY 3 weights */

  /* ── TYPE — fluid size scale ── */
  --fs-hero:clamp(2.75rem,1.9rem + 4.2vw,5rem);        /* 44→80 */
  --fs-h1:clamp(2.25rem,1.7rem + 2.7vw,3.5rem);        /* 36→56 */
  --fs-h2:clamp(1.625rem,1.35rem + 1.4vw,2.25rem);     /* 26→36 */
  --fs-h3:clamp(1.25rem,1.13rem + .6vw,1.5rem);        /* 20→24 */
  --fs-lede:clamp(1.125rem,1.05rem + .35vw,1.3125rem); /* 18→21 */
  --fs-body:1rem;          /* 16 */   --fs-sm:.875rem;     /* 14 */
  --fs-eyebrow:.75rem;     /* 12 */   --fs-micro:.6875rem; /* 11 */
  --fs-metric:clamp(2rem,1.4rem + 2.6vw,2.75rem);      /* register value 32→44 */
  --fs-price:clamp(2.25rem,1.7rem + 2.4vw,3rem);       /* pricing 36→48 */

  /* ── TYPE — tracking (monotonic by size) ── */
  --track-hero:-.035em; --track-h1:-.028em; --track-h2:-.020em;
  --track-h3:-.014em; --track-body:-.010em; --track-eyebrow:.09em; --track-label:.12em;

  /* ── TYPE — line-heights & measure ── */
  --lh-hero:1.02; --lh-head:1.08; --lh-lede:1.5; --lh-body:1.6;
  --lh-mono:1.45; --lh-eyebrow:1;
  --measure:38rem;         /* ~608px prose clamp — BINDING, every template */

  /* ── SPACING — 4/8 base (locked) ── */
  --s1:4px;  --s2:8px;  --s3:12px; --s4:16px; --s5:24px;
  --s6:32px; --s7:48px; --s8:64px; --s9:96px; --s10:128px;

  /* ── SECTION RHYTHM — three named rhythms only ── */
  --rhy-1:clamp(40px,4.5vw,64px);   /* tight: sub-blocks within a section */
  --rhy-2:clamp(64px,7.5vw,104px);  /* default: between content blocks    */
  --rhy-3:clamp(80px,10vw,128px);   /* major: between named sections       */
  --section-y:var(--rhy-3);

  /* ── SHELL, GUTTER, GRID ── */
  --maxw:1200px;        /* default shell                   */
  --maxw-wide:1320px;   /* bento/feature rows ONLY          */
  --gutter:24px; --gutter-sm:16px; --nav-h:56px;

  /* ── BREAKPOINTS (reference; used in media queries) ── */
  --bp-sm:640px; --bp-md:960px; --bp-lg:1200px;

  /* ── RADII ── */
  --r-sm:2px; --r-md:6px; --r:12px; --r-lg:14px; --r-pill:999px;

  /* ── MATERIAL primitives — composed once, reused everywhere ── */
  --plate:inset 0 0 0 1px var(--line-2), 0 1px 0 var(--line-top); /* ring + bevel */
  --bevel:0 1px 0 var(--line-top);
  --ring:inset 0 0 0 1px var(--line-2);
  --sheen:linear-gradient(180deg,#ffffff0a,transparent);
  --glass-tint:rgba(8,9,10,.72);
  --glass-blur:blur(12px) saturate(150%);

  /* ── MOTION — two curves, four durations ── */
  --dur-micro:150ms;   /* hover/focus state change          */
  --dur-enter:400ms;   /* element entrance / reveal          */
  --dur-tick:500ms;    /* count-up numeral settle            */
  --dur-sweep:600ms;   /* signature Calibration Sweep ONLY   */
  --ease-out:cubic-bezier(.165,.84,.44,1); /* easeOutQuart: entrances, reveals, sweep */
  --ease-mat:cubic-bezier(.4,0,.2,1);       /* Material: hover/focus, color/bg changes */
  --stagger:70ms;

  /* ── FOCUS — phosphor "located" ring (the one accent-on-control exception) ── */
  --focus-ring:0 0 0 2px var(--room), 0 0 0 4px var(--accent);

  /* ── CONTROL sizing (a11y floor) ── */
  --ctrl-min:38px; --ctrl-min-sm:32px; --tap:44px;
}
```

**Base document rule:**
```css
html{font-family:var(--font-sans);font-weight:var(--w-body);font-size:16px;
  line-height:var(--lh-body);font-feature-settings:"cv01","ss03","calt";
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
body{background:var(--room);color:var(--ink-2);}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto;}}
```

---

## 2. TYPE SYSTEM

**Family (locked):** Self-hosted **Geist Sans** (prose/UI) + **Geist Mono** (all data), variable woff2, `wght` 100–900, at `public/fonts/Geist.woff2` and `GeistMono.woff2`. No Switzer, Spline, or Cabinet — delete those preloads. **Exactly three weights ship: 400 / 510 / 640.** Never bold (700+), never 590.

**@font-face (paste verbatim):**
```css
@font-face{font-family:Geist;src:url(/fonts/Geist.woff2) format("woff2");
  font-weight:100 900;font-style:normal;font-display:swap;
  size-adjust:100%;ascent-override:92%;descent-override:24%;line-gap-override:0%;}
@font-face{font-family:"Geist Mono";src:url(/fonts/GeistMono.woff2) format("woff2");
  font-weight:100 900;font-style:normal;font-display:swap;
  size-adjust:100%;ascent-override:92%;descent-override:24%;line-gap-override:0%;}
```
**Preload in `<head>` of every page, before CSS (above-fold faces only):**
```html
<link rel="preload" href="/fonts/Geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/GeistMono.woff2" as="font" type="font/woff2" crossorigin>
```

**DATA RULE (non-negotiable):** every numeral, price, hex, unit, control-ID, register label, code →
```css
.mono,code,kbd,.num,.price,.hex,.unit,.ctrl-id,.eyebrow,[data-mono]{
  font-family:var(--font-mono);font-feature-settings:"tnum","zero","calt";
  font-variant-numeric:tabular-nums;}
```

**Per-element recipes (copy-paste):**
```css
.eyebrow{font:var(--w-ui) var(--fs-eyebrow)/var(--lh-eyebrow) var(--font-mono);
  text-transform:uppercase;letter-spacing:var(--track-eyebrow);color:var(--ink-3);}
.hero-title,.hero__h1{font-family:var(--font-sans);font-weight:var(--w-display);
  font-size:var(--fs-hero);line-height:var(--lh-hero);letter-spacing:var(--track-hero);
  color:var(--ink);text-wrap:balance;}
h1,.h1{font-family:var(--font-sans);font-weight:var(--w-display);font-size:var(--fs-h1);
  line-height:var(--lh-head);letter-spacing:var(--track-h1);text-wrap:balance;}
h2,.h2{font-weight:var(--w-display);font-size:var(--fs-h2);line-height:var(--lh-head);
  letter-spacing:var(--track-h2);text-wrap:balance;}
h3,.h3{font-weight:var(--w-ui);font-size:var(--fs-h3);line-height:var(--lh-head);
  letter-spacing:var(--track-h3);}
.lede{font-size:var(--fs-lede);line-height:var(--lh-lede);letter-spacing:-.006em;
  color:var(--ink-2);max-width:var(--measure);}
p,.body{font-size:var(--fs-body);line-height:var(--lh-body);letter-spacing:var(--track-body);
  color:var(--ink-2);max-width:var(--measure);text-wrap:pretty;}
.caption,.unit,small{font:var(--w-body) var(--fs-sm)/1.4 var(--font-mono);color:var(--ink-3);}
.metric{font:var(--w-display) var(--fs-metric)/1 var(--font-mono);
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--ink);}
```

**Type rules:** prose/lede ALWAYS clamp to `--measure`; headings never do. `text-wrap:balance` on headings, `text-wrap:pretty` on `p`. Tracking is monotonic by size — never override per page. Fonts load CLS-free via §2 overrides; gate nothing on JS.

---

## 3. COLOR — semantics & contrast

The full token set lives in §1. Semantics:

- **Surfaces** climb the ladder only: `--room`→`--panel`→`--register`→`--engraved`. `--well` is the one *darker* surface (code/console). `--paper` is the one lit object (artifact only).
- **Ink:** prose/UI labels use `--ink`/`--ink-2`. `--ink-3` is the floor for legible text. `--ink-4` is **large-text only** (≥24px or ≥19px bold) — never body. `--ink-faint`/`--accent-idle` never carry readable content.
- **Accent = verdict only.** `--accent` (verified), `--accent-dead` (out-of-tolerance, desaturated), `--accent-idle` (inert ghost), `--accent-scan` (live sweep), `--accent-glow`/`--accent-wash` (the only emitted/ambient light). One hue, fenced — no second accent ever.

**Contrast (verified against locked hex; AA normal ≥4.5, AAA ≥7.0):**

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink` on `--room`/`--panel`/`--register`/`--well` | 18.7 / 17.9 / 16.9 / 18.3 | AAA — body on any surface |
| `--ink-2` on `--room`/`--panel` | 13.6 / 13.0 | AAA — lede |
| `--ink-3` on `--room`/`--panel`/`--register` | 6.13 / 5.86 / 5.53 | AA normal — captions/units only |
| `--ink-4` on `--room`/`--panel` | 3.45 / 3.30 | AA **large-text only** |
| `--ink-faint` on `--room` | 1.83 | FAILS — decorative microprint only |
| `--accent` on `--room`/`--panel`/`--well` | 12.3 / 11.7 / 12.0 | AAA — verdict glyphs/labels |
| `--accent-idle` on `--room` | 1.98 | inert ghost only — never carries text |
| `--cta-ink` on `--cta-fill` | 17.5 | AAA — CTA label |
| `--room` on `--accent` (inverted chip) | 12.3 | AAA |
| `#08090A` on `--paper` | 17.8 | AAA — artifact body text |
| `--ink-3` on `--paper` | 2.90 | FAILS — never muted ink on paper; use `#3A3D42`-darkened or `--ink` |

---

## 4. SPACING & LAYOUT

**Spacing scale (locked, 4/8):** `--s1`…`--s10` (§1). Gaps inside a card use `--s3/--s4`; between cards `--s5`; component groups `--s6/--s7`. Never hardcode px where a token exists. Off-scale px is forbidden except `1px` hairlines.

**Section rhythm — composed, non-uniform:**
```css
.section{padding-block:var(--section-y);border-top:1px solid var(--line);position:relative;}
.section--tight{padding-block:var(--rhy-2);}
```
Three named rhythms only (`--rhy-1/2/3`). Alternate `--rhy-3`/`--rhy-2` so breath reads as deliberate. The hero overrides: `padding-top:clamp(76px,9vw,136px); border-top:0`.

**Shell, gutter, measure (the iron rule):**
```css
.wrap{max-width:var(--maxw);margin-inline:auto;
  padding-inline:max(var(--gutter),env(safe-area-inset-left)) max(var(--gutter),env(safe-area-inset-right));}
.wrap--wide{max-width:var(--maxw-wide);}
.prose,.lede,.section>p,.section__intro{max-width:var(--measure);}
```
**The container grows, the measure never does.** Every paragraph/lede/intro clamps to `--measure`. Widen only the *shell* (`--maxw-wide`) for grids — text stays at 38rem.

**Breakpoints (3 stops, mobile-up):**
```css
@media (max-width:960px){.wrap{--gutter:20px;}}
@media (max-width:640px){.wrap{--gutter:16px;}}
```

**Grid utilities (the only 6 allowed — no ad-hoc `grid-template-columns`):**
```css
.grid{display:grid;gap:var(--s5);}
.grid>*,.split>*,.bento>*{min-width:0;}
.grid--2{grid-template-columns:repeat(2,minmax(0,1fr));}
.grid--3{grid-template-columns:repeat(3,minmax(0,1fr));}
.grid--4{grid-template-columns:repeat(4,minmax(0,1fr));}
@media (max-width:960px){.grid--3,.grid--4{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media (max-width:640px){.grid{gap:var(--s4);}.grid--2,.grid--3,.grid--4{grid-template-columns:1fr;}}

.split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s7);}
@media (max-width:760px){.split{grid-template-columns:1fr;gap:var(--s5);}}

.hero__grid{display:grid;grid-template-columns:1fr 1.2fr;gap:var(--s8);align-items:center;}
@media (max-width:960px){.hero__grid{grid-template-columns:1fr;gap:var(--s7);}}

.bento{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:var(--s5);}
.bento__main{grid-row:1/span 3;}
@media (max-width:960px){.bento{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media (max-width:640px){.bento{grid-template-columns:1fr;}.bento__main{grid-row:auto;}}
```
**Gap law:** `.grid`/`.bento`=`--s5`, `.split`=`--s7`, `.hero__grid`=`--s8`. Use `--maxw-wide` shell only with `.grid--3/--4` and `.bento`.

**Canonical section structure (every page reuses verbatim):**
```html
<section class="section">
  <div class="wrap">
    <p class="eyebrow">REG · LATENCY</p>
    <h2>Heading</h2>
    <p class="lede">Lede clamps to --measure.</p>
    <div class="grid grid--3"><!-- register cards --></div>
  </div>
</section>
```

---

## 5. MATERIAL / GLASS

Three-layer model: **room** (floor) → **glass/plate** (surface) → **content** (ink). Dark UI has no overhead light — we fake the lamp. **Elevation is luminance stacking, never drop-shadow.** The only emitted light on the page is `--accent-glow`.

**Fake-glass plate — the DEFAULT (`.card`, `.panel`, `.plate`, `.tier`, `.step`, `.register`):** applied everywhere, not as a flourish. No `backdrop-filter`. Elevate by changing `background` up the ladder, not the shadow.
```css
.card,.panel,.plate,.tier,.step,.register{
  position:relative;border-radius:var(--r);
  background:var(--sheen),var(--panel);     /* sheen on background-image; fill stays flat */
  box-shadow:var(--plate);                  /* ring + bevel; NEVER a black shadow */
  transition:background var(--dur-micro) var(--ease-mat),
             box-shadow var(--dur-micro) var(--ease-mat);
}
.card.is-raised,.register{background:var(--sheen),var(--register);} /* one step up */
.engraved{background:var(--sheen),var(--engraved);}                 /* highest step */
```

**Real glass — `backdrop-filter`, RATIONED to nav / `.ui` / `.hud` only:**
```css
.nav,.ui,.hud{
  background:color-mix(in oklab,var(--panel) 72%,transparent);
  -webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
  box-shadow:var(--ring),var(--bevel);
}
@supports not (backdrop-filter:blur(1px)){.nav,.ui,.hud{background:var(--panel);}}
```
Never put `backdrop-filter` on `.card`/`.panel`/`.tier`. Binding.

**Sunk surface — `.well` / code-console (the one darker step):**
```css
.well,.code{background:var(--well);
  box-shadow:inset 0 1px 0 #00000040, var(--ring);  /* inset only, no top bevel */
  border-left:2px solid var(--line-2);                /* engraved rail */
  border-radius:10px;color:var(--ink);
  font-family:var(--font-mono);font-variant-numeric:tabular-nums;}
.well .ln{color:var(--ink-4);}    /* tabular line-numbers */
.well .hdr{color:var(--ink-3);}   /* LISTING 2 · sha256… */
```

**Hairlines:** single rules `--line`; dividers/rings `--line-2`; specular top edge `--line-top`; micro-grids `--line-micro`. Always 1px translucent white (or `color-mix(in oklab,var(--ink),8%)` where hue-coherence matters). Never a grey hex border.

**Material kill-list (binding):** no `backdrop-filter` outside nav/`.ui`/`.hud`; no black drop-shadows anywhere; no grey-hex borders; no second glow; no frosted cards; elevate by luminance step only.

---

## 6. MOTION

**Two curves, four durations (§1). Near-total stillness. One signature.** Spring/bounce/parallax/scroll-jack are killed. Legacy aliases (`--dur-fast`, `--ease`, `--ease-exp`, `--ease-spring*`) are deprecated — do not author against them.

**Reveal-on-scroll (fail-open):**
```css
.reveal{opacity:1;transform:none}                       /* JS-off = visible */
.js-reveal .reveal{opacity:0;transform:translateY(16px);
  transition:opacity var(--dur-enter) var(--ease-out),transform var(--dur-enter) var(--ease-out)}
.js-reveal .reveal.in{opacity:1;transform:none}
.js-reveal .reveal:nth-child(2){transition-delay:var(--stagger)}
.js-reveal .reveal:nth-child(3){transition-delay:calc(2*var(--stagger))}
.js-reveal .reveal:nth-child(n+4){transition-delay:calc(3*var(--stagger))} /* cap */
@media(prefers-reduced-motion:reduce){.js-reveal .reveal{opacity:1;transform:none;transition:none}}
```
JS: `IntersectionObserver({threshold:.15,rootMargin:'0px 0px -10% 0px'})` adds `.in` once, then `unobserve`. No translateX, scale, or blur reveals.

**Hover / focus micro-interactions** (only background/border/box-shadow animate; never width/height/top/left):
```css
.card,.btn,.plate{transition:
  background var(--dur-micro) var(--ease-mat),
  border-color var(--dur-micro) var(--ease-mat),
  box-shadow var(--dur-micro) var(--ease-mat)}
.card:hover,.plate:hover{background:var(--sheen),var(--register);
  box-shadow:inset 0 0 0 1px var(--line-top),0 1px 0 var(--line-top)}
:where(a,button,input,[tabindex]):focus-visible{outline:none;box-shadow:var(--focus-ring);border-radius:var(--r-md)}
```
**Hover = one luminance step up** (`--panel`→`--register`). No lift/translate, no glow except the verified artifact. Container surfaces (`.plate--rows`) do not hover.

**Count-up:** `<span class="count" data-to="99.98" data-dec="2">99.98</span>` (literal final value is the fallback). On reveal, animate once over `--dur-tick`/`--ease-out`, format to `data-dec` places; `tabular-nums` kills jitter. Reduced-motion/JS-off render `data-to` instantly.

**Global reduced-motion law:** every animated rule sits inside `@media(prefers-reduced-motion:no-preference)` OR is overridden by a `reduce` block to the end-state. No exceptions.

---

## 7. THE SIGNATURE — Hero artifact + Calibration Sweep

**One artifact per page; one sweep per page.** Mount on `index.html`, `platform.html`, `pricing.html`. The artifact is the **only** element on the page with a non-inset shadow and the only one that animates.

**Hero markup (identical on all 3 pages; swap copy + datasheet values only):**
```html
<section class="hero" data-sweep>
  <div class="wrap hero__grid">
    <div class="hero__copy">
      <p class="eyebrow">THE AI COMPILER</p>
      <h1 class="hero__h1">Proof, witnessed.</h1>
      <p class="lede">One calibration sweep settles the verdict.</p>
      <div class="hero__cta">
        <a class="btn btn--primary" href="/signup">Get an API key</a>
        <a class="btn btn--ghost" href="/docs">Read the docs</a>
      </div>
    </div>
    <figure class="artifact is-sealed" data-artifact aria-label="Signed .kolm datasheet">
      <i class="regmark regmark--tl"></i><i class="regmark regmark--tr"></i>
      <i class="regmark regmark--bl"></i><i class="regmark regmark--br"></i>
      <header class="artifact__head">
        <span class="ctrl-id"><b>REG-04</b> claims-redactor.kolm</span>
        <span class="ctrl-id">TOL ±0.2 · v3.3</span>
      </header>
      <dl class="register">
        <div class="register__row"><dt class="register__k">LATENCY</dt><dd class="register__v" data-val>388 ms</dd></div>
        <div class="register__row"><dt class="register__k">ARTIFACT</dt><dd class="register__v" data-val>142 MB</dd></div>
        <div class="register__row"><dt class="register__k">SIGNATURE</dt><dd class="register__v" data-val>sha256:a1f0…</dd></div>
      </dl>
      <footer class="artifact__verdict"><span data-verdict>IN SPEC</span>
        <svg class="artifact__check" viewBox="0 0 16 16"><path d="M3 8l3.5 3.5L13 4"/></svg></footer>
      <span class="artifact__scan" aria-hidden="true"></span>
    </figure>
  </div>
</section>
```

**CSS recipe:**
```css
.artifact{position:relative;background:var(--paper);border-radius:6px;padding:24px 28px;color:#1B1E22;
  border-top:1px solid var(--line-top);
  box-shadow:0 1px 0 var(--line-top),0 0 0 1px var(--line-2),0 60px 120px -40px var(--accent-wash);}
.artifact__scan{position:absolute;inset-inline:0;top:0;height:2px;background:var(--accent-scan);
  transform:scaleX(0);opacity:0;pointer-events:none;}
.regmark{position:absolute;width:13px;height:13px;border:1px solid var(--ink-4);opacity:.42;}
.regmark--tl{top:-1px;left:-1px;border-right:0;border-bottom:0;}
.regmark--tr{top:-1px;right:-1px;border-left:0;border-bottom:0;}
.regmark--bl{bottom:-1px;left:-1px;border-right:0;border-top:0;}
.regmark--br{bottom:-1px;right:-1px;border-left:0;border-top:0;}
.register__k{font-family:var(--font-mono);letter-spacing:.09em;text-transform:uppercase;color:#3A3D42;}
.register__v{font-family:var(--font-mono);font-variant-numeric:tabular-nums;opacity:0;transition:opacity .12s;}
.artifact__verdict span{font-family:var(--font-mono);letter-spacing:.09em;color:var(--ink-4);}
.artifact__check path{fill:none;stroke:var(--accent-idle);stroke-width:2;stroke-dasharray:24;stroke-dashoffset:24;}
/* sealed / verified end-state */
.is-sealed .register__v{opacity:1}
.is-sealed .artifact__verdict span{color:#0B7A4C}
.is-sealed .artifact{box-shadow:0 1px 0 var(--line-top),0 0 0 1px var(--accent-glow),0 24px 80px -20px var(--accent-glow)}
.is-sealed .artifact__check path{stroke:#0B7A4C;stroke-dashoffset:0;
  transition:stroke-dashoffset var(--dur-sweep) var(--ease-out)}
@media(prefers-reduced-motion:reduce){.artifact__scan{display:none}.register__v{transition:none}}
```

**Sweep stages (~600ms, GPU-only, fires once, killed off-viewport):** scan-line traverses top→bottom → register fields populate in read order → tear cuts via mask-reveal → verdict flips to `IN SPEC`, hex finishes typing, checkmark settles to green, `--accent-glow` blooms once.

**Sweep JS:**
```js
const io=new IntersectionObserver((es,o)=>es.forEach(e=>{
  if(!e.isIntersecting)return;const a=e.target.querySelector('.artifact');
  const scan=a.querySelector('.artifact__scan');o.unobserve(e.target);
  if(matchMedia('(prefers-reduced-motion:reduce)').matches){a.classList.add('is-sealed');return;}
  scan.animate([{transform:'scaleX(1)',opacity:1,top:'0'},{top:'100%',opacity:0}],
    {duration:600,easing:'cubic-bezier(.165,.84,.44,1)'});
  a.querySelectorAll('[data-val]').forEach((v,i)=>setTimeout(()=>v.style.opacity=1,80*i+120));
  setTimeout(()=>a.classList.add('is-sealed'),560);
},{threshold:.4});
document.querySelectorAll('[data-sweep]').forEach(s=>io.observe(s));
```

**Calm fallback (binding):** render the `.is-sealed` end-state statically server-side (markup ships with `class="artifact is-sealed"`). JS removes `is-sealed` pre-animation only when motion is allowed and the element enters view, then re-adds it at the end. Never a blank artifact. One sweep per page; never re-fires.

---

## 8. COMPONENT LIBRARY — exact recipes + HTML

### 8.1 Buttons (`.btn`)
Accent is **never a button fill.** Primary inverts to ink-on-room.
```css
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;
  font:var(--w-ui) var(--fs-sm)/1 var(--font-sans);letter-spacing:-.006em;
  padding:0 16px;min-height:var(--ctrl-min);border:1px solid transparent;border-radius:var(--r-md);
  cursor:pointer;white-space:nowrap;text-decoration:none;
  transition:background var(--dur-micro) var(--ease-mat),border-color var(--dur-micro) var(--ease-mat),color var(--dur-micro) var(--ease-mat);}
.btn--primary{background:var(--cta-fill);color:var(--cta-ink);border-color:transparent;}
.btn--primary:hover{background:var(--cta-fill-hover);}
.btn--primary:active{background:var(--cta-fill-press);}
.btn--ghost{background:rgba(255,255,255,.02);color:var(--ink);border-color:var(--line-2);}
.btn--ghost:hover{background:rgba(255,255,255,.05);border-color:var(--line-top);}
.btn--sm{min-height:var(--ctrl-min-sm);padding:0 12px;font-size:13px;}
.btn[disabled],.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;pointer-events:none;}
.btn svg{width:15px;height:15px;}
.btn.is-loading{color:transparent;pointer-events:none;position:relative;}
.btn.is-loading::after{content:"";position:absolute;inset:0;margin:auto;width:15px;height:15px;
  border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:var(--accent);
  animation:btn-spin .7s linear infinite;}
@keyframes btn-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.btn.is-loading::after{animation:none}}
```
**Button kill-list:** no `--accent` fill, no glow on buttons, no `translateY` hover lift, no shimmer `::after` sweep. The spinner top-color is the ONLY place accent rides a button (status, not fill).
**ONE-PRIMARY-PER-VIEWPORT (binding):** exactly one `.btn--primary` visible per viewport-height of scroll. Nav CTA renders as a distinct inverted pill (`.nav__cta`), never `.btn--primary`. Two primaries in one screen = build error.
HTML: `<a class="btn btn--primary" href="/signup">Get an API key</a>`

### 8.2 Badges / chips / pills — status registers (mono)
```css
.badge,.chip{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);
  font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-2);border:1px solid var(--line-2);border-radius:var(--r-sm);}
.badge{padding:5px 11px;} .chip{padding:4px 10px;}
.badge--ok,.chip--ok{color:var(--accent);border-color:var(--accent-edge);background:var(--accent-soft);}
.badge--ok::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none;}
.badge--idle,.chip--idle{color:var(--ink-3);border-color:var(--line-2);}
.badge--idle::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent-idle);flex:none;}
.badge--err,.chip--err{color:var(--accent-dead);border-color:color-mix(in oklab,var(--accent-dead),transparent 70%);}
/* table/pill micro-variant */
.pill{display:inline-flex;font-family:var(--font-mono);font-size:9.5px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;padding:3px 8px;border-radius:var(--r-sm);border:1px solid var(--line-2);color:var(--ink-2);}
.pill--ok{color:var(--accent);border-color:var(--accent-edge);background:var(--accent-soft);}
.pill--dead{color:var(--accent-dead);border-color:rgba(255,255,255,.14);}
.pill--idle{color:var(--accent-idle);border-color:var(--line);}
```
HTML: `<span class="badge badge--ok">IN SPEC</span>` · `<span class="chip">v3.3</span>`

### 8.3 Eyebrow / kicker / index — instrument labels
```css
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);
  font-size:var(--fs-eyebrow);font-weight:var(--w-ui);letter-spacing:var(--track-eyebrow);
  text-transform:uppercase;color:var(--ink-3);margin:0 0 16px;}
.eyebrow::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--accent);flex:none;} /* no glow */
.kicker,.idx{display:inline-flex;align-items:center;gap:9px;font-family:var(--font-mono);
  font-size:10.5px;font-weight:600;letter-spacing:var(--track-eyebrow);text-transform:uppercase;
  color:var(--ink-2);margin:0 0 18px;padding:5px 11px;border:1px solid var(--line-2);
  border-radius:var(--r-sm);background:rgba(255,255,255,.022);}
.idx::before{content:"\00a7";color:var(--accent);letter-spacing:0;}  /* § control-ID */
.kicker .n{color:var(--accent);}
```
HTML: `<p class="eyebrow">REG-04 · TOL ±0.2</p>` · `<p class="idx">02 — CONTROLS</p>`

### 8.4 Card (a register)
```html
<div class="card">
  <span class="card__k">REG · LATENCY</span>
  <h3>Settled in one sweep</h3>
  <p>Every claim carries a citable control-ID.</p>
</div>
```
```css
.card{padding:var(--s5);}
.card__k{font:600 10.5px/1 var(--font-mono);letter-spacing:var(--track-label);text-transform:uppercase;
  color:var(--ink-3);display:flex;align-items:center;gap:12px;}
.card__k::after{content:"";flex:1;height:1px;background:var(--line);}
.card h3{margin:var(--s3) 0 var(--s2);font:var(--w-display) 19px/1.18 var(--font-sans);
  letter-spacing:-.02em;color:var(--ink);}
.card p{margin:0;color:var(--ink-2);font-size:14px;line-height:1.6;}
```
Metric variant: value in `.metric` mono `tabular-nums`; unit in `--ink-3`; a 6px phosphor pip (`background:var(--accent)`) **only** if verified, else `--accent-idle`.

### 8.5 Console plate (the one sunk surface)
```html
<div class="plate plate--rows">
  <div class="plate__hd">LISTING 2 · sha256:a1f… · <span class="ok">IN SPEC</span></div>
  <pre class="well"><span class="ln">01</span> capture --policy strict</pre>
  <div class="plate__foot"><span class="badge badge--ok">Signed</span></div>
</div>
```
```css
.plate--rows{padding:0;overflow:hidden;}
.plate--rows:hover{background:var(--sheen),var(--panel);box-shadow:var(--plate);} /* container: no hover */
.plate__hd{font:500 11px/1 var(--font-mono);letter-spacing:.04em;color:var(--ink-3);
  padding:14px 22px;border-bottom:1px solid var(--line);}
.plate__hd .ok{color:var(--accent);}
.plate__foot{display:flex;gap:14px;padding:18px 26px;border-top:1px solid var(--line);}
```

### 8.6 Pricing tier
```css
.tier{display:flex;flex-direction:column;padding:var(--s6);}
.tier--feat{box-shadow:inset 0 0 0 1px var(--accent-edge);}  /* brighter ring; no fill, no glow */
.tier__name{font:600 10.5px/1 var(--font-mono);letter-spacing:var(--track-label);text-transform:uppercase;color:var(--ink-3);}
.tier--feat .tier__name{color:var(--accent);}
.tier__price{font:var(--w-display) var(--fs-price)/1 var(--font-mono);letter-spacing:-.03em;
  font-variant-numeric:tabular-nums;color:var(--ink);margin:var(--s3) 0 2px;}
.tier li svg{color:var(--accent);width:15px;flex:none;}  /* checkmark = verified */
.tier .btn{margin-top:auto;width:100%;}
```

### 8.7 Process step
```css
.step{padding:var(--s5);border-radius:var(--r-sm);}
.step__n{font:600 11px/1 var(--font-mono);letter-spacing:var(--track-label);text-transform:uppercase;
  color:var(--accent);display:inline-flex;gap:8px;align-items:center;margin-bottom:var(--s4);}
.step__n::after{content:"";width:34px;height:1px;background:linear-gradient(90deg,var(--accent),transparent);}
.step h3{margin:0 0 var(--s2);font:var(--w-display) 20px/1.2 var(--font-sans);letter-spacing:-.02em;}
.step p{margin:0;color:var(--ink-2);font-size:14px;line-height:1.6;}
```

### 8.8 Forms & inputs (inputs are **sunk** — opposite of plates)
`.field` is reserved (WebGL); forms use `.fld*`.
```css
.fld{width:100%;min-height:46px;padding:12px 14px;font:var(--w-body) var(--fs-sm)/1.4 var(--font-sans);
  letter-spacing:-.004em;color:var(--ink);background:var(--well);border:1px solid var(--line-2);
  border-radius:var(--r-md);box-shadow:inset 0 1px 0 rgba(0,0,0,.25);
  transition:border-color var(--dur-micro) var(--ease-out),box-shadow var(--dur-micro) var(--ease-out),background var(--dur-micro) var(--ease-out);}
.fld::placeholder{color:var(--ink-4);}
.fld:hover{border-color:var(--line-top);background:var(--panel);}
.fld:focus,.fld:focus-visible{outline:none;border-color:var(--accent);
  box-shadow:inset 0 1px 0 rgba(0,0,0,.25),0 0 0 3px rgba(63,229,160,.14);}
.fld:disabled{opacity:.5;cursor:not-allowed;}
textarea.fld{min-height:120px;resize:vertical;line-height:1.55;}
.fld--mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums;letter-spacing:0;}
.fld-group{display:grid;gap:8px;margin-bottom:var(--s5);}
.fld-label{font:var(--w-ui) 10.5px/1 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);}
.fld-msg{margin:0;font:400 12px/1.4 var(--font-sans);color:var(--ink-3);}
.fld-group.is-error .fld{border-color:var(--accent-dead);}
.fld-group.is-error .fld-msg{color:var(--accent-dead);display:block;}
.fld-group.is-ok .fld{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-glow);}
```
```html
<div class="fld-group">
  <label class="fld-label" for="email">EMAIL</label>
  <input class="fld" id="email" type="email" placeholder="you@company.com" required>
  <p class="fld-msg" hidden></p>
</div>
```
Required on error: `aria-invalid="true"` + `aria-describedby="<msg id>"`. Accent appears only on focus-ring, success border/glow, spinner, verdict text. Errors desaturate to `--accent-dead` — never red, never a 2nd hue. Every control ≥44px; keys/codes/numerals mono; labels uppercase mono `+.14em`. API-key field uses `.fld--mono` with mono affix buttons (`COPY`/`REVEAL`), `.is-copied` swaps text color to `--accent` (no fill).

### 8.9 Tables & data display
```css
.tbl-wrap{overflow-x:auto;border-radius:var(--r-lg);background:var(--panel);box-shadow:var(--plate);}
.tbl{width:100%;min-width:640px;border-collapse:collapse;font-variant-numeric:tabular-nums;}
.tbl th,.tbl td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:top;}
.tbl thead th{font-family:var(--font-mono);font-size:10.5px;letter-spacing:var(--track-label);
  text-transform:uppercase;font-weight:600;color:var(--ink-3);background:var(--well);}
.tbl td{font-family:var(--font-sans);font-size:14px;color:var(--ink-2);}
.tbl td b{color:var(--ink);font-weight:620;}
.tbl td:first-child b{font-family:var(--font-mono);}        /* row key = mono */
.tbl td.num{font-family:var(--font-mono);font-size:13.5px;text-align:right;}
.tbl tbody tr:last-child td{border-bottom:0;}
.tbl tbody tr:hover td{background:rgba(255,255,255,.025);}  /* .15s, no transform */
.tbl .yes{color:var(--accent);} .tbl .no{color:var(--ink-4);} .tbl .muted{color:var(--ink-3);}
```
Key-value register (`<dl class="register">` … `<dt class="register__k">REG · LATENCY</dt><dd class="register__v"><b>42</b>ms</dd>`): mono, `tabular-nums`, key uppercase `+.12em`, value `--ink-2` with `<b>` at `--ink`. `.register--keys .register__v` sits in a `--well`. **All data left-aligned to grid; numerals mono.** Compare tables: featured column cells get `background:var(--register)`; a verified cell shows accent only via `.yes` glyph/pip, never a fill. **On-room** severity uses accent semantics (`--accent`/`--accent-dead`/`--accent-idle`); the **on-sheet** ink-on-paper finding palette (`--sheet-high #B3401F`, `--sheet-accent #0B7A4C`) is **fenced to the lit artifact only** — shared surfaces use the accent-status pills above.

### 8.10 Links + focus
```css
a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line-2);
  transition:border-color var(--dur-micro) var(--ease-out);}
a:hover{border-bottom-color:var(--ink-3);}
:where(a,.btn,button,[tabindex]):focus-visible{outline:none;box-shadow:var(--focus-ring);border-radius:var(--r-md);}
```

### 8.11 Nav (glass — the one rationed `backdrop-filter`)
```html
<header class="nav"><div class="wrap nav__in">
  <a class="nav__brand" href="/" aria-label="kolm home">
    <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="4.5" height="20" rx=".4"/><rect x="13" y="9" width="4.5" height="14" rx=".4"/><rect x="22" y="12" width="4.5" height="8" rx=".4"/></svg>
    <span>kolm</span></a>
  <nav class="nav__links" id="navLinks" aria-label="Primary">
    <a href="/#pipeline">Product</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
  <div class="nav__actions">
    <a class="btn btn--ghost btn--sm" href="/account/overview">Sign in</a>
    <a class="btn nav__cta" href="/signup">Get an API key</a></div>
  <button class="nav__toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
</div></header>
```
```css
.nav{position:sticky;top:0;z-index:50;background:var(--glass-tint);
  -webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
  border-bottom:1px solid var(--line);box-shadow:inset 0 1px 0 0 var(--line-top);}
.nav__in{display:flex;align-items:center;gap:var(--s5);height:var(--nav-h);}
.nav__brand{display:inline-flex;align-items:center;gap:9px;min-height:44px;
  font-family:var(--font-sans);font-weight:var(--w-display);font-size:18.5px;letter-spacing:-.02em;color:var(--ink);}
.nav__brand svg{width:20px;height:20px;}.nav__brand svg rect{fill:var(--accent);}
.nav__links{display:flex;gap:var(--s5);margin-left:var(--s3);}
.nav__links a{display:inline-flex;align-items:center;min-height:44px;font:510 14px/1 var(--font-sans);
  letter-spacing:-.006em;color:var(--ink-3);border-bottom:0;transition:color var(--dur-micro) var(--ease-out);}
.nav__links a:hover,.nav__links a[aria-current="page"]{color:var(--ink);}
.nav__actions{margin-left:auto;display:flex;align-items:center;gap:var(--s3);}
.nav__cta{background:var(--cta-fill);color:var(--cta-ink);border:1px solid var(--line-2);
  border-radius:var(--r-pill);box-shadow:inset 0 1px 0 var(--line-top);} /* inverted; NEVER accent fill */
.nav__cta:hover{background:var(--cta-fill-hover);}
.nav__toggle{display:none;align-items:center;justify-content:center;width:44px;height:44px;
  background:transparent;border:1px solid var(--line-2);border-radius:var(--r-md);color:var(--ink);cursor:pointer;}
.nav__toggle:hover{border-color:var(--ink-3);}
@media(max-width:820px){
  .nav__toggle{display:inline-flex;}.nav__actions .btn--ghost{display:none;}
  .nav__links{display:none;position:absolute;top:var(--nav-h);left:0;right:0;flex-direction:column;gap:0;
    padding:var(--s4) var(--gutter);background:var(--panel);border-bottom:1px solid var(--line);}
  .nav.is-open .nav__links{display:flex;}
  .nav__links a{min-height:50px;font-size:16px;border-bottom:1px solid var(--line);}
  .nav__links a:last-child{border-bottom:0;}}
```
Toggle JS: `nav.classList.toggle('is-open')` + sync `aria-expanded`. On scroll, `.is-scrolled` may engage glass — no transform, no shadow change.

### 8.12 Footer (6 cols; Legal always last; brand col 1.4fr)
```css
.foot{border-top:1px solid var(--line);padding:var(--s8) 0 max(var(--s7),env(safe-area-inset-bottom));
  color:var(--ink-3);font-size:14px;background:var(--well);}
.foot__grid{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(5,minmax(0,1fr));gap:var(--s6);}
@media(max-width:820px){.foot__grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
.foot__tag{color:var(--ink-3);font-size:13px;max-width:34ch;}
.foot__col h3{font-family:var(--font-mono);font-size:10.5px;font-weight:600;letter-spacing:.09em;
  text-transform:uppercase;color:var(--ink-4);margin:0 0 var(--s3);}
.foot__col a:not(.nav__brand){display:flex;align-items:center;min-height:44px;padding:8px 0;
  font:13.5px var(--font-sans);color:var(--ink-2);border-bottom:0;transition:color var(--dur-micro) var(--ease-out);}
.foot__col a:hover{color:var(--ink);}
.foot__bottom{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s3) var(--s4);
  margin-top:var(--s7);padding-top:var(--s4);border-top:1px solid var(--line);}
.foot__copy{margin-left:auto;color:var(--ink-3);font-size:13px;}
```
**Footer column order is fixed: Compiler · Surfaces · Trust · Company · Legal** (Legal last). Bottom strip carries status badges + copy.

---

## 9. PAGE TEMPLATES (the 5)

Every page = `<body class="t-{template}">` → `<header class="nav">` (shared) → `<main>` of `<section class="section">` blocks → `<footer class="foot">` (shared). Sections appear **in this order; omit, don't reorder.** `[req]` = mandatory. Every section opens with an `.eyebrow` (uppercase mono control-ID).

| `class` | Ordered sections (slot names) |
|---|---|
| **t-marketing** | `s-hero`[req] → `s-proof-strip` → `s-bento` → `s-feature-rows` (alt L/R) → `s-evidence` (embedded read-only artifact) → `s-faq` → `s-cta`[req] |
| **t-docs** | `s-doctop` (eyebrow+h1+lede)[req] → `s-toc` (sticky aside) → `s-doc-body` (prose + `.well` code)[req] → `s-related` |
| **t-app** | `s-appbar` (crumb+title+actions)[req] → `s-stat-row` (register cards) → `s-workspace` (panel)[req] → `s-aside` (HUD, optional) |
| **t-legal** | `s-legaltop` (title + `REV·` + effective-date)[req] → `s-legal-meta` (version strip) → `s-legal-body` (numbered prose)[req] → `s-legal-foot` (contact) |
| **t-evidence** | `s-evtop` (part-no header)[req] → `s-artifact` (the lit sheet)[req] → `s-register-grid` (metric cards) → `s-listing` (`.well` + hash) → `s-verdict` (IN SPEC) |

**Template notes:**
- **t-marketing** — `s-hero` is the asymmetric `1fr 1.2fr` grid with the artifact arming the sweep. `s-cta` band uses one inverted `.btn--primary`. Only this template (via the `s-evidence` embed) shares the artifact; the embed is read-only.
- **t-docs / t-app** — `s-toc`/`s-aside` are `position:sticky;top:calc(var(--nav-h) + 24px)`, mono labels, `--register` fill. Code blocks are `.well`, the only sunk surface.
- **t-legal** — prose-only; every paragraph clamps to `--measure`; no diagrams; no `.grid`.
- **t-evidence** — `s-artifact` is the one lit `--paper` object, fires the Calibration Sweep once. No artifact appears on any other template except the marketing embed.

`<div class="wrap wrap--wide">` is used only with `.grid--3/--4` and `.bento`. Prose-only pages let `.wrap` children inherit the `--measure` clamp and never add `.grid`.

---

## 10. CONSISTENCY CONTRACT (binding for every page & all build agents)

1. **One `:root`.** Tokens come only from §1. Zero per-page `:root` overrides; zero body-class palette forks. No invented values.
2. **One hue.** `--accent` = verified only, ~3% of pixels, never a button/card/nav fill, never a second glow. Error desaturates (`--accent-dead`); idle dims (`--accent-idle`).
3. **One surface recipe.** Every card/panel/tier/step uses `--plate` + `--sheen`. Elevate by luminance step (`--panel`→`--register`→`--engraved`). `--well` is the only sunk surface. **Zero black drop-shadows; zero `#000`/`#fff`; zero grey-hex borders.**
4. **Mono is load-bearing.** All numerals/prices/hex/units/IDs/labels are mono + `tabular-nums`. Eyebrows uppercase mono `+.09em`; data labels `+.12em`.
5. **Three weights only** (400/510/640). Prose/lede clamp to `--measure`; headings `text-wrap:balance`, `p` `text-wrap:pretty`. Tracking monotonic by size.
6. **CTA inverts.** `.btn--primary` & `.nav__cta` = `#EAF2EE` on `#08090A`. One `.btn--primary` per viewport. Glass (`backdrop-filter`) only on nav/`.ui`/`.hud`.
7. **One signature.** One artifact + one Calibration Sweep per page (marketing/platform/pricing/evidence). Hover = one luminance step, no lift. Two curves, four durations.
8. **Fail-open + reduced-motion-safe.** Nothing legible gates on JS; `.reveal`/artifact ship visible/sealed end-state. Every animation has a `reduce` override.
9. **A11y floor.** Interactive targets ≥44px; focus ring `--focus-ring`; `--ink-3` is the legible-text floor; `--ink-4` large-text only.
10. **Shared shell.** Nav + footer markup copied verbatim; only `aria-current` and footer link sets vary. Footer order fixed (Compiler · Surfaces · Trust · Company · Legal).
11. **Kill-list (no exceptions).** guilloche, Bayer-dither/WebGL ambient field, crop marks, ghost ordinals, ruler ticks, sparks, dual stage-lights, warm room, second hue, accent-as-button-fill, black drop-shadows, frosted cards, bounce/spring/parallax/scroll-jack.

---

## 11. BUILD / QA CHECKLIST

**Tokens & type**
- [ ] Exactly one `:root` in `kolm-2026.css`; no per-page `:root`, no body-class palette fork.
- [ ] Only Geist Sans + Geist Mono preloaded; Switzer/Spline/Cabinet preloads deleted.
- [ ] Only weights 400/510/640 used; no 590, no 700+.
- [ ] Every numeral/price/hex/unit/ID/label renders in mono with `tabular-nums`.
- [ ] Prose/lede clamp to `--measure` (38rem); shell `--maxw` (1200), `--maxw-wide` (1320) only on grids/bento.

**Color & material**
- [ ] No `#000`, no `#fff`, no grey-hex borders anywhere (`grep` for `#000`, `#fff`, `#ccc`-style hex on `border`).
- [ ] No black `box-shadow` (only `--plate`, `--accent-glow`, inset wells).
- [ ] `--accent` ≤ ~3% of pixels; never a `background`/fill on `.btn`, `.nav__cta`, `.card`, `.tier`.
- [ ] `backdrop-filter` only on `.nav`/`.ui`/`.hud`; `@supports` fallback present.
- [ ] Exactly one `--paper` artifact and one `--well` console region per page where applicable.

**Components & templates**
- [ ] Exactly one `.btn--primary` visible per viewport-height of scroll.
- [ ] Nav + footer markup matches the canonical shell; footer order = Compiler · Surfaces · Trust · Company · Legal.
- [ ] Page `<body>` carries a `t-*` class; sections appear in the template's fixed order; each opens with an `.eyebrow`.
- [ ] Inputs are sunk (`--well` + inset shadow); accent appears only on focus/success/spinner/verdict; errors use `--accent-dead`.

**Motion & a11y**
- [ ] One artifact + one Calibration Sweep per page; fires once; `unobserve` after; killed off-viewport.
- [ ] `prefers-reduced-motion:reduce` ships the sealed end-state and disables reveals/sweep/spinner.
- [ ] Artifact ships `class="artifact is-sealed"` server-side (never blank with JS off).
- [ ] All interactive targets ≥44px; `:focus-visible` shows `--focus-ring`; nav toggle syncs `aria-expanded`.
- [ ] Contrast spot-check: body text never uses `--ink-4`; muted ink never on `--paper`.

**Regression**
- [ ] No bounce/spring/parallax/scroll-jack; only `--ease-out`/`--ease-mat` curves; only the 4 durations.
- [ ] Kill-list clean: no guilloche, dither/WebGL field, crop marks, ghost ordinals, ruler ticks, dual stage-lights, second hue.

---

## 12. DETERMINISM RULES (for the 29 page-rebuild agents)

1. Spacing only from `--s1..--s10`; vertical gaps only from `--rhy-1/2/3`. 2. Prose always `max-width:var(--measure)`. 3. Shell = `--maxw`; `--maxw-wide` only for grid/bento. 4. Grids only via the 6 utilities in §4 — no ad-hoc `grid-template-columns`. 5. Every surface uses `--plate` + `--sheen`; nothing invents its own shadow. 6. Hover = luminance step (`--panel`→`--register`), `.15s`, `--ease-mat`. 7. Accent only as verdict. 8. Copy nav/footer verbatim; vary only `aria-current` + link sets.

---

## 13. DEPRECATED ALIASES (do not author new rules against these)

- **Palette names:** old `--paper` (meaning the *room*) → `--room`; old `--paper-2` → `--panel`; old `--paper-sink`/`--raised` → `--well`/`--register`; `--accent-text` → `--accent`. Use canonical names from §1 only.
- **Weights:** `--weight-display:590` → `--w-display:640`; `--weight-text` → `--w-body`; `--weight-ui` → `--w-ui:510`.
- **Motion:** `--dur-fast`, `--ease`, `--ease-exp`, `--ease-spring*`, `--ease-enter` (when spring) → use `--dur-micro/enter/tick/sweep` + `--ease-out`/`--ease-mat`. Springs must not be used.
- **CTA:** any `.btn--primary`/`.nav__cta` rule that fills with `--accent` is removed; CTAs invert to `--cta-fill` on `--cta-ink`.
- **Fonts:** Switzer/Spline/Cabinet `@font-face` and preloads are deleted.

---

<!-- SUPERSEDED: This document supersedes and replaces — docs/KOLM_DESIGN_SYSTEM_2026.md, docs/UNICORN-DESIGN-2026.md, docs/KOLM_BLACK_UNICORN_SPEC.md, docs/GRAPHICS-SPEC-2026.md, docs/PRODUCT_SURFACE_SPEC_2026-05-20.md. Mark those five as historical; build only from this file + docs/design/art-direction-2026.md. -->
