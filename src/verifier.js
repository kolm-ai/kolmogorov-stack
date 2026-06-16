// Sandbox + test harness for candidate generators.
// Two execution paths:
//   1. JS generators - sandboxed via node:vm with a frozen `lib` global.
//   2. WASM generators - instantiated via WebAssembly with no imports.
// Production should harden with isolated-vm or wasmtime; this is the demo substrate.

import vm from 'node:vm';
import crypto from 'node:crypto';
import { subroutines } from './library.js';

const DEFAULT_TIMEOUT_MS = 150;

// Defence-in-depth: node:vm is not a hard security boundary (a hostile script
// can reach `Function` via `this.constructor.constructor` and escape an empty
// context). We block the canonical escape primitives via a string scan before
// the source ever reaches the compiler. Synthesized recipes never need any of
// these - they operate on the `lib` argument only.
// [token, friendly-hint]. Hint shown in the error message so authors don't
// have to dig through kolm help compile to learn the workaround.
const DANGEROUS = [
  [/\bprocess\b/,             'process',             'access env via lib.params (set in spec.recipes[].params)'],
  [/\brequire\b/,             'require',             'recipes are sandboxed - use only the frozen lib helpers'],
  [/\bmodule\b/,              'module',              'recipes do NOT use module.exports - just declare top-level function generate(input, lib)'],
  [/\bglobal(This)?\b/,       'global / globalThis', 'no globals - pass everything through lib or the input arg'],
  [/\b__dirname\b/,           '__dirname',           'no filesystem - recipes are pure functions on (input, lib)'],
  [/\b__filename\b/,          '__filename',          'no filesystem - recipes are pure functions on (input, lib)'],
  [/\bimport\s*\(/,           'import()',            'dynamic imports disabled - all deps must come through lib'],
  [/\bFunction\s*\(/,         'Function()',          'no dynamic code - write straight JS'],
  [/\beval\s*\(/,             'eval()',              'no dynamic code - write straight JS'],
  [/\bconstructor\b/,         'constructor',         'avoid .constructor access - pre-construct instances if you need them'],
  [/\bprototype\b/,           'prototype',           'use Object.hasOwn(obj, k) instead of .hasOwnProperty; iterate via Object.keys()'],
  [/\bArrayBuffer\b/,         'ArrayBuffer',         'no typed arrays - use plain JS arrays/strings'],
  [/\bSharedArrayBuffer\b/,   'SharedArrayBuffer',   'no typed arrays - use plain JS arrays/strings'],
  [/\bAtomics\b/,             'Atomics',             'no shared memory primitives - recipes are single-shot'],
  // Hardening additions (no legitimate fixture uses these as of 2026-05-14;
  // re-check with `grep -c` against data/versions.json before removing).
  [/\bReflect\b/,             'Reflect',             'use direct property access - no Reflect.* meta-programming'],
  [/\bProxy\b/,               'Proxy',               'no proxies - build plain objects'],
  [/\bWeakRef\b/,             'WeakRef',             'no weak refs - recipes are short-lived pure functions'],
  [/\bFinalizationRegistry\b/, 'FinalizationRegistry', 'no finalizers - recipes are short-lived pure functions'],
  [/\bsetTimeout\b/,          'setTimeout',          'no timers - recipes must be synchronous'],
  [/\bsetInterval\b/,         'setInterval',         'no timers - recipes must be synchronous'],
  [/\bsetImmediate\b/,        'setImmediate',        'no timers - recipes must be synchronous'],
  [/\bqueueMicrotask\b/,      'queueMicrotask',      'no microtasks - recipes must be synchronous'],
];

// Strip JS comments + string literals before sandbox scanning. Otherwise an
// author writing `// avoid prototype, process, require` in a header comment
// gets blocked by the safeguard they were documenting. False positives in
// comments/strings are the #1 first-time-author trap (agent batch 50, retry
// 44 hit this exact pattern).
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 2; else i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function assertSafeSource(source) {
  if (typeof source !== 'string') throw new Error('source must be a string');
  if (source.length > 64 * 1024) throw new Error('source too large (>64 KiB)');
  const scanned = stripCommentsAndStrings(source);
  for (const [re, name, hint] of DANGEROUS) {
    if (re.test(scanned)) {
      throw new Error(
        `source contains a forbidden identifier '${name}': ${hint}.\n` +
        `  See 'kolm help compile' FORBIDDEN IDENTIFIERS section for the full list.`
      );
    }
  }
}

export function compileJs(source) {
  assertSafeSource(source);
  const wrapped = `(function(input, lib){ "use strict"; ${source}\n; return generate(input, lib); })`;
  const script = new vm.Script(wrapped, { filename: 'generator.js' });
  const ctx = vm.createContext({}, { name: 'gen-ctx' });
  const fn = script.runInContext(ctx);
  return (input, opts = {}) => {
    const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    // Extend the standard subroutine library with optional artifact-bound
    // (pack, index) and tenant-bound (params) slots. Recipes that don't
    // reference them get the original behaviour exactly.
    const lib = (opts.pack || opts.index || opts.params)
      ? Object.freeze({
          ...subroutines,
          pack: opts.pack || null,
          index: opts.index || null,
          params: opts.params || null,
        })
      : subroutines;
    return runWithTimeout(() => fn(input, lib), timeout);
  };
}

// ---------------------------------------------------------------------------
// runRecipeContained(source, opts) - Finalized C2 (Privacy / Untrusted-Code
// Containment).
//
// ADDED export (compileJs left untouched as the default + back-compat path).
//
// When KOLM_SECURE_SANDBOX=1 is set, untrusted generator execution is routed
// through src/secure-sandbox.js::runSecure - a vm-hardened backend (codegen
// disabled, constructor-chain severed, hard timeout; optional isolated-vm via
// KOLM_SANDBOX_BACKEND=isolated-vm) whose boundary is gated by the adversarial
// escape-probe suite (tests/finalized-c2-real-escape-probe-test-suite.test.js).
//
// DEFAULT (env unset): falls back to the existing compileJs path verbatim, so
// every existing caller and test sees byte-identical behaviour. assertSafeSource
// is documented as a NON-AUTHORITATIVE pre-filter (cheap defense-in-depth); the
// authoritative boundary is the secure-sandbox backend when armed.
//
// CAVEAT: the secure-sandbox backend is opt-in, NOT the audited default. The
// "make hard-sandbox the default" containment work did not pass independent
// verification (the os-subprocess rung has a process.report.writeReport gap and
// no kernel wall on Windows by default), so flipping the live default is held
// behind this env flag until an OS-sandbox wrapper lands. The real code path is
// preserved and fails LOUD if isolated-vm is requested-but-absent.
//
// Returns the generator output (same shape compileJs's returned fn produces).
// ---------------------------------------------------------------------------
export async function runRecipeContained({ source, input, opts = {} } = {}) {
  const secure = String(process.env.KOLM_SECURE_SANDBOX || '').trim();
  if (secure === '1' || secure === 'true' || secure === 'on') {
    const { runSecure } = await import('./secure-sandbox.js');
    // vm-hardened backend runs in-process so the function-valued `lib` helpers
    // cross fine. (isolated-vm/subprocess backends require JSON-serializable lib;
    // recipes that only touch plain-data lib fields work across all backends.)
    const lib = (opts.pack || opts.index || opts.params)
      ? Object.freeze({
          ...subroutines,
          pack: opts.pack || null,
          index: opts.index || null,
          params: opts.params || null,
        })
      : subroutines;
    return runSecure(source, { input, lib, timeout: opts.timeout || DEFAULT_TIMEOUT_MS });
  }
  // Default / fallback: preserved compileJs path (unchanged behaviour).
  const fn = compileJs(source);
  return fn(input, opts);
}

function runWithTimeout(fn, ms) {
  // Cooperative timeout - JS generators are short and side-effect-free.
  // Real isolation: isolated-vm with hard CPU limit.
  const start = Date.now();
  const result = fn();
  if (Date.now() - start > ms) {
    throw new Error(`generator exceeded ${ms}ms`);
  }
  return result;
}

export async function compileWasm(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, {});
  return (input) => {
    if (typeof inst.exports.generate === 'function') {
      return inst.exports.generate(input);
    }
    throw new Error('wasm module must export `generate`');
  };
}

export function verify(generator, { positives = [], negatives = [], property_tests = [] } = {}) {
  const trace = [];
  let posOk = 0, negOk = 0, propOk = 0;
  let totalLatency = 0, runs = 0;

  for (const ex of positives) {
    const t0 = process.hrtime.bigint();
    let pass = false, output, error;
    try {
      output = generator(ex.input);
      pass = matches(output, ex.expected);
    } catch (e) { error = String(e.message || e); }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    totalLatency += us; runs++;
    if (pass) posOk++;
    trace.push({ kind: 'positive', input: preview(ex.input), expected: preview(ex.expected), output: preview(output), pass, error, latency_us: Math.round(us) });
  }

  for (const ex of negatives) {
    const t0 = process.hrtime.bigint();
    let reject = false, output, error;
    try {
      output = generator(ex.input);
      reject = !matches(output, ex.expected_not);
    } catch (e) { error = String(e.message || e); reject = true; }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    totalLatency += us; runs++;
    if (reject) negOk++;
    trace.push({ kind: 'negative', input: preview(ex.input), output: preview(output), reject, error, latency_us: Math.round(us) });
  }

  for (const pt of property_tests) {
    let pass = false, error;
    try {
      pass = pt.predicate(generator);
    } catch (e) { error = String(e.message || e); }
    if (pass) propOk++;
    trace.push({ kind: 'property', name: pt.name, pass, error });
  }

  const posRate = positives.length ? posOk / positives.length : 1;
  const negRate = negatives.length ? negOk / negatives.length : 1;
  const propRate = property_tests.length ? propOk / property_tests.length : 1;
  const quality = 0.5 * posRate + 0.4 * negRate + 0.1 * propRate;
  const latency_p50 = runs ? Math.round(totalLatency / runs) : 0;

  return {
    quality_score: round(quality, 3),
    pass_rate_positive: round(posRate, 3),
    reject_rate_negative: round(negRate, 3),
    property_pass_rate: round(propRate, 3),
    latency_p50_us: latency_p50,
    trace,
    runs,
  };
}

function matches(actual, expected) {
  if (expected === undefined || expected === null) return actual !== undefined;
  if (typeof expected === 'function') return expected(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) return false;
    return actual.every((a, i) => matches(a, expected[i]));
  }
  if (typeof expected === 'object' && expected && typeof actual === 'object' && actual) {
    return Object.keys(expected).every(k => matches(actual[k], expected[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) < 1e-6;
  }
  return actual === expected;
}

function preview(x) {
  if (typeof x === 'string') return x.length > 120 ? x.slice(0, 117) + '...' : x;
  return x;
}

function round(x, d) { const m = 10 ** d; return Math.round(x * m) / m; }

export function hashSource(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export const QUALITY_GATE = 0.85;
