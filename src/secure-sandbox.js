// Hardened untrusted-code containment for kolm recipe generators (FINALIZED-C2).
//
// WHY THIS EXISTS
// ---------------
// The historical default JS backend (src/verifier.js::compileJs) runs candidate
// generators inside a bare `node:vm` context. A bare node:vm context is NOT a
// security boundary on its own: a hostile generator can reach the HOST `Function`
// constructor through the prototype chain of ANY host object it is handed and
// escape to the real `process`:
//
//   function generate(input){
//     return input.constructor.constructor("return process.cwd()")();
//   }
//
// Because `input` and `lib` are HOST objects passed in by the runner, their
// `.constructor.constructor` is the host `Function`, which closes over the host
// scope where `process`/`require` live. compileJs blocks this TODAY only with a
// best-effort string scan (assertSafeSource): block the token `constructor`,
// `process`, `Function`, etc. before the source ever compiles. That string scan
// is a real defense layer, but it is the ONLY thing standing between untrusted
// source and the host process - if a single obfuscation slips past the regex,
// the bare vm context offers no second line of defense.
//
// This module is that genuine second line of defense: a containment backend that
// EXECUTES untrusted code and structurally removes the escape capabilities
// rather than merely filtering for their names. It is engineered to fail closed.
//
// THREE CONTAINMENT MECHANISMS (all active on the default backend):
//
//   1. codeGeneration: { strings: false, wasm: false } on the vm context.
//      This makes `Function("...")()`, `eval("...")`, and `new Function` throw
//      "Code generation from strings disallowed for this context" at the ENGINE
//      level - no matter which object's `.constructor.constructor` you reach.
//      The canonical node:vm escape chain is dead even if the string scan is
//      bypassed.
//
//   2. Argument re-homing. `input` and `lib` are re-parsed INTO the sandbox
//      context (structured-clone-equivalent via in-context JSON.parse) so the
//      objects the untrusted code touches have the SANDBOX's Object/Function on
//      their prototype chain, never the host's. Even with codegen enabled this
//      would deny the prototype-walk escape.
//
//   3. A null-prototype global with no `process`, `require`, `module`, timers,
//      or network primitives, plus a hard cooperative timeout.
//
// PRIVACY PRINCIPLE: untrusted recipe code never receives a reference to any
// host object, the host `process`, the filesystem, or the network. Sensitive
// host state cannot leak into - and exfiltration cannot leak out of - the
// sandbox. The boundary is provable: see tests/finalized-c2-real-escape-probe-test-suite.test.js
// which executes the documented escape chain and asserts each capability is
// genuinely unreachable, and asserts a host-FS sentinel is never read or written.
//
// OPTIONAL HARDER BACKEND (env-gated, fails LOUD): set
//   KOLM_SANDBOX_BACKEND=isolated-vm
// to require the `isolated-vm` native module (a separate V8 isolate with a hard
// CPU/heap limit and zero host-object bridge). If selected but not installed,
// runSecure throws with an install hint - the real code path is preserved, never
// silently downgraded. The default backend ('vm-hardened') needs no native deps.

import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const SECURE_SANDBOX_SPEC_VERSION = 'kolm-secure-sandbox/1';

const DEFAULT_TIMEOUT_MS = 150;
const MAX_SOURCE_BYTES = 64 * 1024;

// Sentinel marker: the probe suite asserts that no host file path appears in any
// sandbox output and that a write to this path never lands on disk. Exported so
// the test owns one canonical string.
export const SANDBOX_SENTINEL_TOKEN = 'KOLM_SANDBOX_SENTINEL_DO_NOT_LEAK';

function selectBackend() {
  const want = String(process.env.KOLM_SANDBOX_BACKEND || 'vm-hardened').trim();
  if (want === '' || want === 'vm-hardened' || want === 'default') return 'vm-hardened';
  if (want === 'isolated-vm' || want === 'isolated_vm' || want === 'ivm') return 'isolated-vm';
  throw new Error(
    `unknown KOLM_SANDBOX_BACKEND=${JSON.stringify(want)}; ` +
    `valid values: 'vm-hardened' (default, no native dep) or 'isolated-vm' (requires \`npm i isolated-vm\`)`
  );
}

