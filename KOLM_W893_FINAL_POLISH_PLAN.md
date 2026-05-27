# KOLM W893 — FINAL POLISH PLAN

**The last pass before V1 launch.** Atomic, surgical, exhaustive. Every checkbox
below must be ticked before commit. After this, V1 ships.

This file is the durable record of the user-issued punch list of 2026-05-27.
Per the user directive: "document NOW so it survives compacting. do not stop
working until 100% of all docs are done, its deployed when done, and tested in
prod."

Ordering: complete **W892** (six post-launch user-cluster items) FIRST →
**W893** below → bump sw.js → commit → push public → push origin → prod test.

Word-choice rule (load-bearing across the whole file): do **not** use the words
"honest" or "honesty" anywhere. Use "Caveats" / "Constraints" / "Limitations"
instead. Forward-looking; no retroactive scrub required.

---

## W892 — six user-cluster post-launch items (~13 h total)

Source: 2026-05-27 user directive (six clusters → six adds).

| # | Cluster | Add | Effort | Status |
|---|---------|-----|--------|--------|
| C1 | Solo dev ($100–500/mo) | 3-min YouTube demo (indie loop e2e) | 2 h | pending (page scaffold + linked) |
| C2 | Startup team ($2–10K/mo) | GitHub Action `kolm-ai/quality-gate-action@v1` | 4 h | pending |
| C3 | Enterprise compliance | `/security/questionnaire` — 50 pre-answers | 3 h | pending |
| C4 | ML engineer (control) | Standalone `/spec/toml` reference page | 1 h | **DONE** (`public/spec/toml.html`) |
| C5 | Edge / IoT | `--target-profile` lookup table | 2 h | pending |
| C6 | Government / sovereign | `/government` landing page | 1 h | **DONE** (W889-8.1 shipped already) |

For each: page or code change → no breaking schema migration → wire into nav or
docs surface → smoke test → bump sw.js once at the end of W893.

---

## W893 — FINAL POLISH PUNCH LIST (verbatim, preserved)

### PART 1: SITE FIXES (visible to everyone — do first)

#### 1.1 Enterprise Pricing → Contact Sales
```
□ Change Enterprise card on /pricing and homepage from "$1,499/mo" to "Custom"
□ Change the Enterprise CTA from "Start Enterprise" to "Talk to sales"
□ Link the Enterprise CTA to /enterprise/inquiry (a contact form or Calendly embed)
□ The /enterprise page should have: "Book a call" CTA, not a self-serve signup
□ Keep $499/mo Business tier as the highest self-serve tier
□ Update Stripe: remove the $1,499 Enterprise product if it exists as self-serve
```

#### 1.2 GitHub Org Rename
```
□ Rename the GitHub repo to `kolm` (or `kolm-ai/kolm` if you create a new org)
   OR at minimum rename the repo from `kolmogorov-stack` to `kolm`
□ Update every GitHub link on the site:
   - Nav: GitHub ↗ link
   - Footer: GitHub → link
   - Hero: Apache-2.0 link
   - CTA band: GitHub → link
   - Docs: any repo references
   - README badges
□ GitHub automatically redirects old URLs, but update anyway for cleanliness
```

#### 1.3 Footer Link Consistency
```
□ Change product.html → /product
□ Change use-cases.html → /use-cases
□ Change pricing.html → /pricing
□ Change download.html → /download
□ Change signup.html → /signup
□ Ensure all internal links are extensionless (Vercel/Railway rewrites handle this)
```

#### 1.4 Blog + Changelog in Navigation
```
□ Add "Blog" to the Build column in the footer (between Benchmarks and FAQ)
□ Add "Changelog" to the Build column in the footer (after FAQ)
□ Optional: add "Blog" to the main nav between "Docs" and "GitHub"
```

#### 1.5 Wrapper/Studio Naming Alignment
```
□ If keeping Wrapper/Studio as CLI command names: document both names
   "kolm wrapper up" starts the Route & Capture gateway
   "kolm studio open" opens the Distill & Compile browser UI
□ Add a one-line mapping in docs: "The wrapper CLI is the Route & Capture surface"
□ Ensure the homepage cards for wrapper and studio link correctly:
   - wrapper card → /wrapper (not /capture)
   - studio card → /studio (not /forge)
```

#### 1.6 New Copy: Features Not Yet Mentioned on Site
```
□ Shard KV cache (10× compression) — Run & Govern section
□ Device management + fleet — Run & Govern section
□ On-device quant testing — Distill & Compile or Run
□ Cloud compile (RunPod) — Distill & Compile
□ kolm doctor — Quickstart
□ GitHub Action quality gate — Docs or new /ci page
□ Target profiles for edge — Run or new /edge page
```

