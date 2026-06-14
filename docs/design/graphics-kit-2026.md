# Kolm Artisanal Graphics Kit — 2026

> One assembled, drop-in kit that retires the "bare rectangle" everywhere. All graphics
> sit on the existing glass organs (`.field` → `.instrument`/`.kolm-art` → lit `.kolm`),
> reuse the fenced token palette, animate **only** `transform`/`opacity`/`stroke-dashoffset`
> (compositor-safe), are reduced-motion / reduced-transparency / forced-colors safe, and keep
> green (`--accent #3FE5A0`) to ≈3% of pixels = the *verified* moment.
>
> Touch points: `public/kolm-2026.css` (tokens + classes) and `public/index.html` +
> per-page `feat__ui` / `plate` slots (see placement map). The hero `.pipe`
> (`index.html` L122–168) is an **in-place upgrade**; everything else is a new sibling SVG
> that **replaces a `plate plate--rows` or `kolm-art` rectangle**.

---

## 12-LINE SUMMARY

1. Eight subsystems ship as one kit: an upgraded `.card`/`.plate`/`.panel` material plus seven crafted SVG diagram organs (`pipe⁺`, `intercept`, `runtime-ramp`, `verify-loop`, `kolm-anatomy`, `capture-stream`, `section-illustration` glyphs).
2. `card-system` kills the one-rectangle rule: every plate gains a milled top rail (`::after`), a corner registration tick, and one top-lit 40px crafted glyph (capture / compile / deploy), green only on `[data-state=ok]`.
3. `section-illustration` adds a smaller hairline glyph (`.kglyph`, viewBox 100×60, `vector-effect:non-scaling-stroke`) for the top of each feature `.card` — capture/compile/deploy variants, one green path max, hover-only flow.
4. `pipe⁺` upgrades the hero pipeline in place: beveled top-lit nodes (`#ndFace`), a single-source specular top edge (`.nd-hi`), a faint always-on phosphor `.flow`, and a traveling bright `.flow-pulse` = "behavior captured."
5. `intercept` renders the no-rewrite thesis: app → [Kolm wedge] → provider pass-through wire, with capture branching **off** the wire (dashed `.icpt-tap`) into a paper-lit `behavior.kolm`.
6. `runtime-ramp` is the runtime-fit graphic: one `.kolm` ranked across phone→laptop→edge→server with size/cost/latency; bar width = latency proxy; only the in-spec rung (`.is-fit`) is green.
7. `verify-loop` is the trust kernel: `.kolm + key → hash → signature check → VALID|VOID`, driven by a `data-vl` attribute (fail-open valid), failure uses the fenced `--void`, never a second accent.
8. `kolm-anatomy` is the SVG exploded view of a `.kolm` — four signed isometric layers (model/recipe/evals/receipt) bound by one Ed25519 seal; the upgrade path off the flat `<pre>` ASCII art.
9. `capture-stream` is the live ledger: an API line enters glass and crystallizes into governed, signed `.kolm` rows that land top→down with verdict ticks; the last row gets the seal.
10. All motion is gated behind `[data-art-reveal]` + `prefers-reduced-motion:no-preference`; reduced-motion renders a still, fully-formed, fully-readable diagram; forced-colors maps to system canvas/link.
11. Accessibility is uniform: decorative SVG is `aria-hidden="true"`; meaning lives in the `<figure aria-label>` (full data sentence). Contrast holds — `--ink` on glass and `--sheet-ink` on paper both pass AA/AAA.
12. Token additions are minimal and fenced (no new accents): `--nd-*`, `--flow-*`, `--ramp-*`, `--vl-*`, `--anat-*`, `--cap-*`, `--mill`/`--tick`/`--glyph-*`, `--glyph-w/-stroke/-h/-line/-dim` — all derived from the existing accent/line/ink ramps.

---

## PLACEMENT MAP — which graphic replaces which rectangle

| Page | Section (anchor / line) | Existing rectangle | Replace with | Note |
|------|------------------------|--------------------|--------------|------|
| **index.html** | Hero (L122–168) `figure.instrument > svg.pipe` | flat `.pipe` nodes + single dashed `.flow` | **pipe⁺** (in-place: defs + `.nd-hi` bevels + `.flow`/`.flow-pulse`) | Upgrade, don't replace geometry. viewBox 440×372 stays. |
| index.html | "Capture→compile→deploy" cards (L177–194) | 3 bare `.card` | **card-system** (milled rail + tick + `.card__glyph`) | glyphs: capture / compile / deploy; `data-state="ok"` lights compile+deploy. |
| index.html | Capture feat (L212–223) `plate plate--rows` | CAPTURE LOG rows plate | **capture-stream** `figure.instrument > svg.cap` | live ledger replaces the static prow list. |
| index.html | Compile feat (L239–253) `figure.kolm-art > pre` | ASCII `<pre>` tree | **kolm-anatomy** `figure.anat > svg` | SVG exploded view; keep figure `aria-label`. |
| index.html | Deploy feat (L268–279) `plate plate--rows` | RUNTIME TARGETS rows plate | **runtime-ramp** `figure.instrument.runtime-ramp > svg.ramp` | phone→server ranked rungs; `.is-fit` = green. |
| index.html | Evidence (L300–333) `.rep` | (keep) signed report | **verify-loop** *added beside it* | `.rep` is already crafted; add `verify-loop` as the trust-kernel diagram. |
| index.html | FAQ cards (L346–361) | bare `.card` | **section-illustration** `.kglyph` at top of each | optional; hairline glyphs, hover-flow only. |
| **how-it-works.html** | Capture feat (L198–200) `plate plate--rows` | CAPTURE LOG plate | **capture-stream** | same as home capture. |
| how-it-works.html | Compile&compose feat (L225–227) `plate plate--rows` | `claims-redactor.kolm` signed plate | **kolm-anatomy** | exploded view of the artifact. |
| how-it-works.html | Deploy feat (L252–254) `plate plate--rows` | RUNTIME TARGETS plate | **runtime-ramp** | ranked rungs. |
| **platform.html** | Capture feat (L217–219) `plate plate--rows` | CAPTURE LOG plate | **capture-stream** | |
| platform.html | Compile feat (L244–246) `plate plate--rows` | `claims-redactor.kolm` plate | **kolm-anatomy** | |
| platform.html | Compose feat (L271–273) `plate plate--rows` | OBJECT MODEL plate | **(keep)** rows plate | data-dense table — leave as plate, add milled rail via `card-system`. |
| platform.html | Deploy feat (L298–300) `plate plate--rows` | RUN & PROOF plate | **runtime-ramp** | |
| platform.html | Hero eyebrow (L97) "DROP-IN PROXY" | no graphic | **intercept** (add `figure.instrument > svg.icpt`) | renders the no-rewrite thesis next to the claim. |
| **runtimes.html** | "03 · Best fit" feat (L233–235) `plate plate--rows` | DEVICE FIT plate | **runtime-ramp** | canonical home for this organ. |
| runtimes.html | "04 · Proof in the box" feat (L262–264) `plate plate--rows` | `claims-redactor.kolm` signed plate | **kolm-anatomy** | |
| **verify.html** | Hero (L138) "Offline verification" | no hero graphic | **verify-loop** `figure.instrument.vloop` | the page's signature artifact; `data-vl="valid"`. |
| **security.html** | trust/eval plates | `plate plate--rows` | **verify-loop** (one) + `card-system` on the rest | one signature moment per page. |
| **compare.html** | comparison plates | `plate plate--rows` | **card-system** milled rail only | keep tables; no diagram needed. |
| **capabilities.html / integrations.html / docs.html** | `.card` grids | bare `.card` | **card-system** + `section-illustration` glyphs | sitewide card upgrade. |

