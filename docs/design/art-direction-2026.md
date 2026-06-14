# kolm.ai — LOCKED Art Direction 2026: "The Datasheet Machine"

> Status: **BINDING.** This is the single source of truth for `public/kolm-2026.css` and every page. Supersedes all prior concept notes.
> Date: 2026-06-14. Owner: design.
> Grounding: `docs/design/aesthetic-benchmark-2026.md` (27-teardown benchmark).

---

## 0. The synthesis (what won, what was grafted)

The winner by judge average is **swiss-machine** (26.8): a forensic measuring instrument rendered as a strict Swiss grid — the room holds the silence, the numerals hold the authority, the green only ever means *verified*. It leads.

Onto its grid skeleton we graft the two **Datasheet / Spec-Sheet** concepts (24.0 / 22.0), which scored second and third on a single, unbeatable idea: **the information architecture itself is the aesthetic — every surface a labeled register, every claim a citable control-ID, the artifact its calibration certificate. Form follows forensics.** Swiss-machine gives us discipline; the Datasheet gives that discipline a *reason* and a vocabulary (`REG-04 · TOL ±0.2 · v3.3`).

From the runners-up we take exactly one strongest organ each, and nothing more:
- **terminal-luxury (18.3):** the **single dimmed-phosphor idle sibling** of the accent, so live green reads against its own ghost. (We take the idea; we keep the *cool* room, not the warm one — see §2 ruling.)
- **quantized-reactor (17.2):** the framing of the signature as a **verb that means the brand thesis** (continuous → checkable). We fold this into the calibration sweep; we do **not** ship its WebGL Bayer-dither field (subtraction wins).
- **luminous-glass (15.7):** `saturate`-lifted glass **rationed to nav/HUD only**, and a single phosphor floor-glow under the artifact. No frosted-everywhere.
- **forensic-editorial (15.0):** the **registration marks at the artifact's corners** and uppercase mono captions as "the instrument's own handwriting."

Everything these concepts agreed on is now law: off-black room (never `#000`), one rationed accent meaning *verified* only, Geist Sans + Geist Mono, the top-light bevel as the **default** plate, near-total motion stillness, and **one** signature moment. The rejected material is explicit: no guilloche, no dither field, no dual stage-lights, no ambient WebGL, no warm room, no second hue, no decorative accent fills.

**One-line thesis:** *kolm is not a website; it is the instrument's datasheet — a strict Swiss register of citable controls in a forensic dark room, where one calibration sweep settles the proof and the only green ever printed means "in spec."*

---

## 1. TYPE SYSTEM — one decision

**Decision:** Self-hosted **Geist Sans + Geist Mono** (variable woff2), with **Mono load-bearing** for all control-IDs, register labels, units, hex, prices, and every numeral via `tabular-nums`.

