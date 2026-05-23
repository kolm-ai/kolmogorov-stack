# KOLM_VALUATION_PLAN — W656→W680+ atomic wave plan

**Date authored:** 2026-05-23
**Authored by:** Claude (Opus 4.7) at user's explicit request
**Purpose:** Survive context compaction. Every wave below is atomic, self-contained, and re-entrant — a fresh Claude reading only this file plus the repo should be able to pick up any wave mid-stream and finish it.

**The mandate (verbatim from user):**
> "make a document first to make sure you follow all atoms of this feedback over as many waves as necessary surviving comapction"

Preceded by:
> "review kolm.ai whole heartedly and give me a valuation … give all possible modes of improvement we can possible have to get to 10/10 and higher vals … exhaustively to get to 1b-10b. Separate your advice by front end: and back end:"
> "how can we make it 100x better? i thjink those heros are too niche so i was thinking just calling it an AI lab? or AI workbench? or what do you suggest?"
> "give me exhaustively eveyhting this needs to raise at $1B just on tech alone one pilot customer."
> "implement exhaustively. atomically. surgically. make no mistakes."

---

## §0 — TL;DR

We are repositioning kolm.ai from "open-source AI compiler" (W604 frame) to **"the open-source AI engineering workbench"** while keeping every compiler claim intact in body copy and preserving every lock-in test anchor (W220, W260, W268, W271, W335, W373, W404, W408, W410). Then we add ~23 implementation waves of receipts-first proof surfaces (solution pages, /compare matrix, /security, /marketplace, /gateway, /k-score leaderboard, /spec/kolm-1, /cookbook, /manifesto, /customers, programmatic SEO) plus 8+ back-end items (auto-distill loop, multi-teacher, ZK receipts, KIP-1 standard, FedRAMP roadmap, additional runtimes, marketplace revenue share, CMEK, OpenAPI publishing, additional SDKs).

**Target outcome:** A site/product that an institutional investor evaluating a $1B–$10B Series A round can read end-to-end in 30 minutes and conclude "this is the AI workbench category."

---

## §1 — Standing operational constraints (DO NOT VIOLATE)

These are persistent rules from prior session memory. They apply to **every** wave below.

1. **Two remotes, both must be pushed:** `git push origin main` (Vercel auto-deploy) and `git push public main` (GitHub public mirror). A wave is not "live" until both are pushed.
2. **Service worker cache bust:** Every wave that touches `public/*.html`, `public/*.css`, or `public/*.js` MUST bump `public/sw.js` `CACHE` constant to `kolm-vN-YYYY-MM-DD-waveNNN-short-slug`. Increment `N` by 1 per wave.
3. **Frontend version log:** Every wave MUST prepend a new entry to the top of `public/frontend-version.json` `stale_copy_checks` array. Format: `{"wave": "WNNN", "date": "YYYY-MM-DD", "slug": "...", "paths": [...]}`.
4. **Surgical staging:** ALWAYS stage by explicit file path. NEVER `git add -A` or `git add .`. Working tree may contain ~500 dirty files from prior sessions (W604 trap).
5. **Two audit gates before every commit:**
   - `node scripts/audit-href.cjs --strict` → must report `broken: 0`
   - `node scripts/audit-static-refs.cjs` → must report `missing static refs: 0`
6. **Preserve lock-in test anchors.** Never remove these from public HTML without first updating the corresponding test file. Currently in play:
   - W220: `data-w220="category-claim"` (must contain word "compiler" in homepage hero or body)
   - W260: SOC 2 Type I "available" pill on /trust
   - W268: integrations Zapier/Make.com "shipped" pill
   - W271: changelog freshness gates
   - W335: pricing tier integrity
   - W373: gateway capture loop visible
   - W404: model-class artifact present
   - W408: distill recipe links resolve
   - W410: trust-strip "all surfaces ok" badge
7. **No commit/push without explicit user request.** Stage and run audits; wait for user to say "ship it" / "commit and push" / equivalent.
8. **No `*.md` creation without explicit user request.** This file itself was explicitly authorized. Do not write further `.md` files unless asked.
9. **Never force-push.** Exception: `public/main` on kolmogorov-stack is allowed if user explicitly authorizes.
10. **Never stage secrets:** `.env*`, `*.pem`, `*.key`, `secrets/`, `%TEMP%tid.txt`. Delete `.env.prod` after any use.
11. **Hero copy retains the word "compiler"** somewhere in visible body to satisfy W220 even after rebrand to "workbench" eyebrow.

