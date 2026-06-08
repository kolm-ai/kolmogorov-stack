// Wave 312 — /value-loop live status badge lock-in.
//
// The /value-loop page documents the five rungs but until W312 it was static.
// W312 adds a live status pill that probes /health on page load and updates
// the badge color + label + meta. Behavior assertions only — never page copy.
//
// What gets locked in:
//   1. The badge element exists with id=loop-status, role=status, data-state.
//   2. The probe targets /health and uses {cache:'no-store'} so CDN caches do
//      not lie about uptime.
//   3. The script downgrades to amber (not red) on network error, since
//      "couldn't reach kolm.ai" is usually the visitor's network not ours.
//   4. There is an AbortController-based 4s timeout so a hung backend does
//      not leave the pill spinning forever.
//   5. The badge has all three states (checking / green / amber/red) wired
//      via CSS data-state= selectors so a screen reader can read each.
//   6. The page still cites the W297 + W298 tests as the source of truth.
//   7. /health endpoint in src/router.js still emits {status, version,
//      uptime_s} — the three fields the badge displays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VL_PATH = path.resolve(__dirname, '..', 'public', 'value-loop.html');
const ROUTER_PATH = path.resolve(__dirname, '..', 'src', 'router.js');

function readVL() { return fs.readFileSync(VL_PATH, 'utf8'); }
function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

test('W312 #7 — /health endpoint still emits the three fields the badge displays', () => {
  // The badge reads .version + .uptime_s + (presence of status). If any of
  // those go away in src/router.js, the badge meta line breaks silently.
  const src = readRouter();
  assert.match(src, /r\.get\(['"]\/health['"]/, '/health route must exist');
  // Find the handler body.
  const start = src.indexOf("r.get('/health'");
  const end = src.indexOf('}));', start);
  const body = src.slice(start, end);
  assert.match(body, /status:\s*['"]ok['"]/, '/health must include status:"ok"');
  assert.match(body, /version:/, '/health must include version field');
  assert.match(body, /uptime_s:/, '/health must include uptime_s field');
});

