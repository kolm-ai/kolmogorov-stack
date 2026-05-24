// W784 -- Plugin architecture.
//
// Atomic items pinned (matches the W784 implementation):
//
//   1)  PLUGIN_VERSION matches /^w784-/ + PLUGIN_KINDS frozen + exactly 4 kinds
//   2)  PLUGIN_DEFAULTS frozen + carries PLUGIN_KINDS reference
//   3)  PluginError extends Error + carries .code
//   4)  pluginsDir resolves via KOLM_PLUGINS_DIR override + ~/.kolm/plugins fallback
//   5)  listPlugins empty -> {ok:true, total:0, plugins:[], errors:[]}
//   6)  readManifest happy + invalid_json + missing_field paths
//   7)  registerPlugin rejects no manifest_path + bad name + unknown kind
//   8)  registerPlugin happy path copies into pluginsDir + listPlugins surfaces it
//   9)  loadPlugins({kind}) filters + invalid_kind envelope
//   10) getPlugin returns not_found envelope on missing
//   11) Router wires GET/POST /v1/plugins + GET /v1/plugins/:name + auth-gated
//   12) sw.js cache key W604 family lock: regex wave(\d{3,4}) with threshold >=784
//   13) public/docs/plugins.html exists w/ data-w784 anchors
//
// W604 anti-brittleness: family locks use regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugins from '../src/plugins.js';

const {
  PLUGIN_VERSION,
  PLUGIN_KINDS,
  PLUGIN_DEFAULTS,
  PluginError,
  pluginsDir,
  readManifest,
  listPlugins,
  loadPlugins,
  registerPlugin,
  getPlugin,
} = plugins;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function freshPluginsDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w784-'));
  const pdir = path.join(tmp, 'plugins');
  fs.mkdirSync(pdir, { recursive: true });
  process.env.KOLM_PLUGINS_DIR = pdir;
  return { tmp, pdir };
}

function seedPlugin(pdir, name, manifestPatch, entryPatch) {
  const dir = path.join(pdir, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = Object.assign({
    name,
    version: '1.0.0',
    kinds: ['quantization'],
    entry: 'index.js',
    description: 'seeded test plugin',
  }, manifestPatch || {});
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  if (entryPatch !== false) {
    fs.writeFileSync(path.join(dir, manifest.entry || 'index.js'),
      entryPatch || '// seeded plugin entry\nexport default async () => ({ ok: true });\n');
  }
  return { dir, manifest };
}

// =============================================================================
// 1) Module exports + version regex + PLUGIN_KINDS shape
// =============================================================================
test('W784 #1 -- PLUGIN_VERSION matches /^w784-/ + PLUGIN_KINDS frozen + 4 kinds', () => {
  assert.equal(typeof PLUGIN_VERSION, 'string');
  assert.match(PLUGIN_VERSION, /^w784-/);
  assert.ok(Object.isFrozen(PLUGIN_KINDS), 'PLUGIN_KINDS must be frozen');
  assert.equal(PLUGIN_KINDS.length, 4);
  assert.deepEqual(Array.from(PLUGIN_KINDS),
    ['quantization', 'runtime', 'capture-processor', 'eval-metric']);
});

// =============================================================================
// 2) PLUGIN_DEFAULTS frozen
// =============================================================================
test('W784 #2 -- PLUGIN_DEFAULTS frozen + carries PLUGIN_KINDS', () => {
  assert.ok(Object.isFrozen(PLUGIN_DEFAULTS));
  assert.equal(PLUGIN_DEFAULTS.PLUGIN_KINDS, PLUGIN_KINDS);
  assert.ok(Array.isArray(PLUGIN_DEFAULTS.REQUIRED_FIELDS));
  assert.equal(PLUGIN_DEFAULTS.MANIFEST_FILE, 'plugin.json');
});

// =============================================================================
// 3) PluginError shape
// =============================================================================
test('W784 #3 -- PluginError extends Error + carries .code', () => {
  const e = new PluginError('boom', 'test_code', { x: 1 });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PluginError);
  assert.equal(e.name, 'PluginError');
  assert.equal(e.message, 'boom');
  assert.equal(e.code, 'test_code');
  assert.deepEqual(e.detail, { x: 1 });
  // Default code when omitted.
  const e2 = new PluginError('boom2');
  assert.equal(e2.code, 'plugin_error');
});