**One-signature-moment rule:** never put two animated diagram organs in the same viewport.
Per page, at most one of {`pipe⁺`, `intercept`, `runtime-ramp`, `verify-loop`, `kolm-anatomy`,
`capture-stream`} animates; `card-system`/`section-illustration` glyph micro-motion is exempt
(reveal/hover-scoped, sub-pixel).

---

## 1. FINAL CSS — append to `public/kolm-2026.css`

### 1a. Tokens — add to `:root` (atmosphere/instrument-fenced; no new accents)

```css
/* ---- graphics-kit-2026 tokens (all derived from existing accent/line/ink ramps) ---- */
/* pipe⁺ */
--nd-fill:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.014));
--nd-bevel-top:rgba(255,255,255,.18); --nd-shadow:rgba(0,0,0,.45);
--flow-core:#3FE5A0; --flow-halo:#3FE5A0;            /* pulse = the one moment */
/* runtime-ramp */
--ramp-rung-h:54px; --ramp-gap:10px;
--ramp-fill:rgba(255,255,255,.025);                  /* idle bar (= .pipe .chip) */
--ramp-fit:var(--accent-soft);                       /* selected rung wash */
--ramp-bar-idle:var(--line-2); --ramp-bar-fit:var(--accent);
/* verify-loop */
--vl-void:#E0A89F;                                   /* fail tone (reuses --void family) */
--vl-trace:rgba(255,255,255,.06);                    /* idle data path */
--vl-dash:14 320;                                    /* sealed-pulse comet */
/* kolm-anatomy */
--anat-plate:rgba(255,255,255,.022); --anat-edge:rgba(255,255,255,.07);
--anat-shadow:rgba(4,8,9,.55); --anat-dy:14;         /* px y-offset per layer */
/* capture-stream */
--cap-row:rgba(255,255,255,.022);                    /* ledger row fill */
--cap-tick:var(--accent-scan);                       /* governed tick */
--cap-flow:var(--accent);                            /* live capture line */
--cap-dash:14 10;                                    /* stream dash rhythm */
/* card-system */
--mill:linear-gradient(180deg,rgba(255,255,255,.05),transparent 3px); /* milled top edge */
--tick:var(--line-top);                              /* corner registration mark */
--glyph-ink:rgba(255,255,255,.34);                   /* engraved glyph stroke */
--glyph-lit:var(--accent);                           /* lit ONLY when [data-state=ok] */
--r-plate:var(--r);
/* section-illustration (.kglyph) */
--glyph-stroke:1.25; --glyph-h:rgba(255,255,255,.10);  /* top highlight */
--glyph-line:rgba(255,255,255,.16); --glyph-dim:var(--ink-4);
```

### 1b. card-system — append after line ~386 (after the `.card`/`.plate` material block)

```css
/* every plate gets a milled top rail + a registration tick — not a bare box */
.card,.plate,.panel{overflow:clip;}
.card::after,.plate::after,.panel::after{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;
  background:var(--mill);
  -webkit-mask:linear-gradient(#000,#000);mask:linear-gradient(#000,#000);}
.card>.tick{position:absolute;top:8px;right:8px;width:9px;height:9px;z-index:2;
  border-top:1px solid var(--tick);border-right:1px solid var(--tick);
  opacity:.5;transition:opacity 180ms var(--ease-mat);}
.card:hover>.tick{opacity:.9;}
/* the crafted glyph — fills the reserved .card__art slot, 40px, top-lit */
.card__glyph{display:block;width:40px;height:40px;margin:0 0 var(--s4);
  color:var(--glyph-ink);overflow:visible;}
.card__glyph [stroke]{stroke:currentColor;stroke-width:1.25;fill:none;
  stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.card__glyph .face{fill:rgba(255,255,255,.025);}      /* lit top facet */
.card__glyph .edge{stroke:var(--line-top);}           /* one-source highlight edge */
.card[data-state=ok] .card__glyph{color:var(--glyph-lit);}
.card[data-state=ok] .card__glyph .gleam{opacity:1;}
.card__glyph .gleam{opacity:0;stroke:var(--accent);transition:opacity 220ms var(--ease-mat);}
.reveal .card__glyph{transform:translateY(3px);opacity:0;
  transition:transform 420ms var(--ease-mat),opacity 420ms var(--ease-mat);}
.reveal.in .card__glyph{transform:none;opacity:1;}
@media (prefers-reduced-motion:reduce){.reveal .card__glyph{transform:none;opacity:1;transition:none;}}
@media (prefers-reduced-transparency:reduce),(forced-colors:active){
  .card::after,.plate::after,.panel::after{display:none;}}
```

