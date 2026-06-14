# Refine Delta-Spec 2026 — assembled design-system update

Status: implementation-ready. Single source of truth that merges six subsystem
designs (`dynamic-background`, `dynamic-graphics`, `contrast-readability`,
`cta-system`, `rich-nav`, `datasheet-component`) into one ordered set of changes
for three files:

- `public/kolm-2026.css`
- `public/kolm-2026.js`
- canonical nav in `public/pricing.html` (then propagate to all `public/**/*.html`)

> All line numbers below are verified against the **current** files (the
> subsystem specs were authored against stale snapshots — their cited lines are
> superseded by the anchors here). Apply changes by matching the quoted text,
> not by line number.

---

## 0. Conflict resolution (binding decisions)

These conflicts existed across the six inputs. Resolved once, here.

| # | Conflict | Sources | Decision |
|---|----------|---------|----------|
| C1 | **`.field` is two different things** — CSS-only masked `<span>` at `z-index:-1` (dynamic-background) vs JS-injected `<canvas>` at `z-index:-3` (dynamic-graphics). A `.field`/`.field--band` canvas slot already exists at CSS L896-898. | dynamic-background §3, dynamic-graphics §2, existing L896 | **CSS-only wins.** Ship the Phosphor Field as a pure-CSS masked layer (GPU `transform`/`opacity`, no canvas, no RAF render loop, fail-open with JS off). The JS-canvas approach is dropped (heavier, paints every frame, needs a buffer). Reuse the **existing `.field` element name** but give it the new CSS-only ruleset; the legacy canvas rules at L896-898 are replaced. Pointer coupling is the only JS (writes `--mx/--my`). |
| C2 | **Sheet ink hex differ** — `#161A1D / #383F3A / #545B56` (contrast-readability) vs `#16191C / #39403A / #545B56` (datasheet-component). | contrast-readability §1, datasheet-component §1 | **Use datasheet-component's set** (`#16191C / #39403A / #545B56 / #0A6E45`) — both pass AA/AAA; this set is the one paired with the full register-component rewrite below, so keep them coherent. Add `--sheet-pip-idle:#A9B0A6`. |
| C3 | **`--field-blob` shape** — `#3FE5A01A` 8-digit-with-alpha (dynamic-background) vs `#3FE5A0` + separate `--field-alpha:.06` (dynamic-graphics). | dynamic-background §1, dynamic-graphics §1 | **Use the 8-digit alpha tokens** (`--field-blob`, `--field-haze`, `--field-veil`, `--field-fade`) — they drive the CSS-only field directly with no per-gradient alpha math. Drop `--field-alpha` (canvas-only). |
| C4 | **`--nav-h` value** — stays `56px` vs bump to `64px`. | existing L88, rich-nav §1 | **Bump to `64px`** (Series-C breathing room; rich-nav is the canonical nav owner). |
| C5 | **Nav CTA always-solid mechanism** — drop `is-solid` + plain rule (cta-system, contrast-readability) vs `!important` override (rich-nav). | cta-system §4, contrast-readability §5, rich-nav §3 | **Drop `is-solid` entirely; NO `!important`.** The `.nav__cta:not(.is-solid)` ghost rule is the only thing that made it transient — delete it and the CTA is unconditionally solid by plain specificity. `!important` is unnecessary once the conflicting rule is gone and violates the house "no !important war" rule (CSS header L12). |
| C6 | **Hero CTA "opacity gating" bug** — specs say remove `opacity` from `.hero__cta` / `heroEnter`. | cta-system §3, contrast-readability §4 | **Reality check:** `.hero__cta` has **no** opacity rule (L585). The at-rest-hidden behavior comes from `@keyframes heroEnter{from{opacity:0…}}` applied via `.js-reveal .hero [data-enter]{…backwards}` (L918-926). This is **already JS-off-safe** (gated by `.js-reveal`, which only exists when JS runs) and reduced-motion-safe (L912-913 / the `no-preference` wrapper). **No change required** to satisfy "CTAs render with JS off." Leave `heroEnter` intact; do NOT add a redundant `opacity:1` rule. The only hero-CTA edit is the ghost-button visibility fix (§4). |
| C7 | **Phosphor pip vs register tick-in** — datasheet-component adds a `.register__pip`; dynamic-graphics adds a `.register__k::after` tick-in underline on row hover. | datasheet-component §3, dynamic-graphics §3 | **Keep both** — they're orthogonal (pip = verified status dot at row end; tick-in = hover affordance under the label). Merge into one register block. |
| C8 | **Register label/value recipe** authored twice with minor diffs. | contrast-readability §2, datasheet-component §3 | **Use datasheet-component's block verbatim** (richer: row hover-lift, units, pip, sig-row). Fold in contrast-readability's only unique adds (`.artifact .register__v b{color:var(--sheet-ink)}` is already covered; verdict base color covered). |
| C9 | **`--line-micro` delete** vs micro-grid still referenced. | dynamic-background §1 | The hero grid that consumed micro-hairlines is being deleted (§3). Grep shows `--line-micro` has **zero other consumers** → safe to delete. |