---

## §2 — Session state on 2026-05-23 (what is live now)

- Last shipped commit: **`723acf1`** (W655 first-principles compile-receipts band on homepage)
- Previous: **`44598dc`** (W652–W654: receipts on use-cases, pr-vs cost bars on pricing, kolm-svg icons on product)
- `sw.js` CACHE: `kolm-v7-2026-05-23-wave655-compile-receipts`
- Both remotes (`origin` + `public`) in sync at `723acf1`.
- Vercel deploy: kolm.ai serving W655.
- Audit baseline at HEAD: `audit-href 19615 ok 0 broken`, `audit-static-refs 0 missing`.
- Uncommitted in working tree: `public/recipes.html` carries ~513 lines of pre-existing SEO/OG/JSON-LD changes from a prior session — **do not stage in W656+ unless reviewing those lines first**. The /binder→/spec/rs-1 fix lives uncommitted there.

---

## §3 — BRANDING DECISION (LOCKED 2026-05-23)

User asked: *"i thjink those heros are too niche so i was thinking just calling it an AI lab? or AI workbench? or what do you suggest?"*

### LOCKED CHOICES (user-confirmed)

- **Eyebrow / category:** `Open-source AI workbench`
- **H1:** `Capture, distill, compile, deploy. Your AI, on your hardware, with receipts.`

Both choices preserve W220 anchor (`compile` appears in H1).

### Original recommendation kept for context: **"The open-source AI engineering workbench"**

**Why workbench beats lab, platform, compiler, or studio:**
- **Workbench** = active surface where engineers do work. Implies tooling, control, repeatability. Sells to the IC + their manager.
- **Lab** = experimental, research-coded. Implies unfinished. Bad for selling to platform teams.
- **Platform** = saturated category. Vercel, Replicate, Modal, Together all call themselves platforms. Workbench is uncrowded.
- **Compiler** is technically accurate but niche — keep it in body copy as the *engine* description, not the *category* description.
- **Studio** is design-coded (Figma, Linear). Wrong vibe for inference-cost engineering.

### Proposed hero copy (W656)

**Eyebrow:** `Open-source AI engineering workbench`

**H1 (pick one — present to user as a question):**
- **A.** "Own your AI. Compile it once. Run it anywhere. Forever."
- **B.** "Turn your API traffic into private models you own — in 4 commands."
- **C.** "The workbench for engineers who don't want to rent intelligence forever."
- **D.** "Capture, distill, compile, deploy. Your AI, on your hardware, with receipts."

**Recommended:** **A**, because it lands the four-word product promise (own / compile / run / forever) in a rhythm and includes "compile" which preserves the W220 anchor.

**Lede (sub-h1):**
> "DeepSeek-R1-Distill 32B → 17.9 GB INT4 in 125 s on one RTX 5090. Your traffic stays yours. Every artifact ships with a sha256 receipt and an Ed25519 signature."

**Stats strip (under lede, 4 columns):**
- `510 HTML pages` — public surface
- `385 routes` — backend API
- `4 SDKs` — Node, Python, C, Rust (+ MCP, VSCode)
- `0→17.9 GB` — proven quantize matrix, RTX 5090

**Trust pill row (immediately under stats):**
- Apache-2.0 · SOC 2 Type I (available) · K-score verified · Ed25519 signed · runs on Mac / Linux / Windows / WebGPU

### Wave W656 user gate

**Do not start W656 until user confirms one of A/B/C/D, or proposes their own H1.** Show them this section verbatim and ask "Which H1?" + "Workbench framing OK?"

---

## §4 — Wave-by-wave atomic plan (W656 → W680+)

Each wave below has: **scope · files · pattern · verification · est. diff size**.

### W656 — Hero rebrand + outcome-led H1

