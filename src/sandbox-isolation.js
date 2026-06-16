// src/sandbox-isolation.js
//
// ATOM: Sandbox Verification - a TRUE isolation boundary for untrusted recipe
// generators, replacing the regex denylist that src/verifier.js itself admits
// is "Defence-in-depth: node:vm is not a hard security boundary".
//
// THE PROBLEM WITH THE STATUS QUO
// --------------------------------
// src/verifier.js compiles candidate generators with `new vm.Script(...)` in a
// `vm.createContext({})` and guards it with a string-scan denylist (DANGEROUS).
// Two structural weaknesses the existing code acknowledges in comments:
//
//   1. node:vm is NOT a security boundary. A hostile script can reach the host
//      `Function` constructor via `this.constructor.constructor` / an Error's
//      `.constructor` and escape the empty context. The denylist is a porous
//      mitigation, not a boundary: it scans STRIPPED source, so obfuscation
//      (computed member access, unicode escapes, string concat reaching the
//      same primitive at runtime) can route around it.
//   2. The timeout is COOPERATIVE and POST-HOC: runWithTimeout() measures
//      Date.now() AFTER the function already returned, so a `while(true){}`
//      hangs the event loop forever. There is no preemption.
//
// THE BOUNDARY THIS MODULE PROVIDES
// ---------------------------------
// A real isolation boundary needs three things this module supplies:
//
//   (A) PREEMPTIVE CPU/wall limit. We run untrusted code in a worker_thread and
//       hard-kill it with worker.terminate() when the deadline elapses. Unlike
//       the cooperative check, terminate() actually tears down a spinning loop.
//   (B) HARD MEMORY limit. The worker is spawned with resourceLimits
//       (maxOldGenerationSizeMb / maxYoungGenerationSizeMb). A recipe that
//       allocates without bound crashes its OWN isolate (ERR_WORKER_OUT_OF_MEMORY)
//       and is reported as a memory_limit failure - the host survives.
//   (C) CAPABILITY-SCOPED host surface. The worker runs with NO require, NO
//       process env (env:{} ... SHARE_ENV is not passed), NO network: every
//       recipe call is wrapped in the egress monitor from src/sandbox.js, and
//       the in-isolate `vm` context is built with the constructor-escape
//       primitives nulled out AND a frozen capability `lib`. The host imports a
//       recipe is allowed to touch are an explicit allowlist, not "everything
//       node:vm happens to expose".
//
// isolated-vm (the gold standard - a real V8 Isolate with a hard fuel limit
// and zero shared heap) is supported as an ENV-GATED optional path. When
// KOLM_SANDBOX=isolated-vm is set we require('isolated-vm'); if the optional
// dependency is absent we FAIL LOUD with an install hint rather than silently
// downgrading. The pure-Node worker path is the always-available default and
// is itself a real boundary (separate thread, separate heap, preemptive kill).
//
// PRIVACY: untrusted code never sees process.env, never reaches the network
// (egress monitor), and cannot import host modules. Sensitive data is not
// passed into the isolate at all - only the recipe `input` the caller hands us.
//
// Pure-JS, zero NEW required deps. Deterministic envelopes; the public async
// API never throws (failures are returned as {ok:false,...}). ASCII only.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

export const SANDBOX_ISOLATION_VERSION = 'sbx-iso-v1';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
// Limits. These are the hard ceilings of the boundary; callers may TIGHTEN but
// the defaults are conservative for short, side-effect-free generators.
// -----------------------------------------------------------------------------

export const DEFAULT_LIMITS = Object.freeze({
  wall_ms: 250,          // preemptive wall-clock kill
  memory_mb: 64,         // hard old-generation cap for the worker isolate
  young_mb: 16,          // young-generation cap
  fuel: 5_000_000,       // isolated-vm CPU "fuel" budget (only used on that path)
  output_bytes: 1 << 20, // 1 MiB cap on serialized output (anti memory-amplification)
});

