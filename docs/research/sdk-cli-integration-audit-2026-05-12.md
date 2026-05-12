# SDK And CLI Integration Audit

Date: 2026-05-12

Scope: local review of package metadata, root CLI, browser SDK, Node SDK, Python SDK, MCP server, public docs, README, and focused syntax/mock smokes.

## Executive Findings

1. P0: the browser SDK is syntactically broken. `node --check` fails for `public/sdk.js` and every versioned `public/sdk-*.js` file, including the asset pinned by `sdk-current.json`.
2. P1: public convenience helpers are not actually public. The Node SDK `recipe.isSpam()` path and MCP named recipe path resolve public recipes, then call protected `/v1/run` without auth instead of `/v1/public/run`.
3. P1: Python clients are badly out of sync with the current HTTP and CLI contracts. Batch synthesis, verify, public run, compile request/response handling, and CLI flags are mismatched.
4. P1: install/package names are inconsistent across root package, README, public docs, Node SDK, MCP, and Python SDK.
5. P2: SDK tests are live-server smokes, not stable package tests. Node SDK tests fail by default without a localhost server, and Python syntax could not be verified because Python is not installed in this environment.

## Browser SDK: Hard Failure

All browser SDK assets fail syntax check:

```text
public/sdk.js:18
Unexpected token ':'
```

The same failure appears in:

- `public/sdk.js`
- `public/sdk-c102c349da28.js`
- `public/sdk-4d6d60e67927.js`
- `public/sdk-ef22b94a7a38.js`

`public/sdk-current.json` points to `sdk-c102c349da28.js`, so the immutable/SRI recommended path is also broken. This blocks the advertised pattern:

```js
import { recipe } from 'https://kolm.ai/sdk.js';
```

Add `node --check public/sdk.js`, a real browser import smoke, and a versioned SDK rebuild gate before publishing any `sdk-current.json`.

## Public Helpers Call Protected Runtime

Mocked Node SDK smoke:

```json
{
  "error": "missing api key",
  "status": 401,
  "calls": [
    { "url": "https://kolm.ai/v1/public/featured", "method": "GET", "hasAuth": false },
    { "url": "https://kolm.ai/v1/run", "method": "POST", "hasAuth": false }
  ]
}
```

The helper finds a public recipe, then calls `run`, which targets protected `/v1/run`. MCP named recipe runs use the same pattern. These flows should call `/v1/public/run` with `concept_id` for public recipes, then authenticated `/v1/run` only for private ids or explicit authenticated clients.

## Python Contract Drift

Python `recipe` client mismatches:

- default base URL is the old Railway host, not `https://kolm.ai`,
- `synthesize_batch` posts `recipes`, but server expects `items`,
- `verify` posts `examples`, but server expects `positives` and `negatives`,
- `public_run` posts `name` or `recipe_id`, but server expects `concept_id` or `version_id`.

Python `kolm` client mismatches:

- HTTP compile fallback posts `examples_uri` and `base`, but server expects `examples` and `base_model`,
- HTTP compile fallback expects response `id`, but server returns `job_id`,
- CLI bridge uses flags such as `--base`, `--json`, `--recall`, and `--recipe-pack-depth`; root CLI cloud compile uses `--base-model`, `--data`, `--examples`, `--out`, and `--deploy-hook`.

The Python package metadata also says project name `kolm`, the README uses a legacy recipe PyPI install name, and the script entry point is only `recipe`.

## Install Story Drift

Examples found:

- root package: private `kolmogorov-stack`, bin `kolm`,
- README: `npm i -g @kolmogorov/kolm`,
- `public/docs.html`: `npm i -g @kolm/cli` and GitHub install,
- Node SDK: `@kolmogorov/kolm-sdk`, a recipe-named CLI bin, not published,
- MCP SDK: legacy recipe-scoped MCP package name and dependency,
- Python SDK: project `kolm`, script `recipe`, README uses a legacy recipe PyPI name.

For launch, choose one canonical path for each audience:

- CLI: one package name or explicit GitHub install,
- Node SDK: one package name and import path,
- Python SDK: one package name and console script,
- MCP: dependency must resolve from a clean install.

## Verification Notes

Commands run:

- `node --check cli/kolm.js` passed.
- `node cli/kolm.js version` ran.
- `node --check sdk/node/index.mjs`, `index.cjs`, and `bin/cli.mjs` passed.
- `node --check sdk/mcp/server.mjs` passed.
- `node --check public/sdk*.js` failed for every browser SDK asset.
- `node sdk/node/test/sdk.test.mjs` failed by default because no test server was listening on `localhost:3939`.
- Python byte-compile could not run because neither `python` nor `py` is on PATH.

## Immediate Backlog

1. Fix and rebuild browser SDK assets.
2. Change public convenience helpers and MCP named recipe runs to use `/v1/public/run`.
3. Update Python request/response contracts and CLI flags.
4. Choose canonical package names and remove unpublished install commands from public docs.
5. Add mocked SDK unit tests plus opt-in live server contract tests.
6. Add docs/quickstart smoke tests that execute the exact advertised install and first-run commands.

See `sdk-cli-integration-matrix-2026-05-12.csv` for row-level evidence and recommended actions.
