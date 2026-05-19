// W435 — kolm bridges observations + --since=last-compile + server-side
// ?since= filter on /v1/bridges/observations.
//
// The DoD audit named this as the missing handle on the retrain loop:
// without a since filter, every re-distillation had to re-read the whole
// corpus from scratch. With it, the loop is truly incremental.
//
// Lock-in:
//   #1 GET /v1/bridges/observations honors ?since=<iso> filter.
//   #2 Response envelope echoes since_applied for caller verification.
//   #3 CLI cmdBridges declared + wired into dispatcher.
//   #4 CLI command accepts --since-last-compile <artifact> and resolves
//      it via the artifact manifest's created_at.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');
const CLI_PATH = path.join(REPO, 'cli', 'kolm.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');
const cliSrc = () => fs.readFileSync(CLI_PATH, 'utf8');

test('W435 #1 — /v1/bridges/observations reads ?since= and filters created_at', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.get('/v1/bridges/observations'");
  assert.ok(idx !== -1, '/v1/bridges/observations route must exist');
  // Walk to next blank line + closing }); to scope the route body.
  const block = src.slice(idx, idx + 2500);
  assert.ok(/req\.query\?\.since/.test(block),
    'route must read req.query.since');
  assert.ok(/obs\s*=\s*obs\.filter\(\s*o\s*=>\s*String\(o\.created_at\s*\|\|\s*['"]['"]?\)\s*>=\s*sinceISO\s*\)/.test(block),
    'route must filter by created_at >= sinceISO');
});

test('W435 #2 — response envelope echoes since_applied', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.get('/v1/bridges/observations'");
  const block = src.slice(idx, idx + 2500);
  assert.ok(/since_applied:\s*sinceISO\s*\|\|\s*null/.test(block),
    'envelope must include since_applied: sinceISO || null');
});

test('W435 #3 — CLI cmdBridges exists and is wired into the dispatcher', () => {
  const src = cliSrc();
  assert.ok(/async function cmdBridges\(/.test(src),
    'cmdBridges must be declared');
  assert.ok(/bridges:\s*cmdBridges/.test(src),
    'cmdBridges must be in dispatcher map');
  assert.ok(/case 'bridges':\s*await withErrorContext\('bridges'/.test(src),
    'cmdBridges must be in switch dispatcher');
});

test('W435 #4 — cmdBridges accepts --since-last-compile and reads manifest', () => {
  const src = cliSrc();
  const idx = src.indexOf('async function cmdBridges(');
  const block = src.slice(idx, idx + 3000);
  assert.ok(/pickFlag\(rest,\s*['"]--since-last-compile['"]\)/.test(block),
    'must read --since-last-compile flag');
  assert.ok(/resolveArtifact\(sinceLastCompile\)/.test(block),
    'must resolve artifact path');
  // Must read manifest and pull created_at (or issued_at / compiled_at fallback)
  assert.ok(/manifest\.created_at\s*\|\|\s*manifest\.issued_at/.test(block),
    'must read manifest.created_at with issued_at fallback');
});

test('W435 #5 — cmdBridges passes since as query string to /v1/bridges/observations', () => {
  const src = cliSrc();
  const idx = src.indexOf('async function cmdBridges(');
  const block = src.slice(idx, idx + 3000);
  assert.ok(/\/v1\/bridges\/observations/.test(block),
    'must hit /v1/bridges/observations');
  assert.ok(/qs\.set\(\s*['"]since['"]\s*,\s*sinceISO\s*\)/.test(block),
    'must set since query param when sinceISO is resolved');
});