- **Scope:** Replace W604 hero (eyebrow "Open-source AI compiler" + h1 "Distill frontier models / Quantize to INT4 / Run on your hardware") with workbench framing per §3.
- **Files:** `public/index.html` (lines ~120–260 hero block), `public/sw.js`, `public/frontend-version.json`.
- **Pattern:**
  - Keep `<div class="kolm-anatomy">` and `<section class="home-receipts">` (W604/W655) intact.
  - Replace eyebrow text only — keep all `data-*` attributes.
  - H1 becomes user-confirmed option from §3.
  - Lede: DeepSeek-R1 32B → 17.9 GB INT4 sentence (already accurate from W604).
  - Add stats strip + trust pill row as new sibling div under `.hero__lede`.
  - PRESERVE `data-w220="category-claim"` — ensure phrase contains "compiler" somewhere in hero body even if eyebrow changes.
- **Verification:** Run both audits. Visually diff localhost:3000/ vs prod for spacing regressions. Grep for `data-w220` and `category-claim` to confirm anchor intact.
- **Est. diff:** +60 / −20 lines in index.html.

### W657 — Hero persona tabs + "Deploys to" device row

- **Scope:** Add tabbed code/CLI hero showing the 4-command flow under three personas: **Platform Eng / ML Eng / Founder-CTO**. Add a horizontal "Deploys to" strip of device chips (Mac M-series · Linux x86 · NVIDIA RTX · NVIDIA H100 · WebGPU · iOS CoreML · Android NNAPI · Raspberry Pi).
- **Files:** `public/index.html`, new `public/hero-personas.css` (or extend `w604.css`), `public/sw.js`, `public/frontend-version.json`.
- **Pattern:**
  - Tab nav uses radio inputs (no JS state) — CSS-only tab pattern via `:checked` + sibling combinator. Keeps zero-JS hero.
  - Each tab shows a 4-command sequence specific to persona:
    - **Platform Eng:** `kolm gateway start` → 30 captures auto-rolled-up → `kolm distill from-captures` → `kolm deploy --target onnx`
    - **ML Eng:** `kolm capture log` → `kolm bakeoff run` → `kolm compile --quantize int4` → `kolm verify <cid>`
    - **Founder-CTO:** `kolm pull qwen2.5-7b-int4` → `kolm run "..."` → `kolm cost report` → `kolm deploy --hardware rtx-5090`
  - Device row: 8 chips, each a `<span class="kolm-chip">` with `data-kolm-icon` from kolm-svg.js. Hover reveals quantize/latency receipt.
- **Verification:** All 8 device chips must have working icon refs. Tab switching works with keyboard (arrow keys, since radio).
- **Est. diff:** +180 / −10 lines.

### W658 — Logo bar of compatible stacks + K-score badge

- **Scope:** Replace generic "trusted by" placeholder (if any) with a "Compatible with" strip of monochrome SVG marks: vLLM · SGLang · TensorRT-LLM · TGI · llama.cpp · MLX · CoreML · ONNX Runtime · OpenAI SDK · Anthropic SDK · Ollama · LM Studio. Add K-score badge component (the "K" mark, score number, "verified by kolm" label).
- **Files:** `public/index.html`, new `public/img/logos/*.svg` (12 marks), extend `public/kolm-svg.js` with k-score badge primitive, `public/sw.js`, `public/frontend-version.json`.
- **Pattern:**
  - Each logo SVG `currentColor` so opacity-styled.
  - Logo strip uses CSS marquee on mobile (`animation: scroll 30s linear infinite`), static grid on desktop.
  - K-score badge: 64px circular badge, white-on-charcoal "K", score "94.2" underneath, "verified by kolm.ai" microtype.
- **Verification:** audit-static-refs must not flag the 12 new SVG paths.
- **Est. diff:** +280 / −0 lines + 12 new SVG files.

### W659 — `.kolm` artifact visual explainer

- **Scope:** New section between W657 device row and W655 receipts band — visual anatomy of a `.kolm` file. Shows it's a zip with manifest.json, weights.bin, signature.ed25519, receipts/, eval/, license.txt. Magnifying-glass illustration with callouts.
- **Files:** `public/index.html`, extend `public/kolm-svg.js` with new `data-kolm-illustration="artifact-anatomy"` primitive.
- **Pattern:**
  - Two-column: left = annotated artifact illustration; right = bullet list of what each component does.
  - Link "see spec" → `/spec/kolm-1` (created in W667).
- **Est. diff:** +120 / −0 lines.

### W660 — Solution pages (×6)

