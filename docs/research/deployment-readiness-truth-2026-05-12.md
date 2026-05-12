# Deployment Readiness Truth

Date: 2026-05-12

Backlog target: RB-004, "What is the minimum production deployment profile?"

The row-level scenario matrix is `deployment-readiness-matrix-2026-05-12.csv`.

## What `/ready` Actually Requires

`runtimeReadiness()` treats the runtime as production-like when any of these are set:

- `NODE_ENV=production`
- `RAILWAY_ENVIRONMENT`
- `VERCEL`
- `AWS_LAMBDA_FUNCTION_NAME`

In production-like mode, blocking checks are:

- strong `RECIPE_RECEIPT_SECRET`,
- acceptable store mode,
- writable `KOLM_DATA_DIR`,
- writable artifact output path or accepted temp artifact fallback.

Non-blocking checks:

- `ADMIN_KEY`,
- `ANTHROPIC_API_KEY`.

## Minimum Passing Profiles

| Profile | Required Env | Status | Caveat |
| --- | --- | --- | --- |
| SQLite profile | Strong `RECIPE_RECEIPT_SECRET`, `KOLM_STORE_DRIVER=sqlite`, `KOLM_DB_PATH`, writable `KOLM_DATA_DIR`, writable artifact path or fallback. | `ready` | Node emitted an `ExperimentalWarning` for `node:sqlite`; operational support should be explicit. |
| Temporary JSON profile | Strong `RECIPE_RECEIPT_SECRET`, `KOLM_ALLOW_JSON_STORE=true`, writable `KOLM_DATA_DIR`, writable artifact path or fallback. | `ready` | This is a single-node/temporary deployment profile, not a durable multi-node SaaS profile. |

## Blocking Failures Observed

| Scenario | Result | Blockers |
| --- | --- | --- |
| Production with no receipt secret and default JSON store | `not_ready` | `receipt_secret`, `store_driver` |
| Production with weak receipt secret and JSON override | `not_ready` | `receipt_secret` |
| Production with strong receipt secret but default JSON store and no override | `not_ready` | `store_driver` |
| Production with strong receipt secret, JSON override, missing data dir | `not_ready` | `data_dir` |

## Test Drift Found

Command:

`node --test tests\auth.test.js`

Result outside the sandbox:

- `1` test failed
- failure: `tests/auth.test.js:89`
- expected: `runtimeReadiness().status === "not_ready"`
- actual: `"ready"`

Cause: `runtimeReadiness()` now allows artifact output to fall back to `os.tmpdir()/kolm-artifacts` when `KOLM_ARTIFACT_DIR` is missing or unwritable, but the test still expects a missing artifact dir to block readiness.

This is a real semantic decision point:

- If compiled artifacts must be durable in production, `/ready` should fail when `KOLM_ARTIFACT_DIR` is set but missing.
- If temp artifact fallback is acceptable, the test should be updated and public/operator docs must say artifacts may expire.

## Product Truth

Safe wording:

- "`/ready` checks receipt secret, production storage mode, data directory, and artifact writeability."
- "Production can run with SQLite or an explicit JSON-store override for temporary single-node deployments."
- "Model provider and admin key are surfaced but do not block readiness."

Unsafe wording without more controls:

- "Production-ready durable compiler."
- "Artifacts are durably retained by default."
- "JSON store is production-safe."
- "SQLite profile is fully settled" without noting current Node experimental warning.

## Recommended Follow-Up

1. Decide whether artifact temp fallback is allowed in production readiness.
2. Fix either `runtimeReadiness()` or `tests/auth.test.js` so code and test agree.
3. Add `/ready` live-deploy smoke coverage for `kolm.ai`.
4. Document the accepted launch profile: SQLite single-node, JSON override, or a future Postgres/queue profile.
5. Add a retention warning anywhere compiled artifact download URLs are shown when artifact storage is temporary.