### 1c. pipe⁺ — REPLACE the existing `.pipe` block (kolm-2026.css L1190–1210)

```css
.pipe{display:block;width:100%;height:auto;}
.pipe text{font-family:var(--font-mono);}
/* nodes: top-lit beveled plates (one light source, contact shadow) */
.pipe .nd{fill:url(#ndFace);stroke:var(--line-2);stroke-width:1;filter:url(#ndShadow);}
.pipe .nd-hi{fill:none;stroke:var(--nd-bevel-top,rgba(255,255,255,.18));stroke-width:1;} /* 1px top specular */
.pipe .nd-art{fill:url(#ndArt);stroke:none;filter:url(#ndShadow);}
.pipe .spine{stroke:var(--line-2);stroke-width:1.4;fill:none;stroke-linecap:round;}
/* base flow: a faint always-on phosphor trace (verified spine) */
.pipe .flow{stroke:var(--accent);stroke-width:1.6;fill:none;stroke-linecap:round;opacity:.32;}
/* the pulse: a short bright dash traveling the spine = "behavior captured" */
.pipe .flow-pulse{stroke:var(--accent);stroke-width:2.2;fill:none;stroke-linecap:round;
  stroke-dasharray:14 198;stroke-dashoffset:212;filter:drop-shadow(0 0 5px var(--accent-glow));}
.pipe .lbl{fill:var(--ink);font-size:12.5px;font-weight:var(--w-ui);letter-spacing:.01em;}
.pipe .lbl-art{fill:var(--sheet-ink);font-size:12.5px;font-weight:var(--w-display);}
.pipe .sub{fill:var(--ink-3);font-size:9px;letter-spacing:.05em;}
.pipe .sub-art{fill:var(--sheet-ink-2);font-size:8.5px;letter-spacing:.10em;text-transform:uppercase;}
.pipe .tag{fill:var(--ink-4);font-size:8px;letter-spacing:.18em;text-transform:uppercase;}
.pipe .ok{fill:var(--accent);}
.pipe .ok-stroke{stroke:var(--accent);stroke-width:1.4;fill:none;stroke-linecap:round;stroke-linejoin:round;}
.pipe .chip{fill:rgba(255,255,255,.025);stroke:var(--line);stroke-width:1;}
.pipe .chip-t{fill:var(--ink-2);font-size:9px;letter-spacing:.04em;}
.pipe .seal{fill:var(--sheet-accent);}
.pipe .reg{stroke:var(--line);stroke-width:1;}        /* registration tick at each node corner */
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .pipe .flow-pulse{animation:pipe-pulse 3.6s cubic-bezier(.45,0,.55,1) infinite;}
  [data-art-reveal] .pipe .flow{animation:pipe-breathe 3.6s ease-in-out infinite;}
}
@keyframes pipe-pulse{0%{stroke-dashoffset:212;}70%,100%{stroke-dashoffset:0;}}
@keyframes pipe-breathe{0%,100%{opacity:.24;}50%{opacity:.42;}}
@media (prefers-reduced-motion:reduce){.pipe .flow{opacity:.4;} .pipe .flow-pulse{display:none;}}
```

### 1d. intercept — append after the `.pipe` block

```css
/* INTERCEPT — drop-in proxy: pass-through wire + the no-rewrite capture wedge */
.icpt{display:block;width:100%;height:auto;}
.icpt text{font-family:var(--font-mono);}
.icpt .spine{stroke:var(--line-2);stroke-width:1.4;fill:none;}
.icpt .nd{fill:rgba(255,255,255,.02);stroke:var(--line-2);stroke-width:1;}
.icpt .nd-art{fill:var(--paper);stroke:none;}
.icpt .lbl{fill:var(--ink);font-size:12.5px;font-weight:var(--w-ui);letter-spacing:.01em;}
.icpt .lbl-art{fill:var(--sheet-ink);font-size:12px;font-weight:var(--w-display);letter-spacing:.01em;}
.icpt .sub{fill:var(--ink-3);font-size:9px;letter-spacing:.04em;}
.icpt .sub-art{fill:var(--sheet-ink-2);font-size:8.5px;letter-spacing:.06em;}
.icpt .tag{fill:var(--ink-4);font-size:8px;letter-spacing:.18em;text-transform:uppercase;}
/* the wedge — only lit node on the wire (accent = active intercept) */
.icpt-kolm{fill:rgba(63,229,160,.05);stroke:var(--accent);stroke-width:1.4;
  filter:drop-shadow(0 0 7px var(--accent-glow));}
.icpt-kolm + text{fill:var(--accent);}
.icpt .flow{stroke:var(--accent);stroke-width:1.6;fill:none;stroke-linecap:round;
  stroke-dasharray:10 290;stroke-dashoffset:300;}
.icpt-tap{stroke:var(--accent);stroke-width:1.3;fill:none;stroke-linecap:round;
  stroke-linejoin:round;stroke-dasharray:3 4;opacity:.85;}                    /* recording branch */
.icpt-pip{fill:var(--accent);}
.icpt-seal{stroke:var(--sheet-accent);stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round;}
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .icpt .flow{animation:icpt-flow 3.2s cubic-bezier(.4,0,.6,1) infinite;}
  [data-art-reveal] .icpt-pip{animation:icpt-tap 3.2s cubic-bezier(.4,0,.6,1) infinite;
    transform-box:fill-box;transform-origin:center;will-change:transform,opacity;}
}
@keyframes icpt-flow{0%{stroke-dashoffset:300;}60%,100%{stroke-dashoffset:0;}}
@keyframes icpt-tap{0%,45%{transform:scale(1);opacity:.5;}
  60%{transform:scale(1.9);opacity:1;}100%{transform:scale(1);opacity:.5;}}
@media (prefers-reduced-motion:reduce){.icpt .flow{stroke-dashoffset:0;}}
```

