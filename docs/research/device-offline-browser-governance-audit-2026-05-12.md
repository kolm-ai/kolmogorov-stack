# Device Offline Browser Governance Audit

Date: 2026-05-12

Scope: `/device`, `/sdk.js`, versioned browser SDK assets, `recipe-worker.js`, `sw.js`, PWA manifests, `/v1/registry/export`, public device/offline/security copy, live `kolm.ai` assets, and tests.

## Executive Summary

The device/offline browser path is not launch-ready. The public and live device page says the full public registry runs locally, offline, in microseconds, with no network after installation. The current browser assets do not meet that contract.

The most severe issue is not copy drift. `public/sdk.js`, every local versioned SDK file, `public/recipe-worker.js`, and the `/device` module script contain corrupted ternary expressions and fail syntax checks. The live `https://kolm.ai/device` and `https://kolm.ai/recipe-worker.js` assets show the same broken lines. The current SDK pointer still advertises `c102c349da28`, while the corresponding local asset fails `node --check`.

There is a useful narrow core: `/v1/registry/export` is a real unauthenticated public export of recipe source and metadata, live export currently returns 26 recipes with `source_hash` populated, and `public/sw.js` is syntactically valid. But the surrounding offline/PWA/runtime claims are ahead of implementation. The SDK fetches the registry before falling back to cache, the service worker stale-revalidates the registry, `recipe-worker.js` is not precached, the manifest starts at `/` rather than `/device`, and "offline-ready" means service-worker registration succeeded, not that the app can run offline.

The safe launch posture is narrower: "experimental browser registry viewer; one public registry fetch; local execution is blocked until the browser SDK, worker, module script, and offline cache path pass syntax and browser smoke tests." The product can still keep the strategic on-device story, but the shipped browser demo should not be used as proof until the assets run.

## What Is Solid

- `/v1/registry/export` exists and returns public recipe source plus metadata without auth.
- The live registry export returned `spec=rs-1`, `recipes_n=26`, a registry hash, and `source_hash` on all 26 recipes.
- `public/sw.js` is syntactically valid.
- `public/device.html` links a manifest and registers `/sw.js`.
- `src/registry.js` sanitizes concept names, descriptions, and tags before public registry rendering.
- `src/verifier.js` uses `node:vm` plus a dangerous-token scan for Node artifact recipes, with comments correctly warning that this is not a hard isolation boundary.
- `tests/site.test.js` forbids several broad mobile/runtime claims such as `Mobile SDK` and `zero runtime egress` in public copy.

## Evidence Highlights

### Broken Browser Runtime Assets

Local syntax checks failed:

```text
node --check .\public\sdk.js
node --check .\public\sdk-c102c349da28.js
node --check .\public\sdk-4d6d60e67927.js
node --check .\public\sdk-ef22b94a7a38.js
node --check .\public\recipe-worker.js
```

`public/sdk.js` fails on `_now()`:

```js
return (typeof performance !== 'undefined' && performance.now) - performance.now() : Date.now();
```

`public/recipe-worker.js` fails on:

```js
let fn = sh - compiled.get(sh) : null;
```

Extracting the inline module script from `public/device.html` into a temporary `.mjs` file and running `node --check` failed at the source-hash ternary branch. The same broken module lines were fetched from `https://kolm.ai/device`.

### Versioning Propagates Broken SDKs

`public/sdk-current.json` points to `/sdk-c102c349da28.js`, and that local asset fails the same syntax check as `/sdk.js`. `scripts/build-sdk-version.js` copies `public/sdk.js` into a content-addressed asset and updates the manifests, but does not run a syntax check first. The current versioning process can stamp a broken SDK as current.

### Test Coverage Misses The Failure Mode

`tests/site.test.js` parses public inline scripts, but explicitly skips module scripts. It also skips external scripts. That means the current root site test can pass while:

- `/device` module script is invalid,
- `/sdk.js` is invalid,
- versioned SDK assets are invalid,
- `recipe-worker.js` is invalid.

### Offline Claim Does Not Match Cache Behavior

The device page says the first registry fetch is stored in `localStorage` and the next visit hits no network. `public/sdk.js` reads cached data, but still tries `fetch('/v1/registry/export')` first and only uses cached data on fetch failure. `public/sw.js` also uses stale-while-revalidate for `/v1/registry/export`, which attempts a network fetch when online even if a cached copy exists.

This is a useful availability fallback, but it is not "no network after first load."

### PWA Cache Is Incomplete

`public/sw.js` precaches:

