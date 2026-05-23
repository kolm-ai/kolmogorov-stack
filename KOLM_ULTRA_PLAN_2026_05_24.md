# KOLM ULTRA PLAN — 2026-05-24 → site-go-live ($1B–$10B target)

Single source of truth. Survives compaction. Atomic execution. 150 waves (W682–W831). Generated 2026-05-24 after W681 (premium-hero-overhaul, commit `be5c837`) shipped to both `origin` (Vercel) and `public` mirrors.

This file replaces the now-mostly-complete `KOLM_VALUATION_PLAN_2026_05_23.md` for the front-end push. Backend items B1–B12 from that file remain valid and roll forward into this plan's BE columns.

---

## 0. SURVIVAL META — READ FIRST ON RESUME

**What this file is.** A complete 150-wave execution map for taking kolm.ai from a 2/10 (per user W681 feedback) static catalog of ~557 HTML pages to a state-of-the-art frontier-AI developer-product site comparable to vercel.com / linear.app / stripe.com / fireworks.ai / together.ai, ready for public launch. Generated to survive context compaction.

**How to read it after compaction.** Sections are atomic. Section 1 is the locked decisions — never debate, only execute. Section 2 is the page map — execute top-down. Section 3 is the wave roadmap — pick the lowest numbered un-executed wave and run it. Section 4 is the per-page brief — when editing a page, open its brief first. Section 7 is the mandatory checklist — every commit runs it.

**Authorizations carried verbatim (binding):**
- "ship when done" — autonomous commit+push for waves in this plan, both `origin` and `public` remotes
- "implement exhaustively. atomically. surgically. make no mistakes."
- "never force-push to main/master EXCEPT public/main on kolmogorov-stack"
- "prefer adding specific files by name rather than `git add -A`" (W604 staging trap)
- "Delete .env.prod after use; never stage .env*, *.pem, *.key, secrets/, %TEMP%tid.txt"
- "screenshot the site… document everything atomically surgically exhaustively and then build a plan that survives compressions and gets executed to the needle in the haystack" — this file is that plan
- "audit with screenshots and densure its our best foot forward. even if you need 150 waves keep going until our site is completely finished and state of the art"
- "Separate your advice by front end: and back end:" — every wave below has FE/BE columns

**Exclusions from scope (user-explicit):**
1. Founders / about page (no edits)
2. Stars / traction surfaces (no edits, no display, no rebuild) — alternative trust stack is in §1.7

**Branding lock (carry forward):**
- Eyebrow: "Open-source AI workbench"
- H1: "Capture, distill, compile, deploy. Your AI, on your hardware, with receipts." — UPDATED IN W682 (see §1.1)
- Contact: rodneyyesep@gmail.com
- License: Apache-2.0

**Mode:** Auto. Bias toward continuing without stopping for clarifying questions.

---

## 1. STRATEGIC DECISIONS (LOCKED 2026-05-24 — DO NOT RELITIGATE)

### 1.1 Positioning lock

**Locked tagline:** "Frontier AI on your own infrastructure"

**Locked eyebrow:** "Open-source AI workbench"

**Locked H1 (W682 rewrite):** "Frontier AI on your own infrastructure" (the eyebrow becomes a quiet uppercase tagline above; the H1 carries the positioning).

**Locked lede (W682 rewrite, ~22 words):** "Drop in for the OpenAI SDK. Distill your traffic into a signed `.kolm` artifact. Run it on hardware you own."

**Rationale:** The McKinsey-tier valuation memo identified "Frontier AI on Your Own Infrastructure" as the category-creating wedge. "Workbench" alone competes with NVIDIA AI Workbench branding; "lab" alone reads as research-OpenAI competitor. The two-word adjective phrase "on your own infrastructure" plants the wedge against Fireworks/Together (hosted only), Bedrock/Vertex (hyperscaler-only), and Ollama (no enterprise story). It is also the only positioning that pulls all three personas (Enterprise ML buyer, Frontier Researcher, Indie Developer) into one funnel.

**Anti-positioning (do NOT say):**
- "ChatGPT for your data" (too vague, commoditizes)
- "Self-hosted LLMs" (sounds like a 2024 project)
- "AI orchestration platform" (LangChain-like, weak)
- "Fine-tuning service" (commoditized by OpenPipe/Predibase, both already acquired)
- "Open-source RAG" (RAG is a 2024 word)

### 1.2 Brand architecture — single brand, two named surfaces

**Decision:** Single brand `kolm.ai`. Two named surfaces sharing one `.kolm` artifact and one identity system:

- **Kolm Cloud** = the gateway / wrapper. OpenAI-compatible base URL. SDK drop-in. Captures, redacts, traces, attests. The surface an Enterprise ML team adopts first.
- **Kolm Studio** = the lab / compiler. Distill, quantize, gate, sign. The surface a Frontier Researcher and an Indie Developer use to produce `.kolm` artifacts and ship them to user hardware.

Both surfaces converge on the same artifact format (`.kolm`), the same K-score eval gate, the same receipt chain, the same runtime. The brand is one; the entry doors are two.

**Why not one product:** "Workbench" without sub-surfaces forces every page to address every persona at once. Result is the current 2/10 catalog feeling.
**Why not two products:** Two SKUs splits go-to-market, doubles the pricing matrix, confuses the open-source license story.
**Why this:** One brand keeps the GTM unified; two surfaces let users self-identify and follow a clear funnel. This is the Stripe (Payments / Connect / Billing) pattern, the Vercel (Frontend Cloud / AI Cloud) pattern, the Cloudflare (Workers / Pages / R2) pattern.

**Surface acquisition:**
- `/cloud` and `/studio` become first-class nav destinations (top-level after `/product`)
- Each surface gets its own hero, but uses the same `ks.css` design system
- The homepage decides for the user (hero shows both with one-line picker), then routes

### 1.3 Color discipline rules (LOCKED — overrides all prior CSS)

Site-wide single-accent palette, modeled on Vercel (mint/green + neutral grays), Stripe (purple + neutral), Linear (electric blue + neutral). All other accents removed or scoped to one semantic role.

| Token | Value | Allowed roles | Disallowed roles |
|---|---|---|---|
| `--ks-accent` (PRIMARY) | mint `#7ef0d2` | CTAs, focus rings, live state, link underlines, ONE bloom layer, code-output highlights, K-score numeric, success state | None — the entire visual hierarchy hangs on this |
| `--ks-accent-warm` (SCOPED) | amber `#ffb155` | NUMERIC DATA ONLY — prices ($ amounts), durations (`125.3s`), counts, sizes (`17.9 GB`), warning chips ("pending"), `.fr-num` tabular cells | NEVER in gradients, NEVER in hero blooms, NEVER as background, NEVER on text outside data cells |
| `--ks-accent-cool` (DELETED) | ~~lavender `#a89bff`~~ | DELETED — fold into `--ks-fg-2` neutral or `--ks-accent` mint | Forbidden token. If found, replace with mint or neutral. |
| Hardcoded `#f4a7c8` (pink) | DELETED | Forbidden | nav.js surface-media variants must use mint |
| Hardcoded `#8fc7ff` (cyan) | DELETED | Forbidden | nav.js surface-media variants must use mint |
| Hardcoded `#ffce7d` (golden) | DELETED | Forbidden | Replace with `--ks-accent-warm` if numeric, else mint |

**Atmosphere blooms (`ks.css .ks::before/.ks::after`):** ONE bloom layer only. Currently two (mint + warm). Kill the warm bloom. The page should be neutral with a single mint glow.

**Gradients:** All gradients must be single-hue + opacity transitions. No two-hue gradients anywhere except: (a) the K-score sculptural numeral hairline, which already uses neutral-to-accent, and (b) terminal "live" pulse dots, which use mint-to-transparent.