### 1e. runtime-ramp — append after the `.pipe` block

```css
.runtime-ramp{isolation:isolate;}
.ramp .rng{fill:var(--ramp-fill);stroke:var(--line-2);stroke-width:1;}
.ramp .bar{fill:var(--ramp-bar-idle);opacity:.5;transform-origin:left center;will-change:transform;}
.ramp .rl{fill:var(--ink);font:var(--w-display) 13px var(--font-sans);letter-spacing:.01em;}
.ramp .rs{fill:var(--ink-4);font-size:8.5px;letter-spacing:.10em;text-transform:uppercase;}
.ramp .rc{fill:var(--ink-3);font-size:11px;}
.ramp .rt{fill:var(--ink-4);font-size:9px;letter-spacing:.04em;}
.ramp .tick{stroke:var(--accent);stroke-width:1.4;fill:none;stroke-linecap:round;stroke-linejoin:round;}
/* the one selected, in-spec rung — green is verdict, ~3% of pixels */
.ramp .is-fit .rng{fill:var(--ramp-fit);stroke:var(--accent-edge);}
.ramp .is-fit .bar{fill:var(--accent);opacity:.16;}
.ramp .is-fit .rl{fill:var(--accent);}
.ramp .is-fit .rc{fill:var(--accent);}
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .ramp .bar{transform:scaleX(0);animation:ramp-grow var(--dur-sweep) var(--ease-out) forwards;}
  [data-art-reveal] .ramp .rung:nth-child(3) .bar{animation-delay:.07s;}
  [data-art-reveal] .ramp .rung:nth-child(4) .bar{animation-delay:.14s;}
  [data-art-reveal] .ramp .rung:nth-child(5) .bar{animation-delay:.21s;}
  [data-art-reveal] .ramp .is-fit .rng{animation:ramp-fit 2.6s var(--ease-mat) infinite;}
}
@keyframes ramp-grow{to{transform:scaleX(1);}}
@keyframes ramp-fit{0%,100%{filter:drop-shadow(0 0 0 transparent);}50%{filter:drop-shadow(0 0 6px var(--accent-glow));}}
@media (prefers-reduced-motion:reduce){.ramp .bar{transform:none;animation:none;}}
```

### 1f. verify-loop — append after the `.pipe` block

```css
.vl{margin-top:6px}
.vl .vl-trace{stroke:var(--vl-trace);stroke-width:1.6;fill:none}
.vl .vl-flow{stroke:var(--accent);stroke-width:1.8;fill:none;stroke-linecap:round;
  stroke-dasharray:var(--vl-dash);stroke-dashoffset:334}
.vl-band{fill:var(--accent-soft);stroke:var(--accent-edge);stroke-width:1}
.vl-text{fill:var(--accent);font:var(--w-display) 11px/1 var(--font-mono);
  letter-spacing:.14em;text-transform:uppercase}
.vl-mark{stroke-width:1.9;fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:0;
  transform-box:fill-box;transform-origin:center}
.vl-ok{stroke:var(--accent);--ox:-26px;transform:translateX(-26px)}
.vl-void{stroke:var(--vl-void);--ox:0px}
.vloop[data-vl="valid"] .vl-ok{opacity:1}
/* VOID — single source swap, no new layer */
.vloop[data-vl="void"] .vl-flow{stroke:var(--vl-void)}
.vloop[data-vl="void"] .vl-band{fill:var(--void-soft);stroke:var(--void-edge)}
.vloop[data-vl="void"] .vl-text{fill:var(--vl-void)}
.vloop[data-vl="void"] .vl-void{opacity:1}
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .vl-flow{animation:vl-seal 3.6s var(--ease-out) infinite}
  [data-art-reveal] .vloop[data-vl] .vl-mark{animation:vl-stamp 3.6s var(--ease-out) infinite}
}
@keyframes vl-seal{0%{stroke-dashoffset:334}60%,100%{stroke-dashoffset:0}}
@keyframes vl-stamp{0%,58%{opacity:0;transform:scale(.85) translateX(var(--ox,0))}
  66%{opacity:1;transform:scale(1.12) translateX(var(--ox,0))}
  72%,100%{opacity:1;transform:scale(1) translateX(var(--ox,0))}}
@media (prefers-reduced-motion:reduce){
  .vl-flow{stroke-dashoffset:0;animation:none}
  .vloop[data-vl] .vl-mark{animation:none}}
@media (forced-colors:active){
  .vl-band{fill:Canvas;stroke:CanvasText}.vl-text,.vl-flow{stroke:LinkText;fill:LinkText}}
```

### 1g. kolm-anatomy — append after the `.kolm-art` block

```css
.anat{position:relative;border-radius:var(--r-lg);padding:18px 20px;overflow:hidden;isolation:isolate;
  background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--glass-tint);
  -webkit-backdrop-filter:blur(18px) saturate(165%);backdrop-filter:blur(18px) saturate(165%);
  border:1px solid var(--line-2);border-top-color:var(--line-top);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 30px 70px -30px rgba(0,0,0,.7);}
@supports not (backdrop-filter:blur(1px)){.anat{background:var(--register);}}
.anat__hd{display:flex;justify-content:space-between;font:var(--w-ui) 10px/1 var(--font-mono);
  letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:13px;
  padding-bottom:11px;border-bottom:1px solid var(--line);}
.anat svg{display:block;width:100%;height:auto;}
.anat .face{fill:var(--anat-plate);stroke:var(--anat-edge);stroke-width:1;}
.anat .bevel{stroke:var(--line-top);stroke-width:1;fill:none;opacity:.6;}      /* top-light edge */
.anat .lead{stroke:var(--line);stroke-width:1;fill:none;stroke-dasharray:2 3;}  /* leader lines */
.anat .lbl{fill:var(--ink);font:var(--w-display) 12px/1 var(--font-mono);letter-spacing:.01em;}
.anat .sub{fill:var(--ink-3);font:var(--w-ui) 8.5px/1 var(--font-mono);letter-spacing:.10em;text-transform:uppercase;}
.anat .reg{stroke:var(--ink-4);stroke-width:1;fill:none;}                       /* corner reg marks */
.anat .seal{fill:var(--accent);}
.anat .seal-ring{stroke:var(--accent);stroke-width:1.4;fill:none;}
.anat .scan{stroke:var(--accent);stroke-width:1.4;fill:none;stroke-linecap:round;
  stroke-dasharray:8 240;stroke-dashoffset:248;opacity:.9;}
.anat .layer{transform:translateY(0);transition:transform .5s var(--ease-mat);}
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .anat .scan{animation:anat-scan 3.6s cubic-bezier(.4,0,.6,1) infinite;}
  [data-art-reveal] .anat .seal-ring{animation:inst-pulse 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center;}}
@keyframes anat-scan{0%{stroke-dashoffset:248;}55%,100%{stroke-dashoffset:0;}}
@media (prefers-reduced-transparency:reduce){.anat .face{fill:rgba(255,255,255,.05);}}
```