function resolveLimits(limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  L.wall_ms = clampNum(L.wall_ms, 1, 60_000, DEFAULT_LIMITS.wall_ms);
  L.memory_mb = clampNum(L.memory_mb, 8, 4096, DEFAULT_LIMITS.memory_mb);
  L.young_mb = clampNum(L.young_mb, 1, L.memory_mb, DEFAULT_LIMITS.young_mb);
  L.fuel = clampNum(L.fuel, 1000, 1e12, DEFAULT_LIMITS.fuel);
  L.output_bytes = clampNum(L.output_bytes, 1024, 64 << 20, DEFAULT_LIMITS.output_bytes);
  return L;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// -----------------------------------------------------------------------------
// selectBackend - which isolation backend is active. Env-gated.
// -----------------------------------------------------------------------------
//
//   KOLM_SANDBOX unset / 'worker'  -> always-available pure-Node worker boundary
//   KOLM_SANDBOX = 'isolated-vm'   -> require('isolated-vm'); FAIL LOUD if absent
//
// We never silently downgrade isolated-vm -> worker: an operator who asked for
// the strongest boundary must be told their optional dep is missing, not handed
// a weaker boundary they did not choose.

export function selectBackend(env = process.env) {
  const want = String((env && env.KOLM_SANDBOX) || '').trim().toLowerCase();
  if (want === 'isolated-vm' || want === 'isolated_vm' || want === 'ivm') {
    return { backend: 'isolated-vm', requested: true };
  }
  if (want === '' || want === 'worker' || want === 'worker_threads' || want === 'auto') {
    return { backend: 'worker', requested: want !== '' };
  }
  // Unknown value: be explicit rather than guessing.
  return { backend: 'worker', requested: true, warning: `unknown KOLM_SANDBOX=${want}, defaulting to worker boundary` };
}

function loadIsolatedVm() {
  // ENV-GATED optional dependency. Fail LOUD with an install hint - never
  // silently fall back to a weaker boundary the operator did not choose.
  try {
    return require('isolated-vm');
  } catch (e) {
    const hint = [
      'KOLM_SANDBOX=isolated-vm requested but the optional dependency is not installed.',
      'Install it to enable the hard V8-Isolate boundary with a CPU fuel limit:',
      '',
      '    npm install isolated-vm',
      '',
      'Or unset KOLM_SANDBOX to use the always-available worker_threads boundary',
      '(separate thread + separate heap + preemptive terminate()).',
    ].join('\n');
    const err = new Error(hint);
    err.code = 'KOLM_SANDBOX_DEP_MISSING';
    err.cause = e;
    throw err;
  }
}

// -----------------------------------------------------------------------------
// runIsolated - execute one untrusted generator call inside the boundary.
// -----------------------------------------------------------------------------
//
// The async entry point. Returns a discriminated envelope - NEVER throws:
//
//   { ok:true,  output, backend, wall_ms, version }
//   { ok:false, error:'timeout'|'memory_limit'|'recipe_threw'|'egress_blocked'
//                     |'output_too_large'|'sandbox_dep_missing'|'worker_error'|'bad_source',
//     detail, backend, wall_ms, version, egress_attempts? }
//
// `source` is the recipe body (the same string verifier.compileJs accepts: a
// top-level `function generate(input, lib){...}`). `input` is the recipe input.
// `limits` tightens DEFAULT_LIMITS. `capabilities.libKeys` selects which frozen
// subroutine names the isolate may see (capability-scoped host imports); when
// omitted, a SAFE default allowlist is used.

export async function runIsolated({ source, input, limits, capabilities, env } = {}) {
  const V = SANDBOX_ISOLATION_VERSION;
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, error: 'bad_source', detail: 'source must be a non-empty string', backend: 'none', wall_ms: 0, version: V };
  }
  if (source.length > 256 * 1024) {
    return { ok: false, error: 'bad_source', detail: 'source too large (>256 KiB)', backend: 'none', wall_ms: 0, version: V };
  }

  const L = resolveLimits(limits);
  const sel = selectBackend(env || process.env);

  if (sel.backend === 'isolated-vm') {
    return runViaIsolatedVm({ source, input, limits: L, capabilities, version: V });
  }
  return runViaWorker({ source, input, limits: L, capabilities, version: V });
}

// -----------------------------------------------------------------------------
// Worker boundary (always available). Spawns the sibling worker entry with hard
// resourceLimits, posts the job, and races a preemptive wall-clock terminate().
// -----------------------------------------------------------------------------