// --- isolated-vm backend (env-gated, fails LOUD if requested but absent) ------
function loadIsolatedVm() {
  let ivm;
  try {
    // Dynamic require so the module is NOT a hard dependency. Absent by default.
    ivm = require('isolated-vm');
  } catch {
    throw new Error(
      "KOLM_SANDBOX_BACKEND=isolated-vm requested but the 'isolated-vm' module is not installed. " +
      'Install it with: npm i isolated-vm  (native addon; needs a C++ toolchain). ' +
      'Or unset KOLM_SANDBOX_BACKEND to use the default vm-hardened backend.'
    );
  }
  return ivm;
}

function runOnIsolatedVm(source, input, lib, timeout) {
  const ivm = loadIsolatedVm();
  // A genuine separate V8 isolate. No host objects cross the bridge: input/lib
  // are passed as JSON strings and re-parsed inside, and there is no reference
  // to `process`, `require`, the host filesystem, or the network in the isolate.
  const isolate = new ivm.Isolate({ memoryLimit: 32 });
  try {
    const context = isolate.createContextSync();
    const jail = context.global;
    jail.setSync('global', jail.derefInto());
    const wrapped =
      '(function(){"use strict";' +
      'var input = arguments[0] ? JSON.parse(arguments[0]) : undefined;' +
      'var lib = arguments[1] ? JSON.parse(arguments[1]) : undefined;' +
      source + '\n;' +
      'var out = generate(input, lib);' +
      'return (out === undefined) ? undefined : JSON.stringify(out);' +
      '})';
    const script = isolate.compileScriptSync(wrapped);
    const fn = script.runSync(context, { timeout });
    const resultJson = fn.applySync(
      undefined,
      [JSON.stringify(input ?? null), JSON.stringify(lib ?? null)],
      { timeout, result: { copy: true } }
    );
    return resultJson === undefined ? undefined : JSON.parse(resultJson);
  } finally {
    try { isolate.dispose(); } catch { /* deliberate: cleanup */ }
  }
}

// --- default vm-hardened backend (no native dep) ------------------------------
function runOnVmHardened(source, input, lib, timeout) {
  // Null-prototype global: no inherited Object.prototype on the global itself,
  // and critically no `process`, `require`, `module`, timers, or fetch.
  const ctx = vm.createContext(Object.create(null), {
    name: 'kolm-secure-gen',
    // The load-bearing line: deny runtime code generation. Defeats every
    // Function-constructor / eval escape regardless of how the constructor is
    // reached through a prototype chain.
    codeGeneration: { strings: false, wasm: false },
  });

  // Re-home input/lib INTO the context as JSON STRINGS, then re-parse them
  // inside the timed script so the objects untrusted code touches have the
  // SANDBOX's Object/Function on their prototype chain, never the host's. We
  // place only strings on the context (never host objects) so there is no host
  // prototype to walk even before the script runs. JSON round-trip is
  // structured-clone-equivalent for the plain-data values recipes legitimately
  // receive; functions/closures are intentionally dropped (recipes are pure
  // functions over data).
  let inJson, libJson;
  try {
    inJson = input === undefined ? null : JSON.stringify(input);
    libJson = lib === undefined ? null : JSON.stringify(lib);
    if (inJson === undefined) inJson = null;   // JSON.stringify(undefined) === undefined
    if (libJson === undefined) libJson = null;
  } catch (e) {
    throw new Error(`sandbox input/lib not JSON-serializable: ${e.message}`);
  }
  ctx.__kolm_in = inJson;
  ctx.__kolm_lib = libJson;

  // CRITICAL: the generator must be INVOKED inside the timed runInContext call.
  // The vm `timeout` only governs synchronous execution of THIS script - it can
  // interrupt an infinite `while(true){}` spin only because generate() is called
  // here, not from a returned closure the host invokes later. Output is returned
  // as a JSON string so no sandbox object reference crosses back to the host.
  const wrapped =
    '(function(){ "use strict";' +
    'var input = (typeof __kolm_in === "string") ? JSON.parse(__kolm_in) : undefined;' +
    'var lib = (typeof __kolm_lib === "string") ? JSON.parse(__kolm_lib) : undefined;' +
    source + '\n;' +
    'var __out = generate(input, lib);' +
    'return (__out === undefined) ? "__KOLM_UNDEF__" : JSON.stringify(__out);' +
    '})()';
  const script = new vm.Script(wrapped, { filename: 'secure-generator.js' });
  const resultJson = script.runInContext(ctx, { timeout });
  if (resultJson === '__KOLM_UNDEF__' || resultJson === undefined || resultJson === null) return undefined;
  try { return JSON.parse(resultJson); } catch { return undefined; }
}

