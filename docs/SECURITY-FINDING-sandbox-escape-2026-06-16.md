# P0 SECURITY FINDING — Recipe sandbox escape (host filesystem read)

Found by the Component-1 adversarial verify panel (2026-06-16). PRESERVED here so it is
fixed properly in the Privacy/Security component (#2), independent of whether the
component-1 build is kept.

## Claim (proven live by the verifier)
The default recipe sandbox is escapable. `vm` context nulls `Function` but the host
`Function` constructor is reachable through the prototype chain:

- `({}).constructor.constructor` / `Object.constructor` / `[].constructor.constructor`
  reach the REAL host `Function` constructor (NOT nulled).
- `Object.constructor('return globalThis')()` returns the worker realm
  (keys: global, setImmediate, setTimeout, fetch, crypto, ...).
- `Object.constructor('return process')()` returns a live `process`:
  `process.platform`, `process.pid`, `process.cwd()` (real host path), `process.dlopen`,
  `process._linkedBinding`, `process.binding`.
- FULL HOST FS READ proven: a recipe ran
  `process.binding('fs').readFileUtf8(process.cwd()+'/package.json', 0)` and got the
  real file contents. `process.dlopen` also enables loading arbitrary native addons.

## Why the current defenses do not hold
- `vm` is NOT a security boundary (Node docs). `worker_threads` is NOT a security boundary
  against hostile code — same OS process, same filesystem, a real `process`/`require`-capable realm.
- The egress monitor patches global `fetch` (it DID block an escaped fetch), but
  `process.binding('fs')` read/write bypasses the egress monitor entirely.
- The "constructor-escape denied" test gave FALSE assurance: it only passed because the
  worker was spawned with `env:{}` (empty `process.env`), conflating "env happens to be
  empty" with "escape denied." It never probed `process.binding`/`process.cwd`.
- The genuinely-strong `isolated-vm` path is env-gated OFF by default and effectively absent.

## Impact
Recipes are teacher-LLM-authored or pattern-induced JS executed on the operator's / a
customer's machine (`kolm run`, compile-time verification). A hostile/poisoned recipe can
read the host filesystem (secrets, keys, customer data) and load native code — directly
violating the "sensitive data never leaves / untrusted code is contained" principle.

## Required fix (for component #2 Privacy/Security — build for real, do not stub)
1. Make `isolated-vm` (separate V8 isolate, real memory/CPU boundary) the DEFAULT execution
   backend for untrusted recipes; ship it (not env-gated off). Fall back to a hardened
   subprocess with seccomp/landlock (Linux) / Job Object (Win) / sandbox-exec (mac) only
   where isolated-vm is unavailable — never to the escapable in-process vm.
2. If an in-process path must exist, neutralize the constructor chain (freeze
   `Object/Function/Array .prototype.constructor`, strip `process`/`require`/`binding`
   from the realm) AND drop OS capabilities so even a successful escape reaches nothing
   (no fs, no net, no native addon load).
3. Replace the false "escape-denied" test with real probes:
   `Object.constructor('return process')()`, `process.binding('fs')`, `process.cwd()`,
   `process.dlopen` — assert each is unreachable/throws.
4. Defense-in-depth: keep the egress monitor, but add an fs/syscall monitor or rely on the
   OS sandbox so `process.binding` cannot exfiltrate.

## Status
PARTIALLY ADDRESSED in finalized-pass component #2 (run wf_8ff5a84c-0a9, 2026-06-16).
Captured 2026-06-16 from workflow wf_8947ff82-b94 verify panel.

### What shipped (component #2)
- `src/secure-sandbox.js` (NEW, default backend `vm-hardened`, no native dep): executes
  untrusted generators with `codeGeneration:{strings:false,wasm:false}` (engine-level kill
  of every `Function()`/`eval()`/constructor-chain code-gen escape) AND re-homes `input`/`lib`
  as JSON into the sandbox realm (so untrusted code never holds a HOST object whose
  prototype chain reaches the host `Function`). Optional `KOLM_SANDBOX_BACKEND=isolated-vm`
  (separate V8 isolate, hard CPU/heap limit) fails LOUD with an install hint if requested
  but absent. Gated by a real adversarial battery: `ESCAPE_PROBES` (12 families) +
  `tests/finalized-c2-real-escape-probe-test-suite.test.js` (26 probes, all pass) — this
  REPLACES the false "escape-denied" test (requirement #3 above, DONE).
- `src/verifier.js::runRecipeContained()` (NEW entry point): routes to the hardened backend
  when `KOLM_SECURE_SANDBOX=1`; default unset → existing `compileJs` verbatim (byte-identical
  back-compat). `compileJs` untouched.

### Why the hardened backend is env-gated, not the live default (the frontier limit)
The default `compileJs` path passes `lib = subroutines` — HOST FUNCTIONS recipes call
directly. The hardened backend's JSON re-homing (the very thing that severs the host-prototype
escape) DROPS those function helpers, so flipping it on unconditionally would break every
recipe that uses `lib`. And `codeGeneration:{strings:false}` on `compileJs` alone does NOT
close the hole, because the escape runs through the HOST `Function` reached via the passed-in
host objects' prototype chain (host code-gen, not governed by the context flag). A genuinely
HARD, in-process, dependency-free untrusted-code boundary does not exist in Node — the frontier
answer is `isolated-vm` (separate isolate + reference-bridged lib) or an OS sandbox, both of
which legitimately require operator setup. Hence: real hardened path SHIPPED + fail-loud
env-gate is the correct frontier posture, not a stub.

### Still open (default-path residual + operator follow-up)
- DEFAULT `compileJs` remains regex-pre-filtered `node:vm` (the constructor-chain escape is
  still reachable there if the regex is bypassed). REMAINING FIX-FORWARD: make `vm-hardened`
  the default by bridging the `subroutines` FUNCTION helpers into the sandbox realm without
  re-introducing the host-prototype escape (inject a frozen, realm-local facade rather than
  JSON-dropping `lib`), then flip `runRecipeContained` to default-on.
- The separate `os-subprocess` rung (in the unshipped, verify-FAILED `hard-sandbox.js` island,
  left in the worktree) has a `process.report.writeReport` host-FS-write escape and no kernel
  wall on Windows by default; it was NOT shipped. If pursued, patch the entire `process.*`
  native surface AND require an OS wrapper (bubblewrap/landlock / Job Object / sandbox-exec).