---

## 1. `public/kolm-2026.css` — ordered changes

### 1.1 Tokens (`:root`)

**(a) Delete dead `--line-micro`** — current L42:
```css
  --line-micro:rgba(255,255,255,.04); /* hairline micro-grid              */
```
Remove the line (zero consumers after §1.4).

**(b) Add Phosphor-Field + easing + pip tokens** — after the accent block (after current L51, `--accent-edge` line):
```css
  /* ── PHOSPHOR FIELD — one scoped, masked atmosphere layer (CSS-only) ── */
  --field-blob:#3FE5A01A;               /* aurora blob, ~10% accent        */
  --field-haze:#3FE5A00F;               /* outer haze, ~6%                 */
  --field-veil:rgba(255,255,255,.018);  /* cool depth lift                 */
  --field-fade:84%;                     /* section mask cutoff             */
  --ease-out-quad:cubic-bezier(.25,.46,.45,.94);   /* nav popovers         */
  --ease-out-quart:cubic-bezier(.165,.84,.44,1);   /* register tick-in     */
```

**(c) Confirm CTA tokens** — current L53-54 already define `--cta-fill / --cta-ink /
--cta-fill-hover / --cta-fill-press`. **Add** the four ghost tokens after L54:
```css
  --cta-ghost-bg:rgba(255,255,255,.045); --cta-ghost-bg-h:rgba(255,255,255,.09);
  --cta-ghost-bd:rgba(255,255,255,.22);  --cta-ghost-bd-h:rgba(255,255,255,.34);
```

**(d) Bump `--nav-h`** — current L88: `--nav-h:56px;` → `--nav-h:64px;`.

**(e) Add nav popover tint** — in the same row as `--nav-h`:
```css
  --nav-pop-bg:rgba(15,16,17,.94);
```

**(f) ON-SHEET ink — replace 4 hex + add pip** — current L113-116. Replace the three
ink values and the accent, append the pip token:
```css
  /* ── ON-SHEET ink palette — fenced to the lit --paper artifact only ── */
  --sheet-ink:#16191C;      /* values — 16.8:1 on paper (was #1B1E22)      */
  --sheet-ink-2:#39403A;    /* sub-values / no-<b> mono — 7.4:1 (was #4C554F) */
  --sheet-ink-3:#545B56;    /* register labels — 5.4:1 AA (was #6B746E FAIL) */
  --sheet-line:rgba(17,22,19,.10); --sheet-line-2:rgba(17,22,19,.26);
  --sheet-accent:#0A6E45;   /* "in spec" verdict — 5.4:1 AA (was #0B7A4C)  */
  --sheet-high:#B3401F;
  --sheet-pip-idle:#A9B0A6; /* unlit pip on paper (non-text, 3:1+)         */
```
> Note: the duplicate `--sheet-accent:#0B7A4C` in the `.compiler-site--paper` scope
> at L1079 is a separate paper theme — leave it (audit surfaces are deliberately
> separate per project memory).

### 1.2 Body floor — kill the fixed wash (no seam bleed)

