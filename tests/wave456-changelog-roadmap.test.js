// @public-routes-only
// W456: public changelog + roadmap surface.
//
// Asserts behavior + structural invariants, NOT page copy:
// - src/changelog.js exports the WAVES source-of-truth + helpers
// - /v1/changelog public route returns the right envelope
// - CLI wires cmdChangelog into both dispatchers + HELP + COMPLETION_VERBS
// - scripts/build-changelog.cjs preserves the page nav (auto-block only)
// - public/changelog.html and roadmap.html stamps are not stale
// - sw.js CACHE slug references the W454+ family (matches W446 #5 pattern)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const fileUrl = (p) => pathToFileURL(p).href;

test('W456 #1 src/changelog.js exports WAVES + helpers, latest is the current wave', async () => {
  const mod = await import(fileUrl(join(ROOT, 'src', 'changelog.js')));
  assert.ok(Array.isArray(mod.WAVES), 'WAVES must be an array');
  assert.ok(mod.WAVES.length > 0, 'WAVES must be non-empty');
  assert.equal(typeof mod.listWaves, 'function');
  assert.equal(typeof mod.getWave, 'function');
  assert.equal(typeof mod.latestWave, 'function');
  assert.equal(typeof mod.waveCount, 'function');
  // Each entry has the canonical fields.
  for (const w of mod.WAVES) {
    assert.equal(typeof w.wave, 'string', 'wave field must be a string');
    assert.match(w.wave, /^W\d+/, 'wave must start with W<number>');
    assert.match(String(w.date), /^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
    assert.equal(typeof w.title, 'string');
    assert.ok(w.title.length > 0, 'title cannot be empty');
    assert.equal(typeof w.summary, 'string');
  }
  // Latest entry must be in the W456+ shipping family — when W457+ lands at
  // the top of WAVES, this test continues to pass without churning. Same
  // family-pattern relaxation pattern as W456 #8 (sw.js CACHE slug).
  const latest = mod.latestWave();
  const lm = String(latest.wave || '').match(/^W(\d{3,4})$/);
  assert.ok(lm, `latestWave().wave must match W<number>, got: ${latest.wave}`);
  const ln = parseInt(lm[1], 10);
  assert.ok(ln >= 456, `latestWave() must be in the W456+ family, got: ${latest.wave}`);
});

test('W456 #2 listWaves respects --limit, --since, --tag filters', async () => {
  const mod = await import(fileUrl(join(ROOT, 'src', 'changelog.js')));
  // limit
  const five = mod.listWaves({ limit: 5 });
  assert.equal(five.length, 5);
  // since drops waves whose max wave-number is below the cutoff
  const sinceW450 = mod.listWaves({ since: 'W450', limit: 200 });
  for (const w of sinceW450) {
    const maxNum = Math.max(...(w.wave.match(/\d+/g) || ['0']).map(Number));
    assert.ok(maxNum >= 450, `${w.wave} should be >= W450`);
  }
  // tag filter
  const distillWaves = mod.listWaves({ tag: 'distill', limit: 200 });
  assert.ok(distillWaves.length > 0, 'at least one distill-tagged wave expected');
  for (const w of distillWaves) {
    assert.ok(Array.isArray(w.tags) && w.tags.includes('distill'));
  }
});

test('W456 #3 /v1/changelog is public (no auth) and returns the right envelope', async () => {
  const { buildRouter } = await import(fileUrl(join(ROOT, 'src', 'router.js')));
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = app.listen(0);
  try {
    const port = server.address().port;
    // No auth header — should still succeed because it's a public marketing route.
    const res = await fetch('http://127.0.0.1:' + port + '/v1/changelog?limit=3');
    assert.equal(res.status, 200, 'unauthed GET must succeed');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.waves), 'waves must be an array');
    assert.equal(body.waves.length, 3, 'limit=3 must cap to 3');
    assert.ok(typeof body.total === 'number' && body.total >= body.waves.length);
    assert.ok(body.latest && typeof body.latest.wave === 'string');
  } finally {
    server.close();
  }
});