#### 1.7 Nav Structure
```
Current: Product | Use cases | Pricing | Docs | GitHub
No changes unless adding Blog (optional).
```

### PART 2: CODEBASE QUALITY

#### 2.1 Dead Code Removal
```
□ Remove unused .js files from src/ (no importers anywhere)
□ Remove unused exports (no callers)
□ Remove commented-out code blocks (>3 lines clearly dead)
□ Remove all console.log in production code (replace with structured logger)
   grep -rn "console\.log" src/ cli/ workers/ | grep -v node_modules | grep -v test
```

#### 2.2 Error Messages Audit
```
□ Every user-facing error: WHAT + WHY + WHAT TO DO (specific command).
   BAD:  "Error: compilation failed"
   GOOD: "Compilation failed: K-Score 0.72 below gate (0.85).
          Your model needs more training data in the 'billing' category.
          Run: kolm captures seed --namespace support --template billing --count 50"
□ grep -rn "throw new Error\|Error(" src/ cli/ workers/ — audit each
□ Gateway errors: proper HTTP status + helpful body shape:
   { "error": { "type": "rate_limit_exceeded", "message": "...", "help": "Upgrade at kolm.ai/pricing" } }
```

#### 2.3 Logging Standardization
```
□ Create or verify shared logger at src/shared/logger.js
□ Replace every console.log in production code with logger.info/warn/error
□ Add request_id to every gateway log entry
□ Ensure no PII, API keys, or user content appears in logs
```

#### 2.4 Configuration Completeness
```
□ .env.example with EVERY env var the app uses
□ kolm config list shows all configuration options
□ kolm config get <key> works for every key
□ kolm config set <key> <value> persists to ~/.kolm/config.toml
```

#### 2.5 Dependency Lock
```
□ package-lock.json committed + up to date
□ requirements.txt has pinned versions for all Python deps
□ No floating versions (^, ~, *, latest) in production dependencies
□ npm audit --audit-level=critical → 0 critical
□ pip-audit → 0 critical
```

### PART 3: CLI COMPLETENESS

#### 3.1 Help Text Audit (for every verb)
```
□ kolm --help + every verb + every sub-verb: description + ≥1 example + flags + --json
   gateway, gateway start/stop/status/health/call/providers
   captures, captures list/inspect/approve/reject/quarantine/stats/export/seed
   receipts, receipts list/stats/export/rotate-key
   verify
   namespace, namespace create/config/stats/deploy/undeploy/rollback
   compile
   forge, forge data/train/export
   inspect
   hardware
   fit
   serve
   export
   bench
   test-device
   test-quants
   devices, devices add/list/status/health/ping/remove
   deploy
   fleet, fleet status/deploy/monitor/rollback
   drift
   savings
   artifact, artifact lifecycle/revoke
   assurance
   evidence
   doctor
   config
   whoami
   version
   cloud
   chat
   test
```

#### 3.2 --json Audit
```
□ Every output-producing command supports --json
□ --json output is valid JSON (parses through jq)
□ --json contains all fields shown in the human-readable output
□ Test: each command --json | jq . — must not error
```

#### 3.3 Exit Codes
```
□ 0 on success, non-zero on failure
□ Specific codes:
   1  general error
   2  invalid arguments
   3  authentication failure
   4  resource not found
   5  rate limited
   10 K-Score below gate
□ Test: each command with invalid args → verify non-zero exit
```

#### 3.4 Progress Indicators
```
□ kolm compile → per-pass, per-step progress bar
□ kolm deploy → upload, install, start, smoke test
□ kolm bench → per model, per eval example
□ kolm test-quants → per quant level
□ kolm captures export → per batch
□ Every >5s operation has a visible progress indicator
□ All progress indicators respect --no-color and --json (no ANSI in JSON mode)
```

#### 3.5 Graceful Shutdown
```
□ Ctrl+C on every long-running command:
   - stops cleanly (no orphan processes)
   - doesn't corrupt state (no half-written artifacts)
   - prints "Interrupted" and exits 130
□ kolm serve / gateway: finishes in-flight, then stops
□ kolm compile: stops cleanly, cleans up temp files
□ kolm deploy: device left in PREVIOUS state, not half-deployed
```

### PART 4: TUI