Current L143-147:
```css
body{margin:0;overflow-x:clip;color:var(--ink-2);
  /* L1 ROOM — calm near-black + ONE faint phosphor glow, nothing else moving */
  background:radial-gradient(1200px 720px at 50% -320px,var(--accent-wash),transparent 70%),var(--room);
  background-attachment:fixed;
  font-size:var(--fs-body);letter-spacing:var(--track-body);}
```
Replace with (atmosphere now lives in `.field`, scoped per-section):
```css
body{margin:0;overflow-x:clip;color:var(--ink-2);background:var(--room);
  font-size:var(--fs-body);letter-spacing:var(--track-body);}
```

### 1.3 Buttons — final spec (replace L287-301)

Replace `.btn` … `.btn svg` (L287-301) with:
```css
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;
  font:var(--w-ui) var(--fs-sm)/1 var(--font-sans);letter-spacing:-.006em;
  padding:0 18px;min-height:var(--ctrl-min);border:1px solid transparent;border-radius:var(--r-md);
  cursor:pointer;white-space:nowrap;text-decoration:none;-webkit-tap-highlight-color:transparent;
  transition:background var(--dur-micro) var(--ease-mat),border-color var(--dur-micro) var(--ease-mat),
             color var(--dur-micro) var(--ease-mat),box-shadow var(--dur-micro) var(--ease-mat);}
.btn--primary{background:var(--cta-fill);color:var(--cta-ink);border-color:transparent;
  box-shadow:inset 0 1px 0 #fff,inset 0 -1px 0 rgba(8,9,10,.18);font-weight:var(--w-display);}
.btn--primary:hover{background:var(--cta-fill-hover);}
.btn--primary:active{background:var(--cta-fill-press);box-shadow:inset 0 1px 1px rgba(8,9,10,.22);}
.btn--primary:focus-visible{box-shadow:var(--focus-ring),inset 0 1px 0 #fff;}
.btn--ghost{background:var(--cta-ghost-bg);color:var(--ink);border-color:var(--cta-ghost-bd);
  box-shadow:inset 0 1px 0 var(--line-top);}
.btn--ghost:hover{background:var(--cta-ghost-bg-h);border-color:var(--cta-ghost-bd-h);color:var(--ink);}
.btn--ghost:active{background:rgba(255,255,255,.06);}
.btn--sm{min-height:var(--ctrl-min-sm);padding:0 13px;font-size:13px;}
.btn[disabled],.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;pointer-events:none;}
.btn svg{width:15px;height:15px;}
.btn--primary svg{opacity:.85;}
```
Leave `.btn.is-loading*` (L302-307) unchanged (spinner top-color `--accent` is the only
sanctioned accent-on-button). Focus-visible base (L199-200) already covers `.btn`.

### 1.4 Hero + Phosphor Field (replace L565, L569-577; edit L585-587)

**(a)** `.hero` (L565) — keep, ensure `isolation:isolate;z-index:0` (already present).

**(b)** Replace the grid layer `.hero::after` (L569-577) with the masked field +
its layers:
```css
/* ── PHOSPHOR FIELD — one GPU-only, section-clipped atmosphere (replaces grid) ── */
.field{position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden;
  -webkit-mask-image:radial-gradient(120% 100% at 50% 0%,#000 0%,#000 var(--field-fade),transparent 100%);
          mask-image:radial-gradient(120% 100% at 50% 0%,#000 0%,#000 var(--field-fade),transparent 100%);}
.field canvas{display:block;width:100%;height:100%;}   /* keep: legacy canvas slot, harmless */
.field--band{position:absolute;inset:0;z-index:-1;pointer-events:none;}
/* L1 — slow aurora drift: 2 low-freq accent blobs + cool veil, GPU transform only */
.field::before{content:"";position:absolute;inset:-25%;
  background:
    radial-gradient(38% 44% at 28% 32%,var(--field-blob),transparent 70%),
    radial-gradient(34% 40% at 74% 64%,var(--field-haze),transparent 72%),
    radial-gradient(60% 50% at 50% 6%,var(--field-veil),transparent 76%);
  will-change:transform;transform:translate3d(0,0,0);animation:field-drift 52s linear infinite;}
/* L2 — pointer-reactive depth glow */
.field::after{content:"";position:absolute;inset:0;
  background:radial-gradient(620px circle at var(--mx,50%) var(--my,30%),var(--accent-wash),transparent 60%);
  opacity:.9;transition:opacity 400ms var(--ease-mat);will-change:transform;}
@keyframes field-drift{
  0%{transform:translate3d(0,0,0) scale(1.04);}
  50%{transform:translate3d(-3%,2.5%,0) scale(1.10);}
  100%{transform:translate3d(0,0,0) scale(1.04);}}
@media(prefers-reduced-motion:reduce){.field::before{animation:none;}}
@media(hover:none),(pointer:coarse){.field::after{display:none;}}
```
> This **supersedes** the legacy `.field`/`.field--band` canvas rules at L896-898
> (delete those three lines — `.field canvas` is re-declared above for any leftover
> markup; the canvas approach from dynamic-graphics is NOT adopted, see C1).