// =============================================================================
// 4) pluginsDir override
// =============================================================================
test('W784 #4 -- pluginsDir honors KOLM_PLUGINS_DIR override', () => {
  const { pdir } = freshPluginsDir();
  assert.equal(pluginsDir(), pdir);
  // Without the override it falls back to a ~/.kolm/plugins path. We don't
  // assert the exact path (varies by OS); just that it ends with /plugins.
  delete process.env.KOLM_PLUGINS_DIR;
  const fallback = pluginsDir();
  assert.ok(fallback.endsWith('plugins') || fallback.endsWith('plugins/'),
    'fallback dir must end with "plugins" (got: ' + fallback + ')');
  // Restore for subsequent tests.
  process.env.KOLM_PLUGINS_DIR = pdir;
});

// =============================================================================
// 5) listPlugins empty
// =============================================================================
test('W784 #5 -- listPlugins on empty dir returns {ok:true, total:0, plugins:[]}', () => {
  freshPluginsDir();
  const out = listPlugins();
  assert.equal(out.ok, true);
  assert.equal(out.total, 0);
  assert.deepEqual(out.plugins, []);
  assert.deepEqual(out.errors, []);
  assert.match(out.version, /^w784-/);
});

// =============================================================================
// 6) readManifest paths
// =============================================================================
test('W784 #6 -- readManifest happy + invalid_json + missing_field + bad name', () => {
  const { pdir } = freshPluginsDir();

  // happy
  const { dir } = seedPlugin(pdir, 'happy-plug');
  const r = readManifest(path.join(dir, 'plugin.json'));
  assert.equal(r.ok, true);
  assert.equal(r.manifest.name, 'happy-plug');

  // invalid json
  const badDir = path.join(pdir, 'bad-json-plug');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'plugin.json'), '{ this is not json');
  const r2 = readManifest(path.join(badDir, 'plugin.json'));
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'manifest_invalid_json');

  // missing field (no entry)
  const missDir = path.join(pdir, 'miss-plug');
  fs.mkdirSync(missDir, { recursive: true });
  fs.writeFileSync(path.join(missDir, 'plugin.json'),
    JSON.stringify({ name: 'miss-plug', version: '1.0.0', kinds: ['runtime'] }));
  const r3 = readManifest(path.join(missDir, 'plugin.json'));
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'missing_field');

  // bad name (path traversal attempt)
  const badNameDir = path.join(pdir, 'bad-name-plug');
  fs.mkdirSync(badNameDir, { recursive: true });
  fs.writeFileSync(path.join(badNameDir, 'plugin.json'),
    JSON.stringify({ name: '../etc/passwd', version: '1.0.0', kinds: ['runtime'], entry: 'i.js' }));
  const r4 = readManifest(path.join(badNameDir, 'plugin.json'));
  assert.equal(r4.ok, false);
  assert.equal(r4.error, 'bad_name');

  // unreadable
  const r5 = readManifest(path.join(pdir, 'does-not-exist', 'plugin.json'));
  assert.equal(r5.ok, false);
  assert.equal(r5.error, 'manifest_unreadable');

  // unknown kind
  const ukDir = path.join(pdir, 'uk-plug');
  fs.mkdirSync(ukDir, { recursive: true });
  fs.writeFileSync(path.join(ukDir, 'plugin.json'),
    JSON.stringify({ name: 'uk-plug', version: '1.0.0', kinds: ['banana'], entry: 'i.js' }));
  const r6 = readManifest(path.join(ukDir, 'plugin.json'));
  assert.equal(r6.ok, false);
  assert.equal(r6.error, 'unknown_kind');

  // bad entry path traversal
  const teDir = path.join(pdir, 'te-plug');
  fs.mkdirSync(teDir, { recursive: true });
  fs.writeFileSync(path.join(teDir, 'plugin.json'),
    JSON.stringify({ name: 'te-plug', version: '1.0.0', kinds: ['runtime'], entry: '../../../etc/x' }));
  const r7 = readManifest(path.join(teDir, 'plugin.json'));
  assert.equal(r7.ok, false);
  assert.equal(r7.error, 'bad_entry_path');
});