### 1h. capture-stream — append after the `.pipe` block

```css
.cap{display:block;width:100%;height:auto;font-family:var(--font-mono);}
.cap-flow{fill:none;stroke:var(--cap-flow);stroke-width:1.6;stroke-linecap:round;opacity:.16;}
.cap-stream{fill:none;stroke:var(--cap-flow);stroke-width:1.6;stroke-linecap:round;
  stroke-dasharray:var(--cap-dash);}
.cap-gate{fill:rgba(255,255,255,.025);stroke:var(--line-2);stroke-width:1;}
.cap-eye{fill:var(--accent);}
.cap-tag{fill:var(--ink-4);font-size:8px;letter-spacing:.18em;text-transform:uppercase;}
.cap-bg{fill:var(--cap-row);stroke:var(--line);stroke-width:1;}
.cap-id{fill:var(--ink-3);font-size:9px;letter-spacing:.04em;}
.cap-fill{fill:rgba(255,255,255,.10);}
.cap-ok{fill:none;stroke:var(--cap-tick);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;}
.cap-seal{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;
  filter:drop-shadow(0 0 3px var(--accent-glow));}
@media (prefers-reduced-motion:no-preference){
  [data-art-reveal] .cap-stream{animation:cap-run 3.4s linear infinite;}
  [data-art-reveal] .cap-eye{animation:inst-pulse 2.4s ease-in-out infinite;}
  [data-art-reveal] .cap-r{opacity:0;animation:cap-land .5s var(--ease-out) forwards;
    animation-delay:calc(.5s + var(--i)*.32s);}
}
@keyframes cap-run{to{stroke-dashoffset:-48;}}
@keyframes cap-land{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion:reduce){.cap-r{opacity:1;}}
```

### 1i. section-illustration (.kglyph) — append after the `.kolm-art` block

```css
.kglyph{display:block;width:100%;height:auto;aspect-ratio:5/3;border-radius:var(--r-md);
  background:linear-gradient(180deg,rgba(255,255,255,.025),transparent 40%),rgba(255,255,255,.012);
  box-shadow:inset 0 1px 0 var(--glyph-h),inset 0 0 0 1px var(--line);isolation:isolate;overflow:hidden;}
.kglyph *{vector-effect:non-scaling-stroke;}
.kglyph .ln{stroke:var(--glyph-line);stroke-width:var(--glyph-stroke);fill:none;stroke-linecap:round;stroke-linejoin:round;}
.kglyph .dim{stroke:var(--glyph-dim);stroke-width:1;fill:none;stroke-dasharray:2 3;}
.kglyph .fill{fill:rgba(255,255,255,.03);stroke:var(--glyph-line);stroke-width:1;}
.kglyph .ok{stroke:var(--accent);stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round;
  filter:drop-shadow(0 0 4px var(--accent-glow));}
.kglyph .seal{fill:var(--accent);}
.kglyph .reg{stroke:var(--glyph-dim);stroke-width:1;}
.kglyph .t{fill:var(--ink-3);font:var(--w-ui) 8px/1 var(--font-mono);letter-spacing:.04em;}
.kglyph .flow{stroke:var(--accent);stroke-width:1.5;fill:none;stroke-linecap:round;
  stroke-dasharray:5 7;stroke-dashoffset:0;}
@media(prefers-reduced-motion:no-preference){
  .card:hover .kglyph .flow{animation:kg-flow 2.6s linear infinite;will-change:stroke-dashoffset;}}
@keyframes kg-flow{to{stroke-dashoffset:-24;}}
@media(prefers-reduced-motion:reduce){.kglyph .flow{animation:none;}}
@media(prefers-contrast:more){.kglyph .ok,.kglyph .flow{filter:none;}}
```

---

## 2. REUSABLE SVG COMPONENTS

### 2a. pipe⁺ `<defs>` — paste once inside `<svg class="pipe">`, before content

```html
<defs>
  <linearGradient id="ndFace" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity=".055"/>
    <stop offset="1" stop-color="#FFFFFF" stop-opacity=".014"/>
  </linearGradient>
  <linearGradient id="ndArt" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F8F6F0"/><stop offset="1" stop-color="#E9E6DD"/>
  </linearGradient>
  <radialGradient id="flowGlow"><stop offset="0" stop-color="#3FE5A0" stop-opacity=".9"/>
    <stop offset="1" stop-color="#3FE5A0" stop-opacity="0"/></radialGradient>
  <filter id="ndShadow" x="-20%" y="-20%" width="140%" height="160%">
    <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".5"/></filter>
</defs>
```

**Per-node markup deltas (in `index.html` `.pipe`):**
- For each `<rect class="nd" x y width height>`, add a sibling top-bevel: `<path class="nd-hi" d="M{x+1} {y+1} h{w-2}"/>`.
- Add a registration tick at each node's top-left: `<path class="reg" d="M{x} {y+6} v-6 h6"/>`.
- Replace the single `<path class="flow" d="M220 38 L220 250"/>` with two stacked paths sharing that `d`: first `class="flow"`, then `class="flow-pulse"`.
- Keep the `.kolm-art` artifact node lit via `fill="url(#ndArt)"` (the one paper-lit object).