**(c)** Hero ghost CTA (L585-587) — make ghost AA-visible:
```css
.hero__cta{display:flex;gap:12px;margin-top:var(--s6);flex-wrap:wrap;}
.hero__cta .btn{min-height:46px;padding:0 22px;font-size:15px;}
.hero__cta .btn--ghost{background:var(--cta-ghost-bg);color:var(--ink);border-color:var(--cta-ghost-bd);}
.hero__cta .btn--ghost:hover{background:var(--cta-ghost-bg-h);border-color:var(--cta-ghost-bd-h);color:var(--ink);}
```
> No `opacity` rule here (see C6 — `heroEnter` already fail-open).

### 1.5 NAV — Series-C instrument bar (replace L530-562)

Replace the entire nav block from `.nav__links` (L530) through the closing
`@media (max-width:820px){…}` (L562). Deletes `.nav__icon` and the
`.nav__cta:not(.is-solid)` rules (C5).
```css
.nav__links{display:flex;align-items:center;gap:var(--s2);margin-inline:auto;}
.nav__top{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 12px;border-radius:var(--r-md);
  font:var(--w-ui) 14px/1 var(--font-sans);letter-spacing:-.006em;color:var(--ink-2);background:transparent;border:0;cursor:pointer;
  transition:color var(--dur-micro) var(--ease-mat),background var(--dur-micro) var(--ease-mat);}
.nav__top:hover,.nav__top[aria-expanded="true"]{color:var(--ink);background:rgba(255,255,255,.05);}
.nav__top[aria-current]{color:var(--ink);position:relative;}
.nav__top[aria-current]::after{content:"";position:absolute;left:12px;right:12px;bottom:-2px;height:1.5px;
  background:var(--accent);transform-origin:left;border-radius:2px;}
.nav__caret{width:12px;height:12px;opacity:.7;transition:transform var(--dur-micro) var(--ease-mat);}
.nav__top[aria-expanded="true"] .nav__caret{transform:rotate(180deg);}
.nav__group{position:relative;}
.nav__pop{position:absolute;top:calc(100% + 8px);left:0;min-width:280px;padding:8px;display:grid;gap:2px;
  background:var(--nav-pop-bg);-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
  border-radius:var(--r);box-shadow:var(--plate),0 24px 60px -28px rgba(0,0,0,.7);
  opacity:0;visibility:hidden;transform:translateY(-6px);pointer-events:none;
  transition:opacity var(--dur-micro) var(--ease-out-quad),transform var(--dur-micro) var(--ease-out-quad),visibility var(--dur-micro);}
.nav__group:hover .nav__pop,.nav__group:focus-within .nav__pop,.nav__top[aria-expanded="true"]+.nav__pop{
  opacity:1;visibility:visible;transform:none;pointer-events:auto;}
.nav__pop a{display:grid;gap:2px;padding:9px 12px;border-radius:var(--r-md);border-bottom:0;}
.nav__pop a b{color:var(--ink);font:var(--w-ui) 14px/1.2 var(--font-sans);letter-spacing:-.01em;}
.nav__pop a span{color:var(--ink-3);font:var(--w-body) 12px/1.3 var(--font-mono);}
.nav__pop a:hover,.nav__pop a:focus-visible{background:rgba(255,255,255,.06);}
.nav__actions{margin-left:0;display:flex;align-items:center;gap:var(--s3);}
.nav__status{display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:0 6px;border-bottom:0;
  font:var(--w-ui) 12px/1 var(--font-mono);letter-spacing:.04em;color:var(--ink-2);}
.nav__status i{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);flex:none;}
.nav__rule{width:1px;height:20px;background:var(--line-2);flex:none;}
.nav__cta{background:var(--cta-fill);color:var(--cta-ink);border:1px solid transparent;
  border-radius:var(--r-pill);padding:0 16px;font-weight:var(--w-display);
  box-shadow:inset 0 1px 0 #fff,inset 0 -1px 0 rgba(8,9,10,.18);}
.nav__cta:hover{background:var(--cta-fill-hover);color:var(--cta-ink);}
.nav__cta:active{background:var(--cta-fill-press);}
.nav.is-scrolled{background:rgba(8,9,10,.82);box-shadow:inset 0 1px 0 0 var(--line-top),0 1px 0 var(--line);}
.nav__toggle{display:none;align-items:center;justify-content:center;width:44px;height:44px;
  margin-left:var(--s2);background:transparent;border:1px solid var(--line-2);border-radius:var(--r-md);color:var(--ink);cursor:pointer;}
.nav__toggle svg{width:20px;height:20px;}.nav__toggle:hover{border-color:var(--ink-3);}
.theme-toggle{display:none;}
@media(prefers-reduced-motion:reduce){.nav__pop,.nav__caret{transition:none;}}
@media (max-width:980px){
  .nav__toggle{display:inline-flex;}
  .nav__actions .nav__status,.nav__actions .nav__rule,.nav__actions .btn--ghost:not(.nav__cta){display:none;}
  .nav__links{position:absolute;top:var(--nav-h);left:0;right:0;z-index:49;flex-direction:column;align-items:stretch;gap:0;margin:0;
    padding:var(--s3) max(var(--gutter),env(safe-area-inset-left));background:var(--panel);border-bottom:1px solid var(--line);
    display:none;max-height:calc(100dvh - var(--nav-h));overflow-y:auto;overscroll-behavior:contain;}
  .nav.is-open .nav__links{display:flex;}
  .nav__group{position:static;}
  .nav__top{min-height:50px;padding:0;font-size:16px;justify-content:space-between;border-bottom:1px solid var(--line);border-radius:0;}
  .nav__top[aria-current]::after{display:none;}
  .nav__pop{position:static;min-width:0;padding:4px 0 8px 12px;background:none;backdrop-filter:none;box-shadow:none;
    opacity:1;visibility:visible;transform:none;display:none;}
  .nav__top[aria-expanded="true"]+.nav__pop{display:grid;}
  .nav__pop a span{display:none;}
}
```
> Drop the old `.nav__cta`/`.nav__cta:not(.is-solid)`/`.nav__icon` rules (L536-546)
> entirely — superseded above. Breakpoint moves 820 → 980px (richer bar needs it).

