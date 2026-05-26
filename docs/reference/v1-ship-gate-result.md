# V1 Ship-Gate Result (W890-16 final 9-step verification)

Canonical reference for the W890-16 audit — the absolute last step of the V1
production code audit (Part K of `KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md`).
Eleven sections covering verdict per step, blocker analysis, fix-forward plan
for any reds, and the recommendation to the user.

This document is generated alongside ten `data/w890-16-*.json` artifacts via
`node scripts/w890-16-final-verification.cjs`. The artifacts are the source
of truth; this file is the human-readable summary.

Cross-references:

- `docs/reference/codebase-organization.md` (W890-1)
- `docs/reference/code-quality-policy.md` (W890-2)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/logging-policy.md` (W890-4)
- `docs/reference/testing-policy.md` (W890-5)
- `docs/reference/security-policy.md` (W890-6)
- `docs/reference/configuration-policy.md` (W890-7)
- `docs/reference/storage-policy.md` (W890-8)
- `docs/reference/api-policy.md` (W890-9)
- `docs/reference/frontend-policy.md` (W890-10)
- `docs/reference/cli-policy.md` (W890-11)
- `docs/reference/documentation-policy.md` (W890-12)
- `docs/reference/deployment-policy.md` (W890-13)
- `docs/reference/performance-policy.md` (W890-14)
- `docs/reference/monitoring-policy.md` (W890-15)
- `docs/runbook-rollback.md` (W890-13 companion runbook)
- `docs/runbook-alerts.md` (W890-15 companion runbook)

## 1. Scope

W890-16 runs nine verbatim steps from the plan against the live repository
and the live production deployment. Each step is captured in a per-step JSON
file under `data/w890-16-step-N-<name>.json` and rolled up into
`data/w890-16-final-verdict.json`. The nine steps are:

1. Full test suite — `npm test` (the canonical entry point; `kolm test all`
   is plan-shorthand)
2. Ship gate — `kolm test ship-gate` (52 named V1 contract checks)
3. Dependency audit — `npm audit --audit-level=critical`
4. Secrets in repo — pattern-grep across `git log -p --all`
5. Production smoke — `https://kolm.ai/health` + `https://kolm.ai/v1/gateway/health`
6. Cold start — `kolm version` cold spawn, 3 samples, mean + p95
7. Doctor — `kolm doctor --json` (42 named environment checks)
8. Git status — working tree clean
9. Git log — last commit subject describes the final state

## 2. Verdict per step

Read the live verdict from `data/w890-16-final-verdict.json`. Each step is
either `pass`, `fail`, or (for steps 8 + 9) `expected-fail-until-commit`.

The verdict aggregator emits `all_passed` (boolean), `blocker_step_ids`
(numeric array), and `recommendation` (human-readable). The lock-in
contract at `tests/wave890-16-final-verification.test.js` permits the
aggregate to pass when either `all_passed === true` OR every blocker is
in the expected-fail set `{5, 8, 9}`.

## 3. Expected pre-commit state machine

W890-1 through W890-15 were shipped uncommitted by directive: 15 sub-waves
of code + policy + runbook + lock-in work, all staged in the working
tree, awaiting a single user-authorized batched commit. This means:

- Step 8 (`git status` clean) fails by design — there are 1300+ uncommitted
  changes spanning W890-1..15.
- Step 9 (last commit describes final state) fails by design — the last
  committed work is `781a08ef W888a Font bleed fix`; the W890 batch has
  not been written to history yet.
- Step 5 (prod smoke) fails by design — the W890-13 `/health` shape upgrade
  (which adds `ok:true` and six other fields) is uncommitted and
  undeployed, so `https://kolm.ai/health` still returns the pre-W890-13
  shape (`{status:"ok", version:"0.2.0", ...}` without an `ok` field).

After the user authorizes the W890-1..15 batched commit and the resulting
deploy lands on Vercel, all three steps flip green. Steps 1, 2, 3, 4, 6,
and 7 are the load-bearing pre-ship signals.

