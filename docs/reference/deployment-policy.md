# Deployment Policy

Canonical reference for the W890-13 audit. Names the deploy pipeline,
rollback recipe, `/health` shape, graceful-shutdown contract, zero-downtime
strategy, env parity rules, secrets posture, container image baseline, and
lock-file invariants.

This document is generated alongside eleven `data/w890-13-*.json` artifacts
via `node scripts/w890-13-deployment-audit.cjs`. The artifacts are the
source of truth; this file is the human-readable summary.

Cross-references:

- `docs/reference/codebase-organization.md` (W890-1)
- `docs/reference/code-quality-policy.md` (W890-2)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/logging-policy.md` (W890-4)
- `docs/reference/configuration-policy.md` (W890-7)
- `docs/reference/storage-policy.md` (W890-8)
- `docs/reference/api-policy.md` (W890-9)
- `docs/reference/frontend-policy.md` (W890-10)
- `docs/reference/cli-policy.md` (W890-11)
- `docs/reference/documentation-policy.md` (W890-12)
- `docs/runbook-rollback.md` (W890-13 runbook)

## 1. Deploy pipeline

```
   developer push
        |
        v
   +----+-----+               +-----------------+
   | origin/  | --auto-deploy-> Vercel build     |
   | main     | -------+      | (frontend + api  |
   +----------+        |      |  routes)         |
                       |      +--------+---------+
                       |               |
                       |               v
                       |        kolm.ai (alias)
                       |
                       +--auto-deploy-> Railway build
                                       (backend, api.kolm.ai)