### 1.6 Misused non-text tokens on real text (contrast)

- `.well .ln` (L282): `--ink-4` → `--ink-3` (line-numbers are read).
- `.ui__step::after` ordinal: `--ink-4` → `--ink-3` (grep `ui__step` for current line).
- `.regmark` border (L616): keep `--ink-4` (decorative-on-paper).
- Add a one-line comment at the `--ink-4` token asserting it is **large-text-only**;
  `--ink-faint`/`--accent-idle` carry zero readable content.

### 1.7 DATASHEET register component (replace L623-637)

Replace `.artifact .register*` … the reduced-motion block (L623-637) with:
```css
.artifact .register{padding:0;color:var(--sheet-ink-2);gap:0;}
.artifact .register__row{grid-template-columns:104px 1fr;align-items:baseline;gap:16px;
  padding:11px 0;border-bottom:1px solid var(--sheet-line);position:relative;
  transition:background var(--dur-micro) var(--ease-mat),padding-left var(--dur-micro) var(--ease-mat);}
.artifact .register__row:hover{background:rgba(17,22,19,.045);
  padding-left:8px;margin-inline:-8px;padding-right:8px;border-radius:var(--r-sm);}
.artifact .register__k{color:var(--sheet-ink-3);font-size:10px;font-weight:var(--w-ui);
  letter-spacing:.13em;padding-top:2px;}
/* hover tick-in under the label (forensic "alive" read) */
.artifact .register__k::after{content:"";position:absolute;left:0;bottom:-1px;height:1px;width:36px;
  background:var(--sheet-accent);transform:scaleX(0);transform-origin:left;
  transition:transform var(--dur-micro) var(--ease-out-quart);}
.artifact .register__row:hover .register__k::after{transform:scaleX(1);}
.artifact .register__v{display:flex;align-items:baseline;gap:6px;color:var(--sheet-ink);
  font-size:15px;opacity:1;word-break:normal;font-variant-numeric:tabular-nums;}  /* resting opacity:1 */
.artifact .register__v b{color:var(--sheet-ink);font-weight:var(--w-display);
  font-variant-numeric:tabular-nums;letter-spacing:-.01em;}
.artifact .register__u{color:var(--sheet-ink-2);font-size:12px;font-weight:var(--w-body);}
.artifact .register__row--sig .register__v{font-size:12.5px;word-break:break-all;}
.artifact .register__row--sig b{font-weight:var(--w-ui);}
/* verified phosphor pip — lit only when sealed (3% accent rule) */
.artifact .register__pip{width:6px;height:6px;border-radius:50%;margin-left:auto;flex:none;
  align-self:center;background:var(--sheet-pip-idle);transition:background var(--dur-micro) var(--ease-mat);}
.is-sealed .register__pip{background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.artifact__verdict span{font-family:var(--font-mono);letter-spacing:.09em;text-transform:uppercase;
  color:var(--sheet-ink-2);}                              /* was --ink-4 (invisible on paper) */
.is-sealed .artifact__verdict span{color:var(--sheet-accent);font-weight:var(--w-ui);}
.is-sealed .artifact__check path{stroke:var(--sheet-accent);stroke-dashoffset:0;}
/* fade ONLY the one animating, motion-allowed sweep — never the resting state */
@media(prefers-reduced-motion:reduce){.artifact__scan{display:none;}}
@media(prefers-reduced-motion:no-preference){
  [data-sweep] .artifact:not(.is-sealed) .register__v[data-val]{opacity:0;transition:opacity .12s var(--ease-mat);}
}
```
> Deletes the old `.artifact .register__v{…opacity:0…}` (L627), the bare
> `.is-sealed .register__v{opacity:1}` (L633), and the `--ink-4` verdict (L629).
> Keeps `.is-sealed.artifact` shadow (L635) and the check-stroke transition (L639).
> The dark-room `.register` (L419-434) is **untouched**.