- **Scope:** Six new persona/vertical pages with shared layout. Each must end in a receipt block + a "talk to engineering" CTA (mailto: rodneyyesep@gmail.com or /demo).
- **Files:** new `public/for/healthcare.html`, `public/for/fintech.html`, `public/for/support-automation.html`, `public/for/agents.html`, `public/for/edge-ai.html`, `public/for/government-defense.html`. Update `vercel.json` with 6 clean URL rewrites IN THE SAME COMMIT (W466 trap).
- **Pattern per page:**
  - Hero: vertical-specific outcome ("Distill HIPAA-safe support models without sending PHI to OpenAI")
  - Pain → kolm-solution → 3-step recipe → cost-vs-frontier bar (re-use W653 `.pr-vs` block) → real artifact receipt → compliance pill row.
  - Footer cross-links to /compare, /security, /pricing.
- **Verification:** audit-href must show 0 broken across all 6. vercel.json rewrites tested by curl-ing each clean URL after deploy.
- **Est. diff:** +1200 / −0 lines, 6 new HTML files, 1 vercel.json update.

### W661 — `/compare` matrix

- **Scope:** Comprehensive comparison table: Kolm vs Fireworks AI · Together AI · OpenPipe · Predibase · HuggingFace + vLLM · OpenAI Fine-Tuning · Anthropic Workbench · Replicate · Modal · Baseten. Rows: artifact ownership · self-host · INT4 quantize · gateway capture · distillation · K-score · open spec · Apache-2.0 · cost-per-1M-tokens.
- **Files:** new `public/compare.html`, `vercel.json` (rewrite for `/compare`).
- **Pattern:**
  - Sticky leftmost column (feature names).
  - Kolm column highlighted with `--ks-accent`.
  - Each Kolm "✓" links to receipt (e.g. INT4 → /run/quantize-receipt).
  - Every competitor claim has a footnote citation (link to their pricing page or docs).
- **Critical:** Verify every competitor fact with `WebFetch` before publishing — false competitor claims are litigation risk.
- **Est. diff:** +400 / −0 lines + 1 new file.

### W662 — `/security` expansion

- **Scope:** Promote /trust into a full /security surface. Sections: SOC 2 Type I (current) · SOC 2 Type II (roadmap) · HIPAA BAA (available enterprise) · ISO 27001 (roadmap) · FedRAMP Moderate (roadmap) · threat model · pen-test summary (when available) · data residency · key management · zero-knowledge receipts (W670 back-end).
- **Files:** new or extended `public/security.html`, preserve `data-w260` anchor for SOC 2 Type I pill.
- **Pattern:** Each compliance row has status pill: **available** · **in progress** · **q3 2026** · **enterprise only**.
- **Verification:** W260 lock-in test must pass. Roadmap items must be marked, not claimed.
- **Est. diff:** +500 / −0 lines.

### W663 — `/pricing` improvements

- **Scope:** Three tiers (Pro / Team / Enterprise), each with ROI calculator showing payback period vs frontier API spend. Sticky tier nav on scroll. Add "BYOC" inline comparison from W653 receipts. Currency selector (USD / EUR / GBP).
- **Files:** `public/pricing.html` (extend existing — W653 already added `.pr-vs`), `public/sw.js`.
- **Pattern:**
  - Preserve `data-w335` pricing tier integrity anchors.
  - ROI calculator: vanilla JS, no framework — input monthly frontier spend, output payback in months on each tier.
  - Sticky nav: position: sticky on scroll past hero, links to each tier card.
- **Est. diff:** +250 / −20 lines.

### W664 — `/marketplace` first-class surface

- **Scope:** Marketplace of compiled `.kolm` artifacts. Each entry shows: model name · base model · quantize method · size · K-score · price (free / one-time / per-call) · downloads · sha256 · publisher. Filters: task / size / hardware / license.
- **Files:** new `public/marketplace.html`, new `public/marketplace/[slug].html` per artifact (start with 4–8 published artifacts that already exist in /artifacts), `vercel.json`.
- **Pattern:**
  - Each artifact card uses the same `.home-receipts__row` from W655 for consistency.
  - "Get" button: `kolm pull <slug>` (CLI command, not download link — verifiable trust).
  - License row links to a parseable license page.
- **Est. diff:** +600 / −0 lines + 8 new files.

### W665 — `/gateway` as standalone page