**Audit (mandatory every wave):**
```
grep -rn '#a89bff\|#f4a7c8\|#8fc7ff\|#ffce7d\|ks-accent-cool' public/ | wc -l
```
Must return 0 by W685 close. Subsequent waves keep it at 0.

### 1.4 Page consolidation totals (target: 557 → ~80 canonical destinations)

| Cluster | Before | After | Reduction |
|---|---:|---:|---:|
| Security / Compliance | 15 | 4 | 73% |
| Verticals + Use Cases | 14 | 8 | 43% |
| Compare (root + /compare/) | 30 | 8 | 73% |
| Integrations | 17 | 17 | 0% (each unique) |
| Marketplace | 8 | 8 | 0% |
| Device / Runtime / Hardware | 18 | 3 | 83% |
| Docs (subtree) | 143 | ~80 | 44% |
| Research (subtree) | 57 | ~12 | 79% |
| Articles | 16 | ~10 | 38% |
| Cookbook | 38 | ~20 | 47% |
| Root-level orphans | ~30 | 0 | 100% (move or delete) |
| Account console | 23 | 23 | 0% (authenticated app) |
| **TOTAL (rough)** | **~557** | **~200 net** | **~64%** |

Full per-file plan in §2. Execution waves W691–W730 (security, verticals, compare, device, docs, root-orphans).

### 1.5 Three-persona conversion funnel

| Persona | Lands on | Sees first | Next click | Conversion endpoint |
|---|---|---|---|---|
| **Enterprise ML buyer** (CIO/CISO/Head of Platform) | `/` → `/cloud` | "Drop in for OpenAI SDK. Stay in your VPC. Audit-grade receipts." | `/security` → `/enterprise` | `mailto:rodneyyesep@gmail.com` w/ "Enterprise" subject pre-filled, or `/signup?plan=enterprise` |
| **Frontier researcher** (ML eng, ML PhD, distill maxi) | `/` → `/studio` | "Distill any model. Quantize to INT4 in seconds. Reproducible." | `/k-score` → `/spec/kolm-format-v1` → `/docs` | `/signup?plan=studio` → first artifact in <10 min |
| **Indie developer** (solo dev, side project, OSS contributor) | `/` → `/quickstart` | "Free tier. OpenAI base URL swap. One command to capture." | `/docs/sdk` → `/pricing` | `/signup?plan=free` → first capture in <2 min |

**Funnel rules:**
- Every page has ONE primary CTA per persona; no page has more than 2 primary CTAs total.
- The persona is identifiable from the URL: `/cloud/*` enterprise, `/studio/*` researcher, `/quickstart`/`/docs/*` indie.
- The footer always carries all three CTAs ("Get an API key" / "Talk to sales" / "Read the spec") so any page can convert any persona.

### 1.6 Pricing tier lock (from McKinsey-tier valuation memo)

| Tier | Price | Target | Surface | Quotas |
|---|---|---|---|---|
| **Free** | $0/mo | Indie | Cloud + Studio (light) | 10 artifacts/mo, 1M tokens/mo through gateway, public artifacts only |
| **Pro** | $15/mo | Indie → Power user | Cloud + Studio | 100 artifacts/mo, 100M tokens/mo, private artifacts, K-score on demand |
| **Team** | $500/mo (per workspace) | Small co/team | Cloud + Studio + Team controls | unlimited artifacts, 1B tokens/mo included, RBAC, audit log, SSO via SAML/OIDC |
| **Business** | $5,000/mo (workspace) | Growth/regulated | + BAA, dedicated capture region, k-score SLAs | 10B tokens/mo, slack-shared on-call, residency selection |
| **Enterprise** | Custom ($50K–$500K/yr) | Regulated, finance/healthcare/defense | + air-gap, self-host, MSA, BAA, dedicated SE | Custom, BYO compute |
| **Frontier** | Custom ($500K–$5M/yr) | Foundation labs, sovereign AI, defense primes | + on-prem distill cluster, SLA-backed K-score, custom adapters | Pegged to compute |

Pricing surface = `/pricing`. Wave W786–W790 implements per-tier ROI calculator, currency selector (W663 already shipped this baseline), and a hard "talk to sales" CTA for Business+.

### 1.7 Trust signal stack (REPLACES stars/traction; user-excluded)

In order of above-fold weight:

1. **`.kolm` artifact receipts** — clickable link to a real signed receipt JSON on every artifact-related page
2. **Reproducible quantize benchmarks** — table with command, duration, file size, K-score, hash; ship as `/benchmarks/swe-bench-mini` and similar
3. **SOC 2 Type I (available)** + **Type II (Q4 2026 target stated honestly)** + **HIPAA BAA (available on Business+)** — single `/security` page consolidates 15 prior pages
4. **Halborn pen test report 2026-04** — already exists, link from `/security`
5. **Apache-2.0 source license + SBOM** — link to GitHub repo `sneaky-hippo/kolmogorov-stack` from footer
6. **Customer attestation quotes** (when shipped) — single-line named attribution; no logo wall until 10+ named customers (CURRENTLY ZERO; placeholder reserved as `/security#attest`)
7. **K-score leaderboard** — `/k-score` public leaderboard (W666, pending, queue for W775)

Trust signal placement: hero footer ribbon (3 signals max above fold), then a dedicated `/security` summary card on every product-surface page, plus footer site-wide.

---

## 2. PAGE CONSOLIDATION MAP — FULL EXECUTION SPEC

### 2.1 Canonical destination list (~80 pages)

This is the FINAL site map. Anything not on this list either gets merged into one of these, redirected via `vercel.json` rewrite, or deleted.

```
/
/cloud                            ← new (W751)
/cloud/openai-compat              ← from integrations/openai-sdk
/cloud/anthropic-compat           ← from integrations/anthropic-sdk
/cloud/sdks                       ← from /sdks
/cloud/gateway                    ← from /capture
/cloud/captures                   ← from /captures
/cloud/observability              ← new (W754)
/studio                           ← new (W761)
/studio/distill                   ← from /distill
/studio/quantize                  ← from cli docs
/studio/compile                   ← from /compile
/studio/bakeoffs                  ← from /account/bakeoffs (public mirror)
/studio/run                       ← from /run
/spec/kolm-format-v1              ← keep
/k-score                          ← keep, W775 leaderboard
/security                         ← merge 15 → 1 (W691)
/security/compliance              ← merge compliance/* (W692)
/security/attestation             ← from security/halborn-2026-04
/security/recipes                 ← from cookbook/hipaa-summarizer + articles/hipaa-*
/pricing                          ← keep
/enterprise                       ← keep (consolidate /teams /tunnels /byoc /airgap)
/use-cases                        ← keep, point to /solutions/*
/solutions                        ← new index (W701)
/solutions/healthcare             ← merge for/healthcare + healthcare + healthcare-v2 (W702)
/solutions/finance                ← merge for/fintech + finance + finance-v2 + fintech (W703)
/solutions/legal                  ← merge legal + legal-v2 (W704)
/solutions/defense                ← merge for/government-defense + defense + defense-v2 + gov (W705)
/solutions/edge                   ← merge for/edge-ai + edge (W706)
/solutions/agents                 ← merge for/agents + use-cases/agentic-coding (W707)
/solutions/support                ← from for/support-automation (W708)
/use-cases/ai-saas                ← keep
/use-cases/capture-and-distill    ← keep
/use-cases/enterprise-search      ← keep
/use-cases/embedded               ← keep
/use-cases/mobile                 ← keep
/use-cases/web3-verifiable        ← keep
/compare                          ← keep, index of 8
/compare/openai                   ← merge vs-openai* + compare/kolm-vs-openai (W711)
/compare/openpipe                 ← keep 2026 version, delete legacy (W712)
/compare/predibase                ← keep 2026 version, delete legacy (W713)
/compare/together                 ← keep 2026 version, delete legacy (W714)
/compare/fine-tuning              ← merge vs-fine-tune + vs-openai-fine-tune (W715)
/compare/rag                      ← merge vs-rag + compare/kolm-vs-rag (W716)
/compare/alternatives             ← merge vs-ollama + vs-langsmith + vs-mem0 + vs-hindsight + kolm-vs-bedrock-distill + kolm-vs-proxis (W717)
/compare/positioning              ← merge how-vs-anthropic + how-vs-diy + how-vs-hyperscaler + how-vs-lorax (W718)
/migrate                          ← keep, hub
/device                           ← merge device + device-transfer + docs/devices (W721)
/device/targets                   ← from device-transfer/* (W722)
/runtime                          ← merge runtimes + docs/runtime + docs/cli/runtime/gpu/quantize/install-device (W723)
/integrations                     ← keep, index
/integrations/<17 keep>           ← keep all 17 integration files
/marketplace                      ← keep, index
/marketplace/<8 keep>             ← keep all 8
/docs                             ← keep, restructured (W741+)
/docs/quickstart                  ← keep
/docs/sdk                         ← keep
/docs/api                         ← keep (and consolidate /api)
/docs/cli                         ← keep
/docs/recipes                     ← keep
/articles                         ← keep, index
/articles/<10 keep>               ← keep 10 SEO-load-bearing, archive rest (W731)
/cookbook                         ← keep, index
/cookbook/<20 keep>               ← keep 20 marquee recipes, archive rest (W732)
/case-studies                     ← keep when populated; placeholder honest until then
/changelog                        ← keep
/blog                             ← if exists, fold into /changelog or /articles
/research                         ← keep ~12 marquee pieces (W733)
/about                            ← EXCLUDED from edits
/careers                          ← EXCLUDED from edits
/account/*                        ← 23 pages, authenticated app, separate scope
/signin /signup /dashboard        ← keep
/404 /admin                       ← keep
```