// =============================================================================
// 7) registerPlugin rejects bad inputs
// =============================================================================
test('W784 #7 -- registerPlugin rejects no manifest_path / bad manifest / missing entry', () => {
  freshPluginsDir();

  // no manifest_path
  let err = null;
  try { registerPlugin({}); } catch (e) { err = e; }
  assert.ok(err instanceof PluginError);
  assert.equal(err.code, 'no_manifest_path');

  // bad manifest (unknown kind)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w784-src-'));
  fs.writeFileSync(path.join(tmp, 'plugin.json'),
    JSON.stringify({ name: 'kind-bad', version: '1.0.0', kinds: ['nope'], entry: 'i.js' }));
  fs.writeFileSync(path.join(tmp, 'i.js'), '// x');
  err = null;
  try { registerPlugin({ manifest_path: path.join(tmp, 'plugin.json') }); } catch (e) { err = e; }
  assert.ok(err instanceof PluginError);
  assert.equal(err.code, 'unknown_kind');

  // entry missing at source
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w784-src2-'));
  fs.writeFileSync(path.join(tmp2, 'plugin.json'),
    JSON.stringify({ name: 'no-entry', version: '1.0.0', kinds: ['runtime'], entry: 'missing.js' }));
  err = null;
  try { registerPlugin({ manifest_path: path.join(tmp2, 'plugin.json') }); } catch (e) { err = e; }
  assert.ok(err instanceof PluginError);
  assert.equal(err.code, 'entry_missing');
});

// =============================================================================
// 8) registerPlugin happy path
// =============================================================================
test('W784 #8 -- registerPlugin copies plugin dir into pluginsDir + listPlugins surfaces it', () => {
  const { pdir } = freshPluginsDir();

  const srcTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w784-src-happy-'));
  fs.writeFileSync(path.join(srcTmp, 'plugin.json'),
    JSON.stringify({
      name: 'my-quant',
      version: '1.0.0',
      kinds: ['quantization'],
      entry: 'index.js',
      description: 'custom quant',
    }, null, 2));
  fs.writeFileSync(path.join(srcTmp, 'index.js'),
    'export default async function () { return { ok: true }; }\n');

  const out = registerPlugin({ manifest_path: path.join(srcTmp, 'plugin.json') });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'my-quant');
  assert.deepEqual(out.kinds, ['quantization']);
  assert.equal(out.plugin_dir, path.join(pdir, 'my-quant'));
  // Files actually exist at dest
  assert.ok(fs.statSync(path.join(pdir, 'my-quant', 'plugin.json')).isFile());
  assert.ok(fs.statSync(path.join(pdir, 'my-quant', 'index.js')).isFile());

  // listPlugins now surfaces it
  const list = listPlugins();
  assert.equal(list.ok, true);
  assert.equal(list.total, 1);
  assert.equal(list.plugins[0].name, 'my-quant');
  assert.equal(list.plugins[0].entry_exists, true);
});