- **Scope:** Pull gateway out of generic feature copy into its own destination page. Show: live analytics dashboard mockup · PII redaction report sample · prompt-cluster visualization · routing rules editor mockup.
- **Files:** new `public/gateway.html`, `vercel.json`.
- **Pattern:** Static mockups (no live data needed for marketing surface). Each mockup is a screenshot of the real /v1/gateway dashboard.
- **Est. diff:** +350 / −0 lines.

### W666 — `/k-score` public leaderboard

- **Scope:** Public leaderboard of K-scores by model + task. Methodology card. Filter by base model · task · hardware. Each row links to verifiable receipt.
- **Files:** new `public/k-score.html`, `public/k-score-leaderboard.json` (data source), `vercel.json`.
- **Pattern:**
  - Initial data: hand-curated 20 entries from existing bakeoff results.
  - Methodology: 3-section explainer — what K measures (accuracy · cost · latency · ownership) · how scored · how to reproduce.
  - "Reproduce" CLI: `kolm bakeoff verify k-score <id>`.
- **Est. diff:** +400 / −0 lines + 1 JSON file.

### W667 — `/spec/kolm-1` format specification

- **Scope:** Public spec for the `.kolm` artifact format. RFC-style document: file layout · manifest.json schema · signature format · receipt format · validation rules · versioning.
- **Files:** new `public/spec/kolm-1.html` (or extend existing `/spec/rs-1` pattern), `vercel.json`.
- **Pattern:** Long-form static doc, RFC numbered sections, monospace blocks. Footer "implementations: kolm-cli (Apache-2.0)" — invite others.
- **Est. diff:** +800 / −0 lines.

### W668 — `/cookbook` with 5+ real use cases

- **Scope:** Cookbook of end-to-end recipes. Each recipe: problem · starting cost · 4-command kolm flow · ending cost · K-score · downloadable `.kolm`.
- **Files:** new `public/cookbook.html`, new `public/cookbook/[slug].html` per recipe (5 to start: support-bot · code-completer · pdf-extractor · summarizer · classifier), `vercel.json`.
- **Pattern:** Each recipe has a "copy all" CLI block + a "fork on github" button.
- **Est. diff:** +800 / −0 lines + 6 new files.

### W669 — Programmatic SEO pages

- **Scope:** Three template families, ~50 pages total:
  - `/quantize/[method]` for: int8 · int4 · nf4 · awq · gptq · spqr · variational-speculative
  - `/distill/[teacher-to-student]` for top 12 pairs (gpt-4o→qwen-7b · claude-sonnet→llama-8b · etc.)
  - `/run/[framework]` for: vllm · sglang · tensorrt-llm · tgi · llama-cpp · mlx · coreml · onnx · openvino · executorch · triton · wasm
- **Files:** ~50 new HTML files in `public/quantize/`, `public/distill/`, `public/run/`, `vercel.json` updates.
- **Pattern:** Templated layout with method-specific receipts. Each page ~300 lines. Use a generator script `scripts/build-seo-pages.cjs` to produce from a JSON config.
- **Est. diff:** +15000 / −0 lines (most generated) + ~50 new files.

### W670 — `/manifesto` (The Compiler Thesis)

- **Scope:** Long-form essay arguing why AI compilation is the next category. ~3000 words. Author byline (founder). Quotable pull-quotes. Footnote citations.
- **Files:** new `public/manifesto.html`, `vercel.json`.
- **Pattern:** Magazine-style layout. Drop-cap. Generous whitespace. Pull-quotes break into right column.
- **Est. diff:** +600 / −0 lines.

### W671 — `/learn/*` glossary

- **Scope:** ~20 glossary pages: distillation · quantization · INT4 · NF4 · K-score · `.kolm` artifact · gateway · receipt · bakeoff · BYOC · sovereign AI · etc.
- **Files:** ~20 new HTML files in `public/learn/`, `vercel.json`.
- **Pattern:** Each page: 1 definition + 1 visual + 1 receipt + cross-links to related terms + "see in product" CTA.
- **Est. diff:** +4000 / −0 lines.

### W672 — `/blog` + 10 cornerstone articles

