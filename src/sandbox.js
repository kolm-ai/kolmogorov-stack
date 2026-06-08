// Reusable in-process egress monitor.
//
// Patches every Node socket-level + fetch-level entry point in the running
// process so any outbound network call from sandboxed code is recorded and
// blocked. Intended for two callers:
//
//   * `src/benchmark.js` - wraps a single artifact run, hard-fails on any
//     egress attempt (the manifest claims egress=0; we prove it).
//   * `src/artifact-runner.js` - when called with `{ egress: 'block' }`, the
//     same guard runs for every recipe.run on the server, so a malicious
//     recipe that smuggles past the DANGEROUS regex still cannot exfiltrate.
//
// CAVEAT: this is process-wide. install() returns a restore() function that
// MUST be called in a finally block, otherwise the calling process can't
// make legitimate HTTP/HTTPS requests. Concurrent installs are NOT supported
// (last-write-wins on the patch); callers must serialise across requests.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function createEgressMonitor({ throwOnAttempt = true } = {}) {
  const attempts = [];
  const patches = [];
  const modules = [];

  try { modules.push(['http', require('node:http')]); } catch {} // deliberate: cleanup
  try { modules.push(['https', require('node:https')]); } catch {} // deliberate: cleanup
  try { modules.push(['net', require('node:net')]); } catch {} // deliberate: cleanup
  try { modules.push(['tls', require('node:tls')]); } catch {} // deliberate: cleanup
  try { modules.push(['dns', require('node:dns')]); } catch {} // deliberate: cleanup

  function describeTarget(value) {
    if (typeof value === 'string') return value.slice(0, 200);
    if (value instanceof URL) return value.toString().slice(0, 200);
    if (value && typeof value === 'object') {
      if (value.href) return String(value.href).slice(0, 200);
      if (value.hostname || value.host) return String(value.hostname || value.host).slice(0, 200);
    }
    return typeof value;
  }

  function record(api, args) {
    attempts.push({ api, target: describeTarget(args[0]), at: Date.now() });
    if (throwOnAttempt) throw new Error(`network egress blocked by kolm sandbox: ${api}`);
    return null;
  }

  function patch(obj, key, api) {
    if (!obj || typeof obj[key] !== 'function') return;
    const original = obj[key];
    obj[key] = function (...args) { return record(api, args); };
    patches.push(() => { obj[key] = original; });
  }

  return {
    attempts,
    install() {
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch === 'function') {
        globalThis.fetch = (...args) => record('fetch', args);
        patches.push(() => { globalThis.fetch = originalFetch; });
      }
      for (const [name, mod] of modules) {
        for (const key of ['request', 'get', 'connect', 'createConnection', 'lookup', 'resolve', 'resolve4', 'resolve6']) {
          patch(mod, key, `${name}.${key}`);
        }
      }
      return () => {
        while (patches.length) patches.pop()();
      };
    },
  };
}

// Convenience: run `fn` with an egress monitor installed; restore even on
// throw; return both the function's result and the egress attempts list.
export async function withEgressBlocked(fn) {
  const mon = createEgressMonitor({ throwOnAttempt: true });
  const restore = mon.install();
  try {
    const result = await fn();
    return { result, attempts: mon.attempts.slice() };
  } finally {
    restore();
  }
}
