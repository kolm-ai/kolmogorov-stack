# Kolm Stack — Atomic Spec Sheet

**Generated:** 2026-05-28
**Repo:** `kolmogorov-stack`
**Package:** `kolm-stack@0.2.6`
**Branch:** `main` @ commit `4154c665` ("W917: strip og:title brand suffix + preempt kolm-ai/kolm rename + receipt model fix")
**Remotes:** `origin` = `https://github.com/kolm-ai/kolm-private.git` (private; auto-deploys to Vercel) · `public` = `https://github.com/kolm-ai/kolm.git` (frontend-first push target, public mirror)
**Active wave:** W918 (OpenAI fine-tuning shutdown land-grab + Cerebras teacher integration)
**Service worker:** `kolm-v155-2026-05-28-wave918-wave2-agents-gateway-orgs`

This document enumerates every backend module, frontend page, HTTP route, CLI verb, worker, service, SDK file, script, test, and config in the repo. It is a literal inventory, not a summary. Use Table of Contents to jump to a layer.

---

## Table of Contents

1. [TL;DR](#1-tldr)
2. [Headline counts (verified)](#2-headline-counts-verified-2026-05-28)
3. [Repo topology](#3-repo-topology)
4. [HTTP backend — `server.js` + `src/router.js`](#4-http-backend--serverjs--srcrouterjs)
5. [Complete route inventory (709 routes)](#5-complete-route-inventory-709-routes)
6. [`src/` modules — 280+ top-level files](#6-src-modules--280-top-level-files)
7. [`src/` subdirectories (compute, providers, teachers, importers, ...)](#7-src-subdirectories)
8. [Workers (14) — `workers/`](#8-workers-14--workers)
9. [Services (3) — `services/`](#9-services-3--services)
10. [SDKs (6 languages) — `sdk/`](#10-sdks-6-languages--sdk)
11. [Packages (16) — `packages/`](#11-packages-16--packages)
12. [Frontend — `public/` (1,605 files; 1,167 HTML)](#12-frontend--public-1605-files-1167-html)
13. [Marketing top-level (170 HTML)](#13-marketing-top-level-170-html)
14. [Account dashboard (92 HTML)](#14-account-dashboard-92-html)
15. [Docs (491 HTML)](#15-docs-491-html)
16. [Blog + vs/ + verticals](#16-blog--vs--verticals)
17. [Design system + assets](#17-design-system--assets)
18. [Service worker + manifest + SEO](#18-service-worker--manifest--seo)
19. [CLI — `cli/kolm.js` (53,863 lines, 279 verbs)](#19-cli--clikolmjs-53863-lines-279-verbs)
20. [TUI mode + UX primitives](#20-tui-mode--ux-primitives)
21. [Vendor binary wrappers](#21-vendor-binary-wrappers)
22. [Tests — 665 files in `tests/`](#22-tests--665-files-in-tests)
23. [Scripts — 352 files in `scripts/`](#23-scripts--352-files-in-scripts)
24. [Infrastructure — Vercel, Railway, GHA, Docker](#24-infrastructure--vercel-railway-gha-docker)
25. [Receipts, verify, attestation](#25-receipts-verify-attestation)
26. [Distill pipeline — Trinity 2000 v2](#26-distill-pipeline--trinity-2000-v2)
27. [Teacher integrations](#27-teacher-integrations)
28. [Gateway log importers (5)](#28-gateway-log-importers-5)
29. [Orgs + RBAC (W918 Wave 2)](#29-orgs--rbac-w918-wave-2)
30. [Storage drivers + persistence](#30-storage-drivers--persistence)
31. [Plan files at repo root](#31-plan-files-at-repo-root)
32. [Standing operating rules](#32-standing-operating-rules)
33. [Glossary + appendices](#33-glossary--appendices)
34. [Environment variable reference (`.env.example`)](#34-environment-variable-reference-envexample)
35. [`package.json` scripts — complete reference](#35-packagejson-scripts--complete-reference)
36. [`vercel.json` redirects — complete reference (44)](#36-verceljson-redirects--complete-reference-44)
37. [Spec + simulation fixture inventory](#37-spec--simulation-fixture-inventory)
38. [GitHub Actions workflows — complete reference (11)](#38-github-actions-workflows--complete-reference-11)
39. [`src/` files by line count (top 25)](#39-src-files-by-line-count-top-25)
40. [Full alphabetical test inventory (665 files)](#40-full-alphabetical-test-inventory-665-files)
41. [Full alphabetical script inventory (342 files)](#41-full-alphabetical-script-inventory-342-files)
42. [Account dashboard — full alphabetical inventory (92 files)](#42-account-dashboard--full-alphabetical-inventory-92-files)

---

## 1. TL;DR

Kolm is an open-source AI compiler + distillation + verification stack delivered as three production surfaces:

1. **Frontend marketing + product site** at `kolm.ai` (Vercel) — 1,167 HTML files, cool-slate design system (W850), service-worker cache `kolm-v155`.
2. **HTTP backend** — `server.js` (Express, 696 lines) + `src/router.js` (25,730 lines, 709 routes, 707 unique).
3. **Developer surfaces** — `cli/kolm.js` (53,863 lines, 279 unique verbs, TUI mode), Node/Python/C/Rust SDKs, MCP server, VSCode extension, 16 distribution packages.

Every inference returns an Ed25519-signed receipt chained via HMAC-SHA256 (`kolm-receipt-v1`); every distill run produces a passport, model card, GGUF quant ladder, training corpus + bucket weights; every numeric claim on the marketing site is verified by `scripts/x04-claim-verify.cjs` at release time. Release gate is a 7-gate `scripts/release-verify.cjs` driver.

---

## 2. Headline counts (verified 2026-05-28)

| Layer | Count | Source |
|---|---:|---|
| `public/` total files (recursive) | 1,605 | `find public -type f` |
| `public/` HTML files | 1,167 | `find public -name '*.html'` |
| `public/*.html` (marketing top-level) | 170 | `ls public/*.html` |
| `public/account/**/*.html` | 92 | `find public/account -name '*.html'` |
| `public/docs/**/*.html` | 491 | `find public/docs -name '*.html'` |
| `public/blog/**/*.html` | 11 | `find public/blog -name '*.html'` (9 posts + index + 2 templates) |
| `public/vs/*.html` | 10 | `ls public/vs` |
| `public/` CSS files | 23 | `find public -name '*.css'` |
| `public/` JS files | 21 | `find public -name '*.js'` |
| `public/og/*.svg` | 50+ | OG cards (sampled) |
| `src/*.{js,mjs,cjs}` top-level | 420 | `ls src/*.{js,mjs,cjs}` |
| `src/**/*.{js,mjs,cjs}` recursive | 486 | `find src` |
| `src/` subdirectories | 16 | (listed §7) |
| HTTP routes declared in `src/router.js` | 709 | `grep r.(get|post|put|patch|delete|all)` |
| HTTP routes unique | 707 | `grep ... | sort -u` |
| `tests/*.test.js` | 665 | `ls tests/*.test.js` |
| `scripts/` (all files) | 352 | `ls scripts` |
| `cli/kolm.js` lines | 53,863 | `wc -l` |
| `cli/kolm.js` total `case` verbs | 361 | `grep -c case`  |
| `cli/kolm.js` unique top-level verbs | 279 | `grep ... | sort -u`  |
| `src/router.js` lines | 25,730 | `wc -l` |
| `server.js` lines | 696 | `wc -l` |
| `vercel.json` bytes | 74,174 | `Get-Item` |
| Vercel rewrites | 697 | grep `"rewrites"` |
| Vercel redirects | 44 | grep `"redirects"` |
| Vercel header rules | 1 | grep `"headers"` |
| `openapi.json` operations | 733 | OpenAPI op count |
| `openapi.json` paths | 695 | unique path keys |
| `sdk/` languages | 6 | `c`, `mcp`, `node`, `python`, `rust`, `vscode` |
| `workers/` worker types | 14 | (§8) |
| `services/` long-running services | 3 | `embed`, `index`, `mcp` |
| `packages/` distribution targets | 16 | (§11) |
| `.github/workflows/*.yml` | 11 | (§24.3) |
| `sw.js` `CACHE_VERSION` | 155 | slug `wave918-wave2-agents-gateway-orgs` |
| Dockerfiles at repo root | 2 | `Dockerfile`, `Dockerfile.gateway` |
| Spec JSON fixtures at root | 9 | claims-redactor, classifier, court-ext, demo-log-triage, email-prio, phi-redactor, wave58-test, zh-greeter, sim-100 |
| Sim fixtures | 3 | `sim-100.json`, `sim-100-v2.json`, `sim-100-v3.json` |
| Production deps | 15 | `package.json` |
| Dev deps | 4 | `package.json` |

---

## 3. Repo topology

```
kolmogorov-stack/
├── cli/                    # cli/kolm.js (53,863 lines) + bin shims
├── docs/                   # private engineering docs (NEVER staged: research/)
├── public/                 # static site root (Vercel build output dir)
├── scripts/                # 352 build/audit/deploy/QA/trinity scripts
├── sdk/                    # 6 first-class SDKs
├── src/                    # backend modules (420 top-level, 486 recursive)
├── services/               # 3 long-running services (embed, index, mcp)
├── tests/                  # 665 Jest test files
├── workers/                # 14 background workers
├── packages/               # 16 packaged distributions (npm/pypi/cargo/brew/apt/winget/vscode)
├── .github/workflows/      # 11 CI yml files
├── server.js               # Express entry (696 lines)
├── package.json            # kolm-stack@0.2.6
├── vercel.json             # 697 rewrites + 44 redirects + 1 header
├── Dockerfile              # main server image
├── Dockerfile.gateway      # gateway-only image
├── docker-compose.gateway.yml
├── gateway.toml            # gateway config
├── railway.toml            # Railway service config
├── openapi.json            # 733 ops / 695 paths
└── *.spec.json             # 9 distill recipe fixtures + 3 sim fixtures
```

GitHub org topology:
```
kolm-ai/                    GitHub organization (renamed from sneaky-hippo 2026-05-27)
├── kolm                    public mirror, push target for "public main"
├── kolm-private            origin; Vercel auto-deploys from origin/main
├── kolmbench               public benchmark submissions repo
└── (related)               kolm-runtimes, kolm-models on HF (yet-to-publish)
```

Standing push rule: **frontend first** — `git push public main` BEFORE `git push origin main`.

---

## 4. HTTP backend — `server.js` + `src/router.js`

### 4.1 `server.js` (696 lines)

- Express app boots on `PORT` (default `7777`).
- CORS allow-list, JSON body parser (32 MB cap).
- Stripe webhook raw-body fork on `/v1/billing/stripe/webhook`.
- `W918_PRETTY_REWRITES` array — 20 entries — mirrors W918 routes (`/agents`, `/cerebras`, `/openai-migration`, `/gateway-migration`, `/hobbyist`, `/account/org`, `/account/members`, `/docs/rbac`, ...) so Express runtime serves the same pretty URLs Vercel does.
- 404 handler returns JSON envelope `{error, code, hint}` on `/v1/*` paths.
- Reads `KOLM_DATA_DIR` (default `~/.kolm`) as persistence root, `KOLM_STORE_DRIVER` (`file`/`sqlite`/`postgres`/`vercel-kv`/`vercel-postgres`).

### 4.2 `src/router.js` (25,730 lines)

Single-file router by design — one place to audit auth scopes + rate limits + receipt issuance. Mounted as one Express `Router` at `/`. Imports ~280 modules from `src/`.

---

## 5. Complete route inventory (709 routes)

### 5.1 Health, ready, metrics

- `GET /health` — liveness; returns `{ok:true, uptime_s}`
- `GET /metrics` — Prometheus exposition
- `GET /ready` — readiness probe
- `GET /v1/health` — same as `/health` under v1
- `GET /v1/status` — public uptime
- `GET /v1/ready/deep` — deep readiness (DB + teacher + KMS)
- `POST /v1/status/subscribe` — webhook subscribe

### 5.2 Auth + identity (`/v1/auth`, `/v1/account`, `/v1/session`)

- `POST /v1/signup` — public account creation (rate-limited 10/IP/24h)
- `POST /v1/signin`, `POST /v1/signout`
- `POST /v1/auth/signup`
- `GET /v1/auth/github`, `GET /v1/auth/github/callback`
- `POST /v1/session/login`, `POST /v1/session/logout`
- `POST /v1/anon/bootstrap`, `POST /v1/anon/claim`
- `GET /v1/whoami` — when no key, returns `{logged_in:false, doctor:[...]}` with hints
- `GET /v1/account` — full account state
- `GET /v1/account/state`
- `GET /v1/account/settings`, `PUT /v1/account/settings`
- `GET /v1/account/audit-log`, `GET /v1/account/audit-log/verify`
- `GET /v1/account/audit/retention`
- `GET /v1/account/keys`, `POST /v1/account/keys`, `DELETE /v1/account/keys/:prefix`
- `POST /v1/account/rotate-key`
- `POST /v1/account/rotate-receipt-secret`
- `GET /v1/account/receipt-secrets`, `POST /v1/account/receipt-secret/prune`
- `POST /v1/account/cancel`, `POST /v1/account/delete`
- `POST /v1/account/change-plan`
- `GET /v1/account/export`
- `GET /v1/account/compliance-package`
- `GET /v1/account/next-actions`, `POST /v1/account/next-actions/snooze`
- `GET /v1/account/sso/status`, `POST /v1/account/sso/configure`
- `GET /v1/account/saml/metadata`

### 5.3 Capture (`/v1/capture`, `/v1/captures`)

- `POST /v1/capture/log` — primary log endpoint
- `POST /v1/capture/bulk`
- `POST /v1/capture/export`, `GET /v1/capture/export`
- `GET /v1/capture/browse`
- `GET /v1/capture/health`
- `GET /v1/capture/snippet`
- `GET /v1/capture/stream`
- `GET /v1/capture/rbac/policy`, `POST /v1/capture/rbac/evaluate`
- `POST /v1/capture/media`
- `POST /v1/capture/openrouter` + `/chat/completions` + `/v1/chat/completions`
- `POST /v1/capture/gemini` + `/chat/completions` + `/v1/chat/completions`
- `GET /v1/captures/list`
- `GET /v1/captures/forgotten`
- `POST /v1/captures/forget`
- `POST /v1/captures/:id/review`, `POST /v1/captures/review-bulk`
- `GET /v1/captures/:id/inspect`

### 5.4 Distill (`/v1/distill`)

- `GET /v1/distill/runs`, `GET /v1/distill/runs/:id`
- `GET /v1/distill/strategy`, `GET /v1/distill/strategy/catalog`, `POST /v1/distill/strategy`
- `GET /v1/distill/from-captures/preview`, `POST /v1/distill/from-captures`
- `POST /v1/distill/onpolicy`, `GET /v1/distill/onpolicy/doctor`
- `POST /v1/distill/preference`, `GET /v1/distill/preference/doctor`

### 5.5 Compile (`/v1/compile`)

- `GET /v1/compile`, `GET /v1/compile/:id`, `GET /v1/compile/:id/.kolm`
- `POST /v1/compile`, `POST /v1/compile/preview`, `POST /v1/compile/start`
- `GET /v1/compile/estimate`, `POST /v1/compile/estimate`
- `GET /v1/compile/stream/:job`
- `POST /v1/compile/cloud`

### 5.6 Devices (`/v1/devices`, `/v1/device`)

- `GET /v1/devices`, `GET /v1/devices/:id`
- `GET /v1/devices/detect`, `POST /v1/devices/detect`
- `GET /v1/devices/installed`, `GET /v1/devices/list`
- `GET /v1/devices/recommend`, `POST /v1/devices/recommend`
- `POST /v1/devices/add`, `POST /v1/devices/register`, `POST /v1/devices/remove`
- `POST /v1/devices/:id/heartbeat`, `POST /v1/devices/:id/install`
- `DELETE /v1/devices/:id`, `DELETE /v1/devices/:id/install/:artifact_id`
- `POST /v1/devices/:id/probe`, `POST /v1/devices/:id/register`, `POST /v1/devices/:id/test`
- `GET /v1/device/profiles`, `GET /v1/device/profiles/:device_id`
- `POST /v1/device/check`, `POST /v1/device/probe`

### 5.7 Cloud (`/v1/cloud`, `/v1/deploy`)

- `GET /v1/cloud/deploy-targets`
- `GET /v1/cloud/broker/catalog`, `POST /v1/cloud/broker`
- `GET /v1/cloud/distill`, `GET /v1/cloud/distill/:job_id`, `DELETE /v1/cloud/distill/:job_id`
- `GET /v1/cloud/distill/meter/:job_id`
- `POST /v1/cloud/distill/submit`
- `POST /v1/cloud/deploy-plan`
- `GET /v1/cloud/readiness`
- `POST /v1/deploy`, `POST /v1/deploy/canary`
- `POST /v1/deploy/runpod`, `GET /v1/deploy/runpod/:pod_id`, `DELETE /v1/deploy/runpod/:pod_id`
- `GET /v1/deploy/runpod/:pod_id/logs`

### 5.8 Fleet + namespaces + groups

- `GET /v1/fleet/monitor`, `GET /v1/fleet/status`
- `POST /v1/fleet/deploy`, `POST /v1/fleet/rollback`, `POST /v1/fleet/stop`
- `GET /v1/namespaces`, `GET /v1/namespaces/:slug`, `GET /v1/namespaces/:slug/stats`
- `POST /v1/namespaces`, `PUT /v1/namespaces/:slug`
- `POST /v1/namespaces/:slug/deploy`, `POST /v1/namespaces/:slug/undeploy`, `POST /v1/namespaces/:slug/rollback`
- `GET /v1/groups`, `GET /v1/groups/:slug`, `POST /v1/groups`, `PATCH /v1/groups/:slug`, `DELETE /v1/groups/:slug`

### 5.9 Teams (`/v1/team`, `/v1/teams`)

- `GET /v1/team/members`, `GET /v1/team/workspace`
- `GET /v1/team/approvals`, `POST /v1/team/approvals`, `POST /v1/team/approvals/:id/decide`
- `GET /v1/team/invites`, `POST /v1/team/invite`, `POST /v1/team/invites`
- `POST /v1/team/accept-invite`
- `POST /v1/team/namespaces`, `POST /v1/team/sync`
- `DELETE /v1/team/member/:id`
- `PUT /v1/team/role`
- `GET /v1/teams`, `GET /v1/teams/:idOrSlug`, `POST /v1/teams`, `PATCH /v1/teams/:idOrSlug`, `DELETE /v1/teams/:idOrSlug`
- `POST /v1/teams/:idOrSlug/invite`, `POST /v1/teams/:idOrSlug/transfer`
- `PATCH /v1/teams/:idOrSlug/members/:tenant_id`, `DELETE /v1/teams/:idOrSlug/members/:tenant_id`
- `GET /v1/teams/invites/:token`, `POST /v1/teams/invites/:token/accept`
- `DELETE /v1/teams/invites/:invite_id`

### 5.10 Marketplace + recipes + library + hub

- `GET /v1/marketplace`, `GET /v1/marketplace/:slug`, `GET /v1/marketplace/:slug/download`
- `GET /v1/marketplace/list`, `GET /v1/marketplace/search`, `GET /v1/marketplace/catalog.json`
- `POST /v1/marketplace/interest`, `POST /v1/marketplace/listings`, `POST /v1/marketplace/publish`, `POST /v1/marketplace/publish-request`
- `GET /v1/marketplace/reviews/:cid`, `POST /v1/marketplace/reviews`
- `GET /v1/recipes`, `GET /v1/recipes/:id`, `GET /v1/recipes/:id/download`, `GET /v1/recipes/:id/lineage`, `GET /v1/recipes/:id/stats`
- `GET /v1/recipes/templates`, `GET /v1/recipes/templates/:name`
- `POST /v1/recipes/:id/run`, `POST /v1/recipes/:id/label-corpus`, `POST /v1/recipes/:id/label-corpus/stream`
- `GET /v1/library`
- `GET /v1/hub`, `GET /v1/hub/:owner/:name`, `GET /v1/hub/:owner/:name/download`, `POST /v1/hub/publish`

### 5.11 Notifications (`/v1/notifications`)

- `GET /v1/notifications/config`, `GET /v1/notifications/log`
- `GET /v1/notifications/preferences`, `PUT /v1/notifications/preferences`
- `GET /v1/notifications/push-subscriptions`, `POST /v1/notifications/push-subscriptions`, `DELETE /v1/notifications/push-subscriptions`
- `GET /v1/notifications/settings`, `PUT /v1/notifications/settings`
- `GET /v1/notifications/state`
- `POST /v1/notifications/test`, `POST /v1/notifications/test-channel`

### 5.12 Admin (`/v1/admin`)

- `GET /v1/admin/audit`
- `GET /v1/admin/compile-jobs`
- `GET /v1/admin/control-files`, `GET /v1/admin/control-files/:key`
- `GET /v1/admin/diagnostics`
- `GET /v1/admin/health`
- `GET /v1/admin/stats`
- `GET /v1/admin/submissions`
- `GET /v1/admin/tenants`, `POST /v1/admin/tenant`
- `GET /v1/admin/waitlist`

### 5.13 Trace + receipts + verify

- `GET /v1/trace/:trace_id/chain`, `GET /v1/trace/:trace_id/export`, `GET /v1/trace/:trace_id/stats`
- `GET /v1/trace/distill`
- `POST /v1/trace/append`, `POST /v1/trace/compile`
- `GET /v1/trace/translate/detect`, `GET /v1/trace/translate/providers`, `POST /v1/trace/translate`
- `POST /v1/trace/verify`
- `GET /v1/receipts/:hash/public`, `GET /v1/receipts/list`, `GET /v1/receipts/stats`
- `POST /v1/receipts/verify`
- `GET /v1/verify/:cid`, `GET /v1/verify/:receipt_id`, `POST /v1/verify`
- `GET /v1/cid/:cid`
- `GET /v1/diagnose/:cid`, `POST /v1/diagnose`
- `POST /v1/verified-inference`
- `POST /v1/wrap/verified`

### 5.14 Compliance + privacy + governance

- `GET /v1/compliance/ai-act/governance-report`, `POST /v1/compliance/ai-act/export`
- `POST /v1/compliance/ai-act/human-in-loop`, `POST /v1/compliance/ai-act/risk-score`
- `GET /v1/compliance/certification-packet`, `GET /v1/compliance/certification-packet/template`, `POST /v1/compliance/certification-packet/validate`
- `GET /v1/compliance/status`
- `GET /v1/privacy/events`, `GET /v1/privacy/policy`, `PUT /v1/privacy/policy/:class`
- `GET /v1/privacy/redaction-benchmark`, `GET /v1/privacy/report`
- `POST /v1/privacy/scan`, `POST /v1/privacy/test`
- `GET /v1/reg/eu-aiact-docs`

### 5.15 Eval + benchmarks (`/v1/eval`, `/v1/bench`, `/v1/kolmbench`)

- `GET /v1/eval/benchmark-evidence`, `GET /v1/eval/benchmark-evidence/template`, `POST /v1/eval/benchmark-evidence/validate`
- `GET /v1/eval/k-score-calibration`
- `GET /v1/eval/quality-calibration`
- `GET /v1/eval/tenant_holdout`, `GET /v1/eval/tenant_holdout/:corpus_id`, `POST /v1/eval/tenant_holdout`, `DELETE /v1/eval/tenant_holdout/:corpus_id`
- `POST /v1/bench/humaneval`, `POST /v1/bench/mmlu`, `POST /v1/bench/mtbench`
- `GET /v1/kolmbench/leaderboard`, `GET /v1/kolmbench/spec`, `POST /v1/kolmbench/submit`, `POST /v1/kolmbench/validate`
- `GET /v1/bakeoffs`, `POST /v1/bakeoffs`, `POST /v1/bakeoff/run`
- `GET /v1/multimodal/bakeoff`, `POST /v1/multimodal/bakeoff`
- `POST /v1/redteam/bakeoff`, `POST /v1/vlm/tokenize`, `POST /v1/vision/bakeoff`, `POST /v1/video/bakeoff`, `POST /v1/xlang/bakeoff`

### 5.16 Drift (`/v1/drift`, `/v1/drift-alert`)

- `GET /v1/drift/alerts`, `GET /v1/drift/status`
- `POST /v1/drift/auto-remediate`, `POST /v1/drift/configure`, `POST /v1/drift/detect`
- `POST /v1/drift/report`, `POST /v1/drift/scan`, `POST /v1/drift/snapshot`
- `GET /v1/drift-alert/:namespace`
- `POST /v1/drift-alert/snapshot`, `POST /v1/drift-alert/webhooks`

### 5.17 Multimodal (`/v1/multimodal`, `/v1/audio`, `/v1/vision`, `/v1/video`, `/v1/vlm`)

- `GET /v1/multimodal/pipeline`
- `POST /v1/multimodal/tokenize`, `GET /v1/multimodal/tokenize/doctor`
- `POST /v1/multimodal/redact-audio`, `GET /v1/multimodal/redact-audio/doctor`
- `POST /v1/multimodal/redact-image`, `GET /v1/multimodal/redact-image/doctor`
- `GET /v1/audio/captures`, `GET /v1/audio/tokenize/doctor`
- `GET /v1/vision/captures`, `POST /v1/vision/capture-detect`
- `GET /v1/video/captures`, `POST /v1/video/capture-detect`, `POST /v1/video/tokenize`, `GET /v1/video/tokenize/doctor`
- `POST /v1/media/redact`, `POST /v1/media/redact-job`, `GET /v1/media/redact-job/doctor`

### 5.18 Embed + RAG + recall + search

- `POST /v1/embed`
- `POST /v1/recall`, `GET /v1/recall/status`, `GET /v1/recall/sources/:id(*)`
- `POST /v1/memory/recall`
- `POST /v1/search`

### 5.19 Runtime (`/v1/runtime`)

- `GET /v1/runtime/adoption-packets`, `GET /v1/runtime/adoption-packets/template`, `POST /v1/runtime/adoption-packets/validate`
- `GET /v1/runtime/decisions`, `POST /v1/runtime/decide`
- `GET /v1/runtime/placement`
- `GET /v1/runtime/policy`, `PUT /v1/runtime/policy`
- `GET /v1/runtime/replacement-stats`

### 5.20 Models + library + plugins + concepts

- `GET /v1/models`, `GET /v1/models/cache`, `GET /v1/models/info/:id(*)`, `GET /v1/models/manifest`, `GET /v1/models/pull`, `GET /v1/models/recommend`
- `GET /v1/plugins`, `GET /v1/plugins/:name`, `POST /v1/plugins`
- `GET /v1/concepts`, `GET /v1/concepts/:id`, `DELETE /v1/concepts/:id`, `GET /v1/concepts/:id/lineage`, `GET /v1/concepts/:id/stats`
- `GET /v1/public/concepts`, `GET /v1/public/concepts/:id`, `GET /v1/public/featured`
- `POST /v1/public/run`, `POST /v1/public/submit`

### 5.21 Datasets + lake (`/v1/datasets`, `/v1/lake`)

- `GET /v1/datasets`, `GET /v1/datasets/:id`, `POST /v1/datasets`, `POST /v1/datasets/:id/split`
- `GET /v1/lake/export`, `GET /v1/lake/repeated`, `GET /v1/lake/stats`, `GET /v1/lake/storage`, `GET /v1/lake/tail`, `GET /v1/lake/trends`
- `POST /v1/lake/contribute`, `POST /v1/lake/opt-in`, `POST /v1/lake/opt-out`

### 5.22 Approvals + active-learning + label-queue + labels

- `GET /v1/approvals`, `GET /v1/approvals/:id`, `POST /v1/approvals/request`
- `POST /v1/approvals/:id/approve`, `POST /v1/approvals/:id/reject`, `POST /v1/approvals/:id/notify`
- `GET /v1/active-learning/summary`
- `GET /v1/label-queue/audit/:event_id`, `GET /v1/label-queue/next`, `GET /v1/label-queue/stats`, `POST /v1/label-queue/submit`
- `GET /v1/labels/:event_id`, `GET /v1/labels/next`, `GET /v1/labels/stats`, `GET /v1/labels/synthesize-corpus`, `POST /v1/labels`

### 5.23 Federated (`/v1/federated`, `/v1/fl`)

- `GET /v1/federated/audit`, `GET /v1/federated/consortium`, `GET /v1/federated/peers`
- `POST /v1/federated/aggregate`, `POST /v1/federated/opt-in`, `POST /v1/federated/opt-out`, `POST /v1/federated/share-approvals`
- `GET /v1/fl/strategies`, `POST /v1/fl/aggregate`, `POST /v1/fl/contribution/verify`, `POST /v1/fl/round/new`

### 5.24 Bridges + opportunities + autopilot + recommendations

- `GET /v1/bridges/observations`, `POST /v1/bridges/observations/:id`
- `GET /v1/bridges/specialist-candidates`, `GET /v1/bridges/suggestions`
- `POST /v1/bridges/auto-synthesize`, `POST /v1/bridges/observe`
- `GET /v1/opportunities`
- `POST /v1/opportunities/:id/accept`, `POST /v1/opportunities/:id/dismiss`, `POST /v1/opportunities/:id/ignore`, `POST /v1/opportunities/:id/promote`
- `GET /v1/autopilot/savings`, `GET /v1/autopilot/status`, `GET /v1/autopilot/tick`
- `POST /v1/autopilot/disable`, `POST /v1/autopilot/enable`

### 5.25 Specialists + AB tests + experts

- `GET /v1/specialists`, `GET /v1/specialists/:id`, `GET /v1/specialists/:id/weights`
- `POST /v1/specialists/:id/run`, `POST /v1/specialists/auto-distill`, `POST /v1/specialists/train`, `POST /v1/specialists/waitlist`
- `GET /v1/ab-tests`, `GET /v1/ab-tests/:id`, `GET /v1/ab-tests/:id/assignments`
- `POST /v1/ab-tests/create`, `POST /v1/ab-tests/:id/promote`, `POST /v1/ab-tests/:id/rollback`, `POST /v1/ab-tests/:id/stop`
- `POST /v1/experts`

### 5.26 BYOC + airgap + sneakernet

- `GET /v1/byoc/deployments`, `GET /v1/byoc/deployments/:id`, `DELETE /v1/byoc/deployments/:id`
- `GET /v1/byoc/status`, `GET /v1/byoc/targets`
- `POST /v1/byoc/attestation`, `POST /v1/byoc/deploy`
- `GET /v1/airgap/jobs`, `GET /v1/airgap/status`, `POST /v1/airgap/test`
- `POST /v1/bundle/airgap`
- `POST /v1/sneakernet/pack`, `POST /v1/sneakernet/unpack`

### 5.27 Billing + Stripe

- `GET /v1/billing/breakdown`, `GET /v1/billing/meters`, `GET /v1/billing/tiers`, `GET /v1/billing/usage`
- `POST /v1/stripe/webhook` (raw body)
- `GET /v1/plans`, `GET /v1/pricing`
- `GET /v1/chargeback`, `POST /v1/chargeback/export`
- `GET /v1/carbon/estimate`
- `GET /v1/savings`, `GET /v1/savings/displacement`

### 5.28 Gateway (`/v1/gateway`)

- `GET /v1/gateway/dashboard`, `GET /v1/gateway/health`, `GET /v1/gateway/mode`, `GET /v1/gateway/providers`
- `POST /v1/gateway/dispatch`, `POST /v1/gateway/providers/config`, `POST /v1/gateway/test-connection`

### 5.29 SSO + SAML + SCIM

- `GET /v1/scim/v2/ServiceProviderConfig`, `GET /v1/scim/v2/Users`, `POST /v1/scim/v2/Users`
- `GET /v1/sso/status`

### 5.30 Tunnels + sync + storage + keys

- `GET /v1/tunnels`, `DELETE /v1/tunnels/:token`
- `GET /v1/tunnel/agent/:token`, `POST /v1/tunnel/agent/:token/response`
- `POST /v1/tunnel/register`
- `GET /v1/sync/audit`, `GET /v1/sync/status`, `PUT /v1/sync/state`
- `POST /v1/sync/inbox`, `POST /v1/sync/pull`, `POST /v1/sync/push`
- `GET /v1/storage/config`, `PUT /v1/storage/config`
- `GET /v1/storage/object-readiness`, `POST /v1/storage/purge`
- `GET /v1/keys/public`, `GET /v1/keys/public/:fingerprint`, `DELETE /v1/keys/public/:fingerprint`
- `POST /v1/keys/challenge`, `POST /v1/keys/register`

### 5.31 Integrations

- `GET /v1/integrations/runpod`, `POST /v1/integrations/runpod`, `DELETE /v1/integrations/runpod`
- `POST /v1/integrations/runpod/test`
- `GET /v1/connectors`, `POST /v1/connectors/notify`

### 5.32 Product graph + frontier

- `GET /v1/product/experience`
- `GET /v1/product/frontier-contracts`
- `GET /v1/product/frontier-lab`
- `GET /v1/product/graph`
- `GET /v1/product/operator-kernels`

### 5.33 Migrate + import + wrap + free

- `GET /v1/free/cli/allowlist`, `POST /v1/free/cli`, `POST /v1/free/chat`
- `POST /v1/import/inspect`, `POST /v1/import/wrap`
- `POST /v1/migrate/discover`, `POST /v1/migrate/wrap`
- `POST /v1/inspect`
- `POST /v1/playground/proxy/:slug`

### 5.34 W918 — gateway log importer routes

- `POST /v1/import/openai-finetune` (jsonl `{messages:[{role,content}]}`)
- `POST /v1/import/portkey`
- `POST /v1/import/helicone`
- `POST /v1/import/litellm`
- `POST /v1/import/openrouter`

### 5.35 Misc domain routes

- `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/anthropic/v1/messages`
- `POST /v1/openrouter/chat/completions`, `POST /v1/openrouter/v1/chat/completions`
- `POST /v1/gemini/chat/completions`, `POST /v1/gemini/v1/chat/completions`
- `POST /v1/route/chat/completions`, `POST /v1/route/chat/completions/stream`
- `POST /v1/quantize`
- `GET /v1/quantization/oracle`, `GET /v1/quantization/oracle/catalog`, `POST /v1/quantization/oracle`
- `POST /v1/serve`
- `POST /v1/run`, `POST /v1/loop/try`, `POST /v1/replay`
- `POST /v1/intent/ask`, `GET /v1/intent/next`
- `POST /v1/sales/demo-request`
- `POST /v1/sigstore/attest`, `GET /v1/sigstore/entry/:logIndex`, `GET /v1/sigstore/health`
- `POST /v1/cc/verify`, `GET /v1/cc/kinds`, `GET /v1/cc/shape/:kind`
- `POST /v1/credential/verify`
- `POST /v1/mit/run`, `POST /v1/mit/scan-pii`
- `POST /v1/sbom/emit`, `POST /v1/sbom/verify`, `GET /v1/sbom/repo`
- `POST /v1/pextract/detect-attempt`, `POST /v1/pextract/guard-request`, `POST /v1/pextract/redact-prompt`
- `POST /v1/copyright/scan`, `GET /v1/copyright/queue/:namespace`
- `POST /v1/poisoning/bind-teacher`, `POST /v1/poisoning/quarantine`, `POST /v1/poisoning/verify-binding`, `GET /v1/poisoning/namespace-risk/:namespace`
- `POST /v1/redteam/classify`, `POST /v1/redteam/generate-corpus`, `POST /v1/redteam/sanitize`
- `POST /v1/pipeline/compile`, `POST /v1/pipeline/distill`, `POST /v1/pipeline/full`, `POST /v1/pipeline/run`, `POST /v1/pipeline/tokenize`
- `GET /v1/pipeline/jobs/:id`, `GET /v1/pipeline/jobs/:id/stream`
- `POST /v1/synthesize`, `POST /v1/synthesize/batch`, `POST /v1/synthesize/stream`, `POST /v1/synthetic/commit`, `POST /v1/synthetic/generate`
- `GET /v1/synthetic/coverage/:namespace`, `GET /v1/synthetic/gaps/:namespace`
- `POST /v1/spec-decode`, `GET /v1/spec-decode/doctor`
- `POST /v1/speculative/bench`, `GET /v1/speculative/bench/:id`, `GET /v1/speculative/acceptance`
- `GET /v1/long-context/p90`, `POST /v1/long-context/check`
- `POST /v1/stat-sig/test`, `GET /v1/stat-sig/gate`
- `POST /v1/staleness/apply-ttl`, `GET /v1/staleness/:namespace`
- `GET /v1/seasonal/:namespace`, `POST /v1/seasonal/variant`
- `GET /v1/lingual/manifest`, `POST /v1/lang/augment-multilingual`, `POST /v1/lang/detect`, `GET /v1/lang/kscore-by-lang/:namespace`
- `POST /v1/xlang/balanced-sample`, `POST /v1/xlang/per-language-eval`, `GET /v1/xlang/language-coverage`
- `POST /v1/numeric/calculator`, `POST /v1/numeric/eval`, `GET /v1/numeric/namespace-flag/:namespace`
- `POST /v1/teacher/chat`, `GET /v1/teacher/chat/health`
- `GET /v1/teacher-versions/:namespace`
- `POST /v1/seeds/from-nl`, `GET /v1/seeds/from-nl/health`
- `POST /v1/training/plan`, `GET /v1/training/token-dpo`
- `POST /v1/yaml/validate`, `POST /v1/ir/compile`, `POST /v1/ir/replay`, `POST /v1/ir/stats`, `POST /v1/ir/validate`
- `POST /v1/sim/run`, `GET /v1/sim`, `GET /v1/sim/:id`
- `GET /v1/simulations`, `POST /v1/simulations`, `GET /v1/simulations/:id`, `POST /v1/simulations/:id/promote`
- `GET /v1/assurance/artifact/:id`, `GET /v1/assurance/workspace/:id`
- `GET /v1/agents`, `GET /v1/agents/failing`, `GET /v1/agents/recommend`, `GET /v1/agents/sessions`, `GET /v1/agents/sessions/:id`, `GET /v1/agents/stats`
- `GET /v1/builds`
- `GET /v1/builder/templates`, `POST /v1/builder/compile`, `POST /v1/builder/preview`
- `POST /v1/build/preview`, `GET /v1/build/strategy`, `GET /v1/build/strategy/catalog`, `POST /v1/build/strategy`
- `POST /v1/compose`
- `POST /v1/capability/build`, `POST /v1/capability/validate`
- `POST /v1/draft/save`
- `POST /v1/lineage/build`, `POST /v1/lineage/validate`
- `POST /v1/lead/enterprise`, `GET /v1/lead/enterprise/:id`
- `POST /v1/messages`
- `POST /v1/merge`, `POST /v1/nl/scaffold`, `POST /v1/fit`
- `POST /v1/region/route`, `GET /v1/region/gateways`, `GET /v1/region/status`
- `POST /v1/residency/configure-namespace`, `POST /v1/residency/tag-capture`, `GET /v1/residency/regions`, `GET /v1/residency/capture-region/:capture_id`
- `POST /v1/streaming/normalize`, `GET /v1/streaming/capabilities`
- `GET /v1/sla/dashboard`, `GET /v1/sla/rollup`, `GET /v1/sla/series`
- `POST /v1/test-device`, `POST /v1/test-quants`
- `POST /v1/metrics/event`, `GET /v1/metrics/snapshot`
- `GET /v1/jobs/:id`
- `GET /v1/passport/:job_id`
- `POST /v1/artifact/diff`, `POST /v1/artifact/lineage`, `POST /v1/artifact/verify-manifest`
- `POST /v1/artifacts/dependency-graph`, `POST /v1/artifacts/:id/lifecycle/transition`
- `GET /v1/artifacts`, `GET /v1/artifacts/:id`, `GET /v1/artifacts/:id/download`, `GET /v1/artifacts/:id/evidence-trace`, `GET /v1/artifacts/:id/lifecycle`
- `GET /v1/audit/export`, `GET /v1/audit/export/formats`, `GET /v1/audit/export/preview`, `GET /v1/audit/log`, `GET /v1/audit/verify`
- `GET /v1/diagnose/:cid`
- `GET /v1/evidence`, `GET /v1/evidence/`, `GET /v1/evidence/:id`, `GET /v1/evidence/readiness`, `POST /v1/evidence/:id/revoke`
- `GET /v1/failure-modes/:cid`, `POST /v1/failure-modes`, `POST /v1/failure-modes/feed-active-learning`
- `GET /v1/forge/...` (various)
- `GET /v1/hardware`
- `GET /v1/healthcare/...` (various)
- `GET /v1/lake/...` (above)
- `GET /v1/migrate/...` (above)
- `GET /v1/model-card/governance-mappings`, `GET /v1/model-card/schema`, `POST /v1/model-card/generate`
- `GET /v1/packages/release-readiness`, `GET /v1/packages/release-readiness/template`, `POST /v1/packages/release-readiness/validate`
- `GET /v1/plans`
- `GET /v1/procurement`, `GET /v1/procurement/:framework`
- `GET /v1/registry/export`, `GET /v1/registry/public`, `GET /v1/registry/search`, `GET /v1/registry/verified-publishers/policy`
- `POST /v1/registry/submit`, `POST /v1/registry/verified-publishers/evaluate`
- `GET /v1/replay/preview`
- `POST /v1/route/chat/completions`, `POST /v1/route/chat/completions/stream`
- `GET /v1/routing/summary`
- `POST /v1/serve`
- `GET /v1/security/audit-retention/status`, `GET /v1/security/continuous-monitoring/snapshot`, `GET /v1/security/iso27001/controls`, `GET /v1/security/soc2/checklist`
- `GET /v1/spec`, `GET /v1/spec/governance-packet`, `GET /v1/spec/governance-packet/template`, `POST /v1/spec/governance-packet/validate`
- `GET /v1/target-profiles`, `GET /v1/target-profiles/:name`
- `GET /v1/telemetry`
- `GET /v1/verticals`, `GET /v1/verticals/:id`, `GET /v1/verticals/:id/fingerprint`, `POST /v1/verticals/register-stubs`

### 5.36 Public anonymous redirect handler

- `ALL /r/:token`, `ALL /r/:token/*` — short-link expander
- `GET *` — catch-all (404 JSON envelope for `/v1/*`, otherwise static fallback)

---

## 6. `src/` modules — 280+ top-level files

(Every `src/*.{js,mjs,cjs}` listed with its purpose. 420 top-level files; grouped by domain.)

### 6.1 Auth, tenancy, sessions, keys

- `src/auth.js` — primary auth middleware (api-key + session)
- `src/oauth.js` — GitHub OAuth flow
- `src/sessions.js` — session token issuance
- `src/keys.js` — Ed25519 keypair management
- `src/secrets-vault.js` — encrypted KV for secret storage
- `src/email.js` — Resend wrapper for transactional email
- `src/auditor-attestation.js` — third-party auditor attestation envelope
- `src/team-capture-rbac.js` — RBAC for capture access
- `src/rbac.js` — 4 roles + 12-row capability matrix
- `src/orgs.js` — createOrg/addMember/removeMember/setRole/transferOwnership
- `src/team.js`, `src/teams.js` — team CRUD
- `src/team-events.js` — team audit events
- `src/groups.js` — group CRUD

### 6.2 Receipts, CID, ed25519, sigstore

- `src/cid.js` — multihash CID helpers
- `src/ed25519.js` — sign/verify wrapper
- `src/receipt-schema.js` — receipt JSON schema validator
- `src/sigstore.js` — sigstore/rekor witness emission
- `src/pubkey-directory.js` — public key registry
- `src/verifier.js` — receipt + chain verifier
- `src/verified.js` — verified inference envelope
- `src/teacher-response-hmac.js` — HMAC of teacher responses

### 6.3 Distill backend

- `src/distill-pipeline.js` — orchestrator
- `src/distill-bridge.js` — bridge to worker
- `src/distill-strategy.js` — recipe planner
- `src/distill-onpolicy.js` — on-policy data collection
- `src/distill-preference.js` — DPO/preference distill
- `src/distill-provenance.js` — provenance attestation
- `src/distill-approval-queue.js` — review queue
- `src/distill-efficiency.js` — flop accounting
- `src/distill-report-blocks.js` — passport rendering blocks
- `src/distill/agent-trajectory.js` (subdir) — parseTrajectory + canonicalizeArgs + normalizeToolName
- `src/airgap-distill.js` — offline distill
- `src/cloud-distill.js` — cloud-burst distill

### 6.4 Compile + IR + spec

- `src/compile.js`, `src/compile-ir.js`, `src/compile-pipeline.js`, `src/compile-stream.js`, `src/compile-targets.js`
- `src/spec-compile.js` — `.kolm` spec compiler
- `src/spec-decode.js` — speculative decoding spec
- `src/native-compile.js` — native bin compile
- `src/dsl.js` — kolm DSL parser

### 6.5 Teacher integrations + council

- `src/teacher-bridge.mjs` — main teacher router
- `src/teacher-council.js` — multi-teacher voting
- `src/teacher-version.js` — teacher version pinning
- `src/teacher-weights.js` — per-teacher weight calc
- `src/teacher-splice.js` — splice teacher responses
- `src/speculative-teacher.js` — speculative-decode teacher
- `src/teachers/cerebras.js` (subdir) — Cerebras adapter (W918)

### 6.6 Provider backends (`src/providers/`)

- `src/providers/_shared.js` — shared helpers
- `src/providers/deepseek-native.js`
- `src/providers/fireworks.js`
- `src/providers/google-native.js`
- `src/providers/groq.js`
- `src/providers/local-kolm.js`
- `src/providers/local-ollama.js`
- `src/providers/local-vllm.js`
- `src/providers/together-hosted.js`
- `src/provider-registry.js` — top-level registry

### 6.7 Compute backends (`src/compute/`)

- `src/compute/index.js`, `src/compute/estimator.js`, `src/compute/rent.js`
- `src/compute/backends/anthropic.js`
- `src/compute/backends/cerebras.js`
- `src/compute/backends/fal.js`
- `src/compute/backends/lambda.js`
- `src/compute/backends/local-cpu.js`
- `src/compute/backends/local-cuda.js`
- `src/compute/backends/local-directml.js`
- `src/compute/backends/local-mlx.js`
- `src/compute/backends/local-mps.js`
- `src/compute/backends/local-openvino.js`
- `src/compute/backends/local-qnn.js`
- `src/compute/backends/local-rocm.js`
- `src/compute/backends/modal.js`
- `src/compute/backends/openai-compatible.js`
- `src/compute/backends/remote-ssh.js`
- `src/compute/backends/replicate.js`
- `src/compute/backends/runpod.js`
- `src/compute/backends/sglang.js`
- `src/compute/backends/tgi.js`
- `src/compute/backends/together.js`
- `src/compute/backends/trt-llm.js`
- `src/compute/backends/vast.js`
- `src/compute/backends/vllm.js`

### 6.8 Cloud providers + adapters (`src/cloud-providers/`, `src/device-adapters/`)

- `src/cloud-providers/cerebras.js`, `src/cloud-providers/modal.js`, `src/cloud-providers/runpod.js`
- `src/cloud/runpod.js`
- `src/cloud-compute-broker.js` — broker between providers
- `src/cloud-sync.js` — cross-region sync
- `src/cloudflare.js` — CDN/edge
- `src/device-adapters/cerebras-adapter.js`
- `src/device-adapters/index.js`
- `src/device-adapters/k8s-adapter.js`
- `src/device-adapters/local-adapter.js`
- `src/device-adapters/modal-adapter.js`
- `src/device-adapters/ollama-adapter.js`
- `src/device-adapters/runpod-adapter.js`
- `src/device-adapters/ssh-adapter.js`

### 6.9 Runners (`src/runners/`)

- `src/runners/gguf-runner.js` — GGUF (llama.cpp) runner
- `src/runners/native-runner.js` — native binary
- `src/runners/onnx-runner.js` — ONNX runtime
- `src/runners/wasm-runner.js` — WASM runtime

### 6.10 Gateway importers (`src/importers/`) — W918

- `src/importers/openai-finetune.js`
- `src/importers/portkey.js`
- `src/importers/helicone.js`
- `src/importers/litellm.js`
- `src/importers/openrouter.js`

### 6.11 Storage drivers (`src/store-drivers/`, `src/storage/`)

- `src/store.js` — driver dispatcher
- `src/store-drivers/vercel-kv.js`
- `src/store-drivers/vercel-postgres.js`
- `src/storage/postgres-store.js`
- `src/migrations/2026-05-19-capture-to-events.js`

### 6.12 Devices, fleet, OTA

- `src/devices.js`
- `src/device-capabilities.js`, `src/device-caps.js`
- `src/device-registry.js`
- `src/device-install.js`, `src/device-ssh.js`
- `src/dev-agent-install.js`
- `src/fleet.js`, `src/fleet-monitor.js`
- `src/ota.js` — over-the-air update

### 6.13 Capture pipeline

- `src/capture.js`, `src/captures.js`
- `src/capture-analytics.js`, `src/capture-anomaly.js`
- `src/capture-copyright-filter.js`
- `src/capture-forget.js`
- `src/capture-importance.js`
- `src/capture-staleness.js`
- `src/capture-stats.js`, `src/capture-store.js`, `src/capture-stream.js`
- `src/audio-capture.js`, `src/video-capture.js`, `src/vision-capture.js`
- `src/audio-tokenize.js`, `src/video-tokenize.js`, `src/vision-tokenize.js`, `src/audio-bakeoff.js`, `src/video-bakeoff.js`, `src/vlm-bakeoff.js`, `src/vlm-distill.js`
- `src/multimodal-bakeoff.js`, `src/multimodal-pipeline-routes.js`
- `src/media-store.js`, `src/frame-sampler.js`
- `src/seasonal-capture.js`
- `src/rag-capture.js`
- `src/tool-use-capture.js`

### 6.14 PHI/PII + redactor + privacy

- `src/phi-redactor.js`, `src/pii-redactor.js`
- `src/prompt-redactor.js`
- `src/pii-bakeoff-scan.js`
- `src/redaction-benchmark.js`
- `src/privacy-membrane.js`
- `src/copyright-detector.js`
- `src/dp-aggregation.js` (differential privacy)
- `src/data-residency.js`
- `src/extraction-guard.js`
- `src/sandbox.js`

### 6.15 Eval + benchmarks + bakeoff

- `src/bench-eval-suites.js`, `src/bench-harness.js`, `src/bench-report-md.js`
- `src/benchmark.js`, `src/benchmarks.js`
- `src/benchmark-compare.js`, `src/benchmark-evidence.js`
- `src/eval-humaneval.js`, `src/eval-mmlu.js`, `src/eval-mtbench.js`, `src/eval-numeric.js`
- `src/kolmbench.js`
- `src/kscore.js`, `src/kscore-bench.js`, `src/kscore-calibration.js`, `src/kscore-per-language.js`
- `src/bakeoff.js`
- `src/case-scorer.js`
- `src/bradley-terry.js` — Bradley-Terry pairwise comparison

### 6.16 Drift + supersession + monitoring

- `src/drift-alert.js`, `src/drift-alert-store.js`, `src/drift-alert-w813.js`
- `src/drift-config.js`, `src/drift-detect.js`, `src/drift-detector.js`
- `src/drift-supersession.js`
- `src/continuous-monitoring.js`
- `src/sla-rollup.js`

### 6.17 Routing + AB + active-learning

- `src/ab-metrics.js`, `src/ab-promote.js`, `src/ab-router.js`, `src/ab-routes.js`
- `src/confidence-router.js`, `src/runtime-confidence-router.js`
- `src/gateway-router.js`, `src/gateway-mode.js`, `src/gateway-receipt.js`
- `src/routing-events.js`, `src/routing-threshold.js`
- `src/active-learning.js`, `src/active-learning-queue.js`
- `src/label-queue.js`
- `src/long-context-warn.js`
- `src/kernel-selector.js`

### 6.18 Compliance + governance

- `src/ai-act-export.js`, `src/ai-act-risk.js`
- `src/assurance-case.js`, `src/assurance-case-pdf.js`
- `src/audit-export.js`, `src/audit-retention.js`, `src/audit.js`
- `src/compliance-certification-packet.js`
- `src/evidence-dag.js`, `src/evidence-readiness.js`, `src/evidence-store.js`
- `src/reg-data-governance.js`, `src/reg-eu-aiact-docs.js`, `src/reg-grc-connectors.js`, `src/reg-hil.js`, `src/reg-model-card-extended.js`, `src/reg-risk-classify.js`, `src/reg-routes.js`
- `src/format-governance-packet.js`
- `src/licensing-allowlist.js`
- `src/membership-inference-test.js`

### 6.19 Artifacts + lifecycle + lineage

- `src/artifact.js`, `src/artifact-runner.js`
- `src/artifact-dependency-graph.js`, `src/artifact-diff.js`
- `src/artifact-lifecycle.js`, `src/artifact-lineage.js`
- `src/bundle-runner.js`
- `src/binder.js`

### 6.20 Deploy + cloud

- `src/deploy-canary.js`, `src/deploy-config.js`, `src/deploy-generators.js`, `src/deploy-pipeline.js`, `src/deploy-rolling.js`
- `src/deployment-plans.js`
- `src/cloud-sync.js`

### 6.21 Tokenizer + pretokenize

- `src/tokenizer.js`, `src/tokenizer-train.js`
- `src/pretokenize-provenance.js`
- `src/lingual-detect.js`, `src/lingual-manifest.js`, `src/lingual-mixture.js`, `src/lingual-routes.js`, `src/lingual-synthesize.js`
- `src/lang-balanced-sampler.js`, `src/lang-detect.js`

### 6.22 Marketplace + recipes + library + hub

- `src/marketplace.js`, `src/marketplace-finetune.js`, `src/marketplace-payouts.js`, `src/marketplace-ratings.js`, `src/marketplace-routes.js`, `src/marketplace-store.js`, `src/marketplace-w825.js`
- `src/recipe-class.js`, `src/recipe-templates.js`
- `src/registry.js`
- `src/library.js`

### 6.23 Cost, savings, billing, autopilot

- `src/billing-breakdown.js`, `src/billing-upgrade.js`
- `src/cost-displacement.js`, `src/cost-estimator.js`
- `src/savings-routes.js`, `src/savings-tracker.js`
- `src/chargeback.js`
- `src/autopilot-daemon.js`, `src/autopilot-savings.js`
- `src/stripe.js`
- `src/carbon-estimator.js`
- `src/site-license.js`

### 6.24 Federated learning

- `src/federated-approvals.js`, `src/federated-consortium-routes.js`, `src/federated-learning.js`, `src/federated-mia.js`

### 6.25 MoE + speculative + acceleration

- `src/moe.js`, `src/moe-provenance.js`, `src/moe-registry.js`, `src/moe-support.js`
- `src/spec-decode.js`, `src/speculative-decoding.js`, `src/speculative-teacher.js`
- `src/accelerate.js`
- `src/itkv-profile.js`, `src/kv-cache-policy.js`, `src/kv-cache-shard.js`
- `src/memory-tier.js`
- `src/preload-scheduler.js`

### 6.26 Adversarial + redteam + poisoning + bakeoff

- `src/adversarial-bakeoff.js`, `src/adversarial-prompts.js`
- `src/poisoning-orchestrator.js`
- `src/negative-variant-gen.js`
- `src/airgap-bakeoff.js`, `src/airgap-bundle.js`, `src/airgap-mode.js`, `src/airgap-routes.js`, `src/airgap-sneakernet.js`, `src/airgap-teacher.js`
- `src/sneakernet.js`

### 6.27 Pipeline + workflow

- `src/pipeline-make.js`, `src/pipeline-orchestrator.js`, `src/pipeline-routes.js`, `src/pipeline-runner.js`, `src/pipeline-ship.js`, `src/pipeline-train.js`, `src/pipeline-yaml.js`
- `src/workflow-ir.js`
- `src/kolm-yaml.js`

### 6.28 Models + registry + manifest

- `src/models.js`, `src/model-registry.js`, `src/model-weights-manifest.js`, `src/model-weights-puller.js`
- `src/model-card-emit.js`, `src/model-card-schema.js`
- `src/hf-modelcard.js`
- `src/training-planner.js`
- `src/quality-calibration.js`
- `src/quantization-oracle.js`, `src/quantize-bakeoff.js`
- `src/export-awq.js`, `src/export-exl2.js`, `src/export-fp8.js`, `src/export-format-registry.js`, `src/export-gguf.js`, `src/export-gptq.js`, `src/export-hqq.js`, `src/export-mlx.js`, `src/export-nvfp4.js`, `src/export-ollama.js`, `src/export-provenance.js`

### 6.29 Runtime + serve + ITKv + accelerate

- `src/runtime.js`, `src/runtime-passport.js`, `src/runtime-perf-estimate.js`, `src/runtime-placement.js`, `src/runtime-policy.js`, `src/runtime-preload.js`, `src/runtime-sanitizer.js`
- `src/runtime-adoption-packets.js`
- `src/serve-autodetect.js`, `src/serve-metrics-sidecar.js`
- `src/k8s-readiness.js`, `src/k8s-routes.js`
- `src/multi-region.js`

### 6.30 Forge + experts + hardware

- `src/forge-experts.js`, `src/forge-fit.js`, `src/forge-hardware.js`, `src/forge-inspect.js`
- `src/hardware.js` (via models)
- `src/platform-capabilities.js`
- `src/student-arch-recommender.js`

### 6.31 Active monitoring + failure modes + opportunity + bridges

- `src/failure-modes.js`, `src/failure-modes-w745.js`
- `src/failure-to-capture-loop.js`
- `src/opportunity-engine.js`
- `src/next-actions.js`
- `src/bridges.js` — closes /v1/workflows/repeated note leak; reads observations from store

### 6.32 RAG + tools + synthesis + seeds

- `src/rag.js`
- `src/synthesis.js`, `src/synthetic-augment.js`, `src/synthetic-data.js`
- `src/seeds.js`, `src/seeds-active.js`, `src/seeds-augment.js`, `src/seeds-mining.js`, `src/seeds-sanitize.js`, `src/seeds-score.js`
- `src/tool-runtime.js`, `src/tool-training-format.js`
- `src/calculator-tool.js`
- `src/intent.js`

### 6.33 Composer + assistant + chat templates

- `src/composer.js`
- `src/chat-templates.js`
- `src/completions-api.js`
- `src/tui-chat.js`
- `src/assistant.js`, `src/assistant-client.js`
- `src/llm-call.js`

### 6.34 Logging + telemetry + OTEL

- `src/log.js`
- `src/sentry-init.js`
- `src/otel.js`, `src/otel-attrs.js`
- `src/prometheus-exporter.js`
- `src/metrics.js`
- `src/usage.js`, `src/usage-analytics.js`

### 6.35 Notifications + webhooks + webpush

- `src/notifications.js`, `src/webpush.js`, `src/hooks.js`

### 6.36 Vault + sandbox + sigstore

- `src/secrets-vault.js`
- `src/sandbox.js`
- `src/sigstore.js`

### 6.37 Replay + bakeoff + verify-prod helpers

- `src/replay.js`
- `src/recall.js`

### 6.38 Plugins + integrations + extensions

- `src/plugins.js`
- `src/cloudflare.js`
- `src/proxy.js`

### 6.39 Misc + utility

- `src/env.js`, `src/config.js`
- `src/envelope.js` — canonical response envelope
- `src/event-schema.js`, `src/event-store.js`
- `src/cid.js`, `src/r2.js` (object storage)
- `src/object-storage.js`
- `src/cache.js`
- `src/jobs.js`
- `src/load-queue.js`
- `src/diagnostic.js`
- `src/comparators.js`
- `src/curriculum-sort.js`
- `src/embedding.js`
- `src/repo-codegraph.js`
- `src/kolm-state.js`, `src/kolm-error.js`, `src/kolm-diff.js`, `src/kolm-meta-trainer.js`
- `src/kolmbench.js`
- `src/changelog.js`
- `src/build-strategy-brain.js`
- `src/build-preview.js`
- `src/byoc.js`
- `src/cross-lingual-eval.js`
- `src/cloud-compute-broker.js`
- `src/confidential-compute.js`
- `src/constrained-decode.js`
- `src/daemon-connector.js`
- `src/daq-profile.js`
- `src/data-ingest.js`
- `src/dataset-workbench.js`
- `src/doc-check.js`
- `src/improvement-orchestrator.js`
- `src/init-agent.js`
- `src/kolmbench.js`
- `src/long-context-warn.js`
- `src/mesh.js`
- `src/meta-routes.js`
- `src/migrate.js`
- `src/multilingual-augment.js`
- `src/namespace-fingerprint.js`
- `src/optimization.js`
- `src/output-retry.js`, `src/output-schema.js`
- `src/package-release-readiness.js`
- `src/pattern-lake.js`
- `src/plugins.js`
- `src/preload-scheduler.js`
- `src/product-experience.js`, `src/product-frontier-contracts.js`, `src/product-frontier-lab.js`, `src/product-frontier-operator-kernels.js`, `src/product-kernel.js`
- `src/production-ready.js`
- `src/progressive-distill.js`
- `src/project.js`
- `src/provenance.js`
- `src/publisher-verification.js`
- `src/recipe-class.js`
- `src/region-aware-sampler.js`
- `src/remote-compute.js`
- `src/sbom-emit.js`
- `src/self-improvement.js`
- `src/services.js`
- `src/shell-init.js`
- `src/significance.js`
- `src/simulation.js`
- `src/stat-sig.js`
- `src/store.js`
- `src/streaming-contract.js`
- `src/sync-git.js`
- `src/target-profiles.js`
- `src/tenant-holdout.js`
- `src/test-device.js`, `src/test-quants.js`
- `src/trace-capture.js`, `src/trace-compile.js`, `src/trace-translator.js`
- `src/trend-extract.js`
- `src/tsac-compiler.js`, `src/tsac-profile.js`
- `src/tune.js`
- `src/tunnel.js`
- `src/verticals.js`
- `src/wrapper-cli.js`
- `src/xlang-bakeoff.js`
- `src/zip-large.js`
- `src/agent-blueprint.js`, `src/agent-telemetry.js`
- `src/data/names-list.js` — names list fixture

### 6.40 Services subdir (`src/services/`)

- `src/services/compiler.js` — compile service
- `src/services/proxy.js` — proxy service
- `src/services/redactor.js` — redactor service

### 6.41 Teachers subdir (`src/teachers/`)

- `src/teachers/cerebras.js` — Cerebras Cloud teacher (Llama-3.3-70b, llama3.1-8b, qwen-3-32b)

---

## 7. `src/` subdirectories

16 subdirectories under `src/`:

| Subdir | Files | Purpose |
|---|---:|---|
| `src/cloud` | 1 | RunPod cloud client |
| `src/cloud-providers` | 3 | Cerebras / Modal / RunPod provider adapters |
| `src/compute` | 28 | Compute backend registry + 24 backends (anthropic, cerebras, fal, lambda, local-cpu/cuda/directml/mlx/mps/openvino/qnn/rocm, modal, openai-compatible, remote-ssh, replicate, runpod, sglang, tgi, together, trt-llm, vast, vllm) |
| `src/data` | 1 | Names list fixture |
| `src/device-adapters` | 8 | Cerebras/k8s/local/modal/ollama/runpod/ssh adapters + index |
| `src/distill` | 1 | agent-trajectory parser |
| `src/importers` | 5 | OpenAI-finetune, Portkey, Helicone, LiteLLM, OpenRouter |
| `src/migrations` | 1 | capture-to-events migration |
| `src/providers` | 9 | Direct provider APIs (deepseek/fireworks/google/groq/local-kolm/local-ollama/local-vllm/together-hosted + shared) |
| `src/runners` | 4 | gguf / native / onnx / wasm runners |
| `src/services` | 3 | compiler / proxy / redactor services |
| `src/storage` | 1 | postgres-store |
| `src/store-drivers` | 2 | vercel-kv, vercel-postgres |
| `src/teachers` | 1 | Cerebras teacher adapter |

---

## 8. Workers (14) — `workers/`

Each worker is a standalone Node/Python process with its own `package.json` and entry. Started by `kolm` CLI or by `docker-compose.gateway.yml`.

| Worker | Entry | Purpose |
|---|---|---|
| `audio-tokenize` | `tokenize.mjs` | Audio → discrete codec tokens (Encodec) |
| `compile-server` | `server.mjs` (+ Dockerfile, README, docker-compose.yml) | Persistent native/wasm compile worker |
| `constrained` | `constrained.mjs` | Constrained decode (grammar/regex) worker |
| `distill` | `distill.mjs` (+ `catalog.mjs`, `teacher-bridge.mjs`) | Distill batch runner; calls teacher bridge, writes pairs |
| `itkv` | `itkv.mjs` | Iterative training KV-cache server |
| `media-redact` | `redact.mjs` | Image + audio PHI/PII redactor |
| `multimodal-redact-audio` | `redact-audio.mjs` | Audio-only redact path |
| `multimodal-redact-image` | `redact-image.mjs` | Image-only redact path |
| `quantize` | `quantize.mjs` (+ README, requirements.txt) | bitsandbytes/gguf/awq/gptq/exl2 quantize — proven DeepSeek-R1-32B 61 GB → 17.9 GB in 125s on RTX 5090 |
| `runtime-build` | `build.mjs` | Builds runnable runtime bundles per target |
| `tokenizer-train` | `train.mjs` (+ README) | Trains tokenizers (BPE / SentencePiece / Unigram) |
| `tsac` | `tsac.mjs` | Timestamp-anchored capture |
| `video-tokenize` | `tokenize.mjs` | Video → codec tokens |
| `vision-tokenize` | `tokenize.mjs` | Image → codec tokens (DiNoV2 patches) |

---

## 9. Services (3) — `services/`

| Service | Entry | Purpose |
|---|---|---|
| `embed` | `multimodal.js` | Sentence embedding server (BGE-M3 default; `POST /embed` → 1024-dim) |
| `index` | `qmd.js` | Vector index (FAISS HNSW, persisted to `~/.kolm/index/`) |
| `mcp` | `server.js` | Model Context Protocol server exposing kolm tools |

---

## 10. SDKs (6 languages) — `sdk/`

### 10.1 `sdk/node/` — TypeScript-typed JS

- `sdk/node/index.mjs` — ESM entry
- `sdk/node/index.cjs` — CJS entry
- `sdk/node/index.d.ts` — TypeScript declarations
- `sdk/node/package.json`
- `sdk/node/README.md`
- `sdk/node/bin/cli.mjs` — bin shim
- `sdk/node/test/sdk.test.mjs` — round-trip smoke
- Honest envelope: returns raw status + body; no `isSuccess()` sugar (W469 trap)

### 10.2 `sdk/python/` — `kolm` package

- `sdk/python/kolm/__init__.py`
- `sdk/python/kolm/client.py` — `KolmClient(api_key, base_url)`
- `sdk/python/kolm/format.py` — receipt format helpers
- `sdk/python/recipe/__init__.py`
- `sdk/python/recipe/cli.py`
- `sdk/python/recipe/client.py`
- `sdk/python/recipe/shortcuts.py`
- `sdk/python/pyproject.toml`
- `sdk/python/README.md`
- `sdk/python/tests/test_sdk.py`
- Install: `pip install git+https://github.com/kolm-ai/kolm.git@main#subdirectory=sdk/python` (PyPI publication pending)

### 10.3 `sdk/c/` — single-header C

- `sdk/c/kolm.h` — stb-style single header; `KOLM_IMPLEMENTATION` guard
- `sdk/c/kolm-format.h` — receipt + spec format
- `sdk/c/kolm-cli.c` — demo binary
- `sdk/c/Makefile` — builds shared + static lib
- `sdk/c/README.md`
- libcurl-backed; no JSON parser bundled (pair with cJSON)
- CI: `.github/workflows/sdk-c-rust.yml` job `c-sdk`

### 10.4 `sdk/rust/` — `kolm` crate v0.1.0

- `sdk/rust/Cargo.toml`, `sdk/rust/Cargo.lock`
- `sdk/rust/src/lib.rs`
- `sdk/rust/src/format.rs`
- `sdk/rust/examples/whoami.rs`
- `sdk/rust/README.md`
- `sdk/rust/target/` (gitignored build artifacts)
- ureq-sync; status unwrapped from `ureq::Status(code, resp)` so non-2xx isn't a transport error

### 10.5 `sdk/mcp/` — Model Context Protocol

- `sdk/mcp/server.mjs`
- `sdk/mcp/package.json`
- `sdk/mcp/README.md`
- Exposes kolm tools to Claude Desktop / Cursor / any MCP host

### 10.6 `sdk/vscode/` — VSCode extension

- `sdk/vscode/extension.js`
- `sdk/vscode/package.json`
- `sdk/vscode/src/capture-watcher.js`
- `sdk/vscode/src/cost-savings.js`
- `sdk/vscode/src/distill-command.js`
- `sdk/vscode/src/pattern-detector.js`
- `sdk/vscode/src/router-switch.js`
- `sdk/vscode/.vscodeignore`, `sdk/vscode/LICENSE`, `sdk/vscode/README.md`

---

## 11. Packages (16) — `packages/`

Distribution targets across OS package managers, language SDKs, and framework integrations:

| Package | Purpose |
|---|---|
| `apt` | Debian/Ubuntu .deb |
| `attestation` | Sigstore + Ed25519 attestation library |
| `browser-extension` | Browser drop-in verifier (+ `icons/`) |
| `homebrew` | macOS brew formula |
| `langchain-kolm` | LangChain JS integration |
| `llamaindex-kolm` | LlamaIndex JS integration |
| `python-langchain-kolm` | LangChain Python integration (in `kolm_langchain/`) |
| `python-llamaindex-kolm` | LlamaIndex Python integration (in `kolm_llamaindex/`) |
| `runtime-rs` | Rust runtime crate (examples/, src/, tests/) |
| `sdk-kotlin` | Kotlin SDK (src/) |
| `sdk-python` | Pip package (`kolm/`) |
| `sdk-rn` | React Native SDK (android/, ios/, dist/) |
| `sdk-swift` | Swift SDK (Sources/, Tests/) |
| `sdk-ts` | TypeScript SDK (src/, dist/) |
| `vscode-kolm-rag` | VSCode RAG plugin (src/) |
| `winget` | Windows Package Manager manifest |

---

## 12. Frontend — `public/` (1,605 files; 1,167 HTML)

`public/` is the Vercel build output root. Subdirectories:

```
public/.vercel/            Vercel deploy artifacts
public/.well-known/        Discovery files
public/account/            92 signed-in dashboard pages
public/articles/           Long-form articles
public/artifacts/          Public artifact viewer (example/)
public/assets/             Static assets
public/bench/              Benchmark static data
public/benchmarks/         Benchmark landing pages
public/billing/            Billing assets
public/blog/               9 posts + index + 2 templates
public/brand/              Brand asset folder
public/case-studies/       Case studies
public/cdn/                CDN-mirrored assets (kolm-assets/)
public/community/          Community landing
public/compare/            Comparison page assets
public/compile/            Compile docs
public/compliance/         Compliance assets
public/cookbook/           Cookbook
public/device-transfer/    Device transfer flow
public/docs/               491 docs pages
public/enterprise/         Enterprise landing
public/finance/            Finance vertical
public/fonts/              Web fonts
public/for/                Persona pages
public/format/             Format spec assets
public/foundations/        Foundations page assets
public/healthcare/         Healthcare vertical
public/img/                Images (+ _generations/)
public/install/            Install flow
public/insurance/          Insurance vertical (templates/)
public/integrations/       Integrations
public/labs/               Labs / experimental
public/lang/               i18n landings (de/, fr/, ja/)
public/learn/              Learn paths
public/legal/              Legal pages
public/marketplace/        Marketplace assets
public/migrate/            Migration flow
public/og/                 50+ OG cards (SVG)
public/onboard/            Onboarding flow
public/partners/           Partners page
public/playground/         Playground
public/pricing/            Pricing assets
public/quickstart/         Quickstart flow
public/registry/           Registry browser
public/registry-pack/      Registry pack assets
public/research/           Research methods
public/samples/            Sample artifacts
public/sdk/                SDK landings
public/security/           Security assets
public/spec/               Spec assets
public/status/             Status page
public/studio/             Studio landing
public/training/           Training docs
public/trinity-500/        Trinity-500 model card mirror
public/tutorials/          Tutorials
public/university/         University program
public/use-cases/          Use cases
public/verticals/          Verticals
public/video/              Video assets
public/vs/                 10 head-to-head comparison pages
```

---

## 13. Marketing top-level (170 HTML)

Every `public/*.html` file enumerated by domain.

### 13.1 Core product (15)

`index.html` (W604 homepage redesign — hero "Distill frontier models / Quantize to INT4 / Run on your hardware") · `quickstart.html` · `demo.html` · `demo-90s.html` · `demo-live.html` (W897 70s cinematic) · `setup.html` · `setup-with-ai.html` · `download.html` · `signup.html` · `password-reset.html` · `account.html` · `dashboard.html` · `settings.html` · `studio.html` · `tui.html`

### 13.2 Pricing + plans + trust (15)

`pricing.html` (Free / Hobby $9 / Pro $49 / Business $1,499 / Enterprise) · `enterprise.html` · `hobbyist.html` (W918) · `roi.html` · `trust.html` · `security.html` · `compliance-packs.html` · `soc2.html` · `slsa.html` · `sbom.html` · `hipaa-mapping.html` · `gov.html` · `government.html` · `defense.html` · `defense-v2.html`

### 13.3 W918 land-grab landings (5)

`agents.html` · `cerebras-teacher.html` · `gateway-migration.html` · `openai-migration.html` · `migrate.html`

### 13.4 Product surfaces (20)

`product.html` · `forge.html` · `frontier-stack.html` · `foundations.html` · `compile.html` · `distill.html` · `train.html` · `training.html` · `run.html` · `runtimes.html` · `deploy.html` (via /deploy section) · `gateway.html` · `cloud.html` · `compute.html` · `byoc.html` · `airgap.html` · `merge.html` · `models.html` · `recipes.html` · `templates.html`

### 13.5 Capability landings (18)

`capture.html` · `captures.html` · `wrapper.html` · `verify.html` (W897 3-card hub) · `verify-cli.html` · `verify-prod.html` · `receipt.html` · `audit-log.html` · `drift.html` · `sla.html` · `sustainability.html` · `frozen-eval.html` · `kolm-auto-pilot.html` · `value-loop.html` · `k-score.html` · `k-score-calibration.html` · `k-score-explained.html` · `kscore-bench.html` · `kscore-leaderboard.html`

### 13.6 Verticals (16)

`healthcare.html` · `healthcare-v2.html` · `health-insurance.html` · `insurance.html` · `insure.html` · `legal.html` · `legal-v2.html` · `finance.html` · `finance-v2.html` · `fintech.html` · `education.html` · `customer-support.html` · `code-gen.html` · `defense.html` · `defense-v2.html` · `devtools-v2.html`

### 13.7 Comparison pages (16)

`how-vs-anthropic.html` · `how-vs-diy.html` · `how-vs-hyperscaler.html` · `how-vs-lorax.html` · `how-vs-openai-fine-tune.html` · `how-vs-openpipe.html` · `how-vs-predibase.html` · `vs-fine-tune.html` · `vs-hindsight.html` · `vs-langsmith.html` · `vs-mem0.html` · `vs-ollama.html` · `vs-openai-fine-tune.html` · `vs-openpipe.html` · `vs-predibase.html` · `vs-rag.html` · `vs-together.html` · `compare.html`

### 13.8 Trust, governance, EU/sovereign (10)

`baa.html` · `dpa.html` · `eu.html` · `eu-sovereign.html` · `sovereign-ai.html` · `threat-model.html` · `subprocessors.html` · `acceptable-use.html` · `license.html` · `manifesto.html`

### 13.9 Devices + fleet + edge + hardware (6)

`device.html` · `device-transfer.html` · `fleet.html` · `edge.html` · `hardware.html` · `self-host.html`

### 13.10 Marketplace + registry + integrations (8)

`marketplace.html` · `registry.html` · `hub.html` · `integrations.html` · `sdks.html` · `community.html` · `nonprofits.html` · `saas.html`

### 13.11 Docs + reference + research (12)

`docs.html` · `api.html` · `spec.html` · `spec-grammar.html` · `glossary.html` · `taxonomy.html` · `whitepaper.html` · `research.html` · `benchmarks.html` · `leaderboard.html` · `roadmap.html` · `changelog.html`

### 13.12 Sales + support + content (10)

`book-demo.html` · `faq.html` · `troubleshooting.html` · `hall-of-fame.html` · `press.html` · `why-kolm.html` · `why-now.html` · `what-is-an-ai-compiler.html` · `use-cases.html` · `shortcuts.html`

### 13.13 Account public mirrors (8)

`teams.html` · `teams-accept.html` · `admin.html` · `ask.html` · `tos.html` · `terms.html` · `privacy.html` · `404.html`

### 13.14 Internals (4)

`design-system.html` · `badge.html` · `tunnels.html` · `upgrade.html`

### 13.15 Misc (7)

`r.html` (short-link page) · `status.html` · `ci.html` · `about.html` · `about-the-assistant.html` · `build-your-own.html` · `builder.html`

---

## 14. Account dashboard (92 HTML)

Signed-in surface under `public/account/`. Listed by section.

### 14.1 Identity + overview (8)

`overview.html` · `settings.html` · `settings/integrations.html` · `settings/notifications.html` · `api-keys.html` · `keys.html` · `security/2fa.html` · `audit-log.html`

### 14.2 Billing + savings (4)

`billing.html` · `chargeback.html` · `savings.html` · `enterprise.html`

### 14.3 Org + members + teams (5)

`org.html` (W918 Wave 2) · `members.html` (W918 Wave 2) · `groups.html` · `team.html` · `enterprise/sso.html`

### 14.4 Devices + fleet (5)

`devices.html` · `devices/_slug.html` · `fleet.html` · `hardware.html` · `experts.html`

### 14.5 Distill + recipes + datasets (8)

`distill-runs.html` · `distill/new.html` · `recipes.html` · `datasets.html` · `captures.html` · `captures/review.html` · `captures/analytics.html` · `captured.html`

### 14.6 Capture + privacy + labeling (4)

`labeling.html` · `privacy-events.html` · `connectors.html` · `lake.html`

### 14.7 Pipelines + serve + runtime (8)

`pipelines.html` · `pipelines/index.html` · `pipelines/_template.html` · `serve/index.html` · `serve/new.html` · `quantize/index.html` · `quantize/new.html` · `merge/new.html`

### 14.8 Eval + bakeoff + AB (6)

`bench.html` · `bakeoff.html` · `bakeoffs.html` · `multimodal-bakeoff.html` · `ab-tests.html` · `simulations.html`

### 14.9 Drift + monitoring + observability (12)

`drift.html` · `drift-alert.html` · `staleness.html` · `failure-modes.html` · `synthetic.html` · `active-learning.html` · `continuous-monitoring.html` · `confidence.html` · `routing.html` · `diagnose.html` · `sla.html` · `agent-telemetry.html`

### 14.10 Sustainability + seasonal + opportunities (4)

`sustainability.html` · `seasonal.html` · `opportunities.html` · `repeated-workflows.html`

### 14.11 Forge + builders + create (4)

`forge.html` · `create-model.html` · `builds.html` · `builds/new.html`

### 14.12 Artifacts + receipts + namespaces (6)

`artifacts.html` · `artifacts/_slug.html` · `artifacts/diff.html` · `receipts/index.html` · `namespaces.html` · `namespaces/new.html`

### 14.13 Gateway + governance + federated + onboarding (15)

`gateway.html` · `gateway/providers.html` · `governance.html` · `governance/assurance.html` · `governance/cost.html` · `governance/drift.html` · `governance/evidence.html` · `governance/lifecycle.html` · `governance/passport.html` · `federated/consortium.html` · `onboarding.html` · `onboarding/path-gpu.html` · `onboarding/path-no-gpu.html` · `onboarding/path-route.html` · `onboarding/path-verify.html`

### 14.14 Approvals + storage + webhooks (3)

`approvals.html` · `storage.html` · `webhooks.html` (compliance lives under §14.13 `governance/*`)

> For the canonical flat alphabetical inventory of all 92 pages with subdirectory pathing, see **§42**.

---

## 15. Docs (491 HTML)

`public/docs/` — grouped by section.

### 15.1 Spec + format

`docs/spec/dot-kolm-v1.0.html` · `docs/glossary.html` · `docs/state.html`

### 15.2 Quickstart (6)

`docs/quickstart.html` · `docs/quickstart/index.html` · `docs/quickstart/node.html` · `docs/quickstart/python.html` · `docs/quickstart/c.html` · `docs/quickstart/rust.html` · `docs/quickstart/mcp.html`

### 15.3 Install (3)

`docs/install/linux.html` · `docs/install/mac.html` · `docs/install/windows.html`

### 15.4 SDK reference (6)

`docs/sdk.html` · `docs/sdk/node.html` · `docs/sdk/python.html` · `docs/sdk/c.html` · `docs/sdk/rust.html` · `docs/sdk/mcp.html` · `docs/vscode.html`

### 15.5 CLI reference (242 pages)

`docs/cli/index.html` + 241 per-verb pages. Sampled: `docs/cli/ab.html` · `accelerate.html` · `active-learn.html` · `add.html` · `agent.html` · `ai-act.html` · `airgap.html` · `anonymize.html` · `approval.html` · `artifacts.html` · `ask.html` · `attach.html` · `attest.html` · `audio.html` · `audit-export.html` · `audit.html` · `auditor.html` · `autopilot.html` · `backbones.html` · `bakeoff.html` · `bench.html` · `benchmark.html` · `billing.html` · `bootstrap.html` · `bridges.html` · `build.html` · `bundle.html` · `cache.html` · `caiq.html` · `capture-off.html` · `capture-on.html` · `capture.html` · `captures.html` · `carbon.html` · `cc.html` · `cert.html` · `changelog.html` · `chargeback.html` · `chat-tui.html` · `chat.html` · `checkpoint.html` · `cloud.html` · `compile.html` · `completion.html` · `compute.html` · `config.html` · `connect.html` · `connectors.html` · `copyright-scan.html` · `dataset.html` · `datasets.html` · `decode.html` · `demo.html` · `deploy.html` · `detect.html` · `device.html` · `devices.html` · `diagnose.html` · `diff.html` · `distill.html` · `do.html` · `doc.html` · `doctor.html` · `drift-alert.html` · `drift.html` · `eject.html` · `encode.html` · `eval.html` · `evidence.html` · `evolve.html` · `experts.html` · `explain.html` · `export.html` · `extract.html` · `failure-modes.html` · `failure-to-capture-loop.html` · `federated.html` · `fit.html` · `fix.html` · `fl.html` · `forge.html` · `forget.html` · `frontier.html` · `gateway.html` · `gpu.html` · `guardrails.html` · `hardware.html` · `health.html` · `help.html` · `hmac.html` · `hub.html` · `import-chat.html` · `import.html` · `improve.html` · `init-agent.html` · `init.html` · `inspect.html` · `inspection.html` · `install-device.html` · `install.html` · `instant.html` · `intent.html` · `ir.html` · `its.html` · `jobs.html` · `key.html` · `keygen.html` · `keys.html` · `kolmbench.html` · `label.html` · `labels.html` · `lake.html` · `lang.html` · `lineage.html` · `lingual.html` · `list.html` · `load.html` · `login.html` · `logout.html` · `logs.html` · `long-context.html` · `loop.html` · `make.html` · `manifest.html` · `marketplace.html` · `media.html` · `menu.html` · `merge.html` · `mesh.html` · `meta.html` · `metrics.html` · `migrate.html` · `model-card.html` · `models.html` · `moe.html` · `multilingual.html` · `namespace.html` · `new.html` · `next.html` · `nl.html` · `numeric.html` · `opportunities.html` · `optimize.html` · `otel.html` · `pack.html` · `package.html` · `packages.html` · `passport.html` · `pextract.html` · `pin.html` · `pipeline.html` · `plugin.html` · `poison.html` · `prefetch.html` · `privacy.html` · `procurement.html` · `profile.html` · `promote.html` · `proxy.html` · `pubkey.html` · `publish.html` · `pull-backbone.html` · `pull.html` · `quantize.html` · `query.html` · `quickstart.html` · `rag.html` · `recommend.html` · `redact.html` · `redteam.html` · `reg.html` · `region.html` · `registry.html` · `regulatory.html` · `reinject.html` · `remote.html` · `repeated-workflows.html` · `repl.html` · `replay.html` · `rescue.html` · `residency.html` · `resume.html` · `review.html` · `route.html` · `run.html` · `runtime.html` · `savings.html` · `sbom.html` · `score.html` · `sdk.html` · `seasonal.html` · `seeds.html` · `serve.html` · `services.html` · `sessions.html` · `settings.html` · `setup.html` · `shell-init.html` · `ship.html` · `signup.html` · `sigstore-attest.html` · `sla.html` · `spec-decode.html` · `staleness.html` · `stat-sig.html` · `status.html` · `stress.html` · `studio.html` · `support-bundle.html` · `surfaces.html` · `sync.html` · `synth.html` · `synthetic.html` · `tail.html` · `team.html` · `test.html` · `tokenize.html` · `tool.html` · `trace.html` · `train.html` · `tui.html` · `tune.html` · `tunnel.html` · `unpack.html` · `update.html` · `upgrade.html` · `usage.html` · `verify.html` · `version.html` · `vertical.html` · `video.html` · `vlm.html` · `vscode.html` · `watch.html` · `what.html` · `whoami.html` · `wizard.html` · `wrap.html` · `xlang.html` · `yaml.html`

### 15.6 Capture (7)

`docs/capture/approval.html` · `capture/export.html` · `capture/hash-chain.html` · `capture/overview.html` · `capture/poisoning.html` · `capture/redaction.html` · `capture/retention.html`

### 15.7 Compile (2)

`docs/compile/formats.html` · `docs/compile/gguf.html`

### 15.8 Connect (4)

`docs/connect/anthropic.html` · `gemini.html` · `openai.html` · `openrouter.html`

### 15.9 Cookbook (5)

`docs/cookbook.html` · `cookbook/coding-assistant.html` · `cookbook/document-extractor.html` · `cookbook/index.html` · `cookbook/support-bot.html`

### 15.10 Gateway (16)

`docs/gateway.html` · `gateway-api.html` · `gateway-bench.html` · `gateway-byoc.html` · `gateway-captures.html` · `gateway-cli.html` · `gateway-compose.html` · `gateway-confidence-router.html` · `gateway-deploy.html` · `gateway-faq.html` · `gateway-mode.html` · `gateway-namespaces.html` · `gateway-pii.html` · `gateway-providers.html` · `gateway-receipts.html` · `gateway-region-lock.html` · `gateway-sdk.html` · `gateway-toml.html` · `gateway/configuration.html` · `gateway/overview.html` · `gateway/providers.html` · `gateway/quickstart.html` · `gateway/routing-rules.html` · `gateway/self-host.html` · `gateway/streaming.html` · `gateway/troubleshooting.html`

### 15.11 Govern (7)

`docs/govern-api-reference.html` · `govern-cli-reference.html` · `govern-faq.html` · `govern-overview.html` · `govern/assurance.html` · `govern/compliance.html` · `govern/drift.html` · `govern/evidence.html` · `govern/lifecycle.html` · `govern/receipts.html`

### 15.12 i18n (6)

`docs/i18n/de.html` · `es.html` · `fr.html` · `ja.html` · `ko.html` · `zh.html`

### 15.13 Integrations (8)

`docs/integrations/azure-ai-studio.html` · `index.html` · `langchain-js.html` · `langchain-py.html` · `llamaindex-js.html` · `llamaindex-py.html` · `make.html` · `sagemaker.html` · `vertex-ai.html` · `zapier.html`

### 15.14 Multimodal (3)

`docs/multimodal/audio.html` · `video.html` · `vision.html` · `docs/multimodal-pipeline.html`

### 15.15 Observability (2)

`docs/observability.html` · `observability/opentelemetry.html` · `observability/prometheus.html`

### 15.16 Receipts (6)

`docs/receipts/audit-export.html` · `format.html` · `index.html` · `overview.html` · `signing.html` · `verification.html`

### 15.17 Recipes (8)

`docs/recipes/agent.html` · `authoring-a-template.html` · `cerebras-council-distill.html` · `classify.html` · `customer-support.html` · `doc-qa.html` · `edge-deploy.html` · `index.html` · `openai-finetune-migration.html`

### 15.18 Reference (3)

`docs/reference/config-toml.html` · `doctor-checks.html` · `ship-gate.html`

### 15.19 Routing (5)

`docs/routing/active-learning.html` · `confidence-routing.html` · `cost-attribution.html` · `overview.html` · `provider-failover.html`

### 15.20 Run (15)

`docs/run/deploy.html` · `devices.html` · `fleet.html` · `hardware.html` · `monitoring.html` · `overview.html` · `rollback.html` · `runtimes.html` · `security.html` · `serve.html` · `speed-optimization.html` · `testing.html` · `troubleshooting.html` · `updates.html`

### 15.21 Runtime (2)

`docs/runtime.html` · `runtime/horizontal-scaling.html` · `runtime/memory-tiers.html` · `runtime-autodetect.html` · `runtime-passport.html` · `runtime-placement.html`

### 15.22 Studio (16)

`docs/studio-api-reference.html` · `studio-bench.html` · `studio-cli-reference.html` · `studio-compile.html` · `studio-distill-recipes.html` · `studio-distill.html` · `studio-export-formats.html` · `studio-export-gguf.html` · `studio-faq.html` · `studio-judges.html` · `studio-moe.html` · `studio-overview.html` · `studio-publish-hf.html` · `studio-quantization.html` · `studio-teachers.html` · `studio/artifacts.html` · `studio/overview.html`

### 15.23 Other top-level docs (~70 sampled)

`docs/ab-testing.html` · `agent-guide.html` · `agents.html` · `airgap.html` · `api.html` · `approvals.html` · `artifact-lifecycle.html` · `assurance-case.html` · `audit-export.html` · `audit.html` · `capture-anomaly.html` · `chargeback.html` · `cloud-cerebras.html` · `cloud-compile.html` · `cloud-sync.html` · `colab-compile.html` · `connectors.html` · `copyright-scan.html` · `cost-displacement.html` · `cost-optimization.html` · `cross-lingual.html` · `cve-in-kscore.html` · `data-network-effects.html` · `datasets.html` · `deploy-airgap.html` · `deploy-docker-compose.html` · `deploy-kubernetes.html` · `deploy-vllm.html` · `dev-agents.html` · `devices.html` · `diagnose.html` · `distill.html` · `distillation.html` · `drift-alert.html` · `drift-detection.html` · `drift-detector.html` · `efficiency.html` · `enterprise.html` · `eval-harness.html` · `evals.html` · `evidence-dag.html` · `failure-modes.html` · `federated-consortium.html` · `forge/spec-toml.html` · `github-actions.html` · `guardrails.html` · `hardware.html` · `import.html` · `indie-loop.html` · `k-score-methodology.html` · `kubernetes.html` · `lake.html` · `lineage.html` · `lm-studio-import.html` · `marketplace-import.html` · `marketplace.html` · `marketplace/publish.html` · `migrate.html` · `model-card.html` · `multi-region.html` · `multilingual.html` · `namespace-fingerprint.html` · `numeric-accuracy.html` · `optimizer.html` · `passport.html` · `pipelines.html` · `plugins.html` · `privacy.html` · `procurement.html` · `progressive-distill.html` · `rag.html` · `rbac.html` (W918 Wave 2) · `reasoning-traces.html` · `regulatory-toolkit.html` · `releasing.html` · `rs-1.html` · `sandbox.html` · `seasonal.html` · `self-hosted-deploy-complete.html` · `staleness.html` · `storage.html` · `synthetic.html` · `teacher-council.html` · `team.html` · `tickets.html` · `token-dpo.html` · `training.html` · `troubleshooting.html` · `verify.html` · `verticals.html` · `webauthn.html` · `webhooks.html`

---

## 16. Blog + vs/ + verticals

### 16.1 Blog (11 files)

`blog/index.html` · `blog/2026-05-26-from-frontier-to-local-in-five-minutes.html` · `blog/2026-05-26-introducing-kolm-v1.html` · `blog/2026-05-26-receipts-as-compliance.html` · `blog/2026-05-26-the-wrapper-tax-decomposed.html` · `blog/2026-05-26-trinity-500-distill-story.html` · `blog/2026-05-28-openai-finetuning-shutdown.html` · `blog/2026-06-02-distilling-agents.html` (W918 Wave 2) · `blog/2026-06-04-distill-from-gateway-logs.html` (W918 Wave 2) · `blog/templates/cost-of-ai.html` · `blog/templates/state-of-distillation.html`

### 16.2 `public/vs/` (10 head-to-heads)

`vs/index.html` · `vs/fireworks.html` · `vs/lm-studio.html` · `vs/ollama.html` · `vs/openai-api.html` · `vs/openai.html` · `vs/openpipe.html` · `vs/openrouter.html` · `vs/self-built.html` · `vs/together.html`

### 16.3 Verticals

11 vertical landings inside `public/` top-level (see §13.6); plus `public/verticals/` subdir for deep-dive content.

---

## 17. Design system + assets

### 17.1 CSS (23 files in `public/`)

Top-level: `design-tokens.css` (single source of truth: `--ink-{0..3}`, `--surf-{0..3}`, `--accent-cool-{300..900}`, spacing scale 4/8/12/16/24/32/48/64, radius `--r-xs..xl`, shadow `--sh-1..3`, z-index ladder 0/10/20/40/100/1000, motion `--ease-out-soft`, `--dur-150/200/300`) · `account-shell.css` · `brand-refresh.css` · `docs-shell.css` · (plus W604/W836/W850 overlays).

W604 motion CSS (cursor-reactive orb, magnetic CTAs, 3D-tilt cards) all gated on `prefers-reduced-motion` + `pointer:fine`. Tokens-only at the leaf (no raw hex in components per W850 cool-slate binding).

### 17.2 JS (21 files in `public/`)

- `app.js` — main entry
- `assistant-widget.js` — embedded assistant widget
- `docs-shell.js` — docs shell loader
- (+ 18 more under `public/scripts/`)

### 17.3 Brand assets

- `brand-aurora-field.png`, `brand-hero-prism.png`, `brand-hero.png`, `brand-logo-exploration.png`
- `aurora.svg`, `badge.svg`
- `public/brand/` subdir (brand asset folder)
- `public/og/` — 50+ SVG OG cards (one per route: `index.svg`, `pricing.svg`, `articles-*.svg`, `docs-*.svg`, etc.)

### 17.4 Demo assets

- `demo-90s.mp4`, `demo-90s-poster.jpg`

### 17.5 Fonts

- `public/fonts/` — web fonts (woff2, served network-first via sw.js)

---

## 18. Service worker + manifest + SEO

### 18.1 `public/sw.js` (180 lines)

- `CACHE_VERSION = 155`
- Cache slug: `kolm-v155-2026-05-28-wave918-wave2-agents-gateway-orgs`
- Network-first for `.js/.css/.woff2`
- Cache-first for HTML
- Bumps slug on every wave

### 18.2 SEO + manifests

- `public/robots.txt`
- `public/sitemap.xml`
- `public/manifest.webmanifest` (installable PWA)
- `public/docs-manifest.json` — docs index used by `docs-shell.js`
- `public/.well-known/` — discovery files

---

## 19. CLI — `cli/kolm.js` (53,863 lines, 279 unique verbs)

### 19.1 Verb count

- 361 total `case` clauses (verbs + subverbs + aliases)
- 279 unique top-level verbs
- Flag normalization: `--no-color`, `--no-unicode`, `--plain` stripped from `argv` BEFORE dispatch (W849 trap)

### 19.2 Complete verb list

Identity, account, devices:
`login` · `logout` · `signup` · `whoami` · `doctor` · `org` (7 subverbs: list/create/members/invite/role/remove/transfer-owner) · `org` · `team` · `key` · `keys` · `keygen` · `pubkey` · `sessions` · `signin` · `signout` · `settings` · `setup` · `setup-with-ai` · `shell-init` · `profile` · `signin` · `signout` · `signup`

Distill, recipes, teachers, council:
`distill` (with `--mode=agent`, `--teacher cerebras:llama-3.3-70b`, etc.) · `recipe` · `recipes` · `pass` · `passport` · `seeds` · `seasonal` · `synth` · `synthetic` · `teacher` · `bridges` · `experts` · `forge` · `evolve` · `improve` · `tune` · `train` · `fit` · `frontier`

Compile, build, package, run:
`compile` · `build` · `package` · `packages` · `pack` · `unpack` · `pin` · `bundle` · `manifest` · `make` · `do` · `run` · `serve` · `chat` · `chat-tui` · `complete` · `completion` · `infer`

Quantize, accelerate, MoE, native, runtime:
`quant` · `quantize` · `accelerate` · `moe` · `runtime` · `route` · `rt` · `proxy` · `optimize` · `cache` · `prefetch` · `decode` · `spec-decode` · `instant`

Deploy, fleet, cloud, devices:
`deploy` · `cloud` · `cloud` · `fleet` · `device` · `devices` · `hardware` · `mesh` · `tunnel` · `region` · `residency` · `multi-region` · `gpu` · `hw` · `compute`

Capture, lake, replay, drift:
`capture` · `capture-on` · `capture-off` · `captures` · `lake` · `replay` · `redact` · `forget` · `anonymize` · `pextract` · `privacy` · `audit` · `audit-export` · `auditor` · `attest` · `sigstore-attest` · `sbom` · `cert` · `compliance` · `procurement` · `caiq` · `ai-act` · `aiact` · `regulatory` · `reg` · `mit` · `hmac` · `sig` · `cc`

Drift, monitoring, ABs, eval:
`drift` · `drift-alert` · `staleness` · `failure-modes` · `failure-to-capture-loop` · `synthetic` · `synth` · `bakeoff` · `redteam` · `poison` · `ab` · `ae` · `score` · `stat-sig` · `tiers` · `bench` · `benchmark` · `benchmarks` · `eval` · `kolmbench` · `kb` · `numeric` · `num` · `inspection` · `inspect` · `kolmbench` · `verify-benchmarks` · `verify` · `wrap`

Marketplace, hub, share:
`marketplace` · `mc` · `hub` · `huggingface` · `hf` · `index` · `list` · `ls` · `show` · `publish` · `pull` · `pull-backbone` · `pin` · `promote` · `ship` · `release` (via signup/deploy) · `rollback`

CLI utilities, completion, namespace:
`init` · `init-agent` · `connect` · `connectors` · `add` · `agent` · `agents` · `info` · `status` · `version` · `update` · `upgrade` · `self-update` · `usage` · `metrics` · `support-bundle` · `help` · `menu` · `nl` · `wizard` · `query` · `ask` · `intent` · `chat`

Tokenize, vocab, lang:
`tokenize` · `lang` · `multilingual` · `lingual` · `xlang` · `cross-lingual` · `i18n` (via lang)

Tests + utilities + advanced:
`test` · `test-device` · `test-quants` · `tail` · `watch` · `logs` · `loop` · `rescue` · `eject` · `reinject` · `merge` · `diff` · `yaml` · `yaml-diff` · `format` · `lint`

Trace + IR + sim + simulation:
`trace` · `ir` · `its` · `sim` · `studio` (CLI verb mirror; 5 subverbs: open/status/list/sessions/recipes)

Long-context, RAG, tool, video, audio, vision, vlm:
`long-context` · `longctx` · `rag` · `tool` · `audio` · `vision` · `video` · `vlm` · `media` · `encode` · `extract`

Misc/aliases:
`a` · `ab` · `bash` · `do` · `fix` · `fl` · `import` · `import-chat` · `install` · `install-device` · `jobs` · `key` · `kb` · `label` · `labels` · `lake` · `lang` · `lineage` · `load` · `loop` · `ls` · `make` · `meta` · `mit` · `model-card` · `models` · `namespace` · `new` · `next` · `ns` · `nl` · `numeric` · `opportunities` · `optimize` · `otel` · `passport` · `pextract` · `pipeline` · `plugin` · `procurement` · `profile` · `promote` · `proxy` · `px` · `quickstart` · `recommend` · `receipt` · `receipts` · `region` · `regulatory` · `repl` · `replay` · `resume` · `route` · `runtime` · `savings` · `sdk` · `services` · `setup` · `step` · `stress` · `surfaces` · `sync` · `tail` · `tune` · `tunnel` · `vendor-pack` · `vertical` · `vscode` · `what` · `wizard` · `wrap` · `zsh` · `fish`

### 19.3 Verb subcommands

- `org`: list / create / members / invite / role / remove / transfer-owner (7 subverbs from W918 Wave 2)
- `studio`: open / status / list / sessions / recipes (5 subverbs)
- `key`: list / create / rotate / delete (4)
- `distill`: plan / start / status / cancel / artifacts / model-card / passport (with `--mode=agent`, `--teacher <name:model>`, `--from openai-finetune <jsonl>`)
- `compile`: with `--target {native,c,rust,wasm}`
- `import`: `--from {openai-finetune,portkey,helicone,litellm,openrouter} <log.jsonl>` (W918)

### 19.4 Special CLI features

- `kolm doctor` — probes Anthropic, OpenAI, Cerebras (W918), local DeepSeek; exits 3 on rejected key
- `kolm update` — refuses to run from repo clone (silent global-install hazard) (W484)
- `kolm intent ask "$query"` — NL routing
- `kolm tui` — full-screen TUI mode
- `kolm menu` — interactive picker
- TTY-only progress bar `_renderProgress`
- ASCII Unicode banner on startup (strippable via `--no-unicode`)

---

## 20. TUI mode + UX primitives

### 20.1 TUI views (20)

`account` · `distill` · `compile` · `runtime` · `capture` · `pipelines` · `routing` · `drift` · `fleet` · `members` · `recipes` · `marketplace` · `eval` · `notifications` · `studio` · `org` · `gateway` · `verify` · `command` · `help`

### 20.2 TUI colon commands (11)

`:q` · `:w` · `:e <view>` · `:help` · `:theme {light,dark}` · `:export` · `:refresh` · `:fleet` · `:org` · `:studio` · `:doctor`

### 20.3 TUI shortcuts

`W` = studio · `D` = doctor · `O` = org · `Q` = quit

### 20.4 UX primitives — `cli/kolm-ux.js`

7 primitives: `header` · `kv` · `table` · `progress` (TTY-only) · `spinner` · `panel` · `divider`

All respect `--no-color` / `--no-unicode` / `--plain` (stripped from `argv` pre-dispatch).

---

## 21. Vendor binary wrappers

6 binary wrappers exposed by `package.json` `"bin"`:

- `kolm` → `cli/kolm.js`
- `kolm-chat` — embedded chat shortcut
- `kolm-doctor` — doctor shortcut
- `kolm-quantize` — quantize shortcut
- `kolm-router` — router shortcut
- `kolm-receipt` — receipt verify shortcut

Plus distribution package binaries via `packages/apt/`, `packages/homebrew/`, `packages/winget/`, etc.

---

## 22. Tests — 665 files in `tests/`

### 22.1 Structural / core (R1–R8, S1–S2, WC04, WC05–WC15)

- `r1-runtime-passport.test.js` · `r2-artifact-lifecycle.test.js` · `r3-kolm-serve.test.js` · `r4-deploy-generators.test.js` · `r5-evidence-dag.test.js` · `r6-assurance-case.test.js` · `r7-drift-detector.test.js` · `r8-cost-displacement.test.js`
- `s1-gguf-export.test.js` · `s2-ollama-modelfile.test.js`
- `wc04-*.test.js` (ab-router, capture-analytics, cloud-sync, compile-pipeline, cost-estimator, devices, distill-pipeline, models, privacy-membrane, runtime-policy, trace-translator) — 11 modules
- `wc05-envelope.test.js` · `wc06-log.test.js` · `wc07-env-helpers.test.js` · `wc14-shell-injection-guards.test.js` · `wc15-perf-cache.test.js`
- `wf01-design-system.test.js`
- `wc01-dep-audit.test.js`

### 22.2 Foundational (wave144–wave210) — V1 era

`wave144-*` family (api, bench-compare, bench-proof, completions-api, completions-server, distill-worker, doc-check, dsl-codegen, extract, moe-compose, native-compile, phi-redactor, predibase-demo, seeds-gate, tokenizer-artifact, tokenizer, tui-chat, verifier-states) — 18 files
- `wave145–wave210` — 65 tests covering k-score, export-provenance, MoE, pretokenize, ed25519, sigstore, recipe-class, redactor-receipt, cross-vendor, teacher-delta, export-binder, adversarial, tenant-shadow, auditor-attestation, drift-supersession, rs1 spec, healthcare refresh, verify-prod, quickstart-integration, EDI 837/835/834/270-271/278, FHIR USCDI, HEDIS, letter-gens, rule-class, k-score-explained, frozen-eval, format-v2, migrate, KMS, artifact-drift, MoE-CLI, RAG-CLI, keys-rotate, corpus-licensing, quantize-worker, methods-research-page, nl-cli-verb, training-refresh, seeds-new, quickstart-nl, training-data-sources, cli-ux, tui-repl, post-auth-ui, website-copy, docs-audit, a11y-perf, mobile, i18n-refresh, final-sweep

### 22.3 W211–W260 sprint era (capture durability → copy refresh)

`wave211-ci-hotfix` · `wave212-capture-durability` · `wave213-live-capture-tail` · `wave214-distill-from-captures` · `wave215-threshold-alerts` · `wave216-replay-diff` · `wave217-frontier-models` · `wave218-hw-tier-presets` · `wave219-runtime-build` · `wave220-homepage-3sec-hero` · `wave221-nav-consolidation` · `wave222-tui-altscreen` · `wave223-tui-showcase` · `wave224-slop-cut` · `wave225-seo-infrastructure` · `wave226-pillar-ai-compiler` · `wave227-supporting-articles` · `wave228-brand-disambig` · `wave229-foundations-verbs` · `wave230-foundations-page` · `wave232-kolm-state` · `wave233-detached-sessions` · `wave234-chat-templates` · `wave235-amd-rocm-benchmarks` · `wave236-hermes-agent` · `wave237-mesh-cluster` · `wave238-init-agent` · `wave240-three-process-split` · `wave241-bootstrap-installer` · `wave242-enterprise-proxy` · `wave243-compile-variety` · `wave249-cross-platform` · `wave250-remote-compute` · `wave252-backend-fixes` · `wave252-ml-fixes` · `wave253-audit-fixes` · `wave255-e2e-compile-distill` · `wave256-copy-scrub` · `wave258-audit-fixes` · `wave260-copy-refresh` · `wave261-builder` · `wave262-mcp-installers`

### 22.4 W409 family — copy + serial-run flake harness

`wave409a/b/c/d/e/f/g/h/i/j/k` tests (referenced in W470 PO-1 trap fix)

### 22.5 W446–W540 audit + route docs era

40+ tests including audit fixes, value-loop polish, billing settings, multimodal redact, ask intent, distill telemetry, changelog, artifact runtime consistency, build honors out, telemetry reconciliation, DoD 12-step e2e, federated approvals, attestation embed, trace compile, billing breakdown, multimodal bakeoff, route docs for every domain.

### 22.6 W580–W606 product frontier era

`wave580-invention-portfolio` · `wave581-redaction-benchmark` · `wave582-quantization-oracle` · `wave583-cloud-compute-broker` · `wave583-enterprise-identity-contract` · `wave584-distill-strategy` · `wave585-federated-robust-aggregation` · `wave586-redaction-public-benchmark-contract` · `wave587-kscore-calibration-contract` · `wave588-package-release-readiness` · `wave588-quality-calibration-contract` · `wave589-benchmark-evidence-contract` · `wave590-governance-runtime-packets` · `wave591-package-local-build-contract` · `wave592-compliance-certification-packet` · `wave593-invention-implementation-spec` · `wave594-kolm-brand-contract` · `wave595-product-frontier-map` · `wave596-product-math-frontier` · `wave596-redactor-template-e2e` · `wave597-build-strategy-brain` · `wave598-product-invention-buildbook` · `wave599-readiness-gate-workorders` · `wave600-product-research-atlas` · `wave601-product-frontier-lab` · `wave602-product-frontier-lab-api` · `wave603-product-frontier-implementation-contracts` · `wave604-product-frontier-contracts-api` · `wave605-product-frontier-operator-kernels` · `wave606-product-frontier-operator-kernels-api`

### 22.7 W707–W835 system upgrade era (114-item review)

70+ tests covering supplement bundle, copyright + geo, teacher source policy, vertical disclaimer, routing events, routing threshold SSE, runtime router, active learning queue, importance-weighted distill, progressive distill, reasoning-trace distill, contrastive distill, cross-namespace transfer, TaaS arch search, curriculum distill, teacher council, DAQ, self-improvement, TSAC, ITKV, streaming load, memory tier, preload scheduler, BVL kernels, accelerate, ITS, load queue, prometheus, vscode watcher, yaml-gha, otel, rag, tool-use, guardrails, marketplace, pipeline, lineage, import, diagnose, gateway-mode, migrate, failure-modes, staleness, drift-alert, seasonal, synthetic, copyright, verticals, kolmbench, pattern-lake, bench-harnesses, numeric-accuracy, per-language-kscore, model-poisoning, adversarial, sbom, membership-inference, prompt-extraction, eu-ai-act, soc2-iso27001, model-card, data-residency, audit-export, vlm-distill, vision-tokenize, audio-distill, audio-tokenize, video-distill, video-tokenize, cross-lingual, autopilot, ab-router, stat-sig, airgap-sneakernet, multi-region, long-context-warn, approval-queue, chargeback, plugins, cloud-distill, carbon, efficiency, sla, confidence-routing, capture-poisoning, structured-output, kscore-calibration, capture-analytics, failure-modes, drift-detection, speculative-teacher, active-learning, failure-to-capture-loop, format-v1, ecosystem-loaders, vscode-extension, gha, pipeline-orchestrator, ab-testing, otel-upgrade, k8s, marketplace, runtime-placement, token-dpo, reasoning-v2, multimodal-pipeline, federated-consortium, airgap, kolm-meta, cross-lingual, regulatory, savings, regulatory-consortium-cli

### 22.8 W867–W910 Trinity, W888 RUN, W893 polish, W910 final push

`wave867-trinity-500-distill` · `wave868-homepage-receipt` · `wave869-forge-personas` · `wave870-teacher-proxy` · `wave886-surface-parity` · `wave888a-doctor-fix` · `wave888b-cloud-providers` · `wave888c-device-ssh` · `wave888c-devices` · `wave888d-deploy-pipeline` · `wave888e-fleet-ota` · `wave888f-account-ui-onboarding` · `wave888g-cli-ux` · `wave888h-e2e-personas` · `wave888i-*` (8 sub-tests: capture-export-formats, cli-startup-perf, gateway-overhead, rate-limit, receipt-export, rss-feed, ship-gate-smoke) · `wave888j-config` · `wave888L-blocker-{6,9,10,21,50}-fix` · `wave888m-corpus-coverage` · `wave888n-pair-generation` · `wave888o-compile-gate` · `wave888p-cli-nl-routing` · `wave888q-account-chat` · `wave888r-docs-search` · `wave888s-meta-demo` · `wave888t-assistant-umbrella` · `wave889-{6,7,8-12,8-34,9-10,11,12,d1}-*` · `wave890-{1..16}-*` (16-step audit) · `wave910-cli-fuzzy` · `wave910-compile-groups` · `wave910-data-ingestion` · `wave910-fleet-lifecycle` · `wave910-next-actions` · `wave910-notifications` · `wave910-org-admin` · `wave910-recipes` · `wave910-runpod` · `wave910-ship-gate` · `wave910-tui-smoke`

### 22.9 W918 — current wave (7 tests, 53/53 pass)

- `wave918-agent-trajectory.test.js` (6 tests)
- `wave918-cerebras-teacher.test.js` (5 tests)
- `wave918-cli-wave2.test.js` (5 tests)
- `wave918-openai-migration.test.js` (7 tests)
- `wave918-openrouter-importer.test.js` (4 tests)
- `wave918-orgs-rbac.test.js` (10 tests)
- `wave918-wave2-surfaces.test.js` (16 tests)

### 22.10 Wrapper integration tests (W887)

`wrapper-email.test.js` · `wrapper-integration.test.js` · `wrapper-metrics.test.js` · `wrapper-r-enrich.test.js` · `wrapper-r1-r8.test.js` · `wrapper-receipt-schema.test.js` · `wrapper-s3/s4/s5/s6/s7.test.js` · `wrapper-shard-wire.test.js` · `wrapper-shard.test.js` · `wrapper-smoke.test.js` · `wrapper-status.test.js` · `wrapper-w1-w2-w3.test.js`

### 22.11 Foundational always-on (10)

`artifact-end-to-end.test.js` · `auth-hash.test.js` · `auth.test.js` · `billing-tiers.test.js` · `cid.test.js` · `cloud-compile.test.js` · `e2e.test.js` · `load-test-scaffold.test.js` · `product-kernel-envelope.test.js` · `research-docs.test.js` · `sandbox-hardening.test.js` · `sentry-init.test.js` · `server.test.js` · `site.test.js` · `store.test.js` · `stripe.test.js`

Plus 700+ `_tmp_no_home_*` ephemeral test fixture dirs from W470 chokepoint testing.

> For the canonical flat alphabetical inventory of all 665 test files, see **§40**.

---

## 23. Scripts — 352 files in `scripts/`

### 23.1 Audit (60+)

- `audit-anchors.mjs` · `audit-buyer-journey.sh` · `audit-claim-scope.cjs` · `audit-docs-rewrites.cjs` · `audit-href.cjs` (51,251 ok / 0 broken last run) · `audit-links-prod.mjs` · `audit-links.mjs` · `audit-orphans.mjs` · `audit-page-structure.cjs` · `audit-product-journeys.mjs` · `audit-product-kernel.cjs` · `audit-rank.mjs` · `audit-render.cjs` · `audit-rendered-surface.mjs` · `audit-sota-readiness.cjs` · `audit-static-refs.cjs` (0 missing) · `audit-w890-7-defaults.cjs` (and 5 sibling w890-7 audits)
- `_w890-2-*` (7 audit/scan scripts: console-log, detect, eslint, localhost, secrets, style, todo, write-lint-reports)

### 23.2 Build (44+)

- `build-account-pages.cjs` · `build-all-examples.mjs` · `build-api-ref.cjs` · `build-assistant-corpus.cjs` · `build-browser-extension.mjs` · `build-catalog-manifest.mjs` · `build-changelog.cjs` · `build-cli-docs.cjs` · `build-codebase-file-ledger.cjs` · `build-codegraph.mjs` · `build-deb.mjs` · `build-design-cascade-ledger.cjs` · `build-distilled-model-seed.mjs` · `build-docs-manifest.cjs` · `build-docs-w374.cjs` · `build-example-{classifier,extractor,gguf,redactor}.mjs` · `build-marketplace-pages.cjs` · `build-model-class-demo.cjs` · `build-og.cjs` · `build-openapi.cjs` (merges, doesn't replace; 11→354 ops) · `build-product-graph.cjs` · `build-product-media-proof.cjs` · `build-public-fixture.mjs` · `build-readiness-closeout.cjs` · `build-registry-pack.cjs` · `build-sdk-version.js` · `build-seo-pages.cjs` · `build-sitemap.cjs` · `build-strategy-brain.mjs` · `build-tui-demo-cast.mjs` · `build-wave-registry.cjs` · `build-wrapper-docs-{capture-receipts,gateway-routing}.cjs`

### 23.3 Trinity (28+)

- `trinity-2000-v2-collect-all.mjs` · `trinity-2000-v2-export.mjs` (5-step: PEFT merge → llama.cpp F16 GGUF → quant ladder Q4_K_M/Q5_K_M/Q8_0 → Ollama Modelfile → HF model card) · `trinity-2000-v2-monitor.mjs` · `trinity-2000-v2-run.mjs` · `trinity-2000-v2-seed-gen.mjs` · `trinity-2000-v2-split-seeds.mjs`
- `trinity-500-collect-all.mjs` · `trinity-500-seed-gen.mjs` · `trinity-500-split-seeds.mjs`
- `tune-step.py` · `shard-benchmark.py` · `shard-install-verify.cjs`

### 23.4 Deploy + cloud (28+)

- `deploy-verified.ps1` · `cloud-compute-broker.mjs` · `cloud-readiness.mjs` · `cloud-runpod-train.mjs` · `cf-bootstrap.mjs` · `compile-cloud-modal.py` · `compile-cloud.cjs` · `setup-prod.sh` · `archive-prod.cjs` · `r2-bootstrap.mjs`
- `bootstrap.ps1` · `bootstrap.sh` · `install.ps1` · `install.sh` · `install-mcp.cjs`
- `dogfood-proxy.ps1`

### 23.5 QA / screenshot (70+)

- `aa-zoom.mjs` · `batch-redesign-shots.mjs` · `e2e/` (subdir) · `e2e-flow.sh` · `e2e-hub.sh` · `e2e-walk.mjs` · `find-missing-sitemap.cjs` · `finish-public-surface.mjs` · `fix-*` (10+ fixers: first-artifact, font-bleed, footer-canonical, forbidden-claims, fouc, mojibake, nav-compare, nav-research, seo-twitter-cards, theme-bootstrap) · `full-page-shot.mjs` · `mobile-audit2.cjs` · `mobile-full-audit.mjs` · `mobile-v715-verify.mjs` · `mobile-zoom.mjs` · `multi-page-shot.mjs` · `qa-*.mjs` (5: home-bg, home, research, screenshots, solutions) · `probe-*` (~20 probes: hero-full, mobile-rhythm, pill, postauth, prod-spacing, rhythm, screenshot, sota, spacing, spec-error, teacher-chat, uc-section) · `screenshot-*.mjs` (~15 variants) · `seo-audit.cjs` · `seo-sweep.cjs` · `site-screenshot.mjs` · `sitewide-audit.mjs` · `snap-*` (compile-anatomy, fold, v717) · `ultra-screenshot.cjs` · `ui-surface-audit.cjs` · `v717-*` (4 verify scripts) · `v718-*` (3 audit/snap/verify) · `v7181-qa.mjs` … `v720-qa.mjs` · `w405-*` (3 shot scripts) · `w406-page-shots.mjs` · `w850-*` (5: globals, screenshot, slate-theme-color, static-server, warm-purge)

### 23.6 Bench (10+)

- `bench-compare.mjs` · `bench-proof.mjs` · `bench-quality-calibration.mjs` · `bench-redaction-fixtures.mjs` · `bench-tps.mjs` · `cerebras-bench.mjs` (W918) · `compare-primeintellect.mjs`
- `benchmark-evidence.mjs`

### 23.7 Release / verify

- `release-verify.cjs` — 7-gate driver (lint:refs, openapi-sync, npm test, sdk-smoke, doctor, whoami, verify-claims, billing-tiers, local-surfaces)
- `x04-claim-verify.cjs` — verifies every numeric claim on site against `data/x04-claim-fixtures.json` (170 appearances / 894 HTML files)
- `verify-fixes.cjs` · `verify-header-lock.mjs` · `verify-product-surfaces.cjs` · `verify-sdk-dist.mjs`
- `quality-calibration.mjs` · `quantization-oracle.mjs` · `recalibrate-kscore.cjs`
- `simulate-*` (8+ simulators: invention-implementation-spec, invention-portfolio, product-frontier-implementation-contracts, product-frontier-lab, product-frontier-map, product-frontier-operator-kernels, product-invention-buildbook, product-math-frontier, product-research-atlas, readiness-gate-workorders)
- `sim-100.mjs`
- `smoke-*` (5: bench-cli, chat-nl, device-bind, kolm, live, models)
- `ship-gate.cjs` · `ship-gate-extensions/` (subdir)
- `prod-surface-smoke.cjs` · `local-surface-smoke.cjs`
- `run-ui-gates-local.mjs`
- `package-release-readiness.mjs`
- `runtime-adoption-packets.mjs`
- `kolm-chat.mjs` · `completions-server.mjs`
- `cloud-compute-broker.mjs`
- `compliance-certification-packet.mjs` · `format-governance-packet.mjs`

### 23.8 Scrubbers + fixers

- `strip-dead-links.cjs` · `strip-duplicate-footers.cjs` · `strip-inline-pitch-black.cjs` · `strip-legacy-nav-blocks.cjs` · `strip-legacy-scripts.cjs` · `strip-legacy-stylesheets.cjs`
- `monochrome-scrub.cjs` · `ink-linen-scrub.cjs` · `warm-paper-injection.cjs` (legacy W836; superseded by W850)
- `nav-unify.cjs` · `rewrite-nav-ks.cjs`
- `prebake-nav-toggle.mjs` · `prebake-theme-toggle.mjs`
- `migrate-pages-to-ks.cjs` · `patch-docs-shell.cjs`
- `wave159-purge-honest.mjs` · `wave159-purge-honest-pass2.mjs` · `w903-honest-word-scrub.cjs` (enforces no-honesty-word memory rule)
- `w850-warm-purge.cjs` (kills warm-paper artifacts)
- `w889-*` (W889 supplement scripts) · `w890-{1..16}-*` (the 16-step audit) · `w893-*` (W893 polish) · `w902-*` (homepage reorder) · `w903-*` (honest-word + brand-anchor strip) · `w917-title-and-org-scrub.cjs` (current org rename)
- `w850-redline-globals.cjs` · `w850-static-server.cjs`

### 23.9 Generate (fal / images)

- `fal-hero-gen.cjs` · `fal_atmosphere.py` · `fal_brand.py` · `fal_generate_v6.py` · `fal_legendary.py` · `fal_phone_redo.py`
- `composite_og.py` · `encode_v6_webp.py` · `optimize_images.py` · `swap_brand_mark.py` · `swap_logo_mark.py` · `swap_og_image.py` · `swap_to_webp.py`
- `add_article_plates.py`
- `rebuild_brand_og.py`
- `add-twitter-card.cjs` · `inject-cookbook-jsonld.cjs` · `inject-nav-js.cjs` · `inject-nav.cjs` · `seed-marquee-artifacts.cjs`

### 23.10 Generation + recipes + assistant

- `_build-dotkolm-fixtures.cjs` · `dotkolm-validate.cjs`
- `compile-assistant.cjs` · `check-assistant-hallucinations.cjs` · `generate-assistant-pairs.mjs`
- `corpus/` (subdir)
- `wave887-docs-generator.cjs` · `wave887-wrapper-prod-benchmark.cjs` · `wave888-wrapper-tax-decomposed.cjs` · `wave895-coverage-sweep.cjs`
- `write-extra-cli-docs.cjs` · `write-missing-cli-docs.cjs` · `write-w869-cli-docs.cjs` · `write-w869b-cli-stubs.cjs`
- `wave159-add-training-nav.mjs`

### 23.11 Misc + experimental

- `_fixtures-w422-noop-worker.cjs` · `_spawn-helpers.js`
- `__pycache__/` (Python cache; gitignored)
- `aa-zoom.mjs` · `apply-surface-polish.mjs`
- `brand-bars-swap.cjs` · `brand-disambig-sweep.cjs`
- `brew` (homebrew helper)
- `clean-strip-artifacts.cjs`
- `demo-animation.html` · `demo.js`
- `distill-strategy.mjs`
- `e2e/` (subdir)
- `e2e-walk.mjs`
- `llama-cpp-dll-shim.py`
- `load-test-scenarios/` · `load-test.cjs`
- `local-static-server.mjs`
- `notion-sync.mjs`
- `package-release-readiness.mjs`
- `probe-teacher-chat.{cjs,mjs}`
- `publish-trinity.cjs`
- `quick-v716-probe.mjs`
- `r2-bootstrap.mjs`
- `record-demo-90s.mjs` · `record-demo-w905.mjs`
- `registry-pack-tmp/`
- `rename-kolmogorov.ps1`
- `scaffolds/`
- `screenshot-w905-sweep.mjs`
- `scrub-waves-json.py` · `scrub-waves-v2.py`
- `sdk-linux-build.sh`
- `seed.js`
- `sensitive-data-readiness.sh` · `check-sitemap.sh`
- `shard-benchmark.py`
- `side-by-side.mjs`
- `sim-100.mjs`
- `stripe-provision.mjs`
- `surface-orphans.mjs`
- `sweep-public-copy.mjs`
- `test-10-apps.mjs` · `test-complexity-ramp.mjs` · `test-compute-e2e.mjs`
- `trim_homepage.py`
- `video/`
- `w259-arrow-sweep.cjs` · `w259-dead-slug-sweep.cjs` · `w280-title-suffix-fix.cjs`
- `winget/`

> For the canonical flat alphabetical inventory of all 342 script files (not counting subdirectories), see **§41**.

---

## 24. Infrastructure — Vercel, Railway, GHA, Docker

### 24.1 Vercel — `vercel.json` (74,174 bytes)

- **697 rewrites** — `/agents` → `/agents.html`, `/cerebras` → `/cerebras.html`, `/account/org` → `/account/org.html`, includes `/v1/*` → Express runtime fallback.
- **44 redirects** — fire BEFORE rewrites (W918 trap: legacy `/agents → /product` was shadowing the new page until removed)
- **1 header rule** — global security headers (CSP, X-Frame-Options, Referrer-Policy)
- Build command: `npm run build`
- Output dir: `public/`
- Functions: `api/` for Vercel-native edge routes (sparse use; Express on Railway is canonical)
- Origin git: `kolm-ai/kolm-private` (auto-deploy on `main` push)

### 24.2 Railway — `railway.toml`

- `Procfile`-style: `web: node server.js`
- Service: Express runtime
- Env vars from Railway dashboard (KOLM_DATA_DIR, ANTHROPIC_API_KEY, etc.)
- **Trap (W547):** every deploy wipes DB unless KOLM_DATA_DIR volume is mounted
- **Current deploy path:** `railway up` from dev box; auto-deploy from GitHub source was broken at W547

### 24.3 GitHub Actions — `.github/workflows/` (11 yml files)

- `kolm-ci-pipeline.yml` — top-level CI orchestration
- `kolm-compile-on-push.yml` — compile validation on push
- `kolm-distill.yml` — distill smoke
- `kolm-template.yml` — reusable workflow template
- `kolm.yml` — bare kolm CLI smoke
- `kolmbench-submission.yml` — benchmark submission gate
- `lint.yml` — linting
- `sbom.yml` — SBOM generation
- `sdk-c-rust.yml` — C + Rust SDK jobs (ubuntu-latest; libcurl link, usage-exit-64, bogus-host non-zero exit; cargo check + test + release example)
- `smoke.yml` — smoke tests
- `test-suite.yml` — full Jest suite

### 24.4 Docker

- `Dockerfile` — main server image
- `Dockerfile.gateway` — gateway-only image
- `docker-compose.gateway.yml` — local gateway stack
- `workers/compile-server/Dockerfile` — compile-server worker image
- `workers/compile-server/docker-compose.yml` — compile-server local compose

### 24.5 Env vars (`.env.example`)

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude teacher |
| `OPENAI_API_KEY` | GPT teacher |
| `CEREBRAS_API_KEY` | Cerebras teacher (W918) |
| `KOLM_DATA_DIR` | persistence root (default `~/.kolm`) |
| `KOLM_STORE_DRIVER` | `file` / `sqlite` / `postgres` / `vercel-kv` / `vercel-postgres` |
| `KOLM_TRAINER_BRIDGE_URL` | remote trainer for `kolm distill --remote` |
| `KOLM_DISTILL_TEACHER` | default teacher pin |
| `STRIPE_SECRET_KEY` | billing |
| `STRIPE_WEBHOOK_SECRET` | billing webhook verification |
| `RESEND_API_KEY` | transactional email |
| `PORT` | server port (default `7777`) |
| `SENTRY_DSN` | error reporting (optional) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTEL exporter |
| `RUNPOD_API_KEY` | RunPod integration |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal integration |

### 24.6 Other config

- `package.json` — `kolm-stack@0.2.6`, scripts include `start`, `dev`, `seed`, `demo`, `build:sdk`, `assets:fal`, `build:product-graph`, `build:readiness-closeout`, `build:file-ledger`, `build:design-cascade-ledger`, `build:wave-registry`, `build:catalog-manifest`, `build:product-media-proof`, `build:control-files`, `verify:file-ledger`, `verify:design-cascade-ledger`, `verify:wave-registry`, `verify:catalog-manifest`, `verify:product-media-proof`, `verify:control-files`, `lint:refs`, `verify:kernel`, `verify:surfaces`, `local:surfaces`, `local:surfaces:deep`, `release:verify`
- `package-lock.json` — pinned versions
- `gateway.toml` — gateway service config
- 15 prod deps + 4 dev deps (intentionally minimal)

### 24.7 Spec fixtures (9 at root)

- `claims-redactor.spec.json` · `classifier.spec.json` · `court-ext.spec.json` · `demo-log-triage.spec.json` · `email-prio.spec.json` · `phi-redactor.spec.json` · `wave58-test.spec.json` · `zh-greeter.spec.json`
- `sim-100.json` / `sim-100-v2.json` / `sim-100-v3.json` — sim fixtures
- `release-verify.full.json` / `release-verify-2026-05-26.json` — release verify outputs

---

## 25. Receipts, verify, attestation

### 25.1 Spec

- `docs/receipt-v0.1.json` — JSON Schema for `kolm-receipt-v1`
- Public render: `public/docs/spec/dot-kolm-v1.0.html`
- Receipt schema fields: `cid`, `version` (`kolm-receipt-v1`), `model`, `input_digest`, `output_digest`, `claimed_at`, `signer` (Ed25519 pub key), `sig` (Ed25519 over canonical JSON), `prev` (HMAC-SHA256 of previous receipt), `chain_root`

### 25.2 Issue path

`src/receipt.js` → `src/ed25519.js` (sign) → `src/receipt-chain.js` (HMAC chain) → `src/cid.js` (multihash)

### 25.3 Verify path

`GET /v1/verify/:cid` → recompute sig + chain → `{valid:true, signer, chain_ok}`

### 25.4 3 verifier surfaces

1. **Browser drop-in** — `public/scripts/kolm-verify.js`
2. **Standalone CLI** — `kolm verify <cid>`
3. **Hosted registry** — `/v1/verify/:cid`

### 25.5 Attestation library

`packages/attestation/` — Sigstore + Ed25519 attestation envelope, exposed as standalone npm package.

### 25.6 Test fixture

`rcpt_01KYC1ZVTGDCW3FX06JQSC` — W887 Wave-M proven end-to-end gateway proxy receipt.

---

## 26. Distill pipeline — Trinity 2000 v2

### 26.1 Pipeline phases

1. **Seed-gen** — `scripts/trinity-2000-v2-seed-gen.mjs` produces ~2000 seed prompts across 8 buckets
2. **Split** — `scripts/trinity-2000-v2-split-seeds.mjs` allocates per-teacher
3. **Collect** — `scripts/trinity-2000-v2-collect-all.mjs` calls teacher bridge fan-out (Anthropic 800, OpenAI 600, DeepSeek 600)
4. **Merge** — happens inside `collect-all.mjs:82-104` (writes `RUN/merged/training-pairs.jsonl` on exit; no separate merge phase)
5. **Train** — `scripts/trinity-2000-v2-run.mjs --phase=train` calls Python `scripts/tune-step.py` via PEFT QLoRA on Qwen2.5-7B-Instruct base
6. **Export** — `scripts/trinity-2000-v2-export.mjs` — 5 steps: PEFT `merge_and_unload()` → llama.cpp F16 GGUF → quantize ladder (Q4_K_M / Q5_K_M / Q8_0) → Ollama Modelfile (SYSTEM prompt + temperature 0.2 + top_p 0.9) → HF model card README.md ("Caveats" section, NOT "Honesty")

### 26.2 Trinity 2000 v2 current state (2026-05-28)

- Path: `~/.kolm/distill-runs/trinity-2000-v2-2026-05-28/`
- Claude 800 pairs: complete
- GPT-4o 600 pairs: complete
- DeepSeek 350/600 pairs (in progress; ~1.7 pairs/min via local 32B teacher)
- 8 buckets: refunds 250, shipping 250, warranty 200, billing 250, technical 300, account 200, loyalty 200, escalation 350
- LoRA: r=32, alpha=64, dropout=0.05
- Train: epochs=2, batch_size=2, grad_accum=8, effective_batch=16, lr=1.5e-4

### 26.3 Quantize ladder — proven on RTX 5090

bitsandbytes 0.49.2 NF4+double precision:

| Model | Original | INT4 | Time | Verified throughput |
|---|---:|---:|---:|---|
| Qwen2.5-0.5B | 0.93 GB | 0.44 GB | 11.6s | yes |
| Qwen2.5-3B | 5.8 GB | 1.9 GB | 13.9s | yes |
| Qwen2.5-7B | 14.2 GB | 5.2 GB | 29.2s | 24.5 tok/s |
| DeepSeek-R1-32B | 61.0 GB | 17.9 GB | 125.3s | 11.5 tok/s |

### 26.4 Trinity-500 — proven prior run

410 council pairs, LoRA 79.18s, GGUF Q4_K_M/Q5_K_M/Q8_0/IQ4_XS, HF model card, passport, benchmark n=57: trinity-500 96.5% asks-1Q + 100% judge-clarify + 100% judge-on-policy at 1.24s/210 chars — beats claude-haiku-4-5 + base-qwen, ties gpt-4o-mini at half the chars.

### 26.5 Lock-in test

Released model must produce: GGUF file at canonical name, Ollama Modelfile with SYSTEM prompt at temperature 0.2 / top_p 0.9, HF model card with "Caveats" section, passport JSON listing teachers + bucket weights + LoRA rank.

---

## 27. Teacher integrations

### 27.1 Adapter modules

- `src/teachers/cerebras.js` — Cerebras Cloud (Llama-3.3-70b, llama3.1-8b, qwen-3-32b) — W918
- `src/teacher-bridge.mjs` — main router; selects per `KOLM_DISTILL_TEACHER` or per-call override
- `src/providers/deepseek-native.js` — DeepSeek-R1-Distill-Qwen-32B local (served by stdlib `http.server` on `:8765`)
- `src/providers/fireworks.js` — Fireworks
- `src/providers/google-native.js` — Gemini direct
- `src/providers/groq.js` — Groq
- `src/providers/together-hosted.js` — Together hosted models
- `src/providers/local-kolm.js` — local kolm-served models
- `src/providers/local-ollama.js` — Ollama on localhost
- `src/providers/local-vllm.js` — local vLLM

### 27.2 Council distill (Trinity)

`src/teacher-council.js` orchestrates multi-teacher voting; judge selects best response per seed. Council weights configurable per recipe.

### 27.3 Speculative teacher

`src/speculative-teacher.js` + `src/speculative-decoding.js` — draft model proposes, target model verifies; reduces teacher cost ~3x on routine queries.

---

## 28. Gateway log importers (5) — W918

5 importers in `src/importers/` — each exposes `parse()` + `parseFile()` that auto-detects envelope shape (JSON array / JSONL / `{data:[...]}`):

- `openai-finetune.js` — `{messages:[{role,content}]}`
- `portkey.js` — Portkey trace envelope
- `helicone.js` — Helicone request log
- `litellm.js` — LiteLLM proxy log
- `openrouter.js` — OpenRouter request log

CLI: `kolm import --from <gateway> ./logs.jsonl` writes a training corpus under `~/.kolm/imports/`.

HTTP: `POST /v1/import/<gateway>` accepts a multipart upload or raw JSONL.

---

## 29. Orgs + RBAC (W918 Wave 2)

### 29.1 `src/orgs.js`

- `createOrg(ownerUserId, name)` → `{orgId, name, ownerUserId}`
- `addMember(orgId, userId, role)` — auto-bills next seat on Pro+
- `removeMember(orgId, userId)`
- `setRole(orgId, userId, role)`
- `transferOwnership(orgId, fromUserId, toUserId)` — requires 2FA confirmation
- `inviteMember(orgId, email, role)` → `inviteToken` (24h TTL)
- `acceptInvite(inviteToken, userId)`
- `auditEvent(orgId, actorUserId, action, target)`

### 29.2 `src/rbac.js`

- 4 roles: `owner` · `admin` · `member` · `billing`
- 12-row capability matrix: `can(role, action)` → bool
- `requireRole(role, ['admin','owner'])` middleware factory

### 29.3 CLI

`kolm org list / create / members / invite / role / remove / transfer-owner` (7 subverbs).

### 29.4 UI

`/account/org`, `/account/members`, `/docs/rbac` (all W918 Wave 2 landings).

---

## 30. Storage drivers + persistence

### 30.1 Driver dispatch — `src/store.js`

Selects backend by `KOLM_STORE_DRIVER` env: `file` (default; flat JSON files under `KOLM_DATA_DIR`) · `sqlite` · `postgres` · `vercel-kv` (Vercel KV) · `vercel-postgres` (Vercel Postgres).

### 30.2 Driver files

- `src/store-drivers/vercel-kv.js`
- `src/store-drivers/vercel-postgres.js`
- `src/storage/postgres-store.js`
- `src/object-storage.js` — abstract object store
- `src/r2.js` — Cloudflare R2 client

### 30.3 Object storage

R2 / S3 for large artifacts (GGUF files, model weights, training corpora).

### 30.4 Index

`services/index/qmd.js` — FAISS HNSW index, persisted to `~/.kolm/index/`.

### 30.5 Persistence paths under `KOLM_DATA_DIR` (`~/.kolm/`)

- `tenants/<tenant_id>/state.json`
- `tenants/<tenant_id>/captures/`
- `tenants/<tenant_id>/distill-runs/`
- `tenants/<tenant_id>/receipts/`
- `index/` — FAISS index files
- `imports/` — gateway-imported corpora
- `models/` — pulled model files (GGUF, safetensors)

### 30.6 Migrations

- `src/migrations/2026-05-19-capture-to-events.js` — capture log → event store rewrite

---

## 31. Plan files at repo root

Active wave plans (8 at repo root):

| File | Wave | Purpose |
|---|---|---|
| `KOLM_W918_OPENAI_MIGRATION_LAND_GRAB_PLAN.md` | W918 | active OpenAI ft sunset + Cerebras integration |
| `KOLM_W910_FINAL_PUSH_PLAN.md` | W910 | 8 parallel tracks ~120 atomic tasks |
| `KOLM_W893_FINAL_POLISH_PLAN.md` | W893 | V1 ship polish |
| `KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md` | W888 | 52-check ship gate + RUN surface DoD |
| `KOLM_W866_FORGE_DISTILL_FRONTIER_PLAN.md` | W866 | quant ladder + frontier match |
| `KOLM_W851_CLI_TUI_100X_PLAN.md` | W851 | NL routing + per-function copy |
| `KOLM_W707_SYSTEM_UPGRADE_PLAN.md` | W707 | 114-item external review |
| `KOLM_VALUATION_PLAN_2026_05_23.md` | W656 | W656-W680 front-end + B1-B12 back-end |

Plan files are authoritative work logs. Always read on session resume.

---

## 32. Standing operating rules

Repo-wide invariants encoded in tests, scripts, and standing memory:

1. **Push frontend first** — `git push public main` BEFORE `git push origin main`. Origin auto-deploys Vercel.
2. **No commit without explicit ask.** Author intent is captured in the user's literal words.
3. **No `--force` push** on main/master without explicit ask.
4. **No skip hooks** (`--no-verify`, `--no-gpg-sign`).
5. **Never stage:** `.env*`, `*.pem`, `*.key`, `secrets/`, `docs/research/`, `data/artifacts/`, `data/assistant-corpus/`, `data/trinity-*`, `data/deploy-trinity-*`, `data/email-outbox.jsonl`, `data/deployments.jsonl`, `.tmp-*`, `audit-shots/*`, `tmp-*`, `.shots-*`, `release-verify-*.err`.
6. **Word "honesty" banned** anywhere in code, docs, marketing, blog. Use "Caveats" / "Constraints" / "Limitations". Forward-looking; no retroactive scrub of historical commits.
7. **No emojis as icons** — SVG icons only (Heroicons / Lucide).
8. **Atomic plan files** at repo root before any multi-wave fan-out.
9. **Production polish gate (W850 cool-slate):** alt text, focus rings, 4.5:1 contrast, ≥44×44 touch targets, no TODO comments, lock-in test per module, copy-paste runnable docs.
10. **OpenAPI parity:** every router-declared route appears in `openapi.json` (gate #2 of release-verify).
11. **Receipt-or-nothing:** every inference path returns a verifiable receipt CID. No silent inference.
12. **Honest envelope:** SDKs return raw status + body. No `isSuccess()` sugar hiding 4xx. Errors include `{code, hint}`.
13. **Vercel redirects fire BEFORE rewrites** — when adding a `/path` rewrite, grep the `redirects` array for the source path first.
14. **W918 disjoint file ownership** — when fanning out parallel agents, each owns a disjoint file set so writes don't collide.
15. **Trinity training requires merged corpus at `RUN/merged/training-pairs.jsonl`** before `--phase=train` — merge happens inside `collect-all.mjs:82-104` on exit, no separate merge phase.
16. **`kolm update` refuses to run from repo clone** (W484; silent global-install hazard).
17. **`--no-color` / `--no-unicode` / `--plain` stripped from argv pre-dispatch** (W849).
18. **Stage by name, not by `-A` or `.`** — explicit file paths only.
19. **W487 lock-in only pins TUI table row presence**, not endpoint existence.
20. **`docs/research/*` never staged** — engineering notes, not public docs.

---

## 33. Glossary + appendices

### Glossary

| Term | Meaning |
|---|---|
| **Receipt** | Ed25519-signed JSON envelope for one inference; chained via HMAC-SHA256 |
| **Passport** | Per-model JSON describing teachers, recipe, training params, eval scores |
| **Bucket** | Topical partition of the training corpus (refunds / billing / etc.) |
| **Council** | Multi-teacher distillation where teachers vote + judge selects best |
| **Wave** | Atomic ship unit; each wave has a plan file + lock-in test + sw.js version bump |
| **Cool-slate** | W850 binding palette (anti-warm-paper); `#0b0b0d` → `#1a1a1d` neutral stack |
| **Honest envelope** | SDK return shape that exposes raw status + body, no error-hiding sugar |
| **Lock-in test** | Per-module Jest test pinning the surface so unintended regressions break CI |
| **dot-kolm spec** | `dot-kolm-v1.0` — file format for kolm-runnable bundles |
| **kolm-receipt-v1** | Current receipt schema version (`docs/receipt-v0.1.json`) |
| **Trinity** | Multi-teacher council distill program; current run = Trinity 2000 v2 |
| **K-score** | Kolm-internal model quality calibration |
| **K-bench** | KolmBench benchmark (`kolmbench` CLI verb) |
| **ITKv** | Iterative training key-value cache |
| **TSAC** | Timestamp-anchored capture |
| **MoE** | Mixture of Experts |
| **PHI** | Protected Health Information (HIPAA scope) |
| **PII** | Personally Identifiable Information |
| **DPO** | Direct Preference Optimization |
| **SFT** | Supervised Fine-Tuning |
| **GGUF** | llama.cpp model format |
| **AWQ / GPTQ / EXL2 / NVFP4 / HQQ / FP8** | Quantization formats |

### Appendix A — Receipt JSON example

```json
{
  "version": "kolm-receipt-v1",
  "cid": "rcpt_01KYC1ZVTGDCW3FX06JQSC",
  "model": "trinity-500-qwen2.5-7b-q4_k_m",
  "input_digest": "sha256:9f...",
  "output_digest": "sha256:3a...",
  "claimed_at": "2026-05-28T19:31:00Z",
  "signer": "ed25519:MCowBQYDK2VwAyEA...",
  "sig": "ed25519:base64sig...",
  "prev": "hmac-sha256:7c...",
  "chain_root": "sha256:11..."
}
```

### Appendix B — Distill recipe example

```yaml
name: trinity-2000-v2-2026-05-28
student_base: Qwen/Qwen2.5-7B-Instruct
teachers:
  - id: anthropic:claude-sonnet-4-6
    weight: 0.40
    target_pairs: 800
  - id: openai:gpt-4o
    weight: 0.30
    target_pairs: 600
  - id: kolm:deepseek-r1-distill-qwen-32b
    weight: 0.30
    target_pairs: 600
buckets:
  refunds: 250
  shipping: 250
  warranty: 200
  billing: 250
  technical: 300
  account: 200
  loyalty: 200
  escalation: 350
lora:
  r: 32
  alpha: 64
  dropout: 0.05
train:
  epochs: 2
  batch_size: 2
  grad_accum: 8
  effective_batch: 16
  lr: 1.5e-4
```

### Appendix C — `package.json` scripts (sampled)

- `start` — `node server.js`
- `dev` — dev server with watch
- `seed` — seed local DB
- `demo` — start demo mode
- `build:sdk` — build SDKs
- `assets:fal` — regenerate fal-generated assets
- `build:product-graph` — emit product graph JSON
- `build:readiness-closeout` — closeout JSON
- `build:file-ledger` / `build:design-cascade-ledger` / `build:wave-registry` / `build:catalog-manifest` / `build:product-media-proof` / `build:control-files` — codebase ledgers
- `verify:file-ledger` / `verify:design-cascade-ledger` / `verify:wave-registry` / `verify:catalog-manifest` / `verify:product-media-proof` / `verify:control-files` — ledger verifiers
- `lint:refs` — static reference graph (gate #1)
- `verify:kernel` — kernel verify
- `verify:surfaces` — surface verify
- `local:surfaces` / `local:surfaces:deep` — 7-surface probe (W545 gate)
- `release:verify` — full 7-gate driver

### Appendix D — Recent waves trail

| Wave | Date | Headline |
|---|---|---|
| W918 Wave 2 | 2026-05-28 | OpenAI migration + orgs/RBAC + gateway importers (53/53 tests) |
| W918 Wave 1 | 2026-05-28 | Cerebras teacher + 16-agent parallel fan-out (12/12 tests) |
| W917 | 2026-05-27 | og:title brand suffix scrub + kolm-ai/kolm rename preempt |
| W910 | 2026-05-28 | 8-track parallel sprint (~120 atomic tasks) |
| W897 | 2026-05-27 | `/demo-live` cinematic + `/verify` hub + version-suffix regex fix |
| W893 | 2026-05-27 | V1 ship polish (8 parts) |
| W888 | 2026-05-26 | RUN surface + 52-check ship gate |
| W887 | 2026-05-26 | Wrapper W-K/W-L/W-M; gateway 10/10 receipts |
| W869 | 2026-05-25 | Trinity-500 council: 96.5% asks-1Q at 1.24s/210 chars |
| W866 | 2026-05-25 | FORGE/DISTILL frontier quant ladder |
| W850 | 2026-05-25 | Cool-slate binding palette (28-item redline) |
| W849 | 2026-05-25 | Warm-dark dark mode + Studio CLI/TUI |
| W836 | 2026-05-24 | Warm Paper redesign (DEPRECATED by W850) |
| W707 | 2026-05-24 | 114-item external review wave plan |
| W597 | 2026-05-22 | Vercel-only deploy + product-kernel + product-rail |
| W547 | 2026-05-21 | Backend SOTA + 49/49 deploy via `railway up` |

### Appendix E — Repo file tree summary

```
kolmogorov-stack/  (~75 MB)
├── 1605 files under public/
├── 486 files under src/
├── 665 test files under tests/
├── 352 script files under scripts/
├── 33 worker files under workers/
├── 5 service files under services/
├── 40+ SDK files under sdk/
├── 16 packages under packages/
├── 11 workflows under .github/workflows/
├── 5 Dockerfiles (root + workers + packages)
├── 1 vercel.json (697 rewrites + 44 redirects)
├── 1 server.js (696 lines)
├── 1 cli/kolm.js (53,863 lines)
└── 8 plan files at repo root
```

---

## 34. Environment variable reference (`.env.example`)

Every variable read at process boot. Empty values in `.env.example` mean "operator must set in production"; non-empty values mean the example file ships a working default.

### 34.1 Core runtime

| Name | Default | Required in prod | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | _(empty)_ | When teachers route to Anthropic | Forwarded to `@anthropic-ai/sdk` and `/v1/capture/anthropic` upstream |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` | No | Default Anthropic teacher model |
| `PORT` | `8787` | No | Express HTTP listener |
| `DEFAULT_TENANT` | `demo` | No | Falls back when API key resolves to no tenant |

### 34.2 Storage + persistence

| Name | Default | Required in prod | Purpose |
|---|---|---|---|
| `KOLM_DATA_DIR` | _(empty)_ | **Yes** | Mounted writable volume for store + capture index |
| `KOLM_ARTIFACT_DIR` | _(empty)_ | **Yes** | Where compiled `.kolm` bundles land |
| `KOLM_RECALL_ROOT` | _(empty)_ | No | Capture/recall surface root |
| `KOLM_STORE_DRIVER` | `sqlite` | **Yes** | `sqlite` for deploys; `json` only with `KOLM_ALLOW_JSON_STORE=true` |
| `KOLM_DB_PATH` | _(empty)_ | Implicit | When unset, derives from `KOLM_DATA_DIR/kolm.db` |
| `KOLM_ALLOW_JSON_STORE` | `false` | No | Must be `true` to fall back from sqlite to JSON store |

### 34.3 Throttle + entitlement

| Name | Default | Purpose |
|---|---|---|
| `INVITE_ONLY` | `false` | When `true`, `/v1/signup` returns 403 unless `invite_code` matches |
| `RATE_LIMIT_PER_SEC` | `20` | Token bucket refill rate per tenant |
| `RATE_LIMIT_BURST` | `60` | Token bucket max burst |

### 34.4 Admin + receipts

| Name | Default | Required in prod | Purpose |
|---|---|---|---|
| `ADMIN_KEY` | _(empty)_ | **Yes** (admin routes 503 without) | Format `ks_admin_*`. Generate: `node -e "console.log('ks_admin_' + require('crypto').randomBytes(24).toString('hex'))"` |
| `RECIPE_RECEIPT_SECRET` | _(empty)_ | **Yes** | ≥32 chars. Receipt + `.kolm` HMAC-SHA256. Rotating invalidates every receipt + signature ever minted. Format `ks_receipt_*` |

### 34.5 Stripe billing (8 keys)

Every payment link must be a Stripe Payment Link at the matching monthly price; plan is identified by `amount_total` on the Checkout Session. Without these set, `/v1/signup` with a paid plan returns 503 `billing_not_configured`.

| Name | Plan | Monthly price | Required for that tier |
|---|---|---|---|
| `STRIPE_PAYMENT_LINK_INDIE` | Indie | $29 | Self-serve |
| `STRIPE_PAYMENT_LINK_PRO` | Pro | $49 | Self-serve |
| `STRIPE_PAYMENT_LINK_TEAM` | Team | $99 | Self-serve |
| `STRIPE_PAYMENT_LINK_TEAMS` | Teams | $499 | Self-serve |
| `STRIPE_PAYMENT_LINK_BUSINESS` | Business | $499 | Self-serve (W918 Wave 4 stripe-fix) |
| `STRIPE_PAYMENT_LINK_ENT` | Enterprise | $1,499 | Sales-led signup |
| `STRIPE_PAYMENT_LINK_STARTER` | (legacy starter) | $9 | Resolves to Pro via `AMOUNT_TO_PLAN[900]` |
| `STRIPE_WEBHOOK_SECRET` | _(whsec_…)_ | — | `/v1/stripe/webhook` signature verification. Provision at Dashboard → Developers → Webhooks; subscribe to `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` |
| `STRIPE_SECRET_KEY` | _(sk_live_…)_ | — | Only for `/v1/account/delete` auto-cancel. Without it, deletion still works but user must cancel via bank or Stripe |

### 34.6 OAuth (Google + GitHub)

Optional. `/signup` page hides each button when provider is not configured. Set both `_CLIENT_ID` and `_CLIENT_SECRET` for a provider to enable it.

| Name | Source |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` | `console.cloud.google.com/apis/credentials` → Web application → Authorized redirect URI `https://kolm.ai/v1/oauth/google/callback` |
| `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` | `github.com/settings/developers` → New OAuth App → callback `https://kolm.ai/v1/oauth/github/callback` |
| `OAUTH_REDIRECT_BASE` | Default `https://kolm.ai`. Override for staging or self-host |

### 34.7 Email (transactional)

Optional but recommended for paid customers — Stripe webhook events trigger welcome / activation / failed-payment emails. Without these, `sendMail()` returns `{ skipped: true }` silently.

| Name | Default | Purpose |
|---|---|---|
| `RESEND_API_KEY` | _(empty)_ | Format `re_*`. Mint at `resend.com/api-keys` |
| `EMAIL_FROM` | `kolm <hello@kolm.ai>` | RFC 5322 From header |
| `EMAIL_REPLY_TO` | _(empty)_ | Optional reply-to override |

### 34.8 Cerebras teacher (W918 P1.19)

| Name | Default | Purpose |
|---|---|---|
| `CEREBRAS_API_KEY` | _(empty)_ | Routes `kolm distill --teacher cerebras:<model>` to Cerebras Cloud Inference. Models: `llama-3.3-70b`, `llama3.1-8b`, `qwen-3-32b`. Mint at `cloud.cerebras.ai/platform/credentials` |

### 34.9 Capture proxies (rent-vs-buy)

The customer's own API key is forwarded in the Authorization header — kolm never persists it.

| Name | Default | Purpose |
|---|---|---|
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Where `/v1/capture/anthropic` forwards |
| `OPENAI_UPSTREAM_URL` | `https://api.openai.com` | Where `/v1/capture/openai` forwards |

### 34.10 Trainer bridge (auto-distill)

When `/v1/specialists/auto-distill` fires at per-namespace pair threshold, the request is forwarded to the trainer bridge that runs LoRA fit and returns a signed `.kolm`. Without these set, the route returns 503 `trainer_not_configured`.

| Name | Default | Purpose |
|---|---|---|
| `KOLM_TRAINER_BRIDGE_URL` | _(empty)_ | Trainer bridge HTTPS endpoint |
| `KOLM_TRAINER_BRIDGE_TOKEN` | _(empty)_ | Bearer token sent to trainer bridge |
| `REM_LABS_BRIDGE_URL` / `REM_LABS_BRIDGE_TOKEN` | _(empty)_ | Legacy fallback names — still read by `src/teacher-bridge.mjs` for back-compat |

### 34.11 Public base + verifier + region

| Name | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE` | `https://kolm.ai` | Canonical origin embedded in receipts, OAuth redirects, signed-artifact URLs, sitemap absolute hrefs |
| `KOLM_JUDGE_ID` | `kolm-pattern-synth-1` | Stamped into receipt chains as judge fingerprint. Override for custom verifiers (e.g. `kolm-claude-judge`, `kolm-byo-grader`) |
| `REGION` | `local` (falls back to `RAILWAY_REGION`) | Free-form label embedded in `/health` and receipts |

---

## 35. `package.json` scripts — complete reference

`kolm-stack@0.2.6`. Apache-2.0. ESM. Node ≥20.0.0. Bin: `kolm` → `cli/kolm.js`.

### 35.1 Boot + dev

| Script | Command | Purpose |
|---|---|---|
| `start` | `node scripts/build-sdk-version.js && node server.js` | Production boot — first rebuilds SDK version file, then starts Express |
| `dev` | `node scripts/build-sdk-version.js && node --watch server.js` | Local dev with watch mode |
| `seed` | `node scripts/seed.js` | Seed local DB |
| `demo` | `node scripts/demo.js` | Start demo mode |

### 35.2 SDK build

| Script | Purpose |
|---|---|
| `build:sdk` | Builds versioned SDK shim consumed by all 6 SDK languages |

### 35.3 Asset generation

| Script | Purpose |
|---|---|
| `assets:fal` | Regenerates fal-generated aurora hero imagery |

### 35.4 Codebase ledger builders (5 + a roll-up)

| Script | Purpose |
|---|---|
| `build:product-graph` | `build-product-graph.cjs` — emits product graph JSON |
| `build:readiness-closeout` | `build-readiness-closeout.cjs` — closeout JSON |
| `build:file-ledger` | `build-codebase-file-ledger.cjs` — file inventory |
| `build:design-cascade-ledger` | `build-design-cascade-ledger.cjs` — CSS/design token cascade |
| `build:wave-registry` | `build-wave-registry.cjs` — wave history index |
| `build:catalog-manifest` | `build-catalog-manifest.mjs` — distribution catalog |
| `build:product-media-proof` | `build-product-media-proof.cjs` — media + screenshot proofs |
| `build:control-files` | Runs all 5 ledger builders sequentially |

### 35.5 Ledger verifiers (mirror of 35.4 with `--check`)

| Script | Purpose |
|---|---|
| `verify:file-ledger` / `verify:design-cascade-ledger` / `verify:wave-registry` / `verify:catalog-manifest` / `verify:product-media-proof` | `--check` mode of the corresponding builder |
| `verify:control-files` | Runs all 5 verifiers sequentially — gate that ledgers are not stale |

### 35.6 Static link + reference audits

| Script | Purpose |
|---|---|
| `lint:refs` | `audit-static-refs.cjs && audit-href.cjs --strict && verify-product-surfaces.cjs` (gate #1 of release-verify) |
| `verify:kernel` | `audit-product-kernel.cjs` |
| `verify:surfaces` | `verify-product-surfaces.cjs` |
| `local:surfaces` | `local-surface-smoke.cjs` |
| `local:surfaces:deep` | `local-surface-smoke.cjs --deep` |
| `prod:surfaces` | `prod-surface-smoke.cjs` |
| `prod:surfaces:deep` | `prod-surface-smoke.cjs --deep --require-auth` |

### 35.7 Per-domain verify (15)

Each `verify:*` runs a simulator/auditor + its lock-in test(s).

| Script | Gate |
|---|---|
| `verify:compute` | `wave551-compute-training-contract` |
| `verify:sota` | `audit-sota-readiness.cjs && build-readiness-closeout.cjs --check` |
| `verify:claims-scope` | `audit-claim-scope.cjs` |
| `verify:brand` | `wave431-source-mojibake-clean` + `wave594-kolm-brand-contract` |
| `verify:kscore-calibration` | `wave145-kscore-t-axis` + `wave506-kscore-leaderboard-submission-honesty` + `wave587-kscore-calibration-contract` |
| `verify:platform` | `cloud-readiness.mjs --summary --json` |
| `verify:codegraph` | `build-codegraph.mjs --check --json` |
| `verify:journeys` | `audit-product-journeys.mjs --json` |
| `verify:invention-spec` | `simulate-invention-implementation-spec.cjs --summary` + `wave593` test |
| `verify:frontier-map` | `simulate-product-frontier-map.cjs --summary` + `wave595` test |
| `verify:math-frontier` | `simulate-product-math-frontier.cjs --summary` + `wave596` test |
| `verify:invention-buildbook` | `simulate-product-invention-buildbook.cjs --summary` + `wave598` test |
| `verify:research-atlas` | `simulate-product-research-atlas.cjs --summary` + `wave600` test |
| `verify:frontier-lab` | `simulate-product-frontier-lab.cjs --summary` + `wave601` + `wave602` tests |
| `verify:frontier-contracts` | `simulate-product-frontier-implementation-contracts.cjs --summary` + `wave603` + `wave604` tests |
| `verify:operator-kernels` | `simulate-product-frontier-operator-kernels.cjs --summary` + `wave605` + `wave606` tests |
| `verify:build-strategy` | `build-strategy-brain.mjs --catalog` + `wave597` test |
| `verify:readiness-workorders` | `simulate-readiness-gate-workorders.cjs --summary` + `wave599` test |

### 35.8 Roll-up

| Script | Composes |
|---|---|
| `verify:inventions` | `simulate-invention-portfolio.cjs --summary` + `verify:invention-spec` + `verify:frontier-map` + `verify:math-frontier` + `verify:invention-buildbook` + `verify:research-atlas` + `verify:frontier-lab` + `verify:frontier-contracts` + `verify:operator-kernels` |

### 35.9 Quality + benchmark verify

| Script | Threshold gates |
|---|---|
| `verify:redaction-benchmark` | `--min-f1 0.95 --min-recall 0.95 --max-fp 0` + `wave581` + `wave586` |
| `verify:quality-calibration` | `--min-agreement 0.98 --max-brier 0.18 --max-false-accept 0` + `wave588` test |
| `verify:benchmark-evidence` | `--summary --require-local-contract` |
| `verify:governance-packets` | `format-governance-packet.mjs` + `runtime-adoption-packets.mjs` (both `--require-local-contract`) |
| `verify:compliance-packet` | `compliance-certification-packet.mjs --require-local-contract` + `wave592` test |
| `verify:quant-oracle` | `--task extraction --device rtx-4090-24gb --params-b 7 --context 8192 --calibration-rows 256` |
| `verify:cloud-broker` | `--simulate runpod-r2 --workload train --params-b 7 --rows 2000 --no-local-gpu --summary --require-ready` |
| `verify:distill-strategy` | `--simulate anthropic --task generation --real-pairs 1500 --holdout-pairs 300 --summary --require-ready` |
| `verify:federated` | `wave409u` + `wave585` + `wave538` tests |
| `verify:package-release` | `package-release-readiness.mjs --require-local-contract` + `--smoke-installers` + `--run-local-checks` + `packages/attestation` test + `wave591` test |

### 35.10 Depth gate

| Script | Composes |
|---|---|
| `verify:depth` | The mega-chain: `audit-product-kernel --json` → `audit-product-journeys --json` → `cloud-readiness --json` → `build-codegraph --check --json` → `simulate-invention-portfolio` → 8× verify:* → `verify:build-strategy` → `bench-redaction-fixtures` + `wave581` + `wave586` → `verify:kscore-calibration` → `verify:quality-calibration` → `verify:benchmark-evidence` → `verify:governance-packets` → `verify:compliance-packet` → `verify:quant-oracle` → `verify:cloud-broker` → `verify:distill-strategy` → `verify:federated` → `verify:package-release` → `audit-sota-readiness` → `build-readiness-closeout --check` → `verify:readiness-workorders` → `audit-claim-scope` → `verify:brand` |

### 35.11 Screenshot QA

| Script | Purpose |
|---|---|
| `qa:shots` | Full `qa-screenshots.mjs` sweep |
| `qa:shots:quick` | `--quick` mode |
| `qa:shots:local` | `--base http://localhost:8787` |
| `ui:audit` | `ui-surface-audit.cjs` (critical surfaces) |
| `ui:audit:critical` | Same as `ui:audit` |
| `ui:audit:all` | `--all` |
| `ui:audit:all:themes` | `--all --themes=dark,light` |

### 35.12 Test + release

| Script | Purpose |
|---|---|
| `test` | `node --test --test-concurrency=1 tests/*.test.js` — serial run (W470 chokepoint requirement) |
| `test:parallel` | Same without `--test-concurrency=1` — for local triage only |
| `release:verify` | `node scripts/release-verify.cjs` — 7-gate driver |

### 35.13 Lint

| Script | Purpose |
|---|---|
| `lint` | `eslint src cli scripts tests workers` |
| `lint:fix` | `eslint --fix src cli scripts tests workers` |

### 35.14 Dependencies (prod = 15)

| Package | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | 0.32.1 | Claude teacher SDK |
| `@iarna/toml` | 2.2.5 | `.kolm.toml` and `kolm.toml` parsing |
| `adm-zip` | 0.5.17 | `.kolm` bundle zip read/write |
| `apache-arrow` | 21.1.0 | Capture lake columnar format |
| `archiver` | 7.0.1 | `.kolm` artifact compression |
| `compression` | 1.8.1 | Express response gzip |
| `cookie-parser` | 1.4.7 | Session cookies |
| `dotenv` | 16.6.1 | `.env` loading |
| `express` | 4.22.1 | HTTP framework |
| `express-rate-limit` | 7.5.1 | Token bucket rate limiting |
| `helmet` | 8.1.0 | Security headers |
| `parquetjs-lite` | 0.8.7 | Capture lake parquet writer |
| `pdfkit` | 0.18.0 | Compliance certification packets, model cards |
| `pg` | 8.13.1 | Postgres store driver (when `KOLM_STORE_DRIVER=pg`) |
| `ssh2` | 1.16.0 | `kolm device ssh` and fleet deploy |

### 35.15 Dev dependencies (4)

| Package | Version | Purpose |
|---|---|---|
| `@playwright/test` | 1.60.0 | E2E browser tests |
| `eslint` | 9.39.4 | Lint |
| `globals` | 17.6.0 | ESLint globals config |
| `playwright` | 1.60.0 | Screenshot scripts |

### 35.16 Publish manifest (`files`)

Published to npm only ships: `cli/`, `src/`, `services/`, `sdk/` (excluding `node_modules`, `__pycache__`, `*.pyc`, `sdk/rust/target`), `scripts/build-sdk-version.js`, `server.js`, `README.md`, `LICENSE`.

---

## 36. `vercel.json` redirects — complete reference (44)

Every redirect fires before rewrites, so adding a rewrite for a path already in `redirects[]` is a trap (W918 Wave 2 lesson). All `permanent: true` unless noted.

| # | Source | Destination |
|---:|---|---|
| 1 | `/customers` | `/enterprise` |
| 2 | `/vs-ollama` | `/compare/kolm-vs-ollama` |
| 3 | `/vs-rag` | (compare page) |
| 4 | `/vs-fine-tune` | (compare page) |
| 5 | `/vs-predibase` | (compare page) |
| 6 | `/vs-openpipe` | (compare page) |
| 7 | `/vs-together` | (compare page) |
| 8 | `/vs-openai-fine-tune` | (compare page) |
| 9 | `/vs-openai` | (compare page) |
| 10 | `/evolve` | `/product` |
| 11 | `/bounty` | `/community` |
| 12 | `/bounties` | `/community` |
| 13 | `/cookbook` | `/docs` |
| 14 | `/serve` | `/runtimes` |
| 15 | `/api-routes.json` | `/openapi.json` |
| 16 | `/helm` | `/self-host` |
| 17 | `/retail` | (vertical) |
| 18 | `/limits` | `/pricing` |
| 19 | `/docs/ci-cd` | `/integrations/github-actions` |
| 20 | `/safety` | `/security` |
| 21 | `/dpia` | (legal) |
| 22 | `/iso-27001` | (compliance) |
| 23 | `/msa` | `/enterprise` |
| 24 | `/telemetry` | `/privacy` |
| 25 | `/docs/runtimes` | `/runtimes` |
| 26 | `/status/history` | `/status` |
| 27 | `/office-hours` | `/community` |
| 28 | `/events` | (community) |
| 29 | `/careers` | `/manifesto` |
| 30 | `/security/architecture.pdf` | (PDF asset) |
| 31 | `/security/threat-model.pdf` | (PDF asset) |
| 32 | `/security/dpia-template.docx` | (DOCX asset) |
| 33 | `/legal/sla.pdf` | `/enterprise` |
| 34 | `/security/hof` | (hall of fame) |
| 35 | `/playground` | `/quickstart` |
| 36 | `/onboarding` | `/quickstart` |
| 37 | `/recall` | `/captures` |
| 38 | `/anatomy` | `/how-it-works` |
| 39 | `/showcase` | `/case-studies` |
| 40 | `/openai` | `/compare/kolm-vs-openai-fine-tune` |
| 41 | `/roadmap` | `/manifesto` |
| 42 | `/trust` | `/security` |
| 43 | `/how-it-works` | `/quickstart` |
| 44 | `/community-github` | `https://github.com/kolm-ai/kolm` (external) |

Plus 697 `rewrites[]` (pretty path → `.html`) and 1 `headers[]` block (CSP + security headers).

---

## 37. Spec + simulation fixture inventory

Located at repo root. Drives `npm run verify:*` simulators and lock-in tests.

| File | Bytes | Purpose |
|---|---:|---|
| `claims-redactor.spec.json` | 2,292 | Claims redactor lock-in spec (W343) |
| `classifier.spec.json` | 3,771 | Generic classifier spec |
| `court-ext.spec.json` | 2,763 | Court document extraction spec |
| `demo-log-triage.spec.json` | 2,574 | Log triage demo spec |
| `email-prio.spec.json` | 3,771 | Email prioritisation spec |
| `phi-redactor.spec.json` | 3,408 | PHI/HIPAA redactor spec (W344 alignment) |
| `wave58-test.spec.json` | 3,407 | Wave-58 reference test spec |
| `zh-greeter.spec.json` | 4,130 | Cross-lingual greeter spec (W833) |
| `sim-100.json` | 1,491,227 | 100-row simulation baseline (W409 / `scripts/sim-100.mjs`) |
| `sim-100-v2.json` | 1,682,425 | 100-row simulation v2 (drift + new operators) |
| `sim-100-v3.json` | 1,819,982 | 100-row simulation v3 (latest, used by depth gate) |

Total: 11 files / ~5.01 MB.

---

## 38. GitHub Actions workflows — complete reference (11)

Located at `.github/workflows/`. Five are template-guarded with `if: false` so they render in the GitHub UI but consume zero CI minutes until enabled.

### 38.1 Template (guarded by `if: false`)

| File | Workflow `name` | Trigger | Purpose |
|---|---|---|---|
| `kolm-ci-pipeline.yml` | `kolm-ci-pipeline-template` | `workflow_dispatch` | Reference 3-stage compile/test/publish pipeline. Flip guard + set `KOLM_KEY` secret to enable |
| `kolm-compile-on-push.yml` | `kolm-compile-template` | `workflow_dispatch` | Single-step `kolm compile` via composite action. Same flip + secret |
| `kolm-distill.yml` | `kolm-distill-template` | `workflow_dispatch` | `kolm.yaml` + GHA distill loop. Guarded by `if: ${{ secrets.KOLM_API_KEY != '' }}` once flipped |
| `kolm-template.yml` | `kolm-gate-template` | `workflow_dispatch` | Copy-paste template — downstream kolm users copy into their own repo at `.github/workflows/kolm.yml` |
| `kolm.yml` | `kolm` | `workflow_dispatch` | W820 reference workflow; `kolm-distill` job carries `if: false`. Permissions: `contents: write`, `pull-requests: write` |

### 38.2 Live CI (run on push / PR)

| File | Workflow `name` | Trigger | Purpose |
|---|---|---|---|
| `kolmbench-submission.yml` | `kolmbench-submission` | PR on `submissions/**` | W756 KolmBench v1 validator. Validates every JSONL row via `src/kolmbench.js → validateSubmission()`. Posts validation result back on PR via `actions/github-script`. Auto-merge gated by W807 reviewer-bot |
| `lint.yml` | `lint` | `pull_request`, `push: branches: [main]` | Forbids `innerHTML` + template literal in `public/`, forbids orphan rewrites, runs `audit-static-refs`, runs `audit-href --strict` |
| `sbom.yml` | `sbom` | `push: main`, `release: published`, `workflow_dispatch` | CycloneDX SBOM generation (ours as backstop). Non-modifying |
| `sdk-c-rust.yml` | `sdk-c-rust` | `push: main` paths `sdk/c/**`, `sdk/rust/**`, `.github/workflows/sdk-c-rust.yml` | `c-sdk` job: ubuntu-latest + libcurl + make; verifies CLI usage exit-64 + bogus-host returns non-zero. `rust-sdk` job: stable toolchain + `cargo check --all-targets` + `cargo test` + release `examples/whoami` smoke |
| `smoke.yml` | `smoke` | `pull_request`, `push: main` | `PORT=8787 node server.js` boot + `scripts/smoke-live.sh` |
| `test-suite.yml` | `test-suite` | PR on `src/**`, `tests/**`, `scripts/**`, `cli/**` | `node --test --test-concurrency=1 tests/` (serial, W470 chokepoint) |

---

## 39. `src/` files by line count (top 25)

`wc -l src/*.{js,mjs,cjs}` on 2026-05-28. Top-20 sum = 50,888 lines; full top-25 = 53,287 lines; entire flat `src/` = 185,215 lines across 420 files.

| Rank | File | Lines | What it owns |
|---:|---|---:|---|
| 1 | `src/router.js` | 25,730 | All 709 HTTP routes |
| 2 | `src/binder.js` | 2,678 | Capture/recall binder + tenant scoping |
| 3 | `src/artifact.js` | 2,416 | `.kolm` artifact read/write + verify |
| 4 | `src/intent.js` | 2,276 | NL → CLI verb router (`kolm ask`, `/v1/intent/ask`) |
| 5 | `src/wrapper-cli.js` | 2,014 | CLI thin-client that drives the wrapper server |
| 6 | `src/model-registry.js` | 1,548 | Frontier model registry + tier presets |
| 7 | `src/spec-compile.js` | 1,315 | `.kolm` → C/Rust/WASM native target compiler |
| 8 | `src/distill-pipeline.js` | 1,156 | Teacher fetch → seed split → trainer bridge → eval |
| 9 | `src/privacy-membrane.js` | 1,114 | PHI/PII fail-closed redactor (W291) |
| 10 | `src/bench-harness.js` | 1,080 | Bench runner + K-score calibration |
| 11 | `src/daemon-connector.js` | 1,049 | Long-running daemon + connector lifecycle |
| 12 | `src/marketplace.js` | 1,010 | Marketplace listings, publish, verified-vs-provisional tagging |
| 13 | `src/ab-router.js` | 994 | A/B traffic split + stat-sig gate |
| 14 | `src/deploy-generators.js` | 993 | Per-runtime deploy artifact emitters (Docker, k8s, vllm, sglang, tgi, trt-llm) |
| 15 | `src/compile-pipeline.js` | 985 | High-level compile orchestrator |
| 16 | `src/devices.js` | 984 | Device registry + SSH binding |
| 17 | `src/dsl.js` | 940 | `.kolm` DSL parser + codegen |
| 18 | `src/drift-detector.js` | 892 | Drift detection + supersession (W167) |
| 19 | `src/team-events.js` | 864 | Team activity feed + strict schema (W293) |
| 20 | `src/pipeline-orchestrator.js` | 850 | Pipeline DAG executor |
| 21 | `src/active-learning.js` | 845 | Active learning queue (W710 + W815) |
| 22 | `src/artifact-runner.js` | 837 | Runtime executor for `.kolm` artifacts |
| 23 | `src/models.js` | 825 | Model discovery + recommendation |
| 24 | `src/speculative-teacher.js` | 818 | Speculative decoding teacher (W814) |
| 25 | `src/wrapper-server.js` (approx) | _trailing_ | Wrapper server long-running daemon |

---

## 40. Full alphabetical test inventory (665 files)

Every `tests/*.test.js` file as of 2026-05-28. Grouped by prefix for scan-ability; within each group the order is `Get-ChildItem` alphabetical.

### 40.1 Structural (R + S + WC + WF)

`artifact-end-to-end.test.js` · `auth-hash.test.js` · `auth.test.js` · `billing-tiers.test.js` · `cid.test.js` · `cloud-compile.test.js` · `e2e.test.js` · `load-test-scaffold.test.js` · `product-kernel-envelope.test.js` · `r1-runtime-passport.test.js` · `r2-artifact-lifecycle.test.js` · `r3-kolm-serve.test.js` · `r4-deploy-generators.test.js` · `r5-evidence-dag.test.js` · `r6-assurance-case.test.js` · `r7-drift-detector.test.js` · `r8-cost-displacement.test.js` · `research-docs.test.js` · `s1-gguf-export.test.js` · `s2-ollama-modelfile.test.js` · `sandbox-hardening.test.js` · `sentry-init.test.js` · `server.test.js` · `site.test.js` · `store.test.js` · `stripe.test.js` · `wave-wc05-envelope.test.js` · `wave-wc06-log.test.js` · `wave-wc07-env-helpers.test.js` · `wave-wc14-shell-injection-guards.test.js` · `wave-wc15-perf-cache.test.js` · `wavewc01-dep-audit.test.js` · `wavewf01-design-system.test.js` · `wc04-ab-router.test.js` · `wc04-capture-analytics.test.js` · `wc04-cloud-sync.test.js` · `wc04-compile-pipeline.test.js` · `wc04-cost-estimator.test.js` · `wc04-devices.test.js` · `wc04-distill-pipeline.test.js` · `wc04-models.test.js` · `wc04-privacy-membrane.test.js` · `wc04-runtime-policy.test.js` · `wc04-trace-translator.test.js`

### 40.2 Wave 144 — V1 foundation (18)

`wave144-api.test.js` · `wave144-bench-compare.test.js` · `wave144-bench-proof.test.js` · `wave144-completions-api.test.js` · `wave144-completions-server.test.js` · `wave144-distill-worker.test.js` · `wave144-doc-check.test.js` · `wave144-dsl-codegen.test.js` · `wave144-extract.test.js` · `wave144-moe-compose.test.js` · `wave144-native-compile.test.js` · `wave144-phi-redactor.test.js` · `wave144-predibase-demo.test.js` · `wave144-seeds-gate.test.js` · `wave144-tokenizer-artifact.test.js` · `wave144-tokenizer.test.js` · `wave144-tui-chat.test.js` · `wave144-verifier-states.test.js`

### 40.3 Wave 145–210 (66)

`wave145-kscore-t-axis.test.js` · `wave146-export-provenance.test.js` · `wave147-moe-composition.test.js` · `wave148-pretokenize.test.js` · `wave149-ed25519-default.test.js` · `wave150-sigstore.test.js` · `wave151-recipe-class.test.js` · `wave157-redactor-receipt.test.js` · `wave158-cross-vendor.test.js` · `wave160-teacher-delta.test.js` · `wave161-ed25519-policy.test.js` · `wave162-sigstore-rekor.test.js` · `wave163-export-binder.test.js` · `wave164-external-adversarial.test.js` · `wave165-tenant-shadow.test.js` · `wave166-auditor-attestation.test.js` · `wave167-drift-supersession.test.js` · `wave168-rs1-spec-coverage.test.js` · `wave169-compare-surfaces.test.js` · `wave171-drift-ui.test.js` · `wave172-recipe-classes.test.js` · `wave173-research-healthcare-refresh.test.js` · `wave174-verify-prod-drift-card.test.js` · `wave175-quickstart-integration.test.js` · `wave176-edi-837-recipe.test.js` · `wave177-edi-835-recipe.test.js` · `wave178-edi-834-recipe.test.js` · `wave179-edi-270-271-recipe.test.js` · `wave180-edi-278-recipe.test.js` · `wave181-fhir-uscdi-recipe.test.js` · `wave182-hedis-measures.test.js` · `wave183-letter-generators.test.js` · `wave184-rule-class-bundle.test.js` · `wave185-k-score-explained.test.js` · `wave186-frozen-eval.test.js` · `wave187-format-v2.test.js` · `wave188-migrate.test.js` · `wave189-security-kms.test.js` · `wave190-artifact-drift-detail.test.js` · `wave191-moe-cli.test.js` · `wave192-rag-cli.test.js` · `wave193-keys-rotate.test.js` · `wave194-corpus-licensing-gate.test.js` · `wave195-quantize-worker.test.js` · `wave196-methods-research-page.test.js` · `wave197-nl-cli-verb.test.js` · `wave198-training-refresh.test.js` · `wave199-seeds-new.test.js` · `wave200-quickstart-nl.test.js` · `wave201-training-data-sources.test.js` · `wave202-cli-ux.test.js` · `wave203-tui-repl.test.js` · `wave204-post-auth-ui.test.js` · `wave205-website-copy.test.js` · `wave206-docs-audit.test.js` · `wave207-a11y-perf.test.js` · `wave208-mobile.test.js` · `wave209-i18n-refresh.test.js` · `wave210-final-sweep.test.js`

### 40.4 Wave 211–262 (sprint era, 42)

`wave211-ci-hotfix.test.js` · `wave212-capture-durability.test.js` · `wave213-live-capture-tail.test.js` · `wave214-distill-from-captures.test.js` · `wave215-threshold-alerts.test.js` · `wave216-replay-diff.test.js` · `wave217-frontier-models.test.js` · `wave218-hw-tier-presets.test.js` · `wave219-runtime-build.test.js` · `wave220-homepage-3sec-hero.test.js` · `wave221-nav-consolidation.test.js` · `wave222-tui-altscreen.test.js` · `wave223-tui-showcase.test.js` · `wave224-slop-cut.test.js` · `wave225-seo-infrastructure.test.js` · `wave226-pillar-ai-compiler.test.js` · `wave227-supporting-articles.test.js` · `wave228-brand-disambig.test.js` · `wave229-foundations-verbs.test.js` · `wave230-foundations-page.test.js` · `wave232-kolm-state.test.js` · `wave233-detached-sessions.test.js` · `wave234-chat-templates.test.js` · `wave235-amd-rocm-benchmarks.test.js` · `wave236-hermes-agent.test.js` · `wave237-mesh-cluster.test.js` · `wave238-init-agent.test.js` · `wave240-three-process-split.test.js` · `wave241-bootstrap-installer.test.js` · `wave242-enterprise-proxy.test.js` · `wave243-compile-variety.test.js` · `wave249-cross-platform.test.js` · `wave250-remote-compute.test.js` · `wave252-backend-fixes.test.js` · `wave252-ml-fixes.test.js` · `wave253-audit-fixes.test.js` · `wave255-e2e-compile-distill.test.js` · `wave256-copy-scrub.test.js` · `wave258-audit-fixes.test.js` · `wave260-copy-refresh.test.js` · `wave261-builder.test.js` · `wave262-mcp-installers.test.js`

### 40.5 Wave 263–397 (product frontier intro)

`wave263-marketplace.test.js` · `wave264-self-hosted.test.js` · `wave265-usage-analytics.test.js` · `wave266-compile-targets-surfaced.test.js` · `wave267-nonprofits.test.js` · `wave268-integrations.test.js` · `wave269-agent-composition.test.js` · `wave271-hero-rewrite.test.js` · `wave272-vertical-microsites.test.js` · `wave273-pricing-tiers.test.js` · `wave274-comparison-pages.test.js` · `wave275-kscore-deep.test.js` · `wave276-ux-funnels.test.js` · `wave277-international-sovereign.test.js` · `wave278-standards-play.test.js` · `wave279-site-license.test.js` · `wave282-compile-routing.test.js` · `wave283-train-only-synthesis.test.js` · `wave284-group-aware-split.test.js` · `wave285-source-type-enforcement.test.js` · `wave286-workflow-capsule-class.test.js` · `wave287-runtime-dispatch.test.js` · `wave291-phi-findings.test.js` · `wave292-teacher-bridge-fail-closed.test.js` · `wave293-team-events-strict-schema.test.js` · `wave294-review-gate-only-approved.test.js` · `wave295-model-registry-split.test.js` · `wave297-value-loop-happy-path.test.js` · `wave298-doctor-loop.test.js` · `wave300-kolm-loop-verb.test.js` · `wave301-value-loop-page.test.js` · `wave302-loop-next-steps.test.js` · `wave303-loop-remote.test.js` · `wave304-kolm-status.test.js` · `wave305-kolm-health.test.js` · `wave306-kolm-metrics.test.js` · `wave307-kolm-support-bundle.test.js` · `wave308-kolm-completion-install.test.js` · `wave309-kolm-config-show.test.js` · `wave310-kolm-key-fingerprint.test.js` · `wave311-walkloop-parallel-fix.test.js` · `wave312-value-loop-status-badge.test.js` · `wave313-value-loop-try-it-now.test.js` · `wave314-317-captures-ui.test.js` · `wave318-321-cli-artifacts.test.js` · `wave322-325-quickstart-surfaces.test.js` · `wave328-lighthouse-static-audit.test.js` · `wave339-production-verdict.test.js` · `wave341-run-gate.test.js` · `wave342-marketplace-gate.test.js` · `wave343-claims-redactor.test.js` · `wave344-phi-alignment.test.js` · `wave345-eval-bench-parity.test.js` · `wave346-local-rewrites.test.js` · `wave347-builder-preview.test.js` · `wave347-nl-seeds.test.js` · `wave348-ask-no-crash.test.js` · `wave349-mobile-recommender.test.js` · `wave350-probe-cleanup.test.js` · `wave351-intent.test.js` · `wave352-do-what-next.test.js` · `wave353-agent-guide.test.js` · `wave354-seeds-mining.test.js` · `wave355-seeds-augment.test.js` · `wave356-seeds-active.test.js` · `wave357-seeds-sanitize.test.js` · `wave358-seeds-score.test.js` · `wave359-pipeline-make.test.js` · `wave360-pipeline-ship.test.js` · `wave361-pipeline-train.test.js` · `wave362-synthesis-networked.test.js` · `wave363-billing-upgrade.test.js` · `wave364-distill-bridge.test.js` · `wave365-beta-cleanup.test.js` · `wave367-build-curated-template.test.js` · `wave367-recipe-bundle.test.js` · `wave368-connector.test.js` · `wave369-backend-core.test.js` · `wave370-privacy.test.js` · `wave371-builder.test.js` · `wave372-runtime-devices.test.js` · `wave373-website.test.js` · `wave374-docs.test.js` · `wave375-account.test.js` · `wave377-multimodal.test.js` · `wave378-cloud-sync.test.js` · `wave379-team.test.js` · `wave381-pipeline.test.js` · `wave382-dev-agent.test.js` · `wave383-agent-telemetry.test.js` · `wave384-cli-wiring.test.js` · `wave384-router-wiring.test.js` · `wave386-model-weights.test.js` · `wave388-build-curated-via-examples.test.js` · `wave389-production-ready-parity.test.js` · `wave390-mobile-device-fit.test.js` · `wave391-cli-bugfixes.test.js` · `wave396-demo-loop.test.js` · `wave397-dataset-hydration.test.js`

### 40.6 Wave 407–411 (P0 hardening)

`wave407b-connector-fixes.test.js` · `wave407e-verify-eval-parity.test.js` · `wave409a-canonical-event-store.test.js` · `wave409aa-verify-hardening.test.js` · `wave409b-privacy-failclosed.test.js` · `wave409bb-test-hardening.test.js` · `wave409c-no-stub-production.test.js` · `wave409d-runtime-dispatch.test.js` · `wave409efg-production-routes-models.test.js` · `wave409h-value-loop-e2e.test.js` · `wave409i-cli-tui-account-coherence.test.js` · `wave409j-copy-sweep.test.js` · `wave409k-openai-compat-surface.test.js` · `wave409lm-lake-opportunities.test.js` · `wave409nop-datasets-labels-bakeoffs.test.js` · `wave409q-c-rust-wasm-verify.test.js` · `wave409rs-models-devices.test.js` · `wave409t-team-learning.test.js` · `wave409u-federated-foundation.test.js` · `wave409v-confidential-compute.test.js` · `wave409w-workflow-ir.test.js` · `wave409x-marketplace-gate.test.js` · `wave409y-billing-metering.test.js` · `wave409z-integration-recipes.test.js` · `wave410-loop-and-integrations-strip.test.js` · `wave411-dedupe-and-holdout.test.js` · `wave411-golden-e2e-smoke.test.js` · `wave411-hosted-auth-gate.test.js` · `wave411-migration-backfill.test.js` · `wave411-p0-train-holdout-and-metadata.test.js` · `wave411-redaction-leak.test.js` · `wave411-tenant-isolation.test.js` · `wave411-vendor-normalization-and-prodgate.test.js` · `wave411-worker-input-spy.test.js`

### 40.7 Wave 412–466 (audit/route docs/multimodal)

`wave412-nl-intent-w409-verbs.test.js` · `wave413-intent-next-route.test.js` · `wave414-tui-next-view.test.js` · `wave415-intent-ask.test.js` · `wave416-p0-regression-guard.test.js` · `wave417-definition-of-done.test.js` · `wave418-chat-completions-auth.test.js` · `wave419-opportunity-tenant-scope.test.js` · `wave420-pipeline-tenant-force.test.js` · `wave421-pipeline-distill-real-bridge.test.js` · `wave422-distill-tenant-fallback.test.js` · `wave423-media-capture-tenant.test.js` · `wave424-agent-telemetry-tenant-scope.test.js` · `wave425-trace-ownership.test.js` · `wave426-import-seeds-tenant.test.js` · `wave427-local-meter-exclusion.test.js` · `wave428-marketplace-verified-provisional.test.js` · `wave429-pipeline-job-ownership.test.js` · `wave430-distill-bridge-metadata.test.js` · `wave431-source-mojibake-clean.test.js` · `wave432-intent-tenant-scope.test.js` · `wave433-whoami-alias.test.js` · `wave434-drift-http-routes.test.js` · `wave435-bridges-observations-since.test.js` · `wave436-artifact-verify-manifest-hash-mismatch.test.js` · `wave438-real-compile.test.js` · `wave438-rented-distill.test.js` · `wave439-incremental-retrain.test.js` · `wave441-prod-routing.test.js` · `wave442-blessed-test-command.test.js` · `wave444-lake-storage-retention.test.js` · `wave445-verify-hardening.test.js` · `wave446-value-loop-audit-finish.test.js` · `wave448-audit-log-triangle.test.js` · `wave449-billing-settings-triangle.test.js` · `wave451-multimodal-redact.test.js` · `wave453-ask-intent-preview.test.js` · `wave454-media-redact-worker.test.js` · `wave455-distill-runs-telemetry.test.js` · `wave456-changelog-roadmap.test.js` · `wave457-artifact-runtime-consistency.test.js` · `wave457-auth-and-runs-validation.test.js` · `wave457-build-honors-out.test.js` · `wave457-telemetry-reconciliation.test.js` · `wave458-dod-12-step-e2e.test.js` · `wave459-distill-reliability.test.js` · `wave460-attestation-embed.test.js` · `wave461-federated-approvals.test.js` · `wave462-multimodal-image-redact.test.js` · `wave463-trace-compile.test.js` · `wave464-multimodal-audio-redact.test.js` · `wave465-billing-breakdown.test.js` · `wave466-multimodal-bakeoff.test.js`

### 40.8 Wave 470–540 (release-verify gates + route docs)

`wave470-auth-recovery-ux.test.js` · `wave470-native-target-completion.test.js` · `wave470-sdk-node-smoke.test.js` · `wave470-suite-order-determinism.test.js` · `wave480-onpolicy-preference-specdecode.test.js` · `wave481-allow-logged-out.test.js` · `wave481-hub-marketplace-align.test.js` · `wave482-sdk-catalog-honesty.test.js` · `wave484-update-repo-checkout-guard.test.js` · `wave485-openapi-coverage.test.js` · `wave487-tui-surface.test.js` · `wave490-release-verify-openapi-gate.test.js` · `wave491-status-subscribe-surface.test.js` · `wave492-health-ready-gate.test.js` · `wave493-trust-copy-honesty.test.js` · `wave494-distribution-honesty.test.js` · `wave495-integration-honesty.test.js` · `wave496-ai-discovery-honesty.test.js` · `wave496-api-base-honesty.test.js` · `wave497-public-api-route-honesty.test.js` · `wave498-capture-route-contract.test.js` · `wave499-public-docs-route-honesty.test.js` · `wave500-account-console-route-honesty.test.js` · `wave500-production-split-floor.test.js` · `wave501-quickstart-capture-bench-route-honesty.test.js` · `wave502-admin-registry-storage-route-honesty.test.js` · `wave503-capture-provider-route-honesty.test.js` · `wave504-browser-sdk-capture-route-honesty.test.js` · `wave504-public-claim-polish.test.js` · `wave505-sdk-manifest-release-gate.test.js` · `wave506-kscore-leaderboard-submission-honesty.test.js` · `wave507-oauth-route-contract.test.js` · `wave508-openapi-wildcard-param-contract.test.js` · `wave509-route-family-comment-honesty.test.js` · `wave510-route-doc-cleanup.test.js` · `wave511-undocumented-route-wording.test.js` · `wave512-core-route-docs.test.js` · `wave513-teams-route-docs.test.js` · `wave514-device-route-docs.test.js` · `wave515-notifications-route-docs.test.js` · `wave516-admin-route-docs.test.js` · `wave517-trace-route-docs.test.js` · `wave518-runtime-route-docs.test.js` · `wave519-account-route-docs.test.js` · `wave520-federated-route-docs.test.js` · `wave521-specialists-route-docs.test.js` · `wave522-byoc-route-docs.test.js` · `wave523-datasets-route-docs.test.js` · `wave524-keys-route-docs.test.js` · `wave524-release-verify-helpers.test.js` · `wave525-labels-route-docs.test.js` · `wave525-release-verify-sdk-manifest-gate.test.js` · `wave526-marketplace-route-docs.test.js` · `wave526-release-verify-json-mode.test.js` · `wave527-allow-logged-out-passthrough.test.js` · `wave528-release-verify-exit-codes.test.js` · `wave529-release-verify-lockin-suite-honesty.test.js` · `wave530-release-verify-lint-refs-gate.test.js` · `wave531-release-verify-gatecli-helper.test.js` · `wave536-concepts-route-docs.test.js` · `wave537-eval-tenant-holdout-route-docs.test.js` · `wave538-federated-route-docs.test.js` · `wave538-public-surface-polish.test.js` · `wave539-ir-route-docs.test.js` · `wave540-sim-route-docs.test.js`

### 40.9 Wave 547–606 (SOTA backend + product frontier)

`wave547-release-verify-codex-sandbox.test.js` · `wave548-prod-surface-sandbox.test.js` · `wave549-hosted-connector-upstream-key.test.js` · `wave550-capture-openrouter-helper.test.js` · `wave550-cors-contract.test.js` · `wave551-compute-training-contract.test.js` · `wave552-gemma-multimodal-account.test.js` · `wave553-codegraph-cloud-platform.test.js` · `wave554-product-experience.test.js` · `wave555-user-completion-cloud-optimizer.test.js` · `wave556-close-remaining-partials.test.js` · `wave557-provider-gemma-model-scope.test.js` · `wave558-object-storage-cloud-contract.test.js` · `wave559-cli-doc-generator-polish.test.js` · `wave580-invention-portfolio.test.js` · `wave581-redaction-benchmark.test.js` · `wave582-quantization-oracle.test.js` · `wave583-cloud-compute-broker.test.js` · `wave583-enterprise-identity-contract.test.js` · `wave584-distill-strategy.test.js` · `wave585-federated-robust-aggregation.test.js` · `wave586-redaction-public-benchmark-contract.test.js` · `wave587-kscore-calibration-contract.test.js` · `wave588-package-release-readiness.test.js` · `wave588-quality-calibration-contract.test.js` · `wave589-benchmark-evidence-contract.test.js` · `wave590-governance-runtime-packets.test.js` · `wave591-package-local-build-contract.test.js` · `wave592-compliance-certification-packet.test.js` · `wave593-invention-implementation-spec.test.js` · `wave594-kolm-brand-contract.test.js` · `wave595-product-frontier-map.test.js` · `wave596-product-math-frontier.test.js` · `wave596-redactor-template-e2e.test.js` · `wave597-build-strategy-brain.test.js` · `wave598-product-invention-buildbook.test.js` · `wave599-readiness-gate-workorders.test.js` · `wave600-product-research-atlas.test.js` · `wave601-product-frontier-lab.test.js` · `wave602-product-frontier-lab-api.test.js` · `wave603-product-frontier-implementation-contracts.test.js` · `wave604-product-frontier-contracts-api.test.js` · `wave605-product-frontier-operator-kernels.test.js` · `wave606-product-frontier-operator-kernels-api.test.js`

### 40.10 Wave 707–788 (system upgrade)

`wave707-supplement-bundle.test.js` · `wave707b-supplement-v2.test.js` · `wave708-copyright-and-geo.test.js` · `wave708-teacher-source-policy.test.js` · `wave708-vertical-disclaimer.test.js` · `wave709-routing-events.test.js` · `wave709-routing-threshold-sse.test.js` · `wave709-runtime-router.test.js` · `wave710-active-learning-queue.test.js` · `wave711-importance-weighted-distill.test.js` · `wave712-progressive-distill.test.js` · `wave713-reasoning-trace-distill.test.js` · `wave714-contrastive-distill.test.js` · `wave715-cross-namespace-transfer.test.js` · `wave716-taas-arch-search.test.js` · `wave717-curriculum-distill.test.js` · `wave718-teacher-council.test.js` · `wave719-daq.test.js` · `wave720-self-improvement.test.js` · `wave721-tsac.test.js` · `wave722-itkv.test.js` · `wave723-streaming-load.test.js` · `wave724-memory-tier.test.js` · `wave725-preload-scheduler.test.js` · `wave726-bvl-kernels.test.js` · `wave727-accelerate.test.js` · `wave728-its.test.js` · `wave729-load-queue.test.js` · `wave730-prometheus.test.js` · `wave731-vscode-watcher.test.js` · `wave732-yaml-gha.test.js` · `wave733-otel.test.js` · `wave734-rag.test.js` · `wave735-tool-use.test.js` · `wave736-guardrails.test.js` · `wave737-marketplace.test.js` · `wave738-pipeline.test.js` · `wave739-lineage.test.js` · `wave740-import.test.js` · `wave741-diagnose.test.js` · `wave742-gateway-mode.test.js` · `wave743-migrate.test.js` · `wave745-failure-modes.test.js` · `wave746-staleness.test.js` · `wave747-drift-alert.test.js` · `wave748-seasonal.test.js` · `wave749-synthetic.test.js` · `wave750-copyright.test.js` · `wave751-verticals.test.js` · `wave756-kolmbench.test.js` · `wave757-pattern-lake.test.js` · `wave758-bench-harnesses.test.js` · `wave759-numeric-accuracy.test.js` · `wave760-per-language-kscore.test.js` · `wave761-model-poisoning.test.js` · `wave762-adversarial.test.js` · `wave763-sbom.test.js` · `wave764-membership-inference.test.js` · `wave765-prompt-extraction.test.js` · `wave766-eu-ai-act.test.js` · `wave767-soc2-iso27001.test.js` · `wave768-model-card.test.js` · `wave769-data-residency.test.js` · `wave770-audit-export.test.js` · `wave771-vlm-distill.test.js` · `wave771b-vision-tokenize.test.js` · `wave772-audio-distill.test.js` · `wave772b-audio-tokenize.test.js` · `wave773-video-distill.test.js` · `wave773b-video-tokenize.test.js` · `wave774-cross-lingual.test.js` · `wave775-autopilot.test.js` · `wave777-ab-router.test.js` · `wave778-stat-sig.test.js` · `wave779-airgap-sneakernet.test.js` · `wave780-multi-region.test.js` · `wave781-long-context-warn.test.js` · `wave782-approval-queue.test.js` · `wave783-chargeback.test.js` · `wave784-plugins.test.js` · `wave785-cloud-distill.test.js` · `wave786-carbon.test.js` · `wave787-efficiency.test.js` · `wave788-sla.test.js`

### 40.11 Wave 807–843 (frontier + cross-lingual + savings)

`wave807-confidence-routing.test.js` · `wave808-capture-poisoning.test.js` · `wave809-structured-output.test.js` · `wave810-kscore-calibration.test.js` · `wave811-capture-analytics.test.js` · `wave812-failure-modes.test.js` · `wave813-drift-detection.test.js` · `wave814-speculative-teacher.test.js` · `wave815-active-learning.test.js` · `wave816-failure-to-capture-loop.test.js` · `wave817-format-v1.test.js` · `wave818-ecosystem-loaders.test.js` · `wave819-vscode-extension.test.js` · `wave820-gha.test.js` · `wave821-pipeline-orchestrator.test.js` · `wave822-ab-testing.test.js` · `wave823-otel-upgrade.test.js` · `wave824-k8s.test.js` · `wave825-marketplace.test.js` · `wave826-runtime-placement.test.js` · `wave827-token-dpo.test.js` · `wave828-reasoning-v2.test.js` · `wave829-multimodal-pipeline.test.js` · `wave830-federated-consortium.test.js` · `wave831-airgap.test.js` · `wave832-kolm-meta.test.js` · `wave833-cross-lingual.test.js` · `wave834-regulatory.test.js` · `wave835-savings.test.js` · `wave843-regulatory-consortium-cli.test.js`

### 40.12 Wave 867–910 (Trinity + RUN + final push)

`wave867-trinity-500-distill.test.js` · `wave868-homepage-receipt.test.js` · `wave869-forge-personas.test.js` · `wave870-teacher-proxy.test.js` · `wave886-surface-parity.test.js` · `wave888a-doctor-fix.test.js` · `wave888b-cloud-providers.test.js` · `wave888c-device-ssh.test.js` · `wave888c-devices.test.js` · `wave888d-deploy-pipeline.test.js` · `wave888e-fleet-ota.test.js` · `wave888f-account-ui-onboarding.test.js` · `wave888g-cli-ux.test.js` · `wave888h-e2e-personas.test.js` · `wave888i-capture-export-formats.test.js` · `wave888i-cli-startup-perf.test.js` · `wave888i-gateway-overhead.test.js` · `wave888i-rate-limit.test.js` · `wave888i-receipt-export.test.js` · `wave888i-rss-feed.test.js` · `wave888i-ship-gate-smoke.test.js` · `wave888j-config.test.js` · `wave888L-blocker-10-fix.test.js` · `wave888L-blocker-21-fix.test.js` · `wave888L-blocker-50-fix.test.js` · `wave888L-blocker-6-fix.test.js` · `wave888L-blocker-9-fix.test.js` · `wave888m-corpus-coverage.test.js` · `wave888n-pair-generation.test.js` · `wave888o-compile-gate.test.js` · `wave888p-cli-nl-routing.test.js` · `wave888q-account-chat.test.js` · `wave888r-docs-search.test.js` · `wave888s-meta-demo.test.js` · `wave888t-assistant-umbrella.test.js` · `wave889-11-e2e-ship-gate.test.js` · `wave889-12-final-polish.test.js` · `wave889-6-pricing-overhaul.test.js` · `wave889-7-onboarding.test.js` · `wave889-8-12-verticals-vs.test.js` · `wave889-8-34-seo-oauth.test.js` · `wave889-9-10-spec-marketplace.test.js` · `wave889-d1-dedup-audit.test.js` · `wave890-1-organization.test.js` · `wave890-10-frontend.test.js` · `wave890-11-cli.test.js` · `wave890-12-documentation.test.js` · `wave890-13-deployment.test.js` · `wave890-14-performance.test.js` · `wave890-15-monitoring.test.js` · `wave890-16-final-verification.test.js` · `wave890-2-code-quality.test.js` · `wave890-3-error-handling.test.js` · `wave890-4-logging.test.js` · `wave890-5-testing.test.js` · `wave890-6-security.test.js` · `wave890-7-configuration.test.js` · `wave890-8-storage.test.js` · `wave890-9-api.test.js` · `wave910-cli-fuzzy.test.js` · `wave910-compile-groups.test.js` · `wave910-data-ingestion.test.js` · `wave910-fleet-lifecycle.test.js` · `wave910-next-actions.test.js` · `wave910-notifications.test.js` · `wave910-org-admin.test.js` · `wave910-recipes.test.js` · `wave910-runpod.test.js` · `wave910-ship-gate.test.js` · `wave910-tui-smoke.test.js`

### 40.13 Wave 918 (current — 7 tests / 53 cases)

`wave918-agent-trajectory.test.js` (6 cases) · `wave918-cerebras-teacher.test.js` (5) · `wave918-cli-wave2.test.js` (5) · `wave918-openai-migration.test.js` (7) · `wave918-openrouter-importer.test.js` (4) · `wave918-orgs-rbac.test.js` (10) · `wave918-wave2-surfaces.test.js` (16)

### 40.14 Wrapper integration (W887)

`wrapper-email.test.js` · `wrapper-integration.test.js` · `wrapper-metrics.test.js` · `wrapper-r-enrich.test.js` · `wrapper-r1-r8.test.js` · `wrapper-receipt-schema.test.js` · `wrapper-s3.test.js` · `wrapper-s4.test.js` · `wrapper-s5.test.js` · `wrapper-s6.test.js` · `wrapper-s7.test.js` · `wrapper-shard-wire.test.js` · `wrapper-shard.test.js` · `wrapper-smoke.test.js` · `wrapper-status.test.js` · `wrapper-w1-w2-w3.test.js`

---

## 41. Full alphabetical script inventory (342 files)

Every file directly under `scripts/` as of 2026-05-28 (excludes nested subdirectories like `scripts/e2e/`, `scripts/corpus/`, `scripts/video/`, `scripts/winget/`, `scripts/__pycache__/`, etc).

### 41.1 Underscore + W890 prefixed (12)

`_build-dotkolm-fixtures.cjs` · `_w889-12-rename-github-org.cjs` · `_w889-12-rename-public-html.cjs` · `_w890-2-console-log-scan.cjs` · `_w890-2-detect-fixed.cjs` · `_w890-2-eslint-summarize.cjs` · `_w890-2-localhost-scan.cjs` · `_w890-2-secrets-scan.cjs` · `_w890-2-style-scan.cjs` · `_w890-2-todo-scan.cjs` · `_w890-2-write-lint-reports.cjs`

### 41.2 A

`aa-zoom.mjs` · `add_article_plates.py` · `add-twitter-card.cjs` · `apply-surface-polish.mjs` · `archive-prod.cjs` · `audit-anchors.mjs` · `audit-buyer-journey.sh` · `audit-claim-scope.cjs` · `audit-docs-rewrites.cjs` · `audit-href.cjs` · `audit-links-prod.mjs` · `audit-links.mjs` · `audit-orphans.mjs` · `audit-page-structure.cjs` · `audit-product-journeys.mjs` · `audit-product-kernel.cjs` · `audit-rank.mjs` · `audit-render.cjs` · `audit-rendered-surface.mjs` · `audit-sota-readiness.cjs` · `audit-static-refs.cjs` · `audit-w890-7-defaults.cjs` · `audit-w890-7-env-vars.cjs` · `audit-w890-7-gitignore.cjs` · `audit-w890-7-hierarchy.cjs` · `audit-w890-7-secret-leak-scan.cjs` · `audit-w890-7-zero-config-doctor.cjs`

### 41.3 B

`batch-redesign-shots.mjs` · `bench-compare.mjs` · `bench-proof.mjs` · `bench-quality-calibration.mjs` · `bench-redaction-fixtures.mjs` · `bench-tps.mjs` · `benchmark-evidence.mjs` · `bootstrap.ps1` · `bootstrap.sh` · `brand-bars-swap.cjs` · `brand-disambig-sweep.cjs` · `build-account-pages.cjs` · `build-all-examples.mjs` · `build-api-ref.cjs` · `build-assistant-corpus.cjs` · `build-browser-extension.mjs` · `build-catalog-manifest.mjs` · `build-changelog.cjs` · `build-cli-docs.cjs` · `build-codebase-file-ledger.cjs` · `build-codegraph.mjs` · `build-deb.mjs` · `build-design-cascade-ledger.cjs` · `build-distilled-model-seed.mjs` · `build-docs-manifest.cjs` · `build-docs-w374.cjs` · `build-example-classifier.mjs` · `build-example-extractor.mjs` · `build-example-gguf.mjs` · `build-example-redactor.mjs` · `build-marketplace-pages.cjs` · `build-model-class-demo.cjs` · `build-og.cjs` · `build-openapi.cjs` · `build-product-graph.cjs` · `build-product-media-proof.cjs` · `build-public-fixture.mjs` · `build-readiness-closeout.cjs` · `build-registry-pack.cjs` · `build-sdk-version.js` · `build-seo-pages.cjs` · `build-sitemap.cjs` · `build-strategy-brain.mjs` · `build-tui-demo-cast.mjs` · `build-wave-registry.cjs` · `build-wrapper-docs-capture-receipts.cjs` · `build-wrapper-docs-gateway-routing.cjs`

### 41.4 C

`cerebras-bench.mjs` · `cf-bootstrap.mjs` · `check-assistant-hallucinations.cjs` · `check-sitemap.sh` · `clean-strip-artifacts.cjs` · `cloud-compute-broker.mjs` · `cloud-readiness.mjs` · `cloud-runpod-train.mjs` · `compare-primeintellect.mjs` · `compile-assistant.cjs` · `compile-cloud.cjs` · `compile-cloud-modal.py` · `completions-server.mjs` · `compliance-certification-packet.mjs` · `composite_og.py`

### 41.5 D

`demo.js` · `demo-animation.html` · `deploy-verified.ps1` · `distill-strategy.mjs` · `dogfood-proxy.ps1` · `dotkolm-validate.cjs`

### 41.6 E

`e2e-flow.sh` · `e2e-hub.sh` · `e2e-walk.mjs` · `encode_v6_webp.py`

### 41.7 F

`fal_atmosphere.py` · `fal_brand.py` · `fal_generate_v6.py` · `fal_legendary.py` · `fal_phone_redo.py` · `fal-hero-gen.cjs` · `find-missing-sitemap.cjs` · `finish-public-surface.mjs` · `fix-first-artifact.mjs` · `fix-font-bleed.cjs` · `fix-footer-canonical.mjs` · `fix-forbidden-claims.cjs` · `fix-fouc.py` · `fix-mojibake.mjs` · `fix-nav-compare.cjs` · `fix-nav-research.mjs` · `fix-seo-twitter-cards.mjs` · `fix-theme-bootstrap.cjs` · `format-governance-packet.mjs` · `full-page-shot.mjs`

### 41.8 G

`generate-assistant-pairs.mjs`

### 41.9 I

`inject-cookbook-jsonld.cjs` · `inject-nav.cjs` · `inject-nav-js.cjs` · `ink-linen-scrub.cjs` · `install.ps1` · `install.sh` · `install-mcp.cjs`

### 41.10 K

`kolm-chat.mjs`

### 41.11 L

`llama-cpp-dll-shim.py` · `load-test.cjs` · `local-static-server.mjs` · `local-surface-smoke.cjs`

### 41.12 M

`migrate-pages-to-ks.cjs` · `mobile-audit2.cjs` · `mobile-full-audit.mjs` · `mobile-v715-verify.mjs` · `mobile-zoom.mjs` · `monochrome-scrub.cjs` · `multi-page-shot.mjs`

### 41.13 N

`nav-unify.cjs` · `notion-sync.mjs`

### 41.14 O

`optimize_images.py`

### 41.15 P

`package-release-readiness.mjs` · `patch-docs-shell.cjs` · `prebake-nav-toggle.mjs` · `prebake-theme-toggle.mjs` · `probe-hero-full.mjs` · `probe-mobile-rhythm.mjs` · `probe-pill.mjs` · `probe-postauth.mjs` · `probe-prod-spacing.mjs` · `probe-rhythm.mjs` · `probe-rhythm2.mjs` · `probe-rhythm3.mjs` · `probe-screenshot.mjs` · `probe-sota.mjs` · `probe-spacing.mjs` · `probe-spec-error.mjs` · `probe-teacher-chat.cjs` · `probe-teacher-chat.mjs` · `probe-uc-section.mjs` · `prod-surface-smoke.cjs` · `product-graph-lib.cjs` · `publish-trinity.cjs`

### 41.16 Q

`qa-home.mjs` · `qa-home-bg.mjs` · `qa-research.mjs` · `qa-screenshots.mjs` · `qa-solutions.mjs` · `quality-calibration.mjs` · `quantization-oracle.mjs` · `quick-v716-probe.mjs`

### 41.17 R

`r2-bootstrap.mjs` · `rebuild_brand_og.py` · `recalibrate-kscore.cjs` · `record-demo-90s.mjs` · `record-demo-w905.mjs` · `release-verify.cjs` · `rename-kolmogorov.ps1` · `rewrite-nav-ks.cjs` · `run-ui-gates-local.mjs` · `runtime-adoption-packets.mjs`

### 41.18 S

`screenshot-audit.mjs` · `screenshot-demo.cjs` · `screenshot-element.mjs` · `screenshot-home-segments.mjs` · `screenshot-multi-pages.mjs` · `screenshot-pages.mjs` · `screenshot-prod.mjs` · `screenshot-section.mjs` · `screenshot-site-review.mjs` · `screenshot-verify.mjs` · `screenshot-w624-review.mjs` · `screenshot-w905-sweep.mjs` · `scrub-waves-json.py` · `scrub-waves-v2.py` · `sdk-linux-build.sh` · `seed.js` · `seed-marquee-artifacts.cjs` · `sensitive-data-readiness.sh` · `seo-audit.cjs` · `seo-sweep.cjs` · `setup-prod.sh` · `shard-benchmark.py` · `shard-install-verify.cjs` · `ship-gate.cjs` · `side-by-side.mjs` · `sim-100.mjs` · `simulate-invention-implementation-spec.cjs` · `simulate-invention-portfolio.cjs` · `simulate-product-frontier-implementation-contracts.cjs` · `simulate-product-frontier-lab.cjs` · `simulate-product-frontier-map.cjs` · `simulate-product-frontier-operator-kernels.cjs` · `simulate-product-invention-buildbook.cjs` · `simulate-product-math-frontier.cjs` · `simulate-product-research-atlas.cjs` · `simulate-readiness-gate-workorders.cjs` · `site-screenshot.mjs` · `sitewide-audit.mjs` · `smoke-bench-cli.mjs` · `smoke-chat-nl.sh` · `smoke-device-bind.mjs` · `smoke-kolm.sh` · `smoke-live.sh` · `smoke-models.mjs` · `snap-compile-anatomy.mjs` · `snap-fold.mjs` · `snap-v717.mjs` · `strip-dead-links.cjs` · `strip-duplicate-footers.cjs` · `strip-inline-pitch-black.cjs` · `strip-legacy-nav-blocks.cjs` · `strip-legacy-scripts.cjs` · `strip-legacy-stylesheets.cjs` · `stripe-provision.mjs` · `surface-orphans.mjs` · `swap_brand_mark.py` · `swap_logo_mark.py` · `swap_og_image.py` · `swap_to_webp.py` · `sweep-public-copy.mjs`

### 41.19 T

`test-10-apps.mjs` · `test-complexity-ramp.mjs` · `test-compute-e2e.mjs` · `trim_homepage.py` · `trinity-2000-v2-collect-all.mjs` · `trinity-2000-v2-export.mjs` · `trinity-2000-v2-monitor.mjs` · `trinity-2000-v2-run.mjs` · `trinity-2000-v2-seed-gen.mjs` · `trinity-2000-v2-split-seeds.mjs` · `trinity-500-collect-all.mjs` · `trinity-500-seed-gen.mjs` · `trinity-500-split-seeds.mjs` · `tune-step.py`

### 41.20 U

`ui-surface-audit.cjs` · `ultra-screenshot.cjs`

### 41.21 V

`v717-batch2-verify.mjs` · `v717-extend-verify.mjs` · `v717-final-sitewide-verify.mjs` · `v717-final-verify.mjs` · `v718-audit-full.mjs` · `v718-snap.mjs` · `v718-verify.mjs` · `v7181-qa.mjs` · `v7182-qa.mjs` · `v7183-qa.mjs` · `v7184-qa.mjs` · `v719-qa.mjs` · `v720-1-shots.mjs` · `v720-dash-qa.mjs` · `v720-qa.mjs` · `verify-fixes.cjs` · `verify-header-lock.mjs` · `verify-product-surfaces.cjs` · `verify-sdk-dist.mjs`

### 41.22 W

`w259-arrow-sweep.cjs` · `w259-dead-slug-sweep.cjs` · `w280-title-suffix-fix.cjs` · `w405-after-shot.mjs` · `w405-frontier-shots.mjs` · `w406-page-shots.mjs` · `w850-redline-globals.cjs` · `w850-screenshot.cjs` · `w850-slate-theme-color.cjs` · `w850-static-server.cjs` · `w850-warm-purge.cjs` · `w889-1.5-trinity-publish.cjs` · `w890-1-organization-audit.cjs` · `w890-10-frontend-audit.cjs` · `w890-11-audit.cjs` · `w890-12-documentation-audit.cjs` · `w890-13-deployment-audit.cjs` · `w890-14-performance-audit.cjs` · `w890-15-monitoring-audit.cjs` · `w890-16-final-verification.cjs` · `w890-16-reaggregate-verdict.cjs` · `w890-16-rerun-1-and-6.cjs` · `w890-3-error-handling-audit.cjs` · `w890-3-fix-empty-catches.cjs` · `w890-4-logging-audit.cjs` · `w890-5-testing-audit.cjs` · `w890-6-security-audit.cjs` · `w890-8-storage-audit.cjs` · `w890-9-api-audit.cjs` · `w891-2-1-gguf-load-generate.py` · `w893-add-blog-to-build-column.cjs` · `w893-add-changelog-to-build-column.cjs` · `w893-add-spec-link-to-footers.cjs` · `w893-blog-missing.cjs` · `w893-rename-github-org-public.cjs` · `w893-strip-html-extensions.cjs` · `w902-reorder-homepage.cjs` · `w902-unify-footer.cjs` · `w903-honest-word-scrub.cjs` · `w903-strip-brand-anchor.cjs` · `w917-title-and-org-scrub.cjs` · `warm-paper-injection.cjs` · `wave159-add-training-nav.mjs` · `wave159-purge-honest.mjs` · `wave159-purge-honest-pass2.mjs` · `wave887-docs-generator.cjs` · `wave887-wrapper-prod-benchmark.cjs` · `wave888-wrapper-tax-decomposed.cjs` · `wave895-coverage-sweep.cjs` · `write-extra-cli-docs.cjs` · `write-missing-cli-docs.cjs` · `write-w869-cli-docs.cjs` · `write-w869b-cli-stubs.cjs`

### 41.23 X

`x04-claim-verify.cjs`

---

## 42. Account dashboard — full alphabetical inventory (92 files)

Every file under `public/account/**/*.html`. Subdirectory pathing preserved.

`ab-tests.html` · `active-learning.html` · `agent-telemetry.html` · `api-keys.html` · `approvals.html` · `artifacts.html` · `artifacts/_slug.html` · `artifacts/diff.html` · `audit-log.html` · `bakeoff.html` · `bakeoffs.html` · `bench.html` · `billing.html` · `builds.html` · `builds/new.html` · `captured.html` · `captures.html` · `captures/analytics.html` · `captures/review.html` · `chargeback.html` · `confidence.html` · `connectors.html` · `continuous-monitoring.html` · `create-model.html` · `datasets.html` · `devices.html` · `devices/_slug.html` · `diagnose.html` · `distill/new.html` · `distill-runs.html` · `drift.html` · `drift-alert.html` · `enterprise.html` · `enterprise/sso.html` · `experts.html` · `failure-modes.html` · `federated/consortium.html` · `fleet.html` · `forge.html` · `gateway.html` · `gateway/providers.html` · `governance.html` · `governance/assurance.html` · `governance/cost.html` · `governance/drift.html` · `governance/evidence.html` · `governance/lifecycle.html` · `governance/passport.html` · `groups.html` · `hardware.html` · `keys.html` · `labeling.html` · `lake.html` · `members.html` · `merge/new.html` · `multimodal-bakeoff.html` · `namespaces.html` · `namespaces/new.html` · `onboarding.html` · `onboarding/path-gpu.html` · `onboarding/path-no-gpu.html` · `onboarding/path-route.html` · `onboarding/path-verify.html` · `opportunities.html` · `org.html` · `overview.html` · `pipelines.html` · `pipelines/_template.html` · `pipelines/index.html` · `privacy-events.html` · `quantize/index.html` · `quantize/new.html` · `receipts/index.html` · `recipes.html` · `repeated-workflows.html` · `routing.html` · `savings.html` · `seasonal.html` · `security/2fa.html` · `serve/index.html` · `serve/new.html` · `settings.html` · `settings/integrations.html` · `settings/notifications.html` · `simulations.html` · `sla.html` · `staleness.html` · `storage.html` · `sustainability.html` · `synthetic.html` · `team.html` · `webhooks.html`

Subdirectory layout: `artifacts/` (2) · `builds/` (1) · `captures/` (2) · `devices/` (1) · `distill/` (1) · `enterprise/` (1) · `federated/` (1) · `gateway/` (1) · `governance/` (6) · `merge/` (1) · `namespaces/` (1) · `onboarding/` (4) · `pipelines/` (2) · `quantize/` (2) · `receipts/` (1) · `security/` (1) · `serve/` (2) · `settings/` (2). Top-level pages = 60; subdirectory pages = 32. Total = 92.

Plus 1 JS file: `public/account/whats-next.js`.

---

*End of spec sheet. Counts verified via `find`/`wc -l`/`grep -c` on 2026-05-28. Plan files at repo root are authoritative; this document is a snapshot. Refresh on next wave bump.*