- **Scope:** Engineering blog with 10 cornerstone articles, each ~2000 words: "Why we built kolm" · "How we proved DeepSeek-R1 32B → INT4 in 125s" · "The economics of API egress" · "K-score: a benchmark you can verify" · "Why .kolm is open" · "How to distill safely" · "Gateway as compliance" · "WebGPU inference economics" · "Sovereign AI in regulated industries" · "Why we're betting on workbench over platform"
- **Files:** new `public/blog.html` (index), new `public/blog/[slug].html` per article (10), `public/blog/feed.xml` (RSS), `vercel.json`.
- **Pattern:** Article layout matches manifesto. Index page lists with date + reading time + tags.
- **Est. diff:** +12000 / −0 lines + 12 new files.

### W673 — Hero demo media (terminal animation)

- **Scope:** Replace static hero CLI block with CSS-keyframed terminal that types out `kolm capture log` → `kolm distill` → `kolm compile` → `kolm run` with simulated output. Respects `prefers-reduced-motion`.
- **Files:** `public/index.html`, extend `public/w604.js` (or new `public/hero-terminal.js`), CSS for terminal.
- **Pattern:** Pure CSS animation cycling through 4 frames, each ~3s. JS only listens for reduced-motion to swap to static.
- **Est. diff:** +200 / −10 lines.

### W674 — `/customers` anonymized case studies

- **Scope:** Even with zero named logos, publish anonymized case studies: "Fintech with 80M API calls/mo cut spend 94% in 2 weeks" · "Healthcare BPO replaced GPT-4 with HIPAA-safe distilled model" · etc.
- **Files:** new `public/customers.html`, `vercel.json`.
- **Pattern:** Anonymized but specific. Industry · scale · before/after metric · K-score · quote (attributed to "head of platform, $X-ARR fintech"). NEVER fabricate — only publish what's true even if anonymized.
- **Verification:** USER GATE — must confirm each case study reflects a real conversation or customer. Skip wave if no real data.
- **Est. diff:** +400 / −0 lines.

### W675 — WebGPU demo (feasibility-gated)