### 2.2 Pages to DELETE or 301-redirect (W693, W709, W719, W724, W734)

Root-level orphans + duplicates (consolidate via `vercel.json` rewrite + then delete from `public/`):

```
DELETE (was security cluster, merged into /security):
- public/baa.html
- public/hipaa-mapping.html
- public/soc2.html
- public/compliance-packs.html
- public/threat-model.html
- public/trust.html
- public/subprocessors.html
- public/slsa.html
- public/sbom.html

DELETE (was vertical duplicates):
- public/healthcare.html, public/healthcare-v2.html → /solutions/healthcare
- public/finance.html, public/finance-v2.html → /solutions/finance
- public/legal.html, public/legal-v2.html → /solutions/legal
- public/defense.html, public/defense-v2.html, public/gov.html → /solutions/defense
- public/fintech.html → /solutions/finance
- public/edge.html, public/for/edge-ai.html (if for/ kept, redirect for/* to /solutions/*)

DELETE (was compare duplicates, legacy versions):
- public/vs-fine-tune.html, vs-hindsight.html, vs-langsmith.html, vs-mem0.html, vs-ollama.html, vs-openai-fine-tune.html, vs-openpipe.html, vs-predibase.html, vs-rag.html, vs-together.html
- public/how-vs-anthropic.html, how-vs-diy.html, how-vs-hyperscaler.html, how-vs-lorax.html, how-vs-openai-fine-tune.html, how-vs-openpipe.html, how-vs-predibase.html
- public/compare/kolm-vs-openpipe.html (keep 2026)
- public/compare/kolm-vs-predibase.html (keep 2026)
- public/compare/kolm-vs-together.html (keep 2026)
- public/compare/legacy.html

DELETE (was device/runtime duplicates):
- public/device-transfer.html → /device
- public/runtimes.html → /runtime
- public/docs/devices.html → /device (docs redirect)
- public/docs/cli/devices.html (keep singular, delete plural)

INVESTIGATE then DELETE/MOVE (root-level orphans):
- public/builder.html (legacy? → archive)
- public/drift.html → /docs/drift or /spec/drift
- public/education.html → /solutions/education (if vertical) or /nonprofits
- public/frozen-eval.html → /docs/frozen-eval
- public/manifesto.html → /about (EXCLUDED, leave alone) or /why-kolm
- public/nonprofits.html → /enterprise#nonprofits or /pricing#nonprofits
- public/receipt.html → /spec/receipt
- public/recipes.html → /cookbook
- public/roadmap.html → /changelog or /research
- public/r.html (shorthand? investigate, likely keep)
- public/setup-with-ai.html → /docs/quickstart
- public/studio.html (legacy variant? merge into new /studio)
- public/taxonomy.html → /spec/taxonomy or /docs/taxonomy
- public/tui.html → /docs/cli/tui
- public/upgrade.html → /pricing#upgrade
- public/value-loop.html → /solutions or /why-kolm
- public/verify-cli.html → /spec/verify or /docs/cli/verify
- public/verify-prod.html → /security#verify
- public/wrapper.html (legacy? archive)
- public/foundations/* (5 internal docs → /docs/internal/ or archive)
- public/learn/* (7 files; check vs /tutorials/* for duplication)
```

All deletions paired with a `vercel.json` rewrite from old URL → new URL to preserve SEO + inbound links.

### 2.3 Critical: nav.js runtime-injection cleanup

`public/nav.js` has runtime-injected surface media (line 576+ `injectSurfaceMedia`) and runtime-injected solutions mega-menu (line 162 `ensureSolutionsNav`). The mega-menu currently points to `/healthcare`, `/finance`, `/legal`, `/defense`, `/edge`, `/devtools`, `/case-studies`, `/compare`, `/migrate`, `/roi`. After consolidation, this must rewrite to `/solutions/*`.

Per-wave dependency: NAV REWRITE (W750) must precede DELETION (W693, W709, W719, W724) of source files, OR rewrites must ship simultaneously. Mechanism: edit nav.js mega-menu links in W750, then enable `vercel.json` redirects in W750.5, then delete source files in subsequent waves.

---

## 3. WAVE ROADMAP — W682 to W831 (150 waves)

Format: `W<id> | name | FE files | BE files / scripts | audit | sw.js bump?`

All waves stage explicit paths. All waves bump `public/sw.js` cache slug `kolm-vNN-YYYY-MM-DD-waveNNN-<slug>`. All waves run `node scripts/audit-static-refs.cjs` + `node scripts/audit-href.cjs --strict`. All waves preserve test anchors (W220, W260, W271, W335, W373, W404, W408, W410). Commits go to BOTH `origin` and `public` remotes.

### Tranche A: Foundations (W682–W690) — Color discipline + positioning lock

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W682 | Hero positioning rewrite | `index.html` (H1 → "Frontier AI on your own infrastructure", lede tightened), `ks.css` (atmosphere bloom collapse 2→1, kill warm bloom) | — | sw.js bump to v18 |
| W683 | Color token surgery | `ks.css` (delete `--ks-accent-cool*`, `--ks-accent-2`; scope `--ks-accent-warm-soft` to data-only), `home-refresh.css` (kill warm/golden/pink/cyan rgba uses) | — | grep audit must hit 0 lavender |
| W684 | nav.js color cleanup | `nav.js` (surface-media kicker colors all unified to `var(--ks-accent)`) | — | runtime injection critical path |
| W685 | Per-page inline-style audit | `public/*.html` (grep for `#a89bff`, `#f4a7c8`, `#8fc7ff`, `#ffce7d` in inline `<style>` blocks → replace) | — | must hit 0 hits in `grep -rn '#a89bff\|#f4a7c8\|#8fc7ff\|#ffce7d' public/` |
| W686 | K-score sculptural refinement | `k-score.html` (post-W681 polish: kerning, hairline density) | — | Tufte data-ink ratio applied to ax-row remnants |
| W687 | Hero motion primitive (subtle particle field, ≤200 LOC) | `index.html` + new `public/w687.js` + `w687.css` | — | respects `prefers-reduced-motion`; canvas only |
| W688 | Logo strip consolidation polish | `index.html` (the 2 strips collapsed in W681 — refine spacing, kerning, opacity) | — | preserve `data-w410` anchor + hidden test-anchor block |
| W689 | Footer trust-signal ribbon | `index.html` + every product surface page footer (`docs-shell.js` or per-page) | — | 3 signals above fold: SOC2, Apache-2.0, Halborn pen test |
| W690 | Tranche A audit + ship | run `release-verify` if available; capture screenshots; commit + push origin+public | `scripts/audit-static-refs.cjs`, `scripts/audit-href.cjs` | sw.js to v19 |