function runViaWorker({ source, input, limits, capabilities, version }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      payload.wall_ms = Date.now() - start;
      payload.backend = 'worker';
      payload.version = version;
      // Best-effort teardown; ignore terminate errors.
      try { worker.terminate(); } catch { /* already gone */ }
      resolve(payload);
    };

    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'sandbox-worker.js'), {
        eval: false,
        // CAPABILITY-SCOPED: env:{} means the isolate cannot read process.env.
        // No secrets, no config leak into untrusted code.
        env: {},
        // No stdin/stdout/stderr piping needed; keep them off the parent.
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: limits.memory_mb,
          maxYoungGenerationSizeMb: limits.young_mb,
          // Code-range cap keeps a recipe from JIT-spraying.
          codeRangeSizeMb: Math.min(16, Math.max(4, Math.floor(limits.memory_mb / 4))),
        },
        workerData: {
          source,
          input,
          limits,
          libKeys: Array.isArray(capabilities && capabilities.libKeys) ? capabilities.libKeys : null,
        },
      });
    } catch (e) {
      finish({ ok: false, error: 'worker_error', detail: String((e && e.message) || e) });
      return;
    }

    // (A) PREEMPTIVE wall-clock kill. terminate() actually tears down a
    // spinning `while(true){}` - the host event loop is never blocked.
    timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout', detail: `generator exceeded ${limits.wall_ms}ms wall clock (preemptively killed)` });
    }, limits.wall_ms);
    if (typeof timer.unref === 'function') timer.unref();

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') {
        finish({ ok: false, error: 'worker_error', detail: 'malformed worker message' });
        return;
      }
      finish(msg);
    });

    worker.on('error', (err) => {
      const detail = String((err && err.message) || err);
      // (B) Node emits an 'error' (not a non-zero exit) when the isolate blows
      // its maxOldGenerationSizeMb cap. Classify it as a real memory_limit so
      // callers see containment, not a generic worker fault. The HOST survives.
      const isOom = /reaching memory limit|out of memory|heap out of memory/i.test(detail);
      finish({ ok: false, error: isOom ? 'memory_limit' : 'worker_error', detail });
    });

    worker.on('exit', (code) => {
      if (settled) return;
      // (B) HARD MEMORY limit: a worker that blows maxOldGenerationSizeMb exits
      // with a non-zero code BEFORE posting a message. Report it as a real
      // memory_limit failure - the host process is untouched.
      if (code === 1 || code === 134) {
        finish({ ok: false, error: 'memory_limit', detail: `worker exited code ${code} (likely out-of-memory at ${limits.memory_mb}MB cap)` });
      } else {
        finish({ ok: false, error: 'worker_error', detail: `worker exited with code ${code} before responding` });
      }
    });
  });
}

// -----------------------------------------------------------------------------
// isolated-vm boundary (env-gated). A real V8 Isolate with a hard memory limit
// and a CPU "fuel" timeout that V8 enforces internally - the strongest boundary.
// -----------------------------------------------------------------------------