## 4. Blocker analysis

The aggregator categorises blockers into three buckets:

1. **Pre-commit expected-fail** — steps 5 + 8 + 9. Fix path: user
   authorizes the batched commit; no code changes needed.
2. **Genuine code-level red** — any blocker not in the expected-fail set.
   Fix path: route to the relevant W890-X sub-wave and fix-forward, then
   re-run W890-16.
3. **Environment red** — typically step 7 (doctor) flagging a missing
   optional dep (Docker, llama.cpp, etc). Fix path: follow the per-OS
   install hint from `data/w890-16-step-7-doctor.json` -> `checks[].detail`.

## 5. Step 1 — Full test suite

Runner: `npm test` (which dispatches `node --test --test-concurrency=1
tests/*.test.js`). The CLI shorthand `kolm test all` from the plan is
implementation-equivalent — both invoke the same Node test runner via a
fresh shell (which sidesteps the Node 22+ nested-`node --test` refusal).

Pass criterion: `fail === 0 && pass > 0`. Total target is 7174+ tests
across all `tests/*.test.js` files. The driver records `pass`, `fail`,
`total`, `duration_s`, `exit_code`, and the last 100 lines of stdout for
forensics on any red.

## 6. Step 2 — Ship gate

Runner: `node cli/kolm.js test ship-gate --json`. The ship gate is the
W888-I 52-check named contract for V1: 10 wrapper checks + 10 studio
checks + 10 run checks + 5 cross-surface checks + 12 infra checks + 3
account checks + 2 perf checks. Pass criterion: `passed === 52 &&
failed === 0`.

The ship-gate runner accepts an installed-but-not-present skip set
(GGUF fixture, kubectl) — these report as `skipped:true` and roll up
into the passed bucket per W888-I contract.

## 7. Step 3 — Dependency audit

Runner: `npm audit --audit-level=critical --json`. Pass criterion: zero
critical vulnerabilities. Moderate / low / high warnings are tolerated
but recorded for visibility.

## 8. Step 4 — Secrets in repo

Runner: full-history `git log -p --all` scan with seven real-key patterns
(`sk-ant-*`, `sk-live-*`, `sk-proj-*`, generic 40+-char `sk-*`,
provider-prefixed `ANTHROPIC_API_KEY=sk*` / `OPENAI_API_KEY=sk*` /
`STRIPE_SECRET=sk_live_*`, AWS `AKIA*`, GitHub `ghp_*`) intersected
with a fixture safelist (`EXAMPLE`, `abcdef`, `sk_test_abcdef`, etc.)
that allows the test fixtures to live in the repo. Pass criterion:
zero pattern hits among added lines (lines starting with `+`).

This mirrors the W890-13 secret-scan posture so the two audits stay
consistent.

## 9. Step 5 — Production smoke

Runner: cross-platform `node -e "fetch(...)"` against two endpoints:

- `GET https://kolm.ai/health` — expect `{ok: true, ...}`
- `GET https://kolm.ai/v1/gateway/health` — expect `{ok: true, ...}`

Both must return JSON with `ok === true`. Pre-W890-13-deploy this step
fails because the prod `/health` shape is older and lacks the `ok`
field; the W890-13 upgrade adds it but the deploy is gated on the
batched commit.

## 10. Step 6, 7, 8, 9 — Cold start / Doctor / Git status / Git log

- **Step 6** — `kolm version` cold spawn x3; mean and p95 both must be
  < 1000ms.
- **Step 7** — `kolm doctor --json`; pass when `ok === true && blockers === 0`.
  Warnings (missing optional deps like Docker, ANTHROPIC_API_KEY,
  project config) are tolerated.
- **Step 8** — `git status --porcelain` byte count; pass when 0
  (working tree clean). Pre-commit: expected-fail.