### Tranche B: Security consolidation (W691–W700)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W691 | `/security` master rewrite | `public/security.html` (merge: BAA, SOC2, HIPAA mapping, compliance packs, threat model, trust, subprocessors, SLSA, SBOM into 9-section page) | — | Each merged file becomes a section anchor `#baa`, `#soc2`, etc. |
| W692 | `/security/compliance` | new `public/security/compliance.html` (merge `compliance/index.html` + `compliance/nist-ai-rmf.html`) | — | Preserve `compliance/*` paths via `vercel.json` rewrites |
| W693 | Security source-file deletion + redirects | delete: `baa.html`, `hipaa-mapping.html`, `soc2.html`, `compliance-packs.html`, `threat-model.html`, `trust.html`, `subprocessors.html`, `slsa.html`, `sbom.html` | `vercel.json` rewrites: old URL → `/security#<anchor>` | nav.js + footer link audit |
| W694 | `/security/attestation` rename + index | rename `security/halborn-2026-04.html` → `security/attestation/halborn-2026-04.html`; add index | — | future pen tests append to this index |
| W695 | `/security/recipes` consolidation | new page merging `cookbook/hipaa-summarizer.html` + `articles/hipaa-ai-from-prompts.html` + `articles/hipaa-on-device.html` | — | source files become redirects |
| W696 | Trust badges across product pages | inject `<aside class="ks-trust">` snippet on `/cloud`, `/studio`, `/pricing`, `/enterprise`, `/`, `/k-score` | — | one component, reused |
| W697 | `/security` SEO + schema.org | head meta + structured data (`Organization` + `WebSite` + security policy URL) | — | site rank lift |
| W698 | `/enterprise` consolidation | merge `/teams`, `/tunnels`, `/byoc`, `/airgap`, `/self-host`, `/baa` references into `/enterprise` page sections | — | source files → 301 to `/enterprise#<anchor>` |
| W699 | Audit log + 2FA copy-tighten | `account/audit-log.html`, `account/security/2fa.html` (admin app — keep, polish copy) | — | minimal change, no consolidation |
| W700 | Tranche B audit + ship | screenshot diff, link audit, sw.js bump, commit + push | — | first BIG visible consolidation |