- **Scope:** Live in-browser inference demo using WebGPU + a small distilled model (Qwen2.5-0.5B INT4, ~0.44GB). User types a prompt, model runs locally in tab.
- **Files:** new `public/demo.html`, new `public/demo/model.wasm` (or wllama integration), new `public/demo/runtime.js`, `vercel.json`.
- **Pattern:** Use existing wllama or transformers.js. Load model on user gesture (don't auto-download 440MB).
- **Risk:** Vercel static hosting may not handle 440MB asset gracefully. May need to host on R2/S3 with CORS. Flag for review before starting.
- **Est. diff:** +500 / −0 lines + binary asset.

### W676 — Compatible-stack logo SVGs in trust strip

- **Scope:** Add the 12 SVG marks from W658 to the new global footer trust strip and to `/compare`. Single source of truth in `public/img/logos/`.
- **Files:** new `public/img/logos/*.svg`, update `public/footer.html` (if exists) or inject pattern into pages with footers.
- **Est. diff:** +120 / −0 lines + 12 SVGs.

### W677 — Enterprise tier copy + page

- **Scope:** Enterprise-specific landing page. SSO/SAML · SCIM · audit log · CMEK · dedicated tenancy · SLA · BAA · DPA · custom training · support tier. Pricing: "contact us".
- **Files:** new `public/enterprise.html`, link from /pricing tier 3, `vercel.json`.
- **Est. diff:** +400 / −0 lines.

### W678 — Brand manifesto / about update

- **Scope:** Update `/about` (if exists) or create from founder voice. Skip founders bio per user constraint ("outside of 1. founders / about page and 2. stars and traction"). Focus on company thesis, not people.
- **Files:** `public/about.html` (update existing or new).
- **Est. diff:** +200 / −50 lines.

### W679 — Conversion optimization pass

- **Scope:** Add CTAs in 5 strategic positions on every long page: hero · after first proof · mid-page · before footer · sticky. Each CTA pair: primary "Try free" + secondary "Talk to eng".
- **Files:** sweep across `public/index.html`, `public/product.html`, `public/use-cases.html`, `public/pricing.html`, `public/compare.html`, `public/security.html`.
- **Pattern:** Use existing button classes; never duplicate CSS. CTA text never marketing fluff — always outcome ("Run your first distillation in 4 commands").
- **Est. diff:** +300 / −100 lines.

### W680 — Final design polish + a11y sweep

- **Scope:** Run axe-core or pa11y across every new page from W656–W679. Fix contrast violations · missing alts · keyboard traps · focus state regressions · ARIA misuse.
- **Files:** sweep.
- **Verification:** Pa11y reports 0 errors per page. Manual keyboard nav test on hero + every new page.
- **Est. diff:** +100 / −50 lines.

---

## §5 — Back-end items (separate planning track, queued post-W680)

These items require backend code, not just static surface. Flag for separate waves once front-end track is shipped through W680. They are NOT trivially addable during front-end waves — premature inclusion will block front-end work.

### B1 — Auto-distill loop
Background job that periodically triggers `kolm distill from-captures` once gateway has accumulated N captures (default 1000) in a namespace. Adds `KOLM_AUTODISTILL_ENABLED` env + `/v1/autodistill/{status,configure}` routes + CLI verb. Touches src/distill.js, src/router.js, cli/kolm.js.

### B2 — Multi-teacher distillation
Allow `kolm distill` to query 2+ teacher models per capture, blend responses by weighted consensus or majority vote. Teacher selection by per-task K-score history. Extend src/distill.js teacher chain.

### B3 — RLAIF preference loop
After bakeoff, allow users to mark preferred outputs. Train preference model. Use to re-rank distillation candidates. New src/preference-loop.js + 4 routes.

### B4 — ZK receipts (zero-knowledge proofs)
Each `.kolm` artifact can include a ZK proof that distillation was run on the claimed data without revealing the data. Likely uses Halo2 or similar. Heavy lift — estimate 6+ waves alone.

### B5 — KIP-1 (Kolm Improvement Proposal) standard
Open governance process for `.kolm` format evolution. Models on Python PEP / JS TC39. Repo at github.com/kolm-ai/kips.

### B6 — FedRAMP Moderate roadmap
Document control matrix, gap analysis, target authorization date. Engage 3PAO. ~12 months.

### B7 — EU AI Act compliance posture
Risk classification document. Conformity assessment for "high risk" use cases. CE marking workflow if any deployed model qualifies.

### B8 — Additional runtimes (ONNX · OpenVINO · ExecuTorch · Triton · WASM)
Currently strong on vLLM/SGLang/llama.cpp/MLX. Add explicit deployment paths and verification for the remaining 5 runtimes. Each is its own wave (compile spec + verify path + docs page).

### B9 — Marketplace revenue share
Backend for publishers to upload `.kolm` files, set pricing, receive payouts. Stripe Connect. Requires legal: publisher agreement, tax handling, content moderation.

### B10 — CMEK (Customer-Managed Encryption Keys)
For enterprise tier — customer brings their KMS key (AWS KMS / GCP KMS / Azure Key Vault / HashiCorp Vault) for encryption-at-rest of their captures + artifacts. New src/cmek.js + 3 routes.

### B11 — Full OpenAPI 3.0 publishing
Auto-publish OpenAPI spec to `/v1/openapi.json` + render Swagger UI at `/api`. Already partially exists; complete + lock-in. Extend scripts/build-openapi.cjs from W482.

### B12 — Additional SDKs (Go · Java · C# · Ruby · PHP · Swift · Kotlin)
Current: Node · Python · MCP · VSCode · C · Rust. Each new SDK = 1 wave: source · README · examples · CI compile-verify. Prioritize Go (cloud-native), Java (enterprise), Swift (iOS app makers).

---

## §6 — Categorization of items (feasibility-by-track)

### Track A — pure copy/markup (zero risk, ship freely)
W656 (with user-confirmed H1), W660, W661 (with competitor fact-check), W663, W670, W671, W672, W674, W677, W678, W679

### Track B — needs new SVG/illustration assets
W657, W658, W659, W665, W666, W676

### Track C — needs backend implementation
B1–B12. None ship in W656–W680 front-end track.

### Track D — needs business/legal action
W674 (real customer permissions), B6 (FedRAMP), B7 (EU AI Act), B9 (marketplace TOS)

### Track E — needs feasibility study before starting
W675 (WebGPU 440MB asset hosting), B4 (ZK proofs — pick framework)

### Track F — already shipped, don't redo
W604 first-principles homepage, W652 receipts, W653 cost bars, W654 product icons, W655 compile-receipts band

---

## §7 — Pending user decisions blocking specific waves

1. **W656 — H1 selection.** Block until user picks A/B/C/D or proposes own.
2. **W656 — Workbench rebrand confirmation.** Block until user says "yes, ship workbench" or "keep compiler."
3. **W674 — Real customer permissions.** Block until user names 1+ customer willing to be anonymized.
4. **W675 — WebGPU asset hosting.** Block until user confirms which CDN to use (Cloudflare R2 / Bunny / Fastly / Vercel large asset tier).
5. **B6/B7 — Compliance investments.** Block until user confirms budget / timeline / target customer profile.

---

## §8 — Per-wave verification checklist (run every wave)

```
1. node scripts/audit-href.cjs --strict     →  expect "broken: 0"
2. node scripts/audit-static-refs.cjs       →  expect "missing static refs: 0"
3. git status                                →  confirm only intended files dirty
4. grep -n "data-w220\|data-w260\|data-w268\|data-w271\|data-w335\|data-w373\|data-w404\|data-w408\|data-w410" public/index.html public/<wave-touched-pages>
   → expect every previously-present anchor still present
5. Read public/sw.js                         →  expect CACHE bumped, slug matches wave
6. Read public/frontend-version.json         →  expect new entry at top of stale_copy_checks
7. git diff --stat                           →  sanity-check diff size matches estimate ±50%
8. STAGE BY EXPLICIT PATH                    →  git add public/foo.html public/bar.css public/sw.js public/frontend-version.json
9. git status                                →  confirm only intended files in staging
10. Wait for user to say "ship it"           →  do not commit/push autonomously
11. git commit + git push origin main + git push public main
12. Verify Vercel deploy live                →  curl -s https://kolm.ai/<changed-page> | head
13. Update MEMORY.md with one-line wave entry pointing at this plan + commit sha
```

---

## §9 — Source feedback context (preserved for compaction survival)

The hackGPT feedback dump that motivated this plan covered both **front-end** and **back-end** improvements toward a $1B–$10B valuation justification. Key themes captured above include:

**Front-end (W656–W680):**
- Hero rebrand from niche "compiler" to broader "AI workbench" while preserving compiler language in body (§3, W656)
- Persona-targeted vertical pages (W660)
- Competitive comparison matrix (W661)
- Hardened security/compliance surface (W662)
- ROI-led pricing with payback math (W663)
- Marketplace as first-class product (W664)
- Gateway as its own destination (W665)
- Public K-score leaderboard (W666)
- Open `.kolm` format spec (W667)
- Cookbook with end-to-end recipes (W668)
- Programmatic SEO at scale (W669)
- Manifesto thesis essay (W670)
- Glossary (W671)
- Cornerstone blog content (W672)
- Hero demo media (W673)
- Anonymized customer proof (W674)
- WebGPU in-browser demo (W675)
- Logo strip / trust visuals (W658, W676)
- Enterprise tier page (W677)
- About/brand update (W678)
- Conversion optimization (W679)
- A11y sweep (W680)

**Back-end (B1–B12 — separate track):**
- Auto-distill loop (B1)
- Multi-teacher distillation (B2)
- RLAIF preference loop (B3)
- ZK receipts (B4)
- KIP-1 open standard (B5)
- FedRAMP Moderate (B6)
- EU AI Act posture (B7)
- Additional runtimes — ONNX/OpenVINO/ExecuTorch/Triton/WASM (B8)
- Marketplace revenue share (B9)
- CMEK (B10)
- Full OpenAPI 3.0 publishing (B11)
- Additional SDKs — Go/Java/C#/Ruby/PHP/Swift/Kotlin (B12)

---

## §10 — How to resume after compaction

If a future Claude reads this file mid-plan:

1. Read `MEMORY.md` for the wave-pointer entry pointing at this file.
2. Read this entire file end-to-end.
3. `git log --oneline -20` to find the most recent wave SHA.
4. Identify the next unblocked wave by:
   - Checking §7 for unresolved user decisions
   - Checking §4 for the lowest-numbered wave not yet committed
5. Open §1 (operational constraints) and §8 (verification checklist) before touching any file.
6. Confirm wave intent with user in one sentence: *"Picking up at WNNN — <wave name>. OK to proceed?"*

---

**END OF PLAN.** Last revised 2026-05-23.