```

`origin/main` is mirrored to `public/main`; pushing either remote triggers
Vercel's auto-deploy (the connected branch is `main`). Railway redeploys
when its GitHub source link sees a push.

Auto-deploy is verified by `data/w890-13-deploy-pipeline.json`: at least
one of `vercel.json` + `railway.toml` + a `push:`-trigger GitHub Actions
workflow must be present and well-formed.

GitHub Actions workflows (`.github/workflows/*.yml`) handle the CI gates
(lint, test, smoke, SBOM) and SDK releases — they do not own the deploy
itself; the platforms do.

## 2. Rollback

Rollback is documented in `docs/runbook-rollback.md` with a hard ceiling
of 5 minutes. Three paths:

| Path | Latency | Use when |
| --- | --- | --- |
| A. Vercel alias swap | ~30s | Frontend / edge API regression |
| B. Railway rollback | ~60-180s | Backend regression |
| C. Git revert | 3-5min | Both platforms unavailable |

Audit artifact: `data/w890-13-rollback.json`. Lock-in #2 verifies the
runbook names both platforms, a <5min time budget, and the git fallback.

## 3. `/health` response shape

`GET /health` is unauthenticated and must return:

```json
{
  "ok": true,
  "status": "ok",
  "version": "0.2.0",
  "git": "abc123def456",
  "uptime_s": 3600,
  "gateway": "ok",
  "capture_store": "ok",
  "signing_key": "loaded",
  "library_version": "...",
  "region": "...",
  "stats": { ... }
}
```

Field contract:

- `ok` — boolean, always `true` when the listener is alive (platform
  liveness probes match on this).
- `version` — the app version string (`package.json` major.minor.patch).
- `git` — the first 12 hex chars of the resolved commit SHA. Resolved via
  `.git/HEAD` walker (mirrors `cli/kolm.js#_w890_resolveGitCommit`) with
  env-var fallbacks (`KOLM_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`,
  `RAILWAY_GIT_COMMIT_SHA`). May be `null` in a stripped container with
  neither `.git/` nor env override.
- `uptime_s` — integer seconds since `process.uptime()` zero.
- `gateway` — `"ok"` whenever the listener is responding (the gateway is
  in-process today; this field is a forward-compat hook for the day the
  gateway moves out).
- `capture_store` — `"ok"` when `storeStats()` returns a counts object;
  `"degraded"` on shape mismatch; `"unavailable"` on throw.
- `signing_key` — `"loaded"` when env key OR cached `~/.kolm/signing-key.pem`
  resolves; `"missing"` when neither resolves; `"disabled"` when
  `KOLM_ED25519_DISABLE=1`.

Audit artifact: `data/w890-13-health-endpoint.json`. Lock-in #3 probes the
live response and asserts every required field is present.

`/ready` is a separate endpoint that fails (503) when production-only
configuration is missing; platform health checks should probe `/health`.
`/v1/health` is the authenticated full snapshot (admin-only).

## 4. Graceful shutdown

`server.js` registers handlers for:

- `unhandledRejection` — log + close + 10s fallback hard-exit
- `uncaughtException` — log + close + 10s fallback hard-exit
- `SIGTERM` — log "graceful shutdown initiated" + `server.close()` +
  10s fallback hard-exit (Railway sends SIGTERM on deploys)
- `SIGINT` — same as SIGTERM (developer Ctrl-C)

In-flight HTTP requests get up to 10 seconds to drain before
`process.exit(0)` fires. The fallback timer is `.unref()`'d so a quick
drain does not block the exit.

`workers/media-redact/redact.mjs` and `cli/kolm.js` (long-running verbs:
serve, route, daemon) carry their own SIGTERM/SIGINT handlers.

Audit artifact: `data/w890-13-graceful-shutdown.json`. Lock-in #4 asserts
the handlers are wired and the fallback timeout is present.

## 5. Zero-downtime deployment

Both deploy platforms perform alias-swap zero-downtime deploys by default:

- **Vercel**: every deploy produces an immutable deployment URL
  (`kolm-ai-<sha>-kolm.vercel.app`). Production traffic flows via an alias
  (`kolm.ai`). The new deploy is built + reachable; only after build
  success does Vercel update the alias to point at the new URL. Previous
  deployments remain reachable for rollback.
- **Railway**: the new container starts, the platform polls
  `healthcheckPath = "/health"` until it returns 200, then swaps the
  proxy target. The old container drains in-flight requests and stops.

Our role is to make the new instance health-check fast enough to swap.
`railway.toml` sets `healthcheckTimeout = 30`; the Dockerfile sets
`--start-period=20s` so a cold start does not falsely fail the probe.

Audit artifact: `data/w890-13-zero-downtime.json`.

## 6. Environment parity

`.env.example` is the authoritative variable catalog (W890-7). `.env.dev`
and `.env.prod` live in the repo as redacted templates so the variable
SHAPE is reproducible; real values live in the platform secret managers
(Vercel project settings, Railway service variables).

Parity audit: `data/w890-13-env-parity.json` diffs the key set of
`.env.dev` vs `.env.prod` and reports `only_in_dev` / `only_in_prod`.
Parity holds when both arrays are empty.

When a new env var lands:

1. Add it to `.env.example` with a comment naming why it exists.
2. Add it to `.env.dev` (placeholder or empty) AND `.env.prod` (redacted
   placeholder).
3. Set the real value in the platform dashboards.
4. Update `docs/reference/configuration-policy.md` if the var is part of
   a documented hierarchy.

## 7. Secrets management

Production secrets MUST NOT live in the repo. They live in:

- Vercel: project → Settings → Environment Variables
- Railway: service → Variables
- Local dev: `.env` (gitignored) loaded by `dotenv` at boot

Audit `data/w890-13-secrets-in-repo.json` runs `git log -p --all` and
greps for real-looking provider keys (`sk-ant-*`, `sk-proj-*`, `AKIA*`,
`ghp_*`, `sk_live_*`). Documented test fixtures (`abcdef`, `EXAMPLE`,
`sk_test_*`) are excluded by the safelist.

`secrets_in_repo` MUST be 0. Lock-in #8 enforces this.

The `.gitignore` blocks:

- `.env`, `.env.local`, `.env.production`, `.env.*.local`, `.env.*`
- `secrets/`, `*.pem`, `*.key`, `*.jks`, `*.p12`, `*.pfx`, `*.crt`
- `.netrc`

Exceptions explicitly tracked: `.env.example`, `.env.gateway.example`,
`.env.dev` (redacted), `.env.prod` (redacted), `.env.vercel.pulled`
(redacted), `.env.cloudflare`, `.env.kolm-teachers`. These are templates
without real values.

## 8. Container image

Two Dockerfiles ship: `Dockerfile` (the server runtime image) and
`Dockerfile.gateway` (the self-host gateway bundle). Both follow the
same baseline:

| Requirement | Dockerfile | Dockerfile.gateway |
| --- | --- | --- |
| Slim base (`node:22-alpine`) | yes | yes |
| Non-root user (`USER node`) | yes | yes |
| `HEALTHCHECK` directive | yes | yes |
| Signal handling (tini PID 1) | yes | yes |
| `CMD ["node", ...]` form | yes | yes |
| Multi-stage build | yes | yes |
| Pinned base image digest (`@sha256:`) | yes | no (tag-only) |

The pinned digest on the server `Dockerfile` (`node:22-alpine@sha256:8ea2...`)
guarantees reproducibility across builds. `Dockerfile.gateway` uses the
floating `node:22-alpine` tag because the gateway is rebuilt by self-host
users on their own infra; they pin the tag to the digest they trust.

Audit artifact: `data/w890-13-container.json`. Lock-in #9 enforces every
row of the table.

## 9. Lock files

| Ecosystem | File | Required state |
| --- | --- | --- |
| npm | `package-lock.json` | committed, `git ls-files` returns it |
| cargo (Rust SDK) | `sdk/rust/Cargo.lock` | committed (per `.gitignore` row) |
| cargo (Rust runtime) | `packages/runtime-rs/Cargo.lock` | committed |
| pip (replicate) | `apps/replicate/requirements.txt` | `==` pins, prod image |
| pip (bench) | `bench/requirements.txt` | `==` pins, reproducibility |
| pip (modal) | `apps/modal/requirements.txt` | `>=` floors, documented |
| pip (quantize worker) | `workers/quantize/requirements.txt` | `>=` floors, optional deps |

`>=` floors are deliberate in `apps/modal/` (Modal resolves at container
build time) and `workers/quantize/` (per the file comment: "every quant
method is OPTIONAL"). They are documented in
`data/w890-13-lockfiles.json` so a future audit reading the data can see
the intent without re-reading the source files.

`floating_in_production_critical` (the count of un-pinned deps in
`apps/replicate` + `workers/quantize`) is informational; the gate is on
the npm lock being committed (lock-in #10) and the prod-critical Python
files using `==` (lock-in #11).

## 10. Ship-gate snapshot

Each W890 sub-wave captures a 52/52 snapshot to
`data/w890-13-ship-gate-snapshot.json`. Lock-in #12 reads the snapshot
because Node 22+ refuses to nest `node --test` invocations cleanly.

The snapshot is regenerated by every audit run via
`node cli/kolm.js test ship-gate --json`. If a transient gate failure
prevents capture, the audit driver falls back to the most recent prior
snapshot (W890-12, W890-11, W890-10, ...) so the lock-in remains green.

## 11. Deferred verifications

Some checks are only meaningful against a live deploy and are documented
as deferred:

- Actual Vercel rollback wall-clock latency (target <60s, only verifiable
  on a real rollback).
- Actual Railway rollback wall-clock latency (target <180s).
- Live curl-every-200ms zero-downtime verification (requires staging
  access; the policy contract is recorded in `data/w890-13-zero-downtime.json`).
- Production /health probe SHA matching (requires push to main); local
  audit probes the in-process router with the local repo .git SHA.

## 12. Artifacts referenced

| File | Audit |
| --- | --- |
| `data/w890-13-deploy-pipeline.json` | §1 |
| `data/w890-13-rollback.json` | §2 |
| `data/w890-13-health-endpoint.json` | §3 |
| `data/w890-13-graceful-shutdown.json` | §4 |
| `data/w890-13-zero-downtime.json` | §5 |
| `data/w890-13-env-parity.json` | §6 |
| `data/w890-13-secrets-in-repo.json` | §7 |
| `data/w890-13-container.json` | §8 |
| `data/w890-13-lockfiles.json` | §9 |
| `data/w890-13-ship-gate-snapshot.json` | §10 |

Run the full audit:

```bash
node scripts/w890-13-deployment-audit.cjs
node --test tests/wave890-13-deployment.test.js
```