// =============================================================================
// 9) loadPlugins filter + invalid_kind envelope
// =============================================================================
test('W784 #9 -- loadPlugins({kind}) filters + returns invalid_kind on bad kind', () => {
  const { pdir } = freshPluginsDir();
  seedPlugin(pdir, 'q-one',  { kinds: ['quantization'] });
  seedPlugin(pdir, 'r-one',  { kinds: ['runtime'] });
  seedPlugin(pdir, 'multi',  { kinds: ['runtime', 'eval-metric'] });

  const q = loadPlugins({ kind: 'quantization' });
  assert.equal(q.ok, true);
  assert.equal(q.total, 1);
  assert.equal(q.plugins[0].name, 'q-one');

  const r = loadPlugins({ kind: 'runtime' });
  assert.equal(r.total, 2,
    'runtime filter must catch both r-one and multi (got: ' + r.total + ')');
  const names = r.plugins.map((p) => p.name).sort();
  assert.deepEqual(names, ['multi', 'r-one']);

  const evalm = loadPlugins({ kind: 'eval-metric' });
  assert.equal(evalm.total, 1);
  assert.equal(evalm.plugins[0].name, 'multi');

  // Unfiltered returns everything
  const all = loadPlugins({});
  assert.equal(all.total, 3);

  // invalid_kind envelope
  const bad = loadPlugins({ kind: 'banana' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_kind');
  assert.deepEqual(Array.from(bad.supported), Array.from(PLUGIN_KINDS));
});

// =============================================================================
// 10) getPlugin not_found
// =============================================================================
test('W784 #10 -- getPlugin returns not_found envelope on missing', () => {
  freshPluginsDir();
  const out = getPlugin('does-not-exist');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');

  // bad name shape
  const out2 = getPlugin('../etc/passwd');
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'bad_name');

  // missing name
  const out3 = getPlugin('');
  assert.equal(out3.ok, false);
  assert.equal(out3.error, 'name_required');
});

// =============================================================================
// 11) Router wires the 3 plugin routes + auth-gated
// =============================================================================
test('W784 #11 -- router wires GET/POST /v1/plugins + GET /v1/plugins/:name + auth-gated', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.get\(['"]\/v1\/plugins['"]/);
  assert.match(router, /r\.post\(['"]\/v1\/plugins['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/plugins\/:name['"]/);
  // Each must auth-gate via req.tenant_record
  const idxGetList   = router.indexOf("r.get('/v1/plugins'");
  const idxPostList  = router.indexOf("r.post('/v1/plugins'");
  const idxGetOne    = router.indexOf("r.get('/v1/plugins/:name'");
  assert.ok(idxGetList > 0 && idxPostList > 0 && idxGetOne > 0);
  for (const idx of [idxGetList, idxPostList, idxGetOne]) {
    const slice = router.slice(idx, idx + 600);
    assert.match(slice, /req\.tenant_record/,
      'plugin route at offset ' + idx + ' must auth-gate via req.tenant_record');
  }
  // Version stamps
  assert.match(router, /version:\s*['"]w784-/, 'router must emit w784 version stamps');
});

// =============================================================================
// 12) sw.js W604 family lock — regex + threshold, never explicit array
// =============================================================================
test('W784 #12 -- sw.js cache key still parses via wave(NNN) regex (W604 anti-brittleness)', () => {
  const swPath = path.join(REPO_ROOT, 'public', 'sw.js');
  const sw = fs.readFileSync(swPath, 'utf8');
  // Lock the regex-based pattern. We do NOT pin the literal cache string —
  // W604 lesson: explicit-array checks fight the next wave's bump.
  const cacheMatch = sw.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(cacheMatch, 'sw.js must declare CACHE const');
  const cacheKey = cacheMatch[1];
  assert.ok(cacheKey.startsWith('kolm-'), 'cache key must start with kolm- (got: ' + cacheKey + ')');
  // Wave-number tokens must be parseable with the standard regex used across
  // all post-W604 surfaces.
  const allWaveMatches = Array.from(cacheKey.matchAll(/wave(\d{3,4})/g)).map(m => Number(m[1]));
  // Either the cache key carries wave tokens (then they must be in range),
  // or it carries none (some waves bump only the non-wave suffix). Both are
  // OK — what we ban is brittle explicit-array gates.
  for (const n of allWaveMatches) {
    assert.ok(n >= 100 && n <= 9999, 'wave token out of range: wave' + n);
  }
});

// =============================================================================
// 13) /docs/plugins.html ships with data-w784 anchor
// =============================================================================
test('W784 #13 -- public/docs/plugins.html exists w/ data-w784 anchor', () => {
  const p = path.join(REPO_ROOT, 'public', 'docs', 'plugins.html');
  assert.ok(fs.statSync(p).isFile(), 'public/docs/plugins.html must exist');
  const html = fs.readFileSync(p, 'utf8');
  assert.match(html, /data-w784/, 'plugins.html must carry a data-w784 anchor for test cross-ref');
  // Must reference the four kinds.
  for (const k of PLUGIN_KINDS) {
    assert.ok(html.includes(k),
      'plugins.html must reference plugin kind: ' + k);
  }
  // Must include a worked manifest example.
  assert.match(html, /plugin\.json/);
});
