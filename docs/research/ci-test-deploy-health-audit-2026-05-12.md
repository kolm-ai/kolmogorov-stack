# CI, Test, And Deploy Health Audit

Date: 2026-05-12

Scope: local CI workflow review, root test execution, SDK test/syntax probes, deploy config review, and comparison against the auth, tenant-data, billing, SDK, sandbox, and readiness audits in this research directory.

## Executive Findings

1. P1: the canonical root suite is red. After fixing research-doc wording that tripped the stale-positioning gate, `npm test` reports 53 pass / 1 fail. The remaining failure is the known readiness semantics mismatch: production-like auth test expects `not_ready`, while `runtimeReadiness()` currently reports `ready` through a temporary artifact directory fallback.
2. P1: CI does not run the root test suite. The lint workflow runs static checks and `npm audit`; the smoke workflow starts the server and runs a shell smoke script. Neither workflow runs `npm test`.
3. P0/P1: major risk surfaces from the current audits are not gated. There are no normal-suite tests for anon claim proof, query API keys, public route manifests, account deletion lifecycle, recall path containment, public-run abuse controls, billing route/webhook flows, or SDK package contracts.
4. P1: the browser SDK can ship broken. Current `public/sdk.js` and versioned SDK files fail `node --check`, while the live smoke script only checks HTTP headers and marker strings.
5. P1: deploy configuration is split across Vercel, Railway, Docker, and GitHub Actions with meaningful drift. Vercel proxies API traffic to legacy Railway infrastructure, Railway health checks `/health` instead of `/ready`, Docker skips the npm start build step, and the reusable GitHub compile action does not match the current CLI cloud compile contract.

## Current Test State

Command run:

```text
cmd /c npm test
```

Result:

```text
tests 54
pass 53
fail 1
```

Failing test:

```text
tests/auth.test.js
admin fallback key is disabled in production-like hosts
actual: ready
expected: not_ready
```

This is not a new regression introduced by the research docs. It matches the readiness drift already tracked in `deployment-readiness-truth-2026-05-12.md`: `src/env.js` permits a temporary artifact fallback in production-like mode, while the test expects missing durable artifact storage to block readiness.

## CI Coverage Reality

`lint.yml` checks:

- install with Node 20,
- forbidden raw `innerHTML` template literals in `public/`,
- orphan Vercel rewrites,
- static asset references,
- internal href targets,
- high-severity production dependency audit.

`smoke.yml` checks:

- install with Node 20,
- start `node server.js` on port 8787,
- run `scripts/smoke-live.sh` against localhost.

Neither workflow runs `npm test`, browser SDK syntax checks, SDK package tests, Python tests, or generated route/auth manifests.

The live smoke script is valuable breadth coverage, but it is string-heavy. For example, it checks that `/sdk.js` contains `export const recipe`, `class Recipe`, and `wrap(client)`. The current SDK still satisfies those marker checks even though it is syntax-invalid.

## Deployment Drift

`vercel.json` serves static pages and proxies `/health`, `/ready`, and `/v1/*` to the legacy Railway backend. This can create a split-brain production posture: a fresh Vercel static deploy can present current docs and SDK files while API behavior comes from another origin.

`railway.toml` uses `/health` as the deploy health check. `/health` is useful liveness, but it does not enforce the strict production readiness conditions tracked in the readiness audit.

`Dockerfile` runs `node server.js` directly. `npm start` runs `scripts/build-sdk-version.js` before `node server.js`. If Docker remains a production path, the entrypoints should be reconciled so SDK manifests and generated assets are handled consistently.

The reusable GitHub compile action calls the CLI with stale flags/output expectations: it invokes compile with `--base` and `--json`, then parses JSON fields that the current cloud compile path does not emit. The current CLI cloud compile path uses `--base-model`, posts to `/v1/compile`, prints progress/prose, downloads the artifact, and reports `job_id` behavior. The action should either consume a real stable JSON mode or be updated to the current prose/field contract.

## Test Gap Map

Highest-priority missing gates:

- Auth: anon claim must require proof for existing accounts; query-string API keys should be rejected or explicitly deprecated; route public/protected status needs a manifest.
- Billing: signed webhook route fixtures must bind payment amount/price to plan activation; cancel, change-plan, delete, and quota response shapes need route tests.
- Tenant lifecycle: account deletion/deactivation must define and test data, public registry, cache, and access behavior.
- Recall/source preview: path containment must be tested for sibling prefixes and encoded traversal cases.
- Public runtime: unauthenticated public runs need rate-limit, input-size, quota/cost, and receipt-boundary tests.
- SDKs: browser syntax/import/worker gates, Node fetch-mocked tests, Python byte-compile/import/HTTP contract tests, and MCP public-helper tests should be required before public SDK claims.

## Recommended Gate Order

1. Restore a green root `npm test` by resolving the readiness storage semantics.
2. Make `npm test` required in CI.
3. Add browser SDK syntax/import gates and rebuild versioned SDK assets.
4. Add route-level regression tests for the P0 auth and billing issues.
5. Align Vercel/Railway/Docker/GitHub Action deploy contracts around one production target and one strict readiness definition.

See `ci-test-deploy-health-matrix-2026-05-12.csv` for row-level evidence and actions.