- **Display** asserts at **weight 640** (kill the 590 whisper; do not go mono-display — that was terminal-luxury's bet and it lost). **UI** at off-grid **510**. **Body** 400.
- **Size-responsive tracking** (the expensive two-axis tell): hero `-0.035em` → h1 `-0.028em` → h2 `-0.020em` → body `-0.010em`; uppercase mono eyebrows/captions/control-IDs `+0.09em`.
- **Mono is the protagonist of data, Sans of prose.** No metric, price, or hex ever escapes mono. Lock OpenType features globally; ship metric-matched fallbacks (`size-adjust`/`ascent-override`) for zero CLS.
- **Prose clamps to `--measure: 38rem`** (~608px) inside the 1200px shell.

**Rationale:** Geist gives display + code a *shared designer and metrics* — the "one system" feel Cohere has and Switzer cannot fake — without trying to out-type a bespoke Pentagram face (an unwinnable axis per the benchmark). 640 out-confides pioneer's timid Helvetica display; tabular mono is the infra/fintech tell with no hacks. This is the cheapest, highest-leverage move off kolm's lowest axis (Type 7→9).

---

## 2. PALETTE — full, exact hex (BINDING)

**RULING — cool room, not warm.** Terminal-luxury's warm-black (`#0A0908`) is rejected. The room stays **cool** `#08090A`: it is locked brand equity, it preserves a single ink temperature across the canvas, and the benchmark prizes hue-coherence over a warmth gimmick. One temperature, one accent, one job each.

### Room & surfaces — luminance ladder (each step +~3–6% L, never grey, never `#000`)
| Token | Hex | Job |
|---|---|---|
| `--room` | `#08090A` | The dark examination room. The floor. Unchanged equity. |
| `--panel` | `#0F1011` | Default plate / register surface the artifact rests on. |
| `--register` | `#15171A` | Raised register-fill / lifted card. |
| `--engraved` | `#1B1E22` | Engraved-label plate / keyline-fill, the highest step. |
| `--well` | `#0C0D0E` | Sunk console / code-block floor (one *darker* surface for forensic depth). |

### Ink ramp (foreground, cool-white — the readout)
| Token | Hex | Job |
|---|---|---|
| `--ink` | `#F7F8F8` | Primary text, the brightest UI value. |
| `--ink-2` | `#D0D6E0` | Secondary / lede. |
| `--ink-3` | `#8A8F98` | Muted, captions, units. |
| `--ink-4` | `#62666D` | Faint labels, registration marks. |
| `--ink-faint` | `#3A3D42` | Microprint, near-floor. |
| `--paper` | `#F4F2EC` | **The one lit object** — the artifact sheet only. Warm off-white laid paper, never `#fff`, never a panel. This is the single high-luminance warm value on the page. |

### Hairlines — translucent foreground, never grey hex
| Token | Value | Job |
|---|---|---|
| `--line` | `rgba(255,255,255,.07)` | Default rule. |
| `--line-2` | `rgba(255,255,255,.12)` | Register divider / ring. |
| `--line-top` | `rgba(255,255,255,.16)` | Top-light specular highlight. |
| `--line-micro` | `rgba(255,255,255,.04)` | Hairline micro-grid. |

Where hue-coherence matters, prefer `color-mix(in oklab, var(--ink), 8%)` over fixed-alpha white (Cursor's move).

### Accent — `#3FE5A0`, rationed to ~3% of pixels, **verdict / in-spec ONLY**
| Token | Hex / value | State |
|---|---|---|
| `--accent` | `#3FE5A0` | **Verified / IN SPEC**, settled verdict, at full only. Never a button fill. |
| `--accent-scan` | `color-mix(in oklab, #3FE5A0 22%, transparent)` | The live calibration scan-line (in-motion). |
| `--accent-idle` | `#23493B` | **Dimmed-phosphor idle/inert sibling** (from terminal-luxury): live green reads against its own ghost. `≈ color-mix(in oklab, #3FE5A0, #15171A 62%)`. |
| `--accent-dead` | `oklch(83% 0.04 163)` | **Out-of-tolerance / error** — desaturated accent ("dead phosphor"), so the room never gains a hue. |
| `--accent-glow` | `#3FE5A033` | The ONLY glow on the page (phosphor light). Used under the sealed/verified artifact. Replaces every black drop-shadow. |
| `--accent-wash` | `#3FE5A011` | Single atmospheric backlight wash under the artifact. The only ambient chroma. |

**CTA inverts** to ink-on-room: `#EAF2EE` text on `#08090A`. The green stops meaning "click" and starts meaning "true."

### Fenced second accent
**NONE.** There is exactly one hue. Error/out-of-tolerance desaturates the accent (`--accent-dead`); idle dims it (`--accent-idle`). The room never gains a second color. This fence is binding.

---

## 3. MATERIAL / GLASS — one recipe, as the default

**Default `.plate` / `.register` recipe (applied everywhere, not as a flourish):**
```
flat luminance surface
+ inset 0 0 0 1px var(--line-2)              /* translucent ring */
+ 0 1px 0 rgba(255,255,255,.16)              /* top-light bevel  */
+ linear-gradient(180deg,#ffffff0a,transparent)  /* top sheen   */
```
This is pioneer's machined-glass bevel promoted to the **baseline** — applied universally it equals or beats their Material 9.

- **Elevation = luminance stacking only.** Move up the ladder (`--panel`→`--register`→`--engraved`). No black drop-shadows anywhere; the only emitted light is `--accent-glow` on a verified state. We fake the lamp — dark UI has no overhead light.
- **Glass is rationed to nav / HUD only:** `backdrop-filter: blur(12px) saturate(150%)`. No frosted-everywhere (luminous-glass's blur is contained here).
- **The artifact** is the one object that catches real light: it carries `--line-top` specular on its top edge, **registration marks at its four corners** (forensic-editorial), and floats over `--accent-wash` with `--accent-glow` blooming only once verified.
- **The code block / console** is the one *sunk* surface: `--well` fill, inset ring, mono, tabular gutters — density bought back here on purpose so everything around it breathes.

---

## 4. MOTION — language

**Near-total stillness is the baseline.** Restraint so the one moment lands.
- Hover/focus `.15s`; entrances `.4s`. Two shared curves only: easeOutQuart `cubic-bezier(.165,.84,.44,1)` and Material `cubic-bezier(.4,0,.2,1)`.
- No bounce, no spring, no scroll-jack, no parallax, no ambient drift. All motion GPU-only and gated on `prefers-reduced-motion`.
- Numerals tick **once** on reveal with `tabular-nums` so columns never jitter. Register fields **fill in like instrument boot** — values type into their labeled fields once, in read order.

---

## 5. THE SIGNATURE MOMENT — "The Calibration Sweep"

**One moment. Fired once on the artifact scrolling into view. ~600ms. GPU-only. Killed off-viewport. Reduced-motion ships the calibrated end-state.**

1. A single phosphor **hairline scan-line** (`--accent-scan`) traverses the artifact top→bottom — the instrument *measuring*.
2. As it passes, the **register fields populate** with measured values (mono types into its labeled fields, in read order).
3. The **perforated tear cuts** via mask-reveal.
4. The **verdict register flips to `IN SPEC`**, the hex signature strip finishes typing, and the lone `--accent` **checkmark settles** to full green as `--accent-glow` blooms once under the sheet.

**Why this is the locked moment:** it is **unfakeable** (it *is* the product — measurement, witnessed), **brand-thesis-bearing** (continuous reality rendered into a checkable, citable verdict), and **singular** (it absorbs swiss-machine's "readout settling," the Datasheet's "calibration sweep," and quantized-reactor's "verb, not texture" — one moment, not three). It out-*moves* Cohere on the axis it neglects and out-*confidences* pioneer's micro-type.

---

## 6. How three things read (binding for layout)

- **Hero:** asymmetric `1fr 1.2fr`. Left — display headline (640) + one-line lede clamped to `--measure`, uppercase mono eyebrow, inverted light-on-room CTA. Right — the artifact framed as a **datasheet header block** (part-number, revision, tolerance band) floating over the dark bench with **registration marks** at its corners and the calibration sweep arming. Right gutter carries a control-ID (`FIG.1 · REG-04 · TOL ±0.2 · v3.3`). No shaders, no dot-grid, no stage-lights.
- **Card = a register:** default bevel plate; engraved mono label top-left (`REG · LATENCY`); the value in large tabular mono; unit in dim mono; a `±tol` micro-row; a phosphor pip **only** if that metric is in a verified state. Ruthless left-alignment to the grid; air around it is the luxury.
- **Code block = a plate with control-IDs:** `--well` fill, inset ring, Geist Mono, dim tabular line-numbers, a left engraved rail, a header strip (`LISTING 2 · sha256:a1f… · IN SPEC`) where the hash is real and the phosphor verdict is earned. The one dense object; everything else breathes.

**Subtraction (binding kill-list):** guilloche, Bayer-dither/WebGL ambient field, crop marks, ghost ordinals, ruler ticks, sparks, dual stage-lights, warm room, second hue, accent-as-button-fill. One lit datasheet in a forensic dark room.
