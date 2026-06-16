// src/sandbox-worker.js
//
// Worker-thread entry for the pure-Node isolation boundary (see
// src/sandbox-isolation.js). This file runs INSIDE the worker isolate:
//   - separate V8 heap with a hard maxOldGenerationSizeMb cap (set by parent),
//   - env:{} so process.env is empty (no host secrets visible),
//   - the egress monitor from src/sandbox.js installed so any network attempt
//     by the untrusted recipe is blocked + reported,
//   - the recipe compiled in a node:vm context with the canonical
//     constructor-escape primitives nulled and a frozen, capability-scoped lib.
//
// The parent preempts a spinning recipe via worker.terminate() and reports a
// memory blowout via the worker exit code; this file only handles the
// well-behaved + recipe-threw + egress + oversized-output cases and posts a
// single message envelope back.
//
// ASCII only. No new deps.

import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { createEgressMonitor } from './sandbox.js';

const VERSION = 'sbx-iso-v1';

function post(msg) {
  try { parentPort.postMessage(msg); } catch { /* parent gone */ }
}

// PURE, self-contained capability lib - re-implemented here so the untrusted
// context holds ZERO references to host modules. Mirrors the isolated-vm path's
// allowlist in src/sandbox-isolation.js.
const LIB_IMPLS = {
  upper: (s) => String(s).toUpperCase(),
  lower: (s) => String(s).toLowerCase(),
  trim: (s) => String(s).trim(),
  reverse: (s) => String(s).split('').reverse().join(''),
  len: (s) => (s == null ? 0 : (s.length || 0)),
  slice: (s, a, b) => String(s).slice(a, b),
  json_stringify: (o) => JSON.stringify(o),
  json_parse: (s) => JSON.parse(s),
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x))),
  round: (x, d) => { const f = Math.pow(10, d || 0); return Math.round(Number(x) * f) / f; },
  abs: (x) => Math.abs(Number(x)),
};
const DEFAULT_LIB_KEYS = ['upper', 'lower', 'trim', 'reverse', 'len', 'slice', 'json_stringify', 'json_parse', 'clamp', 'round', 'abs'];

function buildLib(libKeys) {
  const keys = Array.isArray(libKeys) && libKeys.length ? libKeys : DEFAULT_LIB_KEYS;
  const lib = {};
  for (const k of keys) {
    if (LIB_IMPLS[k]) lib[k] = LIB_IMPLS[k];
  }
  return Object.freeze(lib);
}

function main() {
  const { source, input, limits, libKeys } = workerData || {};
  const outputCap = (limits && Number(limits.output_bytes)) || (1 << 20);

  // CAPABILITY-SCOPED CONTEXT. We harden the in-isolate vm context by nulling
  // the canonical escape primitives. node:vm alone is not a boundary, but here
  // it is the INNER layer; the OUTER boundary is the worker thread itself
  // (separate heap, env:{}, preemptive terminate, hard memory cap). Defence in
  // depth on top of a real boundary, not in place of one.
  const sandboxGlobals = {
    // Deny host capabilities outright inside the context.
    process: undefined,
    require: undefined,
    module: undefined,
    globalThis: undefined,
    global: undefined,
    Function: undefined,        // block the canonical Function-constructor route
    eval: undefined,
    WebAssembly: undefined,
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    queueMicrotask: undefined,
    Buffer: undefined,
    // Pure values the recipe is allowed to use.
    Math: Object.freeze(Object.create(Math)),
    JSON: Object.freeze(Object.create(JSON)),
    String, Number, Boolean, Array, Object, RegExp, Date, Map, Set, Symbol,
    isNaN, isFinite, parseInt, parseFloat,
  };

  let monitor;
  let restore = () => {};
  try {
    // Block + record any egress attempt the recipe makes (belt-and-braces:
    // the worker has its own loader, so a recipe that somehow reached
    // node:http would still be stopped here).
    monitor = createEgressMonitor({ throwOnAttempt: true });
    restore = monitor.install();
  } catch { /* monitor optional; worker isolation still holds */ }

  try {
    const lib = buildLib(libKeys);
    const wrapped = `(function(input, lib){ "use strict"; ${source}\n; return generate(input, lib); })`;
    const script = new vm.Script(wrapped, { filename: 'recipe-generator.js' });
    // No timeout option here: the PARENT owns preemption via terminate(). A
    // vm timeout would only catch sync spins; terminate() catches everything.
    const ctx = vm.createContext(sandboxGlobals, { name: 'kolm-recipe-ctx' });
    const fn = script.runInContext(ctx);
    const output = fn(input, lib);

    let serialized;
    try { serialized = JSON.stringify(output == null ? null : output); }
    catch { serialized = null; }
    if (serialized != null && serialized.length > outputCap) {
      post({ ok: false, error: 'output_too_large', detail: `output ${serialized.length}B > ${outputCap}B cap`, version: VERSION });
      return;
    }
    // Round-trip through JSON so only structured-cloneable data crosses back
    // (no functions/host refs can ride out of the isolate).
    const safeOutput = serialized == null ? null : JSON.parse(serialized);
    post({ ok: true, output: safeOutput, version: VERSION });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/network egress blocked/i.test(msg)) {
      post({ ok: false, error: 'egress_blocked', detail: msg, egress_attempts: (monitor && monitor.attempts) ? monitor.attempts.slice() : [], version: VERSION });
    } else {
      post({ ok: false, error: 'recipe_threw', detail: msg, version: VERSION });
    }
  } finally {
    try { restore(); } catch { /* ignore */ }
  }
}

main();