### 1.8 Optional dynamic-graphics extras (defer-safe, additive)

Low priority; ship only if §1.1-1.7 land clean. Append near the artifact block:
```css
/* verified-metric fill bar (shares the count-up IO; JS-off → full bar) */
.metric__fill{display:block;height:2px;background:var(--accent-idle);border-radius:2px;
  margin-top:6px;transform:scaleX(0);transform-origin:left;}
.in .metric__fill{background:var(--accent);transform:scaleX(1);
  transition:transform var(--dur-tick) var(--ease-out-expo);}
@media(prefers-reduced-motion:reduce){.metric__fill{transform:scaleX(1);transition:none;}}
```
Requires also adding `--ease-out-expo:cubic-bezier(.19,1,.22,1);` to `:root` if used.
(Section-divider mask-fade from dynamic-graphics §6 is deferred — cosmetic.)

---

## 2. `public/kolm-2026.js` — ordered changes

1. **Delete `wireNavCta()` entirely** (L75-91) and its call in `init()` (L147).
   The CTA is now always solid via CSS (C5). Removes the `is-solid` IntersectionObserver.

2. **Extend `wireNav()`** — after the existing toggle/Esc/outside-click handlers
   (after L70, before the closing `}`), add dropdown a11y + scroll-glass:
```js
    // dropdown a11y: click toggles aria-expanded; Esc & focus-out close
    nav.querySelectorAll('[data-menu]').forEach(function (g) {
      var btn = g.querySelector('.nav__top'); if (!btn) return;
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        nav.querySelectorAll('.nav__top[aria-expanded]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      g.addEventListener('keydown', function (e) { if (e.key === 'Escape') { btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
      g.addEventListener('focusout', function () { requestAnimationFrame(function () { if (!g.contains(document.activeElement)) btn.setAttribute('aria-expanded', 'false'); }); });
    });
    // glass thickens on scroll
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 8); };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
```