### Tranche C: Verticals & use-cases (W701–W710)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W701 | `/solutions` index page | new `public/solutions/index.html` (6 vertical cards + 7 workflow cards + 3-persona CTA strip) | — | redirect `/use-cases` to keep working but `/solutions` becomes canonical |
| W702 | `/solutions/healthcare` | merge `for/healthcare.html` + `healthcare.html` + `healthcare-v2.html` into `public/solutions/healthcare.html` | — | choose strongest copy from 3 versions |
| W703 | `/solutions/finance` | merge `for/fintech.html` + `finance.html` + `finance-v2.html` + `fintech.html` | — | |
| W704 | `/solutions/legal` | merge `legal.html` + `legal-v2.html` | — | |
| W705 | `/solutions/defense` | merge `for/government-defense.html` + `defense.html` + `defense-v2.html` + `gov.html` | — | |
| W706 | `/solutions/edge` | merge `for/edge-ai.html` + `edge.html` | — | |
| W707 | `/solutions/agents` | merge `for/agents.html` + `use-cases/agentic-coding.html` | — | |
| W708 | `/solutions/support` | move `for/support-automation.html` → `/solutions/support` | — | |
| W709 | Vertical source-file deletion + redirects | delete: `healthcare*.html`, `finance*.html`, `legal*.html`, `defense*.html`, `gov.html`, `fintech.html`, `edge.html` (for/* kept as rewrite source for SEO if backlinks exist) | `vercel.json` rewrites | nav.js mega-menu rewrite |
| W710 | Tranche C audit + ship | — | — | |

### Tranche D: Compare consolidation (W711–W720)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W711 | `/compare/openai` | merge `vs-openai.html` + `compare/kolm-vs-openai.html` + `how-vs-openai-fine-tune.html` + `vs-openai-fine-tune.html` | — | |
| W712 | `/compare/openpipe` | delete legacy `compare/kolm-vs-openpipe.html` + `vs-openpipe.html` + `how-vs-openpipe.html`; keep `compare/kolm-vs-openpipe-2026.html` → `/compare/openpipe` | — | OpenPipe was acquired — note this in copy |
| W713 | `/compare/predibase` | same pattern: keep 2026, delete legacy | — | Predibase was acquired — note this in copy |
| W714 | `/compare/together` | same pattern | — | |
| W715 | `/compare/fine-tuning` | merge `vs-fine-tune.html` + `vs-openai-fine-tune.html` | — | |
| W716 | `/compare/rag` | merge `vs-rag.html` + `compare/kolm-vs-rag.html` | — | |
| W717 | `/compare/alternatives` | merge `vs-ollama.html` + `compare/kolm-vs-ollama.html` + `vs-langsmith.html` + `vs-mem0.html` + `vs-hindsight.html` + `compare/kolm-vs-bedrock-distill.html` + `compare/kolm-vs-proxis.html` | — | matrix view |
| W718 | `/compare/positioning` | merge `how-vs-anthropic.html` + `how-vs-diy.html` + `how-vs-hyperscaler.html` + `how-vs-lorax.html` | — | strategic-narrative page |
| W719 | Compare source-file deletion + redirects | delete legacy vs-*, how-vs-* files; `vercel.json` rewrites | — | |
| W720 | Tranche D audit + ship | — | — | |

### Tranche E: Device, runtime, root-orphan cleanup (W721–W730)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W721 | `/device` master | merge `device.html` + `device-transfer.html` + `docs/devices.html` + `docs/cli/device.html` | — | |
| W722 | `/device/targets` | move `device-transfer/*.html` to `public/device/targets/<target>.html`; add index | — | preserve all 5 target pages |
| W723 | `/runtime` master | merge `runtimes.html` + `docs/runtime.html` + `docs/cli/runtime.html` + `docs/cli/gpu.html` + `docs/cli/quantize.html` + `docs/cli/install-device.html` | — | |
| W724 | Device/runtime deletion + redirects | delete source files post-merge | `vercel.json` | |
| W725 | Root-orphan triage (builder, drift, frozen-eval, manifesto, receipt, recipes, roadmap, taxonomy, tui, upgrade, value-loop, verify-cli, verify-prod, wrapper, studio.html) | per §2.2 disposition | `vercel.json` | each gets a one-line decision in the wave commit message |
| W726 | `foundations/*` archive or move to /docs/internal | move or delete 5 files | — | if internal, exclude from build |
| W727 | `learn/*` vs `tutorials/*` dedup | identify duplicates, pick winner, redirect loser | — | likely keep `tutorials/` |
| W728 | nav.js mega-menu link rewrite | `nav.js` (solutions menu now `/solutions/*`, not `/healthcare` etc.) | — | runtime injection update |
| W729 | sitemap regeneration | `scripts/build-sitemap.cjs` (if exists, else inline) | `public/sitemap.xml` | reflects new canonical URLs |
| W730 | Tranche E audit + ship; site count target | — | run `find public -name '*.html' | wc -l` — should be ~250 vs ~557 before |

### Tranche F: Cloud surface buildout (W731–W740)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W731 | `/cloud` landing page | new page; hero = "Drop in for OpenAI. Stay in your VPC."; trust strip; SDK matrix | — | top-nav addition |
| W732 | `/cloud/openai-compat` | from `integrations/openai-sdk.html`, refit | — | code-first page |
| W733 | `/cloud/anthropic-compat` | from `integrations/anthropic-sdk.html`, refit | — | |
| W734 | `/cloud/sdks` SDK matrix | from `/sdks`, refit as matrix | — | 6 SDKs: Node, Python, MCP, VSCode, C, Rust |
| W735 | `/cloud/gateway` | from `/capture`, repositioned as "the gateway" not "the capture surface" | — | |
| W736 | `/cloud/captures` | from `/captures`, refit | — | |
| W737 | `/cloud/observability` | new — traces, costs, latencies | — | screenshots from `/account/*` console |
| W738 | nav.js: add `/cloud` top-level | `nav.js` mega-menu | — | |
| W739 | Cloud-surface trust signals + footer | every `/cloud/*` page | — | |
| W740 | Tranche F audit + ship | — | — | |

### Tranche G: Studio surface buildout (W741–W750)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W741 | `/studio` landing page | new; hero = "Distill any model. Quantize to INT4. Reproducible." | — | proof: DeepSeek-R1 32B → 17.9GB in 125s |
| W742 | `/studio/distill` | from `/distill`, refit | — | |
| W743 | `/studio/quantize` | new, from CLI docs | — | proof matrix from W656 memory |
| W744 | `/studio/compile` | from `/compile`, refit | — | |
| W745 | `/studio/bakeoffs` | public-facing mirror of `/account/bakeoffs` | — | |
| W746 | `/studio/run` | from `/run`, refit | — | |
| W747 | nav.js: add `/studio` top-level | `nav.js` mega-menu | — | |
| W748 | Studio-surface trust signals | — | — | |
| W749 | Studio K-score widget (sparkline per artifact) | new component in `frontier.js` or `w749.js` | — | Tufte sparklines |
| W750 | Tranche G audit + ship | — | — | |

### Tranche H: Hero, motion, WebGPU (W751–W760)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W751 | Hero terminal motion (typing animation) | `w604.js` polish | — | reduced-motion safe |
| W752 | Hero terminal multi-line stream (live snail problem reasoning) | new | — | proof-of-distill |
| W753 | Hero gradient mesh (Stripe-style) | `ks.css` `.ks::before` polish (single mint bloom now) | — | from Tranche A |
| W754 | Particle node-network background (vercel-style, ≤200 LOC) | new `public/w754.js` + opt-in via class | — | reduced-motion safe |
| W755 | Magnetic CTA primitive (already in w604.js) — sitewide rollout | — | — | every primary CTA on every product page |
| W756 | 3D-tilt card primitive (already in w604.js) — sitewide rollout | — | — | pricing tiles, K-score cards |
| W757 | Spring-physics page transitions | `frontier.js` or new | — | use View Transitions API if available, fallback CSS |
| W758 | Sticky scrollytelling on `/spec/kolm-format-v1` | new `public/spec/v1.js` | — | step-through artifact anatomy |
| W759 | WebGPU "fluid" hero variant (opt-in, behind flag) | new `public/w759.js` (only if RTX/M-series detected via WebGPU adapter info) | — | sparkle for high-end visitors |
| W760 | Motion audit + reduced-motion sweep | — | — | every motion must have `@media (prefers-reduced-motion: reduce)` opt-out |

### Tranche I: Tufte data-density (W761–W770)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W761 | Sparkline primitive (`<span data-sparkline="3,5,7,8,9,12">`) | new `public/w761.js` + CSS | — | replaces decorative charts |
| W762 | Small-multiples chart primitive | new `public/w762.js` + CSS | — | quantize matrix uses this |
| W763 | Data-ink ratio audit on `/k-score` | strip decorative gridlines, axis ticks, redundant labels | — | |
| W764 | Data-ink audit on `/pricing` | tier comparison table — remove decoration | — | |
| W765 | Data-ink audit on `/spec/kolm-format-v1` | structural diagrams — minimal | — | |
| W766 | Sparkline rollout on `/marketplace` (K-score per artifact) | `marketplace.html` + per-artifact pages | — | |
| W767 | Sparkline rollout on `/changelog` (velocity over time) | `changelog.html` | — | |
| W768 | Inline sparkline in body copy (unicode `▁▃▄▅▆▇`) | `articles/*`, `cookbook/*` | — | Tufte: "integrate words and data" |
| W769 | Number formatting (tabular numerals, `font-variant-numeric: tabular-nums`) | `ks.css` sitewide for `.ks-num`, `.fr-num`, prices, sizes | — | prevents column-shift |
| W770 | Tranche I audit + ship | — | — | |

### Tranche J: K-score, leaderboard, proof artifacts (W771–W780)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W771 | `/k-score` content depth (post-W681 sculptural — now add: methodology, axes, eval pack) | `k-score.html` | — | |
| W772 | K-score "Try it" — paste your eval, get a score | `k-score.html` + `kscore-bench` data | — | live computation if API available, else honest "demo only" |
| W773 | K-score per-model breakdown | new section | — | DeepSeek-R1, Qwen 32B, Llama 70B etc. |
| W774 | K-score historical trend (sparkline) | uses W761 primitive | — | weekly snapshots |
| W775 | `/k-score/leaderboard` public page (task #1934 W666) | new | — | top 20 artifacts by K-score |
| W776 | `/k-score/methodology` deep-dive | new (or section in `/k-score`) | — | 5 axes: Faith, Cover, Calib, Honest, Cost |
| W777 | `/k-score` schema.org + Open Graph | head | — | rich snippets |
| W778 | `/spec/kolm-format-v1` rebuild | `spec/kolm-format-v1.html` | — | scrollytelling from W758 |
| W779 | `/spec/receipt` (from `receipt.html`) | promote orphan to spec | — | |
| W780 | Tranche J audit + ship | — | — | |

### Tranche K: Pricing depth + comp set (W781–W790)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W781 | `/pricing` rebuild around 6 tiers (Free/Pro/Team/Business/Enterprise/Frontier) | `pricing.html` | — | currently has 4 — extend per §1.6 |
| W782 | Per-tier ROI calculator depth | `pricing.html` JS | — | from W663 (already shipped baseline) |
| W783 | Currency selector polish | `pricing.html` (from W663) | — | USD, EUR, GBP minimum |
| W784 | "vs DIY" cost calculator | new section in `/pricing` | — | DIY = GPUs + ops + months → kolm = $5K/mo |
| W785 | Enterprise quote form (replaces mailto for Business+) | new `/pricing/quote` | — | form posts to mailto fallback if no backend |
| W786 | `/compare` matrix rebuild | `compare/index.html` (from /compare) | — | 8-column matrix |
| W787 | `/migrate` interactive wizard | `migrate.html` | — | pick current tool → get migration plan |
| W788 | Public roadmap rewrite | `roadmap.html` (promote from orphan to /changelog/roadmap or /changelog#roadmap) | — | |
| W789 | `/enterprise` quote-to-deploy flow | `enterprise.html` | — | matches PI tier |
| W790 | Tranche K audit + ship | — | — | |

### Tranche L: Docs restructure (W791–W800)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W791 | `/docs` index rebuild | `docs/index.html` | — | by-persona entry: Indie / Researcher / Enterprise |
| W792 | `/docs/quickstart` polish (cross-link to /cloud, /studio) | `docs/quickstart.html` | — | |
| W793 | `/docs/sdk` unified SDK index (6 SDKs) | new | — | from `cloud/sdks` |
| W794 | `/docs/api` consolidation | merge `api.html` + `docs/api.html` | — | OpenAPI source from existing tooling |
| W795 | `/docs/cli` audit | 50+ CLI doc files — keep but cross-link properly | — | |
| W796 | `/docs/recipes` (from cookbook/* selection) | new | — | top 20 |
| W797 | Docs search (client-side, lunr.js or pagefind, ≤50KB) | new `public/docs-search.js` | — | |
| W798 | Docs breadcrumb component sitewide | `docs-shell.js` | — | |
| W799 | Docs versioning surface (v1 visible) | head meta + footer | — | future-proof |
| W800 | Tranche L audit + ship | — | — | |

### Tranche M: Content engine + SEO (W801–W810)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W801 | `/articles` archive selection (keep ~10 SEO-load-bearing) | review each article, pick or archive | — | |
| W802 | `/cookbook` curation (keep 20 marquee) | similar | — | |
| W803 | `/research` curation (keep ~12 marquee) | similar | — | from 57 |
| W804 | Open Graph + Twitter Card site-wide | every page head | — | per-page OG image generation TBD |
| W805 | JSON-LD `WebSite`, `SoftwareApplication`, `Article` schemas | every page | — | |
| W806 | RSS feeds: `/feed.xml`, `/changelog.xml` | new | — | |
| W807 | Sitemap with priorities + lastmod | `sitemap.xml` refresh | — | |
| W808 | robots.txt audit + LLM-friendly directives | `public/robots.txt` | — | |
| W809 | `/llms.txt` (per the emerging convention) | new | — | content for AI agents indexing the site |
| W810 | Tranche M audit + ship | — | — | |

### Tranche N: Performance + a11y (W811–W820)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W811 | Critical CSS inline for hero | `index.html` + key landings | — | sub-1s FCP target |
| W812 | Font subsetting (Geist) | switch from Bunny CDN to self-hosted `woff2` subset | — | reduce render-block |
| W813 | Image audit + AVIF/WebP | inventory `public/*.png/.jpg` → convert | — | |
| W814 | Service worker review post-consolidation | `sw.js` PRECACHE list refresh | — | |
| W815 | Lighthouse run + fix top 5 issues | each canonical page | — | |
| W816 | A11y: skip-to-content link sitewide | header inject | — | |
| W817 | A11y: focus rings + keyboard nav full audit | global | — | WCAG 2.2 |
| W818 | A11y: alt text audit | inventory + fix | — | |
| W819 | Reduced-motion full audit | every motion in W751-W760 | — | |
| W820 | Tranche N audit + ship | — | — | |

### Tranche O: Final audit + go-live (W821–W831)

| Wave | Name | FE | BE | Notes |
|---|---|---|---|---|
| W821 | Site-wide copy audit (Tufte tightening) | every page | — | strip empty calories |
| W822 | Site-wide CTA audit | one primary CTA per page max | — | enforce funnel discipline |
| W823 | Footer rebuild (4 columns, full sitemap, trust ribbon) | `docs-shell.js` footer | — | |
| W824 | 404 page polish | `404.html` | — | brand-strong, useful links |
| W825 | Cookie/privacy banner audit (or removal if not needed) | check current state | — | |
| W826 | `vercel.json` rewrite audit (all redirects landed?) | `vercel.json` | — | |
| W827 | Final screenshot pass (all canonical pages) | scripts/ultra-screenshot.cjs | — | record final state |
| W828 | Test-anchor sweep (W220/W260/W271/W335/W373/W404/W408/W410 all present?) | grep audit | — | |
| W829 | sw.js final cache bump for launch | `sw.js` | — | `kolm-v50-2026-XX-XX-launch-ready` |
| W830 | `frontend-version.json` launch entry | `frontend-version.json` | — | |
| W831 | Tag release + ship + monitor | git tag, push, watch Vercel deploy | — | LAUNCH |

**Backend track (B1–B12 from prior plan, executed in parallel between FE tranches):**

| B# | Name | Files |
|---|---|---|
| B1 | `/v1/cloud/health` + `/v1/studio/health` surface-aware health | `src/router.js` |
| B2 | `/v1/k-score/leaderboard` real endpoint backing W775 | `src/router.js`, `src/k-score.js` |
| B3 | `/v1/billing/quote` for enterprise form W785 | `src/router.js`, `src/billing.js` |
| B4 | `/v1/spec/receipt/:id` for W779 | `src/router.js` |
| B5 | OpenAPI regen for new surface routes | `scripts/build-openapi.cjs` |
| B6 | Sitemap regen wired to canonical list | `scripts/build-sitemap.cjs` |
| B7 | Robots + llms.txt build step | `scripts/build-robots.cjs` |
| B8 | Search index build for docs (W797) | `scripts/build-docs-index.cjs` |
| B9 | Image conversion pipeline (W813) | `scripts/optimize-images.cjs` |
| B10 | Critical CSS extraction (W811) | `scripts/extract-critical.cjs` |
| B11 | Release-verify gate updates for new surfaces | `scripts/release-verify.cjs` |
| B12 | Lock-in tests for canonical-URL contracts | `tests/wave<NNN>-canonical-urls.test.js` |

---

## 4. PER-CANONICAL-PAGE BRIEFS

### 4.1 `/` (home)

- **Persona:** all three; routes
- **Eyebrow:** "Open-source AI workbench"
- **H1:** "Frontier AI on your own infrastructure"
- **Lede (~22 words):** "Drop in for the OpenAI SDK. Distill your traffic into a signed `.kolm` artifact. Run it on hardware you own."
- **Primary CTA(s):** "Get an API key" (right), "See it work" (left, scrolls to terminal)
- **Above-fold structure:** eyebrow → H1 → lede → dual CTA → single chronological terminal (export → kolm distill → kolm verify → kolm run) → trust ribbon (SOC2, Apache-2.0, Halborn)
- **Below fold:** Two-surface picker (Cloud / Studio cards) → "Drops in for" logo strip → "Runs on" device strip → SOTA quantize matrix → K-score teaser → pricing teaser → footer
- **Trust signals shown above fold:** 3 (SOC2 / Apache-2.0 / Halborn)
- **Proof sources:** real `quantize` command transcript (DeepSeek-R1 32B → 17.9GB in 125s)

### 4.2 `/cloud`

- **Persona:** Enterprise ML buyer (primary), Indie developer (secondary)
- **Eyebrow:** "Kolm Cloud — the AI gateway"
- **H1:** "Drop in for OpenAI. Stay in your VPC. Audit-grade receipts."
- **Above fold:** hero → SDK swap example (3-line code change) → trust ribbon
- **Below fold:** observability screenshot → captures explainer → pricing teaser (Team+) → enterprise sales CTA

### 4.3 `/studio`

- **Persona:** Frontier researcher (primary)
- **Eyebrow:** "Kolm Studio — the AI lab"
- **H1:** "Distill any model. Quantize to INT4. Reproducible."
- **Above fold:** hero → quantize matrix (4 sizes proven) → "Try it" CTA
- **Below fold:** K-score teaser → bakeoff explainer → artifact format teaser → docs link

### 4.4 `/security` (consolidates 15 → 1)

- **Persona:** Enterprise ML buyer (CISO/Compliance)
- **Eyebrow:** "Trust"
- **H1:** "Audit-grade AI infrastructure."
- **Sections (each was its own page pre-W691):** #baa (HIPAA BAA), #soc2 (SOC 2 Type I + Type II target Q4 2026), #hipaa-mapping (45 CFR 164.308/310/312/314), #compliance-packs, #threat-model, #subprocessors, #slsa, #sbom, #residency, #pen-test (link to Halborn report), #attestation (link to artifact receipts as security primitive)
- **Trust signals:** every section ends with "verify yourself" link to evidence
- **Primary CTA:** "Talk to sales" + "Read attestation"

### 4.5 `/pricing`

- **Personas:** all three
- **Eyebrow:** "Pricing"
- **H1:** "Plans that match the workflow."
- **6 tiers** per §1.6 (was 4 before W781)
- **Per-tier ROI calculator** (W782)
- **Currency selector** (USD/EUR/GBP minimum, W783)
- **"vs DIY" cost calculator** (W784)
- **Enterprise quote form** for Business+ (W785)
- **Primary CTAs:** "Start free" (top), "Talk to sales" (mid), "Talk to sales — Frontier tier" (bottom)

### 4.6 `/k-score`

- **Persona:** Frontier researcher (primary)
- **Eyebrow:** "K-score"
- **H1:** "One number per artifact. Five axes underneath."
- **Above fold:** sculptural numeral (W681 — done), verdict pill, delta vs prior, 4-row spec list (eval pack / teacher / held-out / recipe), "Five-axis breakdown ↓" anchor
- **Below fold:** methodology, per-axis explanations, public leaderboard (W775), "Try it" widget (W772)

### 4.7 `/spec/kolm-format-v1`

- **Persona:** Frontier researcher + open-source community
- **Eyebrow:** "Spec"
- **H1:** "The `.kolm` artifact format, v1."
- **Structure:** scrollytelling (W758) through artifact anatomy — header, manifest, weights, eval pack, receipt
- **Trust signal:** Apache-2.0 spec, link to canonical schema in repo

### 4.8 `/enterprise`

- **Persona:** Enterprise ML buyer
- **Eyebrow:** "Enterprise"
- **H1:** "Frontier AI in your VPC. With receipts."
- **Consolidates:** teams, tunnels, byoc, airgap, self-host, baa references
- **Primary CTA:** "Talk to sales" (always) + scheduling link

### 4.9 `/compare`

- **Persona:** all three (different per sub-page)
- **Index:** 8-column matrix (kolm vs OpenAI vs OpenPipe-acquired vs Predibase-acquired vs Together vs Fireworks vs Anthropic vs DIY)
- **Sub-pages:** 8 (W711–W718)

### 4.10 `/quickstart`

- **Persona:** Indie developer + new visitor
- **Eyebrow:** "Quickstart"
- **H1:** "From API call to signed artifact in 5 minutes."
- **Structure:** 5 steps, each with copyable command, expected output, "what just happened" explainer
- **Primary CTA:** "Sign up free"

(Remaining ~70 canonical-page briefs follow this template; per-page wave above carries the change list. Briefs for non-marquee pages are intentionally terse — the wave row IS the brief.)

---

## 5. MOTION + WEBGPU PRIMITIVES (per W751–W760)

Total motion JS budget across all pages: ≤25KB minified, lazy-loaded after FCP, behind `prefers-reduced-motion`.

| Primitive | LOC budget | Page | Lib? | Files |
|---|---:|---|---|---|
| Typing animation (terminal) | ≤120 | `/` hero | none | `w604.js` (in place) |
| Magnetic CTA | ≤80 | sitewide | none | `w604.js` (in place) |
| 3D-tilt card | ≤100 | sitewide | none | `w604.js` (in place) |
| Mint single-bloom atmosphere | ≤30 (CSS only) | sitewide | none | `ks.css` |
| Particle node-network bg | ≤200 | `/cloud`, `/studio` | none | `w754.js` |
| Sparkline | ≤120 | `/k-score`, `/marketplace` | none | `w761.js` |
| Small multiples | ≤200 | `/k-score`, `/studio/quantize` | none | `w762.js` |
| Sticky scrollytelling | ≤150 | `/spec/kolm-format-v1` | none | `spec/v1.js` |
| WebGPU fluid (opt-in) | ≤500 (lazy) | `/` (high-end only) | none | `w759.js` |
| View Transitions | ≤80 | sitewide | native API | `frontier.js` |

All primitives:
- Pure vanilla JS (no React, no framework runtime)
- Respect `prefers-reduced-motion: reduce`
- Pause on tab blur
- ≤16ms per frame
- Single-accent (mint) color discipline

---

## 6. TUFTE DATA-DENSITY RULES (applied to kolm.ai)

1. **Max data-ink ratio** — every visual pixel must answer "does this change when the product value prop changes?" — strip decoration; W763 audit on `/k-score`, W764 on `/pricing`.
2. **Small multiples** — instead of 1 big chart, 4 small comparison charts. W762 primitive. Use on `/studio/quantize` (4 sizes proven) and `/k-score` (per-axis).
3. **Eliminate redundant encoding** — never use 3 channels (label + icon + color) for one signal. W821 copy audit applies this site-wide.
4. **Layer hierarchically** — data largest, label medium, axis faintest. Applied on every table.
5. **Minimal effective difference** — mint accent reserved for THE claim; everything else neutral. §1.3 enforces.
6. **Multi-distance reading** — hero must read at 3m and 30cm. Hero H1 is the 3m read; lede + terminal is the 30cm read.
7. **Integrate words and data** — unicode sparklines inline in prose (W768). `▁▃▄▅▆▇` becomes a paragraph element, not a separate chart.

---

## 7. AUDIT GATES — MANDATORY PER WAVE

Every wave that ships ends with:

1. `node scripts/audit-static-refs.cjs` → must report `missing static refs: 0`
2. `node scripts/audit-href.cjs --strict` → must report `broken: 0`
3. Color audit grep: `grep -rn '#a89bff\|#f4a7c8\|#8fc7ff\|#ffce7d\|ks-accent-cool' public/` → must return 0 lines (from W685 onward)
4. Test-anchor sweep: grep for `data-w220|data-w260|data-w271|data-w335|data-w373|data-w404|data-w408|data-w410` → counts must not decrease versus prior wave
5. `public/sw.js` cache slug bumped: `kolm-vNN-YYYY-MM-DD-waveNNN-<slug>`
6. `public/frontend-version.json` `version` field bumped + new `stale_copy_checks` entry describing the wave
7. Stage explicit paths only — NEVER `git add -A` or `git add .` (W604 trap)
8. Verify `git diff --cached --name-only` matches the wave's intended files before commit
9. Commit message format: `W<id>: <name> — <1-line summary>` + Co-Authored-By trailer
10. Push to BOTH `origin` (Vercel auto-deploy) AND `public` (mirror)

Optional gates (run when feasible):
- `node scripts/ultra-screenshot.cjs` (this file) — screenshot diff vs prior wave
- `node --test --test-concurrency=1 tests/wave<NNN>-*.test.js` — lock-in test for the new contract
- Lighthouse run on the most-changed page

---

## 8. RESOURCES — REFERENCE LIBRARY

### 8.1 Comp set (drag-strip)

| Site | Why look |
|---|---|
| vercel.com | Globe particles, monochrome polish, single-product brand-extension model |
| linear.app | Concrete product screenshots over abstract art; minimal accent |
| stripe.com | Parallelogram geometric framing, wave-pattern bg, purple discipline |
| modal.com | Mint accent (close to ours), metrics-driven testimonials |
| fireworks.ai | "From the creators of PyTorch" eyebrow as trust play |
| together.ai | 3D rotating shapes; cutting-edge research aesthetic |
| anthropic.com | Mission-driven H1, monochrome polish |
| cursor.com | Spring-physics transitions, embedded interactive product demos |
| supabase.com | "Build in a weekend. Scale to millions." dual-distance H1 |
| langflow.org | Side-by-side comparison slider, flow-diagram-as-product-photo |
| dify.ai | Community-driven differentiation, GitHub prominence |

### 8.2 H1/eyebrow lines (verbatim, for inspiration not copy)

- Fireworks: "FROM THE CREATORS OF PYTORCH" / "From Inference to Intelligence"
- Together: "⚡️ FlashAttention-4: up to 1.3× faster than cuDNN on NVIDIA Blackwell" / "Build what's next on the AI Native Cloud"
- Modal: "The production cloud for AI." / "AI infrastructure that developers love"
- Replicate: "Run open-source machine learning models with a cloud API" / "Run AI with an API."
- Anthropic: "AI research and products that put safety at the frontier"

### 8.3 WebGPU + canvas primitives (research-backed)

- Stripe mesh gradient: https://github.com/khasty720/stripe-gradient
- tsParticles: https://particles.js.org/
- Three.js webgpu renderer (latest): `import * as THREE from 'three/webgpu'`
- kishimisu/WebGPU-Fluid-Simulation
- matsuoka-601/waterball + WebGPU-Ocean

### 8.4 Tufte reference

- Skill repo: https://github.com/aref-vc/tufte-claude-skill
- Principles distilled to 7 in §6.

### 8.5 AI-native design tools (for component generation, not implementation)

- v0.dev (Vercel)
- Galileo AI
- Uizard
- Figma Make
- Moonchild AI
- Visily
- Relume AI

### 8.6 Awwwards / SOTD references

- awwwards.com/websites/sites_of_the_day/
- awwwards.com/awwwards/collections/ai-powered-web-projects/

---

## 9. RISK REGISTER + TRAPS (READ BEFORE EVERY WAVE)

### R1: Color bleed regression
- **Symptom:** lavender/pink/cyan/golden reappears
- **Source:** nav.js runtime injection (line 576+), per-page inline `<style>` blocks
- **Mitigation:** §7 audit gate #3 (grep) runs every wave

### R2: Test-anchor wipe (W220, W260, W271, W335, W373, W404, W408, W410)
- **Symptom:** site tests fail because hidden anchor span removed
- **Source:** per-page rewrites that drop the hidden test-anchor block
- **Mitigation:** §7 audit gate #4 + memory note from W604 trap

### R3: Staging contamination (W604 trap)
- **Symptom:** unintended files staged via `git add -A`
- **Source:** wide-net staging
- **Mitigation:** §7 audit gate #7 — stage explicit paths only

### R4: Vercel cache staleness
- **Symptom:** CSS/JS changes don't appear in prod for hours
- **Source:** sw.js not bumped, browser holds old cache
- **Mitigation:** §7 audit gate #5

### R5: nav.js runtime injection conflicts
- **Symptom:** mega-menu shows stale links, surface-media tiles show stale colors
- **Source:** nav.js auto-injects after page load; if links/colors changed in HTML but not nav.js, drift
- **Mitigation:** nav.js change goes in same wave as the HTML change it depends on (W728)

### R6: Vercel deploy doesn't auto-trigger from public/main push
- **Symptom:** public/ mirror updated, kolm.ai still stale
- **Source:** documented in memory: "every deploy wipes DB" + "auto-deploy not firing from public/main pushes" (W545)
- **Mitigation:** kolm.ai deploys from `origin` (the private mirror), NOT public/. Push to BOTH; origin triggers Vercel; public is OSS mirror.

### R7: Test-runner state leak across test families
- **Symptom:** Tests pass standalone but fail in full suite
- **Source:** shared KOLM_DATA_DIR across test runs (W470 P0-1)
- **Mitigation:** N/A for FE-only waves; FE waves have no test impact unless backend route touched

### R8: `--ks-accent-cool` removal breaks pages that still reference it
- **Symptom:** flat color on hover/active states
- **Source:** W683 removes token; per-page CSS may still reference
- **Mitigation:** W685 inline-style audit catches; CSS fallback `color: var(--ks-accent-cool, var(--ks-fg-2))` for transition wave

### R9: Page deletion breaks inbound links
- **Symptom:** SEO loss, 404s from backlinks
- **Source:** W693, W709, W719, W724 deletions
- **Mitigation:** `vercel.json` rewrites SHIP IN SAME COMMIT as delete (not separate)

### R10: Plan execution loses thread mid-tranche
- **Symptom:** confusion after context compaction
- **Mitigation:** this file. Always Read this file first on resume. Lowest un-executed wave is the next task.

---

## 10. EXECUTION HANDOFF

### 10.1 On resume after compaction

1. Read this file (`KOLM_ULTRA_PLAN_2026_05_24.md`) in full.
2. Run `git log --oneline -10` to see last shipped wave.
3. Find the lowest wave ID in §3 not yet in `git log`.
4. Open that wave row + its per-page brief in §4 + its risk row in §9.
5. Execute. Stage explicit paths. Bump sw.js. Commit. Push both remotes.

### 10.2 Definition of done per wave

- All FE files in the wave row touched (or skip explicit) + commit
- All BE files in the wave row touched (or skip explicit) + commit
- §7 audit gates 1–10 pass
- `frontend-version.json` updated
- Pushed to origin AND public

### 10.3 Definition of done overall (launch criteria)

- W821–W831 complete
- `find public -name '*.html' | wc -l` ≤ 250 (down from 557)
- Color audit returns 0 forbidden tokens
- Lighthouse ≥ 90 on all 4 categories for top 20 pages
- `release-verify` (if available) all gates green
- Screenshots captured for portfolio / pitch deck

### 10.4 When to stop

Stop only when:
- W831 ships
- OR the user redirects with a higher-priority directive
- OR a wave audit gate fails 2x in a row (then escalate to user)

### 10.5 Parallel agent budget per wave

Per user mandate "up to 100 parallel agents per wave as many as helpful":
- Per wave default: 1 main thread (this assistant) + 0–3 parallel Explore/Plan agents for research-heavy waves
- Tranche-level audit waves (W690, W700, W710, W720, W730, W740, W750, W760, W770, W780, W790, W800, W810, W820, W831): up to 4 parallel agents (color audit + link audit + content audit + screenshot diff)
- Justification: the user's "100 agents" is a budget ceiling, not a target. Parallelism is justified only when subtasks are genuinely independent and large enough to amortize agent setup cost.

---

## APPENDIX A: VALUATION CONTEXT (carried verbatim from user directive for plan robustness)

**Comp set & multiples (mid-2026):**
- Fireworks AI: ~$4B (Series C, mid-2025)
- Together AI: ~$3.3B (Series B-2)
- HuggingFace: ~$4.5B (last priced, possibly stale)
- OpenPipe: acquired by CoreWeave (announced)
- Predibase: acquired by RedHat (announced)
- Modal: ~$1B+ (last priced)
- Replicate: pre-IPO, last priced ~$700M

**Pre-traction valuation range:** $40–$80M seed / $200–$400M Series A (with positioning + receipts visible) → $1–$3B Series B (with 50+ named customers + $10M ARR) → $5–$10B at 36–60mo (with category capture and `.kolm` format standardization).

**Path-to-$10B requires:**
1. Category-creation positioning (locked: "Frontier AI on your own infrastructure")
2. File format standardization (`.kolm` becomes the AI artifact equivalent of `.parquet` for data or `.onnx` for models)
3. Open-source community + enterprise sales motion in parallel (HuggingFace + Snowflake pattern)
4. 3+ marquee regulated customers (defense, healthcare, finance) — visible at launch is necessary, full case studies are not
5. K-score becomes the third-party-cited benchmark (HuggingFace leaderboard pattern)

**Excluded from launch site (user mandate):**
- Founders / about page
- GitHub stars / traction surfaces
(These are launched separately on a later cadence.)

---

## APPENDIX B: REMEMBER (memory writeback after each tranche)

After each tranche ships, write a single MEMORY.md entry summarizing:
- Wave range completed
- Net file delta (X files added, Y deleted)
- Commit SHAs (origin + public)
- One trap encountered + mitigation

This keeps post-compaction recovery cheap.

---

END OF PLAN. Total length: ~9,500 words. Estimated execution timeline: 30–60 days at one tranche per day. Survives compaction. Atomic. Surgical. Exhaustive.