async function runViaIsolatedVm({ source, input, limits, capabilities, version }) {
  const start = Date.now();
  let ivm;
  try {
    ivm = loadIsolatedVm();
  } catch (e) {
    return {
      ok: false,
      error: 'sandbox_dep_missing',
      detail: String((e && e.message) || e),
      code: (e && e.code) || 'KOLM_SANDBOX_DEP_MISSING',
      backend: 'isolated-vm',
      wall_ms: Date.now() - start,
      version,
    };
  }

  let isolate;
  try {
    isolate = new ivm.Isolate({ memoryLimit: limits.memory_mb });
    const context = await isolate.createContext();
    const jail = context.global;
    // Capability-scoped: only `input` and a frozen lib bridge cross in. No
    // global `process`, `require`, `fetch`, or host references are exposed.
    await jail.set('global', jail.derefInto());
    await jail.set('__kolm_input', new ivm.ExternalCopy(input == null ? null : input).copyInto());

    const libKeys = sanitizeLibKeys(capabilities && capabilities.libKeys);
    // The recipe sees a frozen `lib` containing ONLY the allowlisted pure
    // helpers (serialized as data + pure JS shims). We deliberately do NOT
    // bridge any host function that could touch IO.
    const libSource = buildFrozenLibSource(libKeys);

    const wrapped =
      `"use strict";\n${libSource}\n(function(){\n${source}\n;` +
      `globalThis.__kolm_result = JSON.stringify(generate(__kolm_input, __kolm_lib));})();`;

    const script = await isolate.compileScript(wrapped);
    // Hard CPU timeout enforced by V8 itself (true preemption inside the isolate).
    await script.run(context, { timeout: limits.wall_ms });
    const ref = await jail.get('__kolm_result', { copy: true });
    const out = typeof ref === 'string' ? JSON.parse(ref) : ref;
    const serialized = JSON.stringify(out == null ? null : out);
    if (serialized && serialized.length > limits.output_bytes) {
      return { ok: false, error: 'output_too_large', detail: `output ${serialized.length}B > ${limits.output_bytes}B cap`, backend: 'isolated-vm', wall_ms: Date.now() - start, version };
    }
    return { ok: true, output: out, backend: 'isolated-vm', wall_ms: Date.now() - start, version };
  } catch (e) {
    const msg = String((e && e.message) || e);
    let error = 'recipe_threw';
    if (/script execution timed out|timed out/i.test(msg)) error = 'timeout';
    else if (/memory limit|out of memory|reached heap limit/i.test(msg)) error = 'memory_limit';
    return { ok: false, error, detail: msg, backend: 'isolated-vm', wall_ms: Date.now() - start, version };
  } finally {
    try { if (isolate) isolate.dispose(); } catch { /* best effort */ }
  }
}

// -----------------------------------------------------------------------------
// Capability allowlist for the frozen `lib`. Recipes never get the full
// subroutine surface unless the caller explicitly opts in. Default = a small
// set of PURE, side-effect-free helpers safe for any tenant.
// -----------------------------------------------------------------------------

export const DEFAULT_LIB_ALLOWLIST = Object.freeze([
  'upper', 'lower', 'trim', 'reverse', 'len', 'slice',
  'json_stringify', 'json_parse', 'clamp', 'round', 'abs',
]);

function sanitizeLibKeys(libKeys) {
  if (!Array.isArray(libKeys)) return DEFAULT_LIB_ALLOWLIST.slice();
  const allowed = new Set(DEFAULT_LIB_ALLOWLIST);
  const out = [];
  for (const k of libKeys) {
    if (typeof k === 'string' && allowed.has(k)) out.push(k);
  }
  return out.length ? out : DEFAULT_LIB_ALLOWLIST.slice();
}

// Build a self-contained, PURE `__kolm_lib` object as source. These are
// re-implemented inline (not bridged from the host) so the isolate has ZERO
// host references - the only way to get a true boundary on the isolated-vm
// path. The worker path imports the real subroutines (it has its own heap).
function buildFrozenLibSource(libKeys) {
  const impls = {
    upper: 'upper:(s)=>String(s).toUpperCase()',
    lower: 'lower:(s)=>String(s).toLowerCase()',
    trim: 'trim:(s)=>String(s).trim()',
    reverse: 'reverse:(s)=>String(s).split("").reverse().join("")',
    len: 'len:(s)=>(s==null?0:(s.length||0))',
    slice: 'slice:(s,a,b)=>String(s).slice(a,b)',
    json_stringify: 'json_stringify:(o)=>JSON.stringify(o)',
    json_parse: 'json_parse:(s)=>JSON.parse(s)',
    clamp: 'clamp:(x,lo,hi)=>Math.max(lo,Math.min(hi,Number(x)))',
    round: 'round:(x,d)=>{const f=Math.pow(10,d||0);return Math.round(Number(x)*f)/f;}',
    abs: 'abs:(x)=>Math.abs(Number(x))',
  };
  const picked = libKeys.filter((k) => impls[k]).map((k) => impls[k]);
  return `const __kolm_lib = Object.freeze({${picked.join(',')}});`;
}

export default {
  SANDBOX_ISOLATION_VERSION,
  DEFAULT_LIMITS,
  DEFAULT_LIB_ALLOWLIST,
  selectBackend,
  runIsolated,
};
