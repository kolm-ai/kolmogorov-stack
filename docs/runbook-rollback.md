# Rollback Runbook

Restore the previous deployment in **under 5 minutes**. This runbook is the
load-bearing on-call recipe for `kolm.ai` (Vercel frontend + Vercel API
routes) and `api.kolm.ai` (Railway backend). Copy-paste commands; do not
extemporise.

> Audit artifact: `data/w890-13-rollback.json`. Sibling docs: `docs/reference/deployment-policy.md`, `docs/operations/sentry-setup.md`.

---

## When to roll back

Roll back when ANY of:

- `/health` returns non-200 for >60s on production
- Error rate exceeds 5% for >2 minutes
- Receipts stop verifying (regression in `kolm verify`)
- Capture-store unreachable signal in `/status`
- A user-reported issue can be reproduced in <2 minutes

Do **not** roll back for:

- Single user-reported issues that need investigation
- Latency increase below 2x baseline (open an incident; roll back only if
  baseline is breached for >5min)
- Cosmetic regressions (open a hotfix PR instead)

---

## Time budget

| Step | Target | Hard ceiling |
| --- | --- | --- |
| Identify last-known-good deploy | 30s | 60s |
| Trigger rollback (Vercel) | 30s | 90s |
| Trigger rollback (Railway) | 60s | 180s |
| Verify `/health` returns 200 | 30s | 60s |
| Verify `/v1/whoami` works | 30s | 60s |
| **Total** | **3min** | **<5min** |

---

## Path A: Vercel rollback (frontend + edge API routes)

Vercel deployments are immutable. Rollback is an alias swap — the previous
deployment URL still exists and is reachable; we just point the production
alias at it.

### A1. Identify the last-known-good deployment URL

```bash
# List the most recent production deploys.
vercel list --prod --limit 10
# Output:
#   URL                                          State    Created  
#   kolm-ai-abc123def-kolm.vercel.app            READY    2m ago   <- current (bad)
#   kolm-ai-789xyz456-kolm.vercel.app            READY    1h ago   <- last-known-good
#   ...
```

### A2. Swap the production alias (the rollback)

```bash
# Replace <last-good-deploy-url> with the URL from A1.
vercel alias set kolm-ai-789xyz456-kolm.vercel.app kolm.ai
vercel alias set kolm-ai-789xyz456-kolm.vercel.app www.kolm.ai
```

Alternative one-liner via the Vercel dashboard: open
`https://vercel.com/kolm-ai/kolm-ai/deployments`, find the last-known-good,
click the three-dot menu, "Promote to Production". Same effect.

### A3. Verify

```bash
curl -s https://kolm.ai/health | jq .
# Expect: { "ok": true, "version": "0.2.0", "git": "<short-sha>", ... }
```

The `git` field must show the older SHA (the one you rolled back to).

---

## Path B: Railway rollback (backend `api.kolm.ai`)

Railway keeps the last N immutable deployments per service. Rollback uses
the Railway dashboard or CLI.

### B1. List recent deployments

```bash
railway deployments
# Output:
#   ID          Status    Created      Commit
#   abc123def   SUCCESS   2m ago       a1b2c3d <- current (bad)
#   789xyz456   SUCCESS   1h ago       e4f5g6h <- last-known-good
```

### B2. Roll back

```bash
# Roll back to the last-known-good deployment.
railway rollback 789xyz456
```

If the CLI is not authenticated on the on-call machine, use the dashboard:
`https://railway.app/project/<id>/service/<id>/deployments` → previous
deployment → "Redeploy".

### B3. Verify

```bash
curl -s https://api.kolm.ai/health | jq .
# Expect: { "ok": true, "version": "0.2.0", "git": "e4f5g6h", ... }

curl -s https://api.kolm.ai/v1/whoami -H "Authorization: Bearer $KOLM_PROD_KEY" | jq .
# Expect: { "ok": true, "key": { ... }, "tenant": "..." }
```

---

## Path C: Git revert (the nuclear option)

Use this only when both Vercel AND Railway rollback paths are unavailable
(rare; would require both platform dashboards down at the same time).

```bash
# 1. Identify the last-known-good commit.
git log --oneline -20

# 2. Revert (do NOT --hard reset; we want the revert in the history).
git revert <bad-commit-sha>

# 3. Push to both remotes. Vercel + Railway will auto-deploy.
git push origin main
git push public main
```

Time budget for this path is wall-clock dominated by the rebuild (3-5min on
Vercel, 2-4min on Railway). Use Path A / Path B first.

---

## Post-rollback checklist

After the rollback succeeds:

- [ ] `/health` returns 200 with the older `git` SHA
- [ ] `/v1/whoami` returns 200 with the production API key
- [ ] At least one fresh `/v1/bridges/observe` capture writes successfully
- [ ] `/v1/verify/<cid>` returns the same hash chain as before
- [ ] Sentry shows no new error spike post-rollback
- [ ] Open a post-mortem doc within 2h naming root cause + fix-forward plan
- [ ] File a hotfix PR (do NOT push to main without review) to address the
      regression that triggered the rollback

---

## Verify the runbook

Each release-eligible build runs the W890-13 audit:

```bash
node scripts/w890-13-deployment-audit.cjs
node --test tests/wave890-13-deployment.test.js
```

The audit verifies this file exists, names both rollback paths, names the
&lt;5min time budget, and names the git fallback. Lock-in #2 fails if any of
those signals are missing.