test('W456 #4 CLI wires cmdChangelog into BOTH dispatchers + HELP + COMPLETION_VERBS', () => {
  const cli = readFileSync(join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /async function cmdChangelog\(/, 'cmdChangelog must be defined');
  // Main dispatcher
  assert.match(cli, /case 'changelog':\s*await withErrorContext\('changelog'/, 'main dispatcher must wire changelog');
  // Repl dispatcher
  assert.match(cli, /case 'changelog': return withErrorContext\('changelog'/, 'repl dispatcher must wire changelog');
  // HELP
  assert.match(cli, /\n  changelog:\s*`kolm changelog/, 'HELP.changelog must exist');
  // COMPLETION_VERBS
  assert.match(cli, /COMPLETION_VERBS\s*=\s*\[[^\]]*'changelog'/s, 'COMPLETION_VERBS must include changelog');
});

test('W456 #5 build-changelog.cjs is in-place auto-block mode (preserves W221+W399 nav)', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'build-changelog.cjs'), 'utf8');
  // The build() function must slice between AUTO_BEGIN and AUTO_END rather
  // than always invoking fullPage() (which would clobber the mega-menu nav).
  assert.match(script, /existing\.indexOf\(AUTO_BEGIN\)/, 'build must locate AUTO_BEGIN in existing file');
  assert.match(script, /existing\.indexOf\(AUTO_END\)/, 'build must locate AUTO_END in existing file');
  assert.match(script, /existing\.slice\(0, beginAt\)/, 'build must slice prefix before AUTO_BEGIN');
});

test('W456 #6 public/changelog.html has script markers + curated narrative + nav', () => {
  const html = readFileSync(join(ROOT, 'public', 'changelog.html'), 'utf8');
  // The build script slices between these markers; the page now ships a hand-curated
  // narrative changelog (no atomic per-wave dump), so the markers can sit empty.
  assert.match(html, /<!-- CHANGELOG_AUTO_BEGIN -->/, 'AUTO_BEGIN marker present');
  assert.match(html, /<!-- CHANGELOG_AUTO_END -->/, 'AUTO_END marker present');
  // The curated narrative must include at least the current month bucket.
  assert.match(html, /id="may-2026"/, 'May 2026 narrative section must be present');
  // Site-wide mega-menu nav must still be injected (replaces the older inline nav block).
  assert.match(html, /class="mega-menu"/, 'mega-menu nav still in place');
});

test('W456 #7 public/roadmap.html eyebrow stamp no longer says "wave 159"', () => {
  const html = readFileSync(join(ROOT, 'public', 'roadmap.html'), 'utf8');
  // Must NOT still claim wave 159 in the public eyebrow.
  assert.doesNotMatch(html, /public roadmap[^<]*wave 159/, 'eyebrow stamp must be updated');
  // Must point readers at /changelog for the freshest waves.
  assert.match(html, /\/changelog/, 'must link out to /changelog');
});

test('W456 #8 sw.js CACHE slug references the W454+ audit-finish family', () => {
  const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'sw.js must define CACHE');
  const slug = m[1];
  // Relaxed past wave456 once W457+ landed. Same pattern as W446 #5 / W454 #9.
  // Match wave454 or any wave with index >= 454 (forward-compat for the audit-finish family).
  const wm = slug.match(/wave(\d{3,4})/);
  assert.ok(wm, 'sw.js CACHE slug must include a waveNNN token, got: ' + slug);
  const n = parseInt(wm[1], 10);
  assert.ok(n >= 454, 'sw.js CACHE slug must reference the W454+ family, got: ' + slug);
});

test('W456 #9 vercel.json has /changelog and /roadmap rewrites', () => {
  const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = v.rewrites || [];
  const cl = rewrites.find((r) => r.source === '/changelog');
  const rd = rewrites.find((r) => r.source === '/roadmap');
  assert.ok(cl, '/changelog rewrite must exist');
  assert.ok(rd, '/roadmap rewrite must exist');
  assert.equal(cl.destination, '/changelog.html');
  assert.equal(rd.destination, '/roadmap.html');
});

test('W456 #10 getWave() returns the canonical entry by exact wave id', async () => {
  const mod = await import(fileUrl(join(ROOT, 'src', 'changelog.js')));
  const w = mod.getWave('W455');
  assert.ok(w, 'getWave(W455) must return an entry');
  assert.equal(w.wave, 'W455');
  assert.match(w.title, /distill-runs/i);
  // Unknown wave returns null, not throws.
  const miss = mod.getWave('W9999');
  assert.equal(miss, null);
});

test('W456 #11 /v1/changelog clears authMiddleware unauthed (PUBLIC_API exemption)', async () => {
  // W456 #3 hits buildRouter() directly, which bypasses auth. Production
  // mounts authMiddleware in front of every /v1/* path, so the route must
  // ALSO be listed in PUBLIC_API or it returns 401. This test pins the
  // full middleware stack so a refactor that drops the PUBLIC_API entry
  // fails CI instead of silently breaking prod.
  const { buildRouter } = await import(fileUrl(join(ROOT, 'src', 'router.js')));
  const { authMiddleware } = await import(fileUrl(join(ROOT, 'src', 'auth.js')));
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(buildRouter());
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/v1/changelog?limit=1');
    assert.equal(res.status, 200, 'authMiddleware must let /v1/changelog through unauthed');
    const body = await res.json();
    assert.equal(body.ok, true, 'envelope must be ok:true even with no Authorization header');
    assert.ok(Array.isArray(body.waves));
  } finally {
    server.close();
  }
});