#### 4.1 TUI Screens (mirror account UI)
```
kolm tui launches:
□ Home (dashboard)
□ Gateway
□ Captures
□ Namespaces
□ Namespace detail
□ Compile (wizard)
□ Artifacts
□ Artifact detail
□ Devices
□ Device detail
□ Fleet
□ Settings
□ Doctor

Nav:
□ Number/arrow keys between screens
□ Tab between panels
□ q quit, / search, ? help overlay, Esc back
```

#### 4.2 TUI Design (cool slate, no warm tones)
```
Bg #0e1116 / Surface #161b22 / Border #30363d
Text #e6edf3 / Mute #8b949e / Accent #58a6ff
Success #3fb950 / Warning #d29922 / Error #f85149
System mono font
Header: kolm + screen name + keybindings hint
Sidebar: screen list (current highlighted)
Footer: status bar (connection, last action, help)
```

#### 4.3 TUI Implementation
```
□ TUI actions call the same functions as the CLI (one API, two surfaces)
□ Refresh on configurable interval (default 5 s live screens)
□ Keyboard shortcuts in ? overlay
```

### PART 5: ACCOUNT POST-AUTH UI/UX

#### 5.1 Design System (matching site theme — cool slate, NO warm)
```
Light bg #f3f5f7 / Dark bg #0e1116
Surface #ffffff / #161b22
Surface-2 #eef1f5 / #1c2129
Border #d1d5db / #30363d
Text #1c2024 / #e6edf3
Text-2 #636c76 / #8b949e
Accent #0969da / #58a6ff
Success #1a7f37 / #3fb950
Warning #9a6700 / #d29922
Error #cf222e / #f85149

Sans: system-ui / -apple-system / 'Segoe UI'
Mono: 'JetBrains Mono', 'SF Mono', ui-monospace
Headings: 600 weight, -0.02em tracking
Body: 400 weight, 1.5 line height

Cards: 1px border, 8px radius, hover shadow
Buttons: primary (accent fill), secondary (border), ghost (text)
Tables: alt rows, sticky headers
Badges: pills, color-coded
Tabs: underline (not pill)
Code blocks: dark #0e1116 even in light mode
Empty states: centered text + icon + single CTA
Loading: skeleton placeholders (not spinners)
Toasts: bottom-right, 5s auto-dismiss

Dark mode: toggle in account header, persists in localStorage,
respects prefers-color-scheme on first visit.
```

#### 5.2 Account Page Inventory
```
Dashboard:
□ /account → next-actions, three surface cards, savings, activity feed,
   new-user empty state ("Route your first call …")

Gateway:
□ /account/gateway — routing pie/bar, provider cards, recent calls, cost,
   "why frontier" breakdown
□ /account/gateway/providers — configured providers, add form, priority order

Captures:
□ /account/captures — list (preview/teacher/tokens/quality/status/ts),
   filter, bulk actions, search, ★ active-learning badge
□ /account/captures/:id — full input/output, metadata, receipt link, actions,
   "similar captures"

Namespaces:
□ /account/namespaces — cards with readiness bars
□ /account/namespaces/:id — readiness panel, status, teacher dist,
   active learning, deployed artifact, drift, actions
□ /account/namespaces/:id/compile — wizard:
   1 readiness
   2 student selection (TAAS results)
   3 format cards
   4 advanced (gate, passes, council)
   5 progress
   6 result + deploy/download

Artifacts:
□ /account/artifacts — cards (name/K/size/format/state/created)
□ /account/artifacts/:id — six tabs:
   Overview, Passport, Evaluation, Runtime Targets, Receipts, Deploy
□ /account/artifacts/:id/compare — side-by-side, diff, recommendation

Devices:
□ /account/devices — fleet dashboard cards
□ /account/devices/:id — hardware / deployments / health / bench / actions
□ /account/devices/add — 5-step wizard

Governance:
□ /account/governance/drift
□ /account/governance/lifecycle
□ /account/governance/evidence
□ /account/governance/assurance
□ /account/governance/savings
□ /account/governance/receipts

Settings:
□ /account/settings — API keys, team, billing, config, signing keys,
   notifications, dark-mode toggle, export-all-data, delete account

Onboarding:
□ /account/onboarding — 4 paths (GPU / No GPU / Route only / Verify only),
   live feedback, completes at dashboard, replayable from settings
```

#### 5.3 Empty States
```
□ Dashboard new-user
□ Captures none
□ Namespaces none
□ Artifacts none
□ Devices none
□ Drift no data
□ Receipts none
□ Savings no data
```