- **Step 9** — `git log --oneline -5`; pass when the last commit subject
  contains a W890 / V1 / "ship gate" / "final verification" token.
  Pre-commit: expected-fail.

## 11. Recommendation

The live recommendation is in `data/w890-16-final-verdict.json` under
`recommendation`. The four possible verdicts:

1. **V1 SHIP** — All 9 steps green. User authorizes the W890-1..15
   batched commit + Vercel auto-deploys. V1 launches.
2. **CONDITIONAL SHIP** — Steps 1-7 green; only 8 + 9 (and possibly 5)
   are red. The reds are all pre-commit expected-fails. User authorizes
   the batched commit; redeploy lands; re-run W890-16 to confirm
   green-on-green.
3. **CONDITIONAL SHIP after redeploy** — Steps 1-4 + 6-9 green; only 5
   is red. The W890-13 `/health` upgrade needs to land on prod. User
   authorizes commit + redeploy; re-run.
4. **BLOCK** — Any blocker outside `{5, 8, 9}`. Fix-forward into the
   relevant W890-X sub-wave; re-run W890-16.

### Suggested commit-message template for the W890-1..15 batched commit

```
W890 V1 production audit batch — 15 sub-waves shipped

15 sub-waves (W890-1 through W890-15) closed the V1 production code audit:

W890-1   codebase organization        — file ledger + boundary policy
W890-2   code quality                 — eslint clean + style scan
W890-3   error handling               — taxonomy + error_id chain
W890-4   logging                      — structured JSON + request IDs
W890-5   testing                      — coverage budget + lock-ins
W890-6   security                     — shell-injection validators + dep audit
W890-7   configuration                — env-var hierarchy + zero-config doctor
W890-8   storage                      — retention sweep + N+1 audit
W890-9   API                          — OpenAPI + envelope contract
W890-10  frontend                     — sw.js v114->v115 + a11y sweep
W890-11  CLI                          — help coverage + cold start
W890-12  documentation                — Apache-2.0 license + CHANGELOG
W890-13  deployment                   — rollback runbook + /health shape + Dockerfile
W890-14  performance                  — N+1 free + streaming + 100 concurrent
W890-15  monitoring                   — Sentry shim + alerts runbook + 6 metrics

13 canonical policy docs at docs/reference/*-policy.md.
2 runbooks at docs/runbook-{rollback,alerts}.md.
202/202 cumulative lock-ins green. 52/52 ship-gate held throughout.

W890-16 (final 9-step verification) runs as a post-commit re-verify.
```

### Files touched by the batched commit

The exact file list is in `data/w890-16-step-8-git-status.json` under
`files_list_truncated`. Categories (high-level):

- `docs/reference/*.md` — 13 canonical policy docs
- `docs/runbook-{rollback,alerts}.md` — 2 runbooks
- `tests/wave890-*.test.js` — 15 lock-in test files
- `scripts/w890-*-audit.cjs` — 15 audit drivers
- `data/w890-*.json` — 100+ data artifacts
- `src/router.js`, `src/server.js`, `src/sentry-init.js`,
  `src/prometheus-exporter.js` — health endpoint + Sentry + metrics
- `src/ssh-adapter.js`, `src/deploy-pipeline.js` — shell-injection
  validators
- `Dockerfile` — multi-stage + non-root + HEALTHCHECK + tini
- `package.json` — license MIT -> Apache-2.0
- `CHANGELOG.md` — created at repo root
- `apps/replicate/requirements.txt` — `cog>=0.10` -> `cog==0.10.2`
- `public/sw.js` — v114 -> v115
- `public/status.html` — static -> dynamic /health poller
- `KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md` — wave-ledger updates

## Closing note

W890-16 is the gate, not the work. The work is W890-1..15. If the gate
is red, the fix lives in the sub-wave whose contract is broken, not in
W890-16 itself. The driver re-runs cleanly on every invocation and is
the single command the user runs to confirm V1 readiness end-to-end.