3. **Outside-click reset** — in the existing `document.addEventListener('click', …)`
   handler (L65-70), also reset open menus:
```js
        nav.querySelectorAll('.nav__top[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
```

4. **Phosphor-Field pointer coupling** — add a new function and call it from `init()`:
```js
  // ---- Phosphor Field: feed --mx/--my (fine pointer + motion-allowed only).
  // No render loop — drift is pure CSS; JS only writes two vars, rAF-throttled. ----
  function wireField() {
    var mqMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
    var mqFine = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)');
    if (!mqFine || !mqFine.matches || (mqMotion && mqMotion.matches)) return;
    document.querySelectorAll('.field').forEach(function (f) {
      var sec = f.parentElement; if (!sec) return; var raf = 0;
      sec.addEventListener('pointermove', function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          var r = sec.getBoundingClientRect();
          f.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
          f.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
          raf = 0;
        });
      }, { passive: true });
    });
  }
```
   Update `init()`: `wireNavCta()` removed, `wireField()` added:
```js
  function init() { syncThemeColor(); wireReveal(); wireNav(); wirePointerLight(); wireField(); wireCount(); }
```

5. **(Optional, with §1.8)** Artifact sweep stagger — only if `data-sweep` markup +
   §1.8 land. In the `wireReveal` IO callback, when an `.artifact` enters and motion
   is allowed: `remove('is-sealed')`, stagger `.register__v[data-val]` opacity in read
   order (`120 + i*70`ms), then re-add `is-sealed`. Fail-open end-state is CSS
   (`opacity:1` + lit pip), so JS-off is safe. Defer if §1.8 is deferred.

> **Do NOT** add a `.field` canvas injector (dynamic-graphics §2) — the field is
> CSS-only (C1). The existing `wirePointerLight()` (L95-112) stays as-is.

---

## 3. Canonical NAV markup — `public/pricing.html` (replace L47-71)

Replace the entire `<header class="nav">…</header>` (current L47-71) with the
grouped instrument bar. **No `is-solid` class** on the CTA; status dot + rule live
in `.nav__actions`.
```html
<header class="nav" data-nav>
  <div class="wrap nav__in">
    <a class="nav__brand" href="/" aria-label="kolm home">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="4.5" height="20" rx=".4"/><rect x="13" y="9" width="4.5" height="14" rx=".4"/><rect x="22" y="12" width="4.5" height="8" rx=".4"/></svg>
      <span>kolm</span>
    </a>
    <nav class="nav__links" id="navLinks" aria-label="Primary">
      <div class="nav__group" data-menu>
        <button class="nav__top" type="button" aria-expanded="false" aria-haspopup="true" aria-controls="m-platform">Platform
          <svg class="nav__caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="nav__pop" id="m-platform" role="menu">
          <a role="menuitem" href="/platform"><b>Overview</b><span>The compiler, end to end</span></a>
          <a role="menuitem" href="/how-it-works"><b>How it works</b><span>Capture · Compile · Compose · Deploy</span></a>
          <a role="menuitem" href="/runtimes"><b>Runtime targets</b><span>Where artifacts deploy</span></a>
          <a role="menuitem" href="/integrations"><b>Integrations</b><span>Pipelines &amp; SDKs</span></a>
          <a role="menuitem" href="/spec"><b>Spec</b><span>The .kolm format</span></a>
        </div>
      </div>
      <div class="nav__group" data-menu>
        <button class="nav__top" type="button" aria-expanded="false" aria-haspopup="true" aria-controls="m-dev">Developers
          <svg class="nav__caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="nav__pop" id="m-dev" role="menu">
          <a role="menuitem" href="/docs"><b>Docs</b><span>Guides &amp; API reference</span></a>
          <a role="menuitem" href="/account/api-control-center"><b>API control</b><span>Keys, usage, limits</span></a>
          <a role="menuitem" href="/verify"><b>Verify</b><span>Check any .kolm artifact</span></a>
          <a role="menuitem" href="/changelog"><b>Changelog</b><span>Shipped this cycle</span></a>
        </div>
      </div>
      <a class="nav__top" href="/pricing" aria-current="page">Pricing</a>
      <a class="nav__top" href="/trust">Trust</a>
    </nav>
    <div class="nav__actions">
      <a class="nav__status" href="/status"><i></i>Operational</a>
      <span class="nav__rule" aria-hidden="true"></span>
      <a class="btn btn--ghost btn--sm" href="/account/overview">Sign in</a>
      <a class="btn nav__cta" href="/signup">Get an API key <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
    </div>
    <button class="nav__toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    </button>
  </div>
</header>
```
**Per-page `aria-current`:** set on the matching top link (Pricing/Trust) OR on the
parent `.nav__group > .nav__top` button (`aria-current="true"`) for child pages.
**Propagation:** copy this block to every page under `public/` (and `public/account/*`,
`public/solutions/*`, `public/docs/*`, `public/security/*`), flipping only `aria-current`.
CSS/JS live once in the two shared files.