### 2b. intercept — full figure (drop into an `.instrument` slot)

```html
<figure class="instrument" data-art-reveal aria-label="Kolm is a drop-in proxy: your app's OpenAI and Anthropic API calls pass straight through to the provider unchanged — no rewrite — while Kolm captures the behavior off the wire and compiles it into one signed .kolm artifact.">
  <div class="instrument__bar"><span>intercept &middot; <b>drop-in proxy</b></span><span class="live">capturing</span></div>
  <svg class="icpt" viewBox="0 0 440 176" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="spine" d="M70 56 H370"/>
    <rect class="nd" x="22" y="38" width="96" height="36" rx="5"/>
    <text class="lbl" x="70" y="60" text-anchor="middle">your app</text>
    <text class="sub" x="70" y="74" text-anchor="middle">SDK unchanged</text>
    <rect class="icpt-kolm" x="178" y="34" width="84" height="44" rx="6"/>
    <text class="lbl" x="220" y="54" text-anchor="middle">Kolm</text>
    <text class="tag" x="220" y="67" text-anchor="middle">no rewrite</text>
    <rect class="nd" x="322" y="38" width="96" height="36" rx="5"/>
    <text class="lbl" x="370" y="60" text-anchor="middle">provider</text>
    <text class="sub" x="370" y="74" text-anchor="middle">OpenAI &middot; Anthropic</text>
    <path class="flow" d="M70 56 H370"/>
    <path class="icpt-tap" d="M220 78 V104 q0 8 8 8 H300"/>
    <circle class="icpt-pip" cx="220" cy="78" r="2.4"/>
    <rect class="nd-art" x="300" y="98" width="118" height="50" rx="5"/>
    <text class="lbl-art" x="316" y="120">behavior.kolm</text>
    <text class="sub-art" x="316" y="135">model + recipe + evals + receipt</text>
    <path class="icpt-seal" d="M384 113 l4 4 l8 -9"/>
    <text class="tag" x="160" y="128">captured off the wire</text>
  </svg>
</figure>
```

### 2c. runtime-ramp — full figure

```html
<figure class="instrument runtime-ramp" data-art-reveal
  aria-label="Runtime fit: the same claims-redactor.kolm ranked across four runtimes. Phone: 142 MB, $0.00 per thousand calls, 96 ms — selected, in spec. Laptop: 142 MB, $0.04, 71 ms. Edge: 142 MB, $0.21, 39 ms. Server: 142 MB, $0.90, 12 ms. Kolm runs it on the smallest runtime that fits.">
  <div class="instrument__bar"><span>runtime &middot; <b>claims-redactor.kolm</b></span><span class="live">fit</span></div>
  <svg class="pipe ramp" viewBox="0 0 440 300" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
    <text class="tag" x="22" y="14">smallest runtime that fits &middot; 142 mb</text>
    <text class="tag" x="418" y="14" text-anchor="end">cost/1k &middot; p50</text>
    <g class="rung is-fit" transform="translate(0 24)">
      <rect class="rng" x="22" y="0" width="396" height="54" rx="6"/>
      <rect class="bar" x="22" y="0" width="44"  height="54" rx="6"/>
      <text class="rl" x="38" y="24">phone</text>
      <text class="rs" x="38" y="40">142 MB &middot; on-device</text>
      <text class="rc" x="404" y="24" text-anchor="end">$0.00</text>
      <text class="rt" x="404" y="40" text-anchor="end">96 ms</text>
      <path class="tick" d="M380 21 l4 4 l8 -9"/>
    </g>
    <g class="rung" transform="translate(0 88)">
      <rect class="rng" x="22" y="0" width="396" height="54" rx="6"/>
      <rect class="bar" x="22" y="0" width="120" height="54" rx="6"/>
      <text class="rl" x="38" y="24">laptop</text><text class="rs" x="38" y="40">142 MB &middot; local</text>
      <text class="rc" x="404" y="24" text-anchor="end">$0.04</text><text class="rt" x="404" y="40" text-anchor="end">71 ms</text>
    </g>
    <g class="rung" transform="translate(0 152)">
      <rect class="rng" x="22" y="0" width="396" height="54" rx="6"/>
      <rect class="bar" x="22" y="0" width="248" height="54" rx="6"/>
      <text class="rl" x="38" y="24">edge</text><text class="rs" x="38" y="40">142 MB &middot; regional</text>
      <text class="rc" x="404" y="24" text-anchor="end">$0.21</text><text class="rt" x="404" y="40" text-anchor="end">39 ms</text>
    </g>
    <g class="rung" transform="translate(0 216)">
      <rect class="rng" x="22" y="0" width="396" height="54" rx="6"/>
      <rect class="bar" x="22" y="0" width="396" height="54" rx="6"/>
      <text class="rl" x="38" y="24">server</text><text class="rs" x="38" y="40">142 MB &middot; hosted</text>
      <text class="rc" x="404" y="24" text-anchor="end">$0.90</text><text class="rt" x="404" y="40" text-anchor="end">12 ms</text>
    </g>
  </svg>
</figure>
```
> `:nth-child` indices: 1=text,2=text,3–6=rungs (markup order above). Bar width = latency proxy.

### 2d. verify-loop — full figure (set `data-vl="void"` for the failure frame)