// runSecure: execute an untrusted generator source under the active containment
// backend. Returns the generator's output. Throws on any sandbox violation,
// compile error, codegen-denied attempt, or timeout. Never returns a host
// reference. opts.timeout (ms) bounds wall-clock; opts.input / opts.lib are the
// (plain-data) arguments handed to generate(input, lib).
export function runSecure(source, opts = {}) {
  if (typeof source !== 'string') throw new Error('source must be a string');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error(`source too large (>${MAX_SOURCE_BYTES} bytes)`);
  }
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS;
  const input = opts.input;
  const lib = opts.lib;
  const backend = selectBackend();
  if (backend === 'isolated-vm') return runOnIsolatedVm(source, input, lib, timeout);
  return runOnVmHardened(source, input, lib, timeout);
}

// Which backend will run next, for diagnostics / CI banners. Does not load the
// native module (so it is safe to call when isolated-vm is not installed unless
// it is also the selected backend, in which case selection still succeeds and
// only runSecure attempts the load).
export function activeBackend() {
  return selectBackend();
}

// The canonical adversarial escape battery. Each entry is a generator source
// that reaches for a forbidden capability. A correctly-contained backend makes
// every one of these either throw or yield a non-escaped value (never the host
// process, host cwd, a host module, or host file contents). The probe suite
// iterates this list against the DEFAULT backend and fails closed.
//
// `expect` is the contract the runner asserts:
//   'unreachable' - running it must throw OR return a value that proves no host
//                   capability was reached (the probe source self-checks and
//                   returns a tagged result; see the suite for the assertions).
export const ESCAPE_PROBES = Object.freeze([
  {
    name: 'Object.constructor("return process") yields no process',
    source:
      'function generate(){ var P; try { P = ({}).constructor.constructor("return process")(); } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } return { reached: typeof P !== "undefined" && P !== null, kind: typeof P }; }',
  },
  {
    name: 'function-constructor escape to process.cwd',
    source:
      'function generate(){ try { return { reached:true, cwd: (function(){}).constructor("return process.cwd()")() }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'argument-prototype escape (input.constructor.constructor)',
    source:
      'function generate(input){ try { return { reached:true, cwd: input.constructor.constructor("return process.cwd()")() }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'lib-prototype escape (lib.constructor.constructor)',
    source:
      'function generate(input, lib){ try { return { reached:true, p: lib.constructor.constructor("return process.binding")() }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'process.binding("fs") unreachable',
    source:
      'function generate(){ try { var p = (function(){}).constructor("return process")(); return { reached: !!(p && p.binding && p.binding("fs")) }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'process._linkedBinding unreachable',
    source:
      'function generate(){ try { var p = (function(){}).constructor("return process")(); return { reached: !!(p && p._linkedBinding) }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'process.cwd() unreachable',
    source:
      'function generate(){ try { var p = (function(){}).constructor("return process")(); return { reached: !!(p && typeof p.cwd === "function"), cwd: p && p.cwd ? p.cwd() : null }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'process.dlopen unreachable (native addon load)',
    source:
      'function generate(){ try { var p = (function(){}).constructor("return process")(); return { reached: !!(p && typeof p.dlopen === "function") }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'direct global process is undefined',
    source:
      'function generate(){ return { reached: typeof process !== "undefined", kind: typeof process }; }',
  },
  {
    name: 'direct global require is undefined',
    source:
      'function generate(){ return { reached: typeof require !== "undefined", kind: typeof require }; }',
  },
  {
    name: 'eval("require") denied',
    source:
      'function generate(){ try { return { reached:true, r: eval("typeof require") }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
  {
    name: 'this-based context escape neutralized',
    source:
      'function generate(){ try { return { reached:true, p: this.constructor.constructor("return process")() }; } catch (e) { return { reached:false, threw:String(e.message).slice(0,40) }; } }',
  },
]);