---

## 4. Per-page HTML mirrors (hero artifact + CTA)

Apply to the 3 hero pages (`index.html`, `platform.html`, `pricing.html`):

**(a)** Add the field element as the hero's first child (decorative, AT-invisible):
```html
<section class="hero" data-sweep>
  <span class="field" aria-hidden="true"></span>
  …
```
Add the same `<span class="field" aria-hidden="true"></span>` as the first child of
any `.cta`/`.cta-final`/`.cta-band` you want lit.

**(b)** Hero CTA pair (verbatim, one primary + one ghost):
```html
<div class="hero__cta">
  <a class="btn btn--primary" href="/signup">Get an API key</a>
  <a class="btn btn--ghost" href="/docs">Read the docs</a>
</div>
```

**(c)** Artifact register rows — every value gets `<b>` + `register__u` + `register__pip`
(kills the blank SIGNATURE row):
```html
<dl class="register">
  <div class="register__row"><dt class="register__k">Latency</dt>
    <dd class="register__v" data-val><b>388</b><span class="register__u">ms</span><i class="register__pip"></i></dd></div>
  <div class="register__row"><dt class="register__k">Artifact</dt>
    <dd class="register__v" data-val><b>142</b><span class="register__u">MB</span><i class="register__pip"></i></dd></div>
  <div class="register__row"><dt class="register__k">Targets</dt>
    <dd class="register__v" data-val><b>5</b><span class="register__u">runtimes ranked</span><i class="register__pip"></i></dd></div>
  <div class="register__row register__row--sig"><dt class="register__k">Signature</dt>
    <dd class="register__v" data-val><b>sha256</b><span class="register__u">:a1f0&hellip;</span><i class="register__pip"></i></dd></div>
</dl>
```

---

## 5. Acceptance gate

- **Contrast (JS-off):** all register labels ≥5.4:1, values ≥16:1, IN-SPEC verdict
  ≥5.4:1, ghost border ≥3:1 non-text, ghost label ~17:1, nav links 13:1. SIGNATURE row paints.
- **CTA:** exactly one solid primary + one visible ghost per viewport; nav CTA always
  solid (no scroll swap, no `!important`); reduced-motion + JS-off render all CTAs at full opacity.
- **Field:** no dot/line grid; one masked layer, faded to 84% (no top/seam bleed);
  GPU-only (`transform`/`opacity`); `prefers-reduced-motion` → static; coarse pointer → no reactive glow.
- **Nav:** grouped popovers keyboard-operable (click/Enter/Esc), mobile accordion ≤980px,
  status dot + rule + ghost + solid CTA right-aligned; brand left; links centered.
- **No regressions:** `--accent` stays ≤3% (washes are 6-10% alpha, never full); dark-room
  `.register` untouched; audit/paper surfaces (`.compiler-site--paper`, L1079) untouched.