```js
[
  '/device',
  '/styles.css',
  '/sdk.js',
  '/v1/registry/export',
  '/manifest.json'
]
```

The device page also depends on `/brand-refresh.css` and the SDK depends on `/recipe-worker.js`; neither is in the precache list. The service worker can cache `.js` and `.css` on a controlled fetch, but that is not the same as install-time offline readiness. If the app goes offline before the worker asset is cached, the sandbox worker cannot load.

The manifest linked by `/device` has `start_url: "/"`, so an installed app can open the homepage rather than the device runtime.

### Trust Gate Is Narrower Than The Copy

The device page describes an HMAC trust gate with `TRUST_ROOT_PUBLIC`, but the live `/v1/registry/export` envelope and recipe rows had no `signature` field. All live rows had `source_hash`, so the fallback anti-tamper check has data. That is not the same as a signed public registry bundle.

The browser SDK's per-run receipt is local metadata with hashes and runtime fields; it is not HMAC-signed. `verifyReceipt()` is a server round trip to `/v1/receipts/verify`, not an offline public-key check.

### Worker Sandbox Has A Main-Thread Escape Hatch

The intended browser design compiles public recipe source in `recipe-worker.js` after deleting worker globals such as `fetch`, `XMLHttpRequest`, `importScripts`, `indexedDB`, `caches`, `WebSocket`, `EventSource`, and `BroadcastChannel`. That is a reasonable browser hardening direction once the worker parses.

However, `public/sdk.js` also has a fallback path that compiles recipe source with `new Function` on the main page when no worker is available. That fallback has access to page globals. It contradicts any unconditional claim that public registry source never reaches a main-thread `Function` constructor.

## Highest-Risk Gaps

### Live Device Demo Is Broken

The live device page and live worker show the same corrupted JavaScript as local files. The demo cannot be treated as buyer proof for local/offline execution.

### Browser SDK Current Version Is Broken

All local versioned SDK assets failed syntax checks, including the current `c102c349da28` asset. Current SDK consumers can be pinned to a broken file.

### Offline Claims Are Overstated

The shipped cache path is "network first, cached fallback" for registry hydration, not "next visit hits no network." The service worker confirms offline readiness before proving all required runtime assets are cached.

### Signed Browser Receipt Claims Are Overstated

The browser run receipt and worker return path are unsigned metadata. The registry export has no HMAC bundle signature. This is not enough evidence for signed/offline browser proof.

### Test Net Is Too Narrow

The tests that should catch this class of regression skip the exact scripts that are broken. Add syntax and browser smoke checks before treating `/device` as a public proof page.

## Recommended Launch Contract

Use this wording until implementation catches up:

> The browser demo fetches the public registry export and is intended to run public recipes locally after the browser SDK and worker initialize. Offline/PWA behavior is experimental and should be validated per browser before relying on it.

Avoid claiming:

- every public recipe runs locally in the current browser demo,
- zero network after first load,
- complete offline phone app behavior,
- signed public-registry bundles for the browser export,
- signed per-call browser receipts,
- Deno, Bun, or Cloudflare Worker support from the current browser SDK,
- browser worker isolation when fallback main-thread compilation remains enabled.

## Test And Governance Gaps

Add launch-blocking checks for:

- `node --check public/sdk.js`
- `node --check public/sdk-*.js`
- `node --check public/recipe-worker.js`
- extracted `public/device.html` module scripts
- `scripts/build-sdk-version.js` refusing to stamp invalid SDKs
- service-worker precache completeness for `/device`
- manifest `start_url` and install target
- a browser smoke test that loads `/device`, runs `recipe.load()`, runs one live recipe, reloads offline, and verifies no uncached network dependency
- browser receipt shape and signed/unsigned wording

## Validation Performed

- `node --check .\public\sdk.js` failed.
- `node --check .\public\sdk-c102c349da28.js` failed.
- `node --check .\public\sdk-4d6d60e67927.js` failed.
- `node --check .\public\sdk-ef22b94a7a38.js` failed.
- `node --check .\public\recipe-worker.js` failed.
- `node --check .\public\sw.js` passed.
- Extracted `/device` module script failed `node --check`.
- Live `https://kolm.ai/device` contained the same broken module lines.
- Live `https://kolm.ai/recipe-worker.js` failed `node --check`.
- Live `https://kolm.ai/sdk-current.json` still pointed to `c102c349da28`.
- Live `https://kolm.ai/sw.js` matched the local precache/stale-revalidate shape.
- Live `https://kolm.ai/v1/registry/export` returned 26 recipes, all with `source_hash`, none with `signature`.