```html
<figure class="instrument vloop" data-vl="valid" data-art-reveal
  aria-label="Verify loop: a .kolm artifact plus a public key are hashed; the hash is checked against the embedded Ed25519 signature. The result is a single verdict — valid, or void.">
  <div class="instrument__bar"><b>verify loop</b><span class="live">Ed25519</span></div>
  <svg class="pipe vl" viewBox="0 0 440 232" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
    <rect class="nd" x="22"  y="14" width="150" height="40" rx="5"/>
    <text class="lbl" x="38" y="32">.kolm</text><text class="sub" x="38" y="46">142 mb · sealed artifact</text>
    <rect class="nd" x="268" y="14" width="150" height="40" rx="5"/>
    <text class="lbl" x="284" y="32">public key</text><text class="sub" x="284" y="46">ed25519 · 32 b</text>
    <path class="spine" d="M97 54 L220 84 M343 54 L220 84"/>
    <rect class="nd" x="150" y="84" width="140" height="40" rx="5"/>
    <text class="lbl" x="166" y="102">hash</text><text class="sub" x="166" y="116">blake3 · 256-bit digest</text>
    <text class="tag" x="270" y="100" text-anchor="end">Σ</text>
    <path class="spine" d="M220 124 L220 148"/>
    <rect class="nd" x="150" y="148" width="140" height="40" rx="5"/>
    <text class="lbl" x="166" y="166">signature check</text><text class="sub" x="166" y="180">compare · constant-time</text>
    <path class="spine" d="M220 188 L220 206"/>
    <g class="vl-verdict">
      <rect class="vl-band" x="158" y="206" width="124" height="22" rx="11"/>
      <path class="vl-mark vl-ok"   d="M196 217 l4 4 l8 -9"/>
      <path class="vl-mark vl-void" d="M196 212 l8 8 m0 -8 l-8 8"/>
      <text class="vl-text" x="216" y="221">valid</text>
    </g>
    <path class="vl-trace" d="M97 54 L220 84 L220 124 L220 148 L220 188 L220 206"/>
    <path class="vl-flow"  d="M97 54 L220 84 L220 124 L220 148 L220 188 L220 206"/>
  </svg>
</figure>
```
> For `void`, set `data-vl="void"` **and** swap the `<text class="vl-text">` content to `void`.

### 2e. kolm-anatomy — figure (replaces the `<pre>`; repeat the layer block 4×, y += --anat-dy=14)

```html
<figure class="anat" data-art-reveal aria-label="Exploded view of one .kolm file: four signed layers — a distilled model, the exact build recipe, six eval gates, and a sha256 receipt — bound by one Ed25519 signature you can verify offline.">
  <div class="anat__hd"><span>Inside a .kolm</span><span>exploded view</span></div>
  <svg viewBox="0 0 360 300" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
    <path class="reg" d="M8 8h10 M8 8v10 M352 292h-10 M352 292v-10"/>
    <!-- LAYER block — repeat 4×: model(y0) · recipe(y14) · evals(y28) · receipt(y42) -->
    <g class="layer"><path class="face" d="M70 30 L250 30 L290 52 L110 52 Z"/>
      <path class="bevel" d="M70 30 L250 30 L290 52"/>
      <path class="lead" d="M290 41 L330 41"/>
      <text class="lbl" x="78" y="46">model</text>
      <text class="sub" x="334" y="38">your behavior</text>
      <text class="sub" x="334" y="48">distilled</text></g>
    <g class="layer"><path class="face" d="M70 72 L250 72 L290 94 L110 94 Z"/>
      <path class="bevel" d="M70 72 L250 72 L290 94"/>
      <path class="lead" d="M290 83 L330 83"/>
      <text class="lbl" x="78" y="88">recipe</text>
      <text class="sub" x="334" y="84">exact build + sources</text></g>
    <g class="layer"><path class="face" d="M70 114 L250 114 L290 136 L110 136 Z"/>
      <path class="bevel" d="M70 114 L250 114 L290 136"/>
      <path class="lead" d="M290 125 L330 125"/>
      <text class="lbl" x="78" y="130">evals</text>
      <text class="sub" x="334" y="126">6 gates it must pass</text></g>
    <g class="layer"><path class="face" d="M70 156 L250 156 L290 178 L110 178 Z"/>
      <path class="bevel" d="M70 156 L250 156 L290 178"/>
      <path class="lead" d="M290 167 L330 167"/>
      <text class="lbl" x="78" y="172">receipt</text>
      <text class="sub" x="334" y="168">sha256 + capture trace</text></g>
    <line class="scan" x1="70" y1="200" x2="250" y2="200"/>
    <circle class="seal-ring" cx="180" cy="230" r="20"/>
    <path class="seal" d="M172 230 l5 5 l11 -11" stroke="currentColor" stroke-width="2" fill="none"/>
    <text class="sub" x="180" y="268" text-anchor="middle" style="fill:var(--accent)">Ed25519 signed · verify yourself</text>
  </svg>
</figure>
```

### 2f. capture-stream — full figure

```html
<figure class="instrument" data-art-reveal aria-label="Live API traffic is captured and compiled into governed, signed .kolm ledger entries.">
  <div class="instrument__bar"><span>capture &middot; <b>stream.kolm</b></span><span class="live">live</span></div>
  <svg class="cap" viewBox="0 0 440 196" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="cap-flow" d="M0 34 H150 q14 0 14 14 V160 q0 14 14 14 H180"/>
    <path class="cap-stream" d="M0 34 H150 q14 0 14 14 V160 q0 14 14 14 H180"/>
    <rect class="cap-gate" x="138" y="18" width="32" height="32" rx="6"/>
    <circle class="cap-eye" cx="154" cy="34" r="3.5"/>
    <text class="cap-tag" x="138" y="62">CAPTURE</text>
    <g class="cap-led" transform="translate(192,18)">
      <text class="cap-tag" x="0" y="-4">GOVERNED &middot; EXAMPLES</text>
      <g class="cap-r" style="--i:0"><rect class="cap-bg" width="248" height="22" rx="4"/><text class="cap-id" x="10" y="15">REG-01</text><rect class="cap-fill" x="58" y="7" width="120" height="8" rx="2"/><path class="cap-ok" d="M222 11 l4 4 l8 -9"/></g>
      <g class="cap-r" style="--i:1" transform="translate(0,28)"><rect class="cap-bg" width="248" height="22" rx="4"/><text class="cap-id" x="10" y="15">REG-02</text><rect class="cap-fill" x="58" y="7" width="148" height="8" rx="2"/><path class="cap-ok" d="M222 11 l4 4 l8 -9"/></g>
      <g class="cap-r" style="--i:2" transform="translate(0,56)"><rect class="cap-bg" width="248" height="22" rx="4"/><text class="cap-id" x="10" y="15">REG-03</text><rect class="cap-fill" x="58" y="7" width="96" height="8" rx="2"/><path class="cap-ok" d="M222 11 l4 4 l8 -9"/></g>
      <g class="cap-r" style="--i:3" transform="translate(0,84)"><rect class="cap-bg" width="248" height="22" rx="4"/><text class="cap-id" x="10" y="15">REG-04</text><rect class="cap-fill" x="58" y="7" width="134" height="8" rx="2"/><path class="cap-ok" d="M222 11 l4 4 l8 -9"/></g>
      <g class="cap-r" style="--i:4" transform="translate(0,112)"><rect class="cap-bg" width="248" height="22" rx="4"/><text class="cap-id" x="10" y="15">REG-05</text><rect class="cap-fill" x="58" y="7" width="70" height="8" rx="2"/><path class="cap-seal" d="M222 11 l4 4 l8 -9"/></g>
    </g>
  </svg>
</figure>
```

