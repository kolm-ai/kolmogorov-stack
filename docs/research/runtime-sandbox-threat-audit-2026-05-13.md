# Runtime Sandbox Threat Audit - 2026-05-13

## Executive Summary

Kolm's current runtime evidence supports trusted or curated deterministic recipes. It does not support treating customer-supplied, public-registry, or third-party JavaScript as safely sandboxed.

The earlier sandbox decision memo chose the right direction: current `node:vm` is a demo/local substrate, and untrusted recipes need WASM/Wasmtime or an external worker boundary. This slice maps that decision to the current code and tests:

- Server and local artifact execution use `src/verifier.js`, which compiles recipe JS with `node:vm`, an empty context, a string denylist, a 64 KiB source cap, and a cooperative timeout checked only after the function returns.
- Official Node documentation says the VM module is not a security mechanism for untrusted code.
- `runArtifact` adds a 1 MiB input cap and artifact signature verification, but it does not add a hardened sandbox, preemptive CPU/memory limits, filesystem policy, network policy, or signed per-run receipt.
- `runtime.runVersion` executes hosted registry versions with the same verifier path and no route-level input cap in that layer.
- The benchmark egress monitor is useful, but it is benchmark-scoped. It does not protect normal `kolm run`, `/v1/run`, `/v1/public/run`, MCP, or browser runs.
- Public registry and public run surfaces can expose executable JS before a public trust/review level exists.
- Browser runtime claims are especially fragile: `public/sdk.js` and `public/recipe-worker.js` currently fail `node --check`, and the existing site test only parses inline non-module scripts, not these external assets.

The immediate product implication is that "public registry recipes run safely" and "worker sandbox" should be treated as unshipped claims until the code parses, malicious fixtures pass, and public recipes have trust labels.

## Primary Evidence

- `src/verifier.js` imports `node:vm`, creates an empty context, wraps source as `function(input, lib)`, and runs it with `script.runInContext(ctx)`.
- `src/verifier.js` blocks literal source matches for `process`, `require`, `module`, `globalThis`, `__dirname`, `__filename`, dynamic import, `Function`, `eval`, `constructor`, `prototype`, `ArrayBuffer`, `SharedArrayBuffer`, and `Atomics`.
- A local probe confirmed `compileJs` accepts a safe recipe and rejects source containing `process`, `require`, `ArrayBuffer`, and oversized source.
- `src/verifier.js` timeout is cooperative: `runWithTimeout` calls the function first, then checks elapsed time. A non-returning loop can hang the process; there is no `vm.Script` execution timeout on the run call.
- `src/verifier.js` has no memory limit, randomness/determinism guard, async guard, filesystem guard beyond missing globals, or network-denial policy beyond not exposing those host APIs in the empty VM context.
- `src/artifact-runner.js` verifies artifact signatures before execution, enforces 1 MiB input size, uses a default 1 second per-recipe timeout, and returns unsigned `rs-1-run` metadata.
- `src/runtime.js` uses `compileJs` for registry versions and calls the compiled function from `/v1/run`, `/v1/public/run`, and compose paths. It does not add preemptive isolation around recipe execution.
- `src/router.js` lets authenticated users submit source through `/v1/verify` and `/v1/publish`; published concepts can be `visibility: public`; `/v1/public/run` can execute public concepts without authentication.
- `src/registry.js` sanitizes names/descriptions but stores executable `source` in version rows.
- `src/benchmark.js` patches `fetch`, `http`, `https`, `net`, `tls`, and `dns` only inside `benchmarkArtifact`; the restore function removes those patches after the benchmark.
- `tests/artifact-end-to-end.test.js` verifies fixture signatures, evals, benchmark zero egress, tenant params, audit callback, input cap, and tamper rejection. It does not test malicious source primitives, infinite loops, memory pressure, async tasks, public registry trust, browser worker denial, or runtime egress outside benchmark.
- `node --check public/sdk.js` fails on a syntax error in a corrupted ternary expression.
- `node --check public/recipe-worker.js` fails on a syntax error in a corrupted ternary expression.
- `tests/site.test.js` parses inline non-module scripts, but it does not syntax-check external assets such as `public/sdk.js` and `public/recipe-worker.js`.
- Official Node documentation states that `node:vm` should not be used as a security mechanism for untrusted code.
- Official Wasmtime and WebAssembly security documentation describes the stronger model Kolm's artifact story should target: explicit imports, checked memory access, and sandboxed execution with capability-style host interfaces.

## What Is Solid

The current verifier is an acceptable guard for generated or curated recipe code when the source is part of a trusted artifact pipeline. It blocks obvious Node escape strings and keeps generated recipes small.

The artifact runner has useful non-sandbox controls: signature verification before load, input-size cap, stable error codes, embedded eval re-run, benchmark egress monitoring, and tamper rejection tests.

The benchmark egress monitor is valuable as a proof tool. It can catch network calls in the specific benchmark harness and creates report evidence for fixture artifacts.

## Main Gaps

The largest gap is preemption. Both server/local JS execution and browser worker execution are cooperative. A synchronous non-returning recipe can block until the hosting context is killed externally. The Node path has no worker process to kill.

The second gap is trust labeling. Public concepts and exported registry rows are executable source, but there is no reviewed/curated/untrusted trust level attached to route decisions. Visibility is not a trust policy.

The third gap is egress scope. Egress is monitored in benchmark mode only. Normal runtime paths do not patch or deny network at the process boundary. Today this is mostly mitigated by the empty VM context and denylist, but that is not the same as a hardened network policy.

The fourth gap is browser proof. The intended worker sandbox assets do not parse, and the SDK still contains an unsafe main-thread fallback. Even after syntax is fixed, the browser worker needs malicious fixtures for `fetch`, `indexedDB`, `caches`, `importScripts`, `WebSocket`, CPU loops, source hash mismatch, and unsigned registry rows.

The fifth gap is test coverage. Existing tests prove the known fixtures behave. They do not prove the sandbox against malicious recipes.

## Recommended Policy

Treat runtime trust levels as a release-blocking contract:

- `trusted`: first-party fixture artifacts and generated recipes signed by Kolm.
- `customer-private`: code generated or edited inside a tenant boundary; allowed in current JS runtime with warnings and quotas.
- `curated-public`: manually reviewed public registry recipes; allowed in browser demo only after hash/signature verification.
- `public-untrusted`: third-party executable source; must not run in `node:vm` or browser main thread. Require WASM/Wasmtime or external worker isolation.

Immediate release gates:

1. Add malicious `compileJs` tests for every denylisted primitive.
2. Add non-returning-loop tests that demonstrate current behavior and prevent overclaiming, even if the expected result is "not safe".
3. Syntax-check external browser assets in CI.
4. Move benchmark egress wording out of runtime guarantee copy, or move network denial into runtime.
5. Add public registry trust labels and deny unauthenticated public run for unreviewed public source.
6. Keep `node:vm` wording scoped to curated recipes until a WASM or external worker boundary exists.

## Buyer Impact

The runtime story is credible if Kolm says the current product runs curated recipe artifacts locally and proves that with fixture benchmarks. It is not credible if Kolm says public or customer-supplied JS is safely sandboxed. The fix is not copy alone: the product needs trust labels, malicious fixtures, external-asset syntax gates, and a real untrusted-code target.