#### 5.4 Loading States
```
□ Skeleton loaders match content shape
□ Lists 3-5 gray-bar rows
□ Cards skeleton card shape
□ Charts skeleton outline
□ >5s: "This is taking longer than expected"
□ Failure: retry button
```

#### 5.5 Responsive
```
□ Desktop >1024 — sidebar + main
□ Tablet 768–1024 — collapsible sidebar, single column
□ Mobile <768 — bottom nav, stacked cards, simplified tables
□ Every table has horizontal scroll wrapper on mobile
□ Every action menu reachable on touch
□ Test on Chrome / Firefox / Safari / Edge / iOS Safari / Android Chrome
```

### PART 6: SPECIFIC COPY ADDITIONS

#### 6.1 New Product Pages to Create (if missing)
```
□ /edge
□ /fleet
□ /ci
□ /government  (W889-8.1 done — verify content matches Part 6.1 brief)
□ /roi (3-year TCO model)
```

#### 6.2 Footer Link Verification (every link → 200)
```
□ /gateway   □ /capture     □ /distill   □ /compile
□ /runtimes  □ /registry    □ /quickstart □ /docs
□ /sdks      □ /models      □ /benchmarks □ /faq
□ /security  □ /soc2        □ /hipaa-mapping □ /baa
□ /privacy   □ /status      □ /subprocessors □ /verify-prod
□ /enterprise □ /manifesto  □ /why-kolm  □ /press
□ /contact   □ /spec/kolm-format-v1   □ /spec/toml (W892-C4)
□ /blog      □ /changelog   □ /compare  □ /pricing
□ /self-host □ /download
□ All /integrations/*   □ All /docs/*
```

### PART 7: FINAL PRODUCTION AUDIT

```
□ npm audit --audit-level=critical → 0 critical
□ git log -p | grep -c "sk-ant-\|sk-proj-\|OPENAI_API_KEY=sk" → 0
□ HTTPS everywhere (no http:// links on the site)
□ CORS — NOT Access-Control-Allow-Origin: * in production
□ CSP headers set
□ Rate limiting on all public endpoints
□ Input validation on all API endpoints
□ Graceful shutdown handlers (SIGTERM, SIGINT) registered
□ /health → { ok: true, version, uptime }
□ Sentry captures all unhandled errors
□ package-lock.json committed with pinned versions
□ .env.example exists, all env vars documented
□ README.md exists with quickstart + link to docs
□ LICENSE file exists (Apache-2.0)
```

### PART 8: VERIFICATION

```
1. Full test suite          : kolm test all
2. Ship gate                 : kolm test ship-gate
3. Walk indie dev journey    : signup → set base URL → call → capture →
                               approve → compile → serve → query
4. Walk account UI           : visit every page in 5.2; no JS errors
5. Check every footer link   : curl each; 200
6. Enterprise CTA            : goes to contact form, NOT self-serve signup
7. GitHub links              : renamed repo, not sneaky-hippo
8. Commit                    : git add -A && git commit -m "V1.0 final polish — complete" && git push
```

---

## Deploy + prod-test (terminal)

```
□ sw.js CACHE → kolm-v117-2026-05-27-<slug>
□ Bump CACHE_VERSION
□ git add <specific files>; git reset HEAD docs/research/
□ Commit (NEW commit, never --amend, never --no-verify, never bypass signing)
□ Push public main (frontend first per standing rule)
□ Push origin main (Vercel auto-deploy trigger)
□ Wait for Vercel deploy to land
□ Probe live: /, /pricing, /enterprise, /spec/toml, /security/questionnaire,
   /government, /ci, /edge, /fleet, /roi → 200
□ Probe live: /v1/health, /v1/gateway/health → 200 ok:true
□ Probe live: /v1/changelog → 200 with full envelope
□ Run kolm doctor — 0 critical
□ Run kolm test ship-gate — 52/52 green
□ Record final cold-start mean+p95 for kolm version (N=10)
```

---

## Caveats (residual constraints noted, not blockers)

- Railway redeploy is **not** auto-triggered by `git push public main` (per
  memory `W547`). When backend code changes (e.g. PUBLIC_API allowlist edits
  in `src/auth.js`), the public push deploys Vercel only. Railway needs
  `railway up` from an interactive shell — out of scope from this Codex
  session.
- C1 (3-min YouTube demo) requires recording outside this shell. W893 ships
  the page that links to it; the video URL slot is left as a `data-video-id`
  marker so it can be patched in later.

---

End of W893 plan. After every box ticks: V1 is shipped, V1 is sold.