### 2g. card-system glyph set (drop in as first child of `.card`, before `.card__k`)

```html
<!-- Capture (funnel + caught signal mote) -->
<svg class="card__glyph" viewBox="0 0 40 40" role="img" aria-label="Capture">
  <path class="face" d="M6 8h28l-9 13v9l-10 4v-13z"/>
  <path stroke d="M6 8h28l-9 13v9l-10 4v-13z"/>
  <path class="edge" d="M6 8h28"/>
  <circle class="gleam" cx="20" cy="14" r="1.6" fill="currentColor" stroke="none"/>
</svg>
<!-- Compile (stacked layers fused to one) -->
<svg class="card__glyph" viewBox="0 0 40 40" role="img" aria-label="Compile">
  <path class="face" d="M8 14l12-6 12 6-12 6z"/>
  <path stroke d="M8 14l12-6 12 6-12 6zM8 21l12 6 12-6M8 28l12 6 12-6"/>
  <path class="edge gleam" d="M8 14l12-6 12 6"/>
</svg>
<!-- Deploy (signed core radiating to targets) -->
<svg class="card__glyph" viewBox="0 0 40 40" role="img" aria-label="Deploy">
  <rect class="face" x="15" y="15" width="10" height="10" rx="1.5"/>
  <rect stroke x="15" y="15" width="10" height="10" rx="1.5"/>
  <path stroke d="M20 15V6M20 25v9M15 20H6M25 20h9"/>
  <path class="gleam" d="M17.5 20l2 2 3.5-4" stroke="currentColor"/>
</svg>
```

**Card markup contract:**
```html
<div class="card reveal" data-state="ok"><span class="tick" aria-hidden="true"></span>
  <svg class="card__glyph" …>…</svg>
  <span class="card__k">Reg · capture</span>
  <h3>…</h3><p>…</p>
</div>
```

### 2h. section-illustration (.kglyph) — drop one `<figure>` at the TOP of each feature `.card`

```html
<figure class="card__glyph" aria-hidden="true">
 <svg class="kglyph" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet">
  <path class="reg" d="M4 9V4h5M91 4h5v5M96 51v5h-5M9 56H4v-5"/>
  <!-- ===== swap body per card ===== -->
 </svg>
</figure>
```
**CAPTURE body** (calls → proxy → recording):
```html
<path class="dim" d="M10 18h22M10 42h22"/>
<rect class="fill" x="40" y="22" width="20" height="16" rx="2"/>
<path class="flow" d="M32 18h6q4 0 4 4v4M32 42h6q4 0 4-4v-4"/>
<path class="ln" d="M68 30h22"/><circle class="seal" cx="90" cy="30" r="2.2"/>
<text class="t" x="40" y="49">proxy</text>
```
**COMPILE body** (3 layers → 1 artifact):
```html
<path class="ln" d="M14 20h26M14 30h26M14 40h26"/>
<path class="flow" d="M42 30h12"/>
<rect class="fill" x="58" y="20" width="28" height="20" rx="2"/>
<path class="ok" d="M66 31l4 4 8-9"/>
<text class="t" x="58" y="48">.kolm</text>
```
**DEPLOY/VERIFY body** (artifact → smallest runtime, signed):
```html
<rect class="fill" x="12" y="22" width="20" height="16" rx="2"/>
<path class="flow" d="M34 30h10"/>
<rect class="ln" x="48" y="18" width="16" height="24" rx="2" fill="none"/>
<rect class="ln" x="70" y="24" width="12" height="12" rx="2" fill="none"/>
<path class="ok" d="M85 22l3 3 5-6"/><circle class="seal" cx="89" cy="40" r="2"/>
```

---

## 3. REPRODUCTION INVARIANTS (apply to every component)

- **One light source (top).** Bevels/highlights on top edges only — never bottom-light, never a second shadow.
- **Green = verified, ≈3% of pixels.** One green path/seal per glyph; one lit node/rung/wedge per diagram. Failure uses the fenced `--void`, never an invented second accent.
- **GPU-only motion.** Animate `transform` / `opacity` / `stroke-dashoffset` only. Never `filter`/`background-position`. Drop-shadows/bevels are static.
- **One signature moment per page** (the one-signature rule above).
- **A11y.** Decorative SVG `aria-hidden="true"`; meaning lives in the `<figure aria-label>`. Contrast holds AA/AAA on glass and paper.
- **Degrade gracefully.** `prefers-reduced-motion` → still, fully-formed diagram. `prefers-reduced-transparency` → opaque faces / `--register` fallback. `forced-colors` → system canvas/link; rails+ticks hidden.
- **Field grain shows through.** Plate fills stay translucent (`rgba(.012–.055)`) so the `.field` grain reads under every graphic — never add grain inside an SVG.
- **Hairlines.** `vector-effect:non-scaling-stroke` on `.kglyph`/`.card__glyph` keeps 1.25px at any size; diagram strokes ride the `--line`/`--line-2`/`--line-top` ramp at 1–1.4px.
```
