#!/usr/bin/env node
/*
 * ks-sparkline-smoke.mjs — headless test of public/account/ks-sparkline.js.
 *
 * ks-sparkline.js is a browser-oriented UMD/IIFE (no `export`), so we load it
 * by reading the file text and evaluating it inside a fresh module-style
 * function with a captured `module.exports` shim. This exercises the SAME code
 * path the browser runs and returns the pure `renderSparkline` for assertions.
 *
 * Assertions:
 *   1. 3 chronological points -> exactly one <polyline>, points="" has 3 pairs
 *   2. 0 points -> empty-state markup, NO <polyline>, no throw
 *   3. 1 point -> renders without error
 *   4. output contains role="img" and an aria-label
 *   5. NO forbidden warm hex (#c2410c, #faf9f7) anywhere in ks-sparkline.js
 *
 * Prints "<N> passed, <M> failed" and exits non-zero on any failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dirname, '..', 'public', 'account', 'ks-sparkline.js');

const source = readFileSync(SRC_PATH, 'utf8');

// Evaluate the IIFE with a module.exports shim so we capture the public API
// regardless of how the UMD wrapper resolves `this`.
function loadApi(code) {
  const shim = { exports: {} };
  // The wrapper references `module`, `window` (absent here), `self`, `this`.
  // Provide `module`; leave window undefined so the Node/global branch runs.
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'globalThis', code + '\n;return module.exports;');
  const out = fn(shim, shim.exports, globalThis);
  if (out && typeof out.renderSparkline === 'function') return out;
  if (typeof globalThis.renderSparkline === 'function') {
    return { renderSparkline: globalThis.renderSparkline, ...(globalThis.KolmSparkline || {}) };
  }
  throw new Error('renderSparkline not found after eval');
}

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); }
}

let api;
try {
  api = loadApi(source);
} catch (e) {
  console.error('FATAL: could not load ks-sparkline.js:', e && e.message);
  console.log('0 passed, 1 failed');
  process.exit(1);
}
const { renderSparkline } = api;

// Helpers
function countOccur(hay, needle) {
  return hay.split(needle).length - 1;
}
function polylinePointCount(svg) {
  const m = svg.match(/<polyline[^>]*\bpoints="([^"]*)"/);
  if (!m) return -1;
  const raw = m[1].trim();
  if (!raw) return 0;
  return raw.split(/\s+/).filter(Boolean).length;
}

// ---- Assertion 1: 3 chronological points -> one polyline, 3 coord pairs ---
try {
  const pts3 = [
    { ts: '2026-05-01T00:00:00Z', kscore: 0.71, run_id: 'r1' },
    { ts: '2026-05-05T00:00:00Z', kscore: 0.78, run_id: 'r2' },
    { ts: '2026-05-09T00:00:00Z', kscore: 0.83, run_id: 'r3' },
  ];
  const svg3 = renderSparkline(pts3);
  check('3pts: exactly one <polyline>', countOccur(svg3, '<polyline') === 1);
  check('3pts: points="" has exactly 3 coordinate pairs', polylinePointCount(svg3) === 3);
} catch (e) {
  check('3pts: render did not throw (' + (e && e.message) + ')', false);
}

// ---- Assertion 2: 0 points -> empty state, no polyline, no throw ----------
try {
  const svg0 = renderSparkline([]);
  check('0pts: no <polyline>', countOccur(svg0, '<polyline') === 0);
  check('0pts: empty-state markup present', /no runs yet/i.test(svg0));
  check('0pts: returns a non-empty <svg> string', typeof svg0 === 'string' && /<svg[\s>]/.test(svg0));
} catch (e) {
  check('0pts: render did not throw (' + (e && e.message) + ')', false);
}

// ---- Assertion 3: 1 point -> renders without error ------------------------
try {
  const svg1 = renderSparkline([{ ts: '2026-05-01T00:00:00Z', kscore: 0.66, run_id: 'r1' }]);
  check('1pt: returns a non-empty <svg> string', typeof svg1 === 'string' && svg1.indexOf('<svg') === 0);
  check('1pt: no <polyline> for a single point', countOccur(svg1, '<polyline') === 0);
} catch (e) {
  check('1pt: render did not throw (' + (e && e.message) + ')', false);
}

// ---- Assertion 4: output contains role="img" and aria-label ---------------
try {
  const svg = renderSparkline([
    { kscore: 0.5 }, { kscore: 0.6 },
  ]);
  check('a11y: contains role="img"', /role="img"/.test(svg));
  check('a11y: contains aria-label="..."', /aria-label="[^"]+"/.test(svg));
} catch (e) {
  check('a11y: render did not throw (' + (e && e.message) + ')', false);
}

// ---- Assertion 5: NO forbidden warm hex in ks-sparkline.js ----------------
{
  const lower = source.toLowerCase();
  check('palette: no #c2410c (burnt sienna) in source', lower.indexOf('#c2410c') === -1);
  check('palette: no #faf9f7 (warm paper) in source', lower.indexOf('#faf9f7') === -1);
}

// ---- Report ---------------------------------------------------------------
if (fails.length) {
  console.error('Failures:');
  for (const f of fails) console.error('  - ' + f);
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
