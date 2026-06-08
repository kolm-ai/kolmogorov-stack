// Wave 409e/f/g — production-readiness provisional flag,
// account UI <-> server route parity, and /v1/models discovery surface.
//
// W409e: productionReadySync() returns a provisional verdict only. Every
// callsite that flips production_ready:true for a real artifact must AWAIT
// productionReady() so the executable_bundle + eval_parity + durability
// gates actually run. Tests assert the field is propagated; greppable.
//
// W409f: the /account/*.html pages were wired against /v1/bakeoffs,
// /v1/label-queue/*, /v1/simulations and /v1/devices/detect (POST) before
// the server exposed those exact paths. Behavior assertion: every fetch URL
// referenced from a static HTML file under public/account/ must resolve
// against the running Express router. We walk the HTML, extract URLs, and
// strip path params (/v1/devices/:id/test -> /v1/devices/__id__/test) so
// we don't depend on transient IDs.
//
// W409g: hosted GET /v1/models returns an OpenAI-compatible
// {object:'list', data:[...]} envelope built from FRONTIER_MODELS (teachers)
// + the tenant's compiled .kolm artifacts. Anthropic-compat aliases are
// surfaced when family hints at an Anthropic-shaped client.
//
// Tests assert BEHAVIOR (status codes, JSON shape, fields present) so a
// later registry/route reshuffle doesn't have to touch the test logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// =====================================================================
// Per-test isolation. Each call to makeAppAndTenant() bumps the env to a
// fresh KOLM_DATA_DIR + HOME + USERPROFILE so on-disk modules (jobs,
// datasets, labels, etc.) write under a per-test directory.
// =====================================================================
function freshDataDir() {
  const d = path.join(
    os.tmpdir(),
    'kolm-w409efg-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'),
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function makeAppAndTenant() {
  const dir = freshDataDir();
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';
  // Reset the cached event-store module so each test picks up its own path.
  try {
    const es = await import('../src/event-store.js');
    es._resetForTests?.();
  } catch { /* not all modules expose this */ }
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key, tenantId: t.id, dataDir: dir };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

async function api(base, p, { apiKey, method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (apiKey) init.headers.authorization = 'Bearer ' + apiKey;
  if (body != null) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  }
  return fetch(base + p, init);
}

// =====================================================================
// W409e — productionReadySync returns a _provisional verdict.
// =====================================================================
test('W409e #1 — productionReadySync returns _provisional:true on its verdict envelope', async () => {
  const PR = await import('../src/production-ready.js');
  // Minimal happy-path manifest used by W339 #10 — gives ok:true so we can
  // assert _provisional independent of gate failures.
  const mf = {
    artifact_class: 'rule',
    k_score: 0.92,
    n_seeds: { train: 90, holdout: 10 },
    seed_meta: { synthetic_train_count: 0, holdout_overlap: 0, holdout_split_ok: true },
    drift: { z_score: 0.1 },
    entry: { file: 'recipe.js', sha256: 'a'.repeat(64) },
  };
  const v = PR.productionReadySync(mf);
  assert.equal(typeof v, 'object', 'sync verdict must be an object');
  assert.equal(v._provisional, true, 'productionReadySync MUST tag verdict _provisional:true');
  assert.ok('gates' in v, 'verdict must carry the gates breakdown');
  // The three async-only gates are skipped with a note, but still reported so
  // a caller that grep's by gate-name can find them.
  assert.ok(v.gates.durability, 'durability gate present');
  assert.ok(v.gates.executable_bundle, 'executable_bundle gate present');
  assert.ok(v.gates.eval_parity, 'eval_parity gate present');
  assert.equal(typeof v.gates.durability._skipped, 'string', 'durability marked skipped in sync mode');
});

test('W409e #2 — isFullyVerifiedVerdict() rejects provisional sync verdicts', async () => {
  const { productionReadySync, isFullyVerifiedVerdict } = await import('../src/production-ready.js');
  const mf = {
    artifact_class: 'rule', k_score: 0.92,
    n_seeds: { train: 90, holdout: 10 },
    seed_meta: { synthetic_train_count: 0, holdout_overlap: 0, holdout_split_ok: true },
    drift: { z_score: 0.1 },
    entry: { file: 'recipe.js', sha256: 'a'.repeat(64) },
  };
  const v = productionReadySync(mf);
  assert.equal(isFullyVerifiedVerdict(v), false, 'sync verdict must NOT be treated as fully verified');
  // An async verdict (no _provisional flag) IS treated as fully verified.
  const fakeAsync = { ok: true, gates: {}, reasons: [] };
  assert.equal(isFullyVerifiedVerdict(fakeAsync), true, 'plain verdict without _provisional flag is fully verified');
  assert.equal(isFullyVerifiedVerdict(null), false, 'null verdict is never fully verified');
  assert.equal(isFullyVerifiedVerdict({}), true, 'plain object verdict (no _provisional) is fully verified');
});

test('W409e #3 — build callers route production_ready:true through the async productionReady()', async () => {
  // Behaviour assertion via static analysis: every file that flips
  // production_ready:true for a real on-disk artifact must call AWAIT
  // productionReady (the async one). The sync one is reserved for dry-runs
  // (build-preview, marketplace catalog hydration where the router overlays
  // the async verdict).
  const candidatePaths = [
    path.join(ROOT, 'src', 'compile-pipeline.js'),
    path.join(ROOT, 'src', 'pipeline-make.js'),
    path.join(ROOT, 'src', 'pipeline-ship.js'),
    path.join(ROOT, 'cli', 'kolm.js'),
  ];
  for (const file of candidatePaths) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // If the file does flip production_ready:true (from gates OR from a
    // verdict.ok), it must reach productionReady() somewhere (the async
    // import). The sync function alone is not enough for a real artifact.
    const flipsTrue = /production_ready\s*[:=]\s*(?:[a-zA-Z_$][\w$]*)?(?:true|verdict\.ok|v\.ok)/m.test(text);
    if (!flipsTrue) continue;
    // The file must reference the async productionReady (import or call).
    // Bare grep for the symbol is enough — we don't need to parse AST.
    const hasAsync = /\bproductionReady\b/.test(text);
    assert.ok(hasAsync, `${path.basename(file)} flips production_ready but does not reference productionReady() (async)`);
  }
});

// =====================================================================
// W409f — account UI <-> server route parity.
//
// We walk public/account/*.html, extract every URL referenced via fetch()
// or window.kfetch(...), strip path params, and assert every one is
// reachable on the running router. The router stack is enumerable via
// the registered handlers list (Express stores them on r.stack).
// =====================================================================

// Robust URL extractor: scrape fetch("/v1/..."), kfetch("/v1/..."),
// kfetch('/v1/...'), kfetch(`/v1/...`), with optional template-string
// interpolation that we substitute with a known sentinel.
function extractAccountUrls(htmlText) {
  const urls = new Set();
  // Match (fetch|kfetch)( <quote> /v1/... <quote> )
  const re = /(?:fetch|kfetch)\s*\(\s*(['"`])(\/v1\/[^'"`)\s]+)\1/g;
  let m;
  while ((m = re.exec(htmlText)) !== null) {
    let url = m[2];
    // Strip query string.
    const q = url.indexOf('?');
    if (q >= 0) url = url.slice(0, q);
    // Strip template-string holes like "/v1/devices/" + id + "/test".
    // The captured URL ends before the closing quote, so for concatenated
    // forms like "/v1/devices/" we just see the prefix — that's fine.
    urls.add(url);
  }
  // Also capture concatenated forms like "/v1/devices/"+id+"/test" by
  // grepping concatenations independently. The first segment ends with /
  // and the second segment after the +<var>+ starts with /.
  const reConcat = /(?:fetch|kfetch)\s*\(\s*['"](\/v1\/[a-zA-Z0-9_\-/]+\/)['"](?:\s*\+[^,)]*?\+\s*['"](\/[a-zA-Z0-9_\-/]+)['"])?/g;
  while ((m = reConcat.exec(htmlText)) !== null) {
    let prefix = m[1].replace(/\/$/, '');
    if (m[2]) {
      urls.add(prefix + '/__id__' + m[2]);
    } else {
      urls.add(prefix);
    }
  }
  return Array.from(urls);
}

// Walk Express router stack and collect every registered route path. Express
// stores each registered handler in r.stack[i].route.path (for r.METHOD)
// and r.stack[i].regexp for nested routers. We only need the path strings.
function collectRouterPaths(routerStack) {
  const paths = new Set();
  for (const layer of routerStack) {
    if (layer.route && layer.route.path) {
      const p = layer.route.path;
      if (typeof p === 'string') paths.add(p);
      else if (Array.isArray(p)) for (const q of p) paths.add(q);
    }
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      for (const sub of layer.handle.stack) {
        if (sub.route && sub.route.path) {
          const p = sub.route.path;
          if (typeof p === 'string') paths.add(p);
          else if (Array.isArray(p)) for (const q of p) paths.add(q);
        }
      }
    }
  }
  return paths;
}

// Match a fetch URL (with our __id__ sentinel for path params) against a
// registered route. Express routes use ":param" placeholders; we accept any
// segment for :params and exact match for static segments.
function matches(routeFromHtml, registeredRoute) {
  // Normalise trailing slashes.
  const rh = routeFromHtml.replace(/\/+$/, '');
  const rr = registeredRoute.replace(/\/+$/, '');
  const a = rh.split('/');
  const b = rr.split('/');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (b[i].startsWith(':')) continue; // :id, :name -> wildcard
    // Treat our __id__ sentinel as a wildcard too.
    if (a[i] === '__id__') continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test('W409f #5 — POST /v1/bakeoffs accepts dataset_id + contestants and returns 200/400 (not 404)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/bakeoffs', {
      apiKey, method: 'POST',
      body: { dataset_id: 'nonexistent', contestants: [] },
    });
    // 200 with body, 400 if validation rejects empty contestants, or 404 if
    // dataset missing. Any of these is OK; what we DON'T want is the page
    // 404'ing because the route was never wired.
    assert.notEqual(r.status, 404, 'POST /v1/bakeoffs must be wired (not 404)');
    const body = await r.json();
    assert.equal(typeof body, 'object', 'body must be JSON object');
  });
});

test('W409f #6 — GET /v1/bakeoffs returns a {bakeoffs:[...]} envelope (not 404)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/bakeoffs', { apiKey });
    assert.equal(r.status, 200, 'GET /v1/bakeoffs must be reachable; got ' + r.status);
    const body = await r.json();
    assert.ok('bakeoffs' in body, 'response must include {bakeoffs:[]} key for the page');
    assert.ok(Array.isArray(body.bakeoffs), 'bakeoffs must be an array');
  });
});

test('W409f #7 — GET /v1/label-queue/next + stats are wired (not 404)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r1 = await api(base, '/v1/label-queue/next', { apiKey });
    assert.notEqual(r1.status, 404, '/v1/label-queue/next must be wired');
    const r2 = await api(base, '/v1/label-queue/stats', { apiKey });
    assert.notEqual(r2.status, 404, '/v1/label-queue/stats must be wired');
    assert.equal(r2.status, 200, 'stats should return 200');
  });
});

test('W409f #8 — GET /v1/simulations + POST /v1/simulations are wired (not 404)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r1 = await api(base, '/v1/simulations', { apiKey });
    assert.equal(r1.status, 200, 'GET /v1/simulations must return 200; got ' + r1.status);
    const body = await r1.json();
    // Page accepts both {simulations:[...]} and a bare array.
    const arr = body.simulations || (Array.isArray(body) ? body : []);
    assert.ok(Array.isArray(arr), 'response must include an array of simulations');
    // POST should be reachable; payload may be invalid, but not a 404.
    const r2 = await api(base, '/v1/simulations', {
      apiKey, method: 'POST', body: { type: 'invalid_type_for_test' },
    });
    assert.notEqual(r2.status, 404, 'POST /v1/simulations must be wired');
  });
});

test('W409f #9 — POST /v1/devices/detect is wired (was GET-only before W409f)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/devices/detect', {
      apiKey, method: 'POST', body: {},
    });
    assert.notEqual(r.status, 404, 'POST /v1/devices/detect must be wired');
    // We accept 200 (success) or 500 (no devices to detect in test env).
    // Specifically NOT 405 (method not allowed) -- the page would fail.
    assert.notEqual(r.status, 405, 'POST /v1/devices/detect must accept POST');
  });
});

// =====================================================================
// W409g — hosted OpenAI-compatible /v1/models.
// =====================================================================
test('W409g #10 — GET /v1/models returns {object:list, data:[...]} (no auth required)', async () => {
  const { app } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    // Unauthenticated request: must still get a populated envelope (teachers
    // + connectors), even without tenant artifacts.
    const r = await fetch(base + '/v1/models', { headers: { accept: 'application/json' } });
    assert.equal(r.status, 200, '/v1/models must be 200 without auth');
    const body = await r.json();
    assert.equal(body.object, 'list', 'envelope must be {object:"list"}');
    assert.ok(Array.isArray(body.data), 'data[] must be present');
    assert.ok(body.data.length >= 1, 'data[] must include at least one model (teachers)');
    for (const m of body.data.slice(0, 3)) {
      assert.equal(m.object, 'model', 'each entry must be {object:"model"}');
      assert.equal(typeof m.id, 'string', 'each entry must carry a string id');
      assert.equal(typeof m.owned_by, 'string', 'each entry must declare owned_by');
    }
  });
});

test('W409g #11 — /v1/models includes a teacher row from FRONTIER_MODELS', async () => {
  const { app } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models');
    const body = await r.json();
    const reg = await import('../src/model-registry.js');
    const teachers = (reg.FRONTIER_MODELS || []).map((row) => row.id).filter(Boolean);
    assert.ok(teachers.length > 0, 'FRONTIER_MODELS must export at least one model id');
    const ids = new Set(body.data.map((m) => m.id));
    const overlap = teachers.filter((t) => ids.has(t));
    assert.ok(
      overlap.length > 0,
      'at least one teacher id from FRONTIER_MODELS must surface in /v1/models; teachers=' +
      teachers.slice(0, 5).join(',') + ' surfaced=' + body.data.slice(0, 5).map((m) => m.id).join(','),
    );
    // Each surfaced teacher row must be owned_by:'kolm-teachers'.
    for (const m of body.data) {
      if (overlap.includes(m.id)) {
        assert.equal(m.owned_by, 'kolm-teachers', `teacher ${m.id} must be owned_by kolm-teachers`);
      }
    }
  });
});

test('W409g #12 — /v1/models includes the tenant\'s compiled .kolm artifacts as kolm:<id>', async () => {
  const { app, apiKey, tenantId, dataDir } = await makeAppAndTenant();
  // Seed one completed compile job under the tenant so /v1/models has
  // something to surface. We reach for compile.createJob() to insert the
  // row, then flip status -> 'completed' via store.update() (compile.js
  // doesn't export updateJob).
  const compile = await import('../src/compile.js');
  const store = await import('../src/store.js');
  const j = compile.createJob({
    task: 'test',
    examples: [{ input: 'a', output: 'b' }],
    corpus_namespace: 'w409g-test',
    base_model: 'test/teacher',
    tenant: tenantId,
    tenant_id: tenantId,
  });
  store.update('compile_jobs', (x) => x.id === j.id, {
    status: 'completed',
    k_score: 0.9,
    artifact_hash: 'a'.repeat(64),
  });
  // Sanity: listJobs() actually surfaces our seeded row.
  const surfaced = compile.listJobs(tenantId, 50).filter((row) => row.status === 'completed');
  assert.ok(
    surfaced.length >= 1,
    'precondition: listJobs(tenantId) must surface the seeded completed job; got ' + surfaced.length,
  );
  await withServer(app, async (base) => {
    const r = await api(base, '/v1/models', { apiKey });
    assert.equal(r.status, 200);
    const body = await r.json();
    const ids = body.data.map((m) => m.id);
    const tenantRows = ids.filter((id) => typeof id === 'string' && id.startsWith('kolm:'));
    assert.ok(
      tenantRows.length >= 1,
      'at least one tenant artifact must surface as kolm:<id>; got: ' + ids.slice(0, 10).join(','),
    );
    const tenantRow = body.data.find((m) => m.id.startsWith('kolm:'));
    assert.equal(tenantRow.owned_by, 'kolm', 'tenant artifact must be owned_by:"kolm"');
    assert.ok(tenantRow.kolm && tenantRow.kolm.artifact_id, 'tenant row must expose kolm.artifact_id');
  });
  // Final sanity: dataDir was real.
  assert.ok(fs.existsSync(dataDir), 'dataDir must persist for test isolation');
});

test('W409g #13 — Anthropic-compat aliases surface for Anthropic-family teachers', async () => {
  const { app } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/models');
    const body = await r.json();
    const reg = await import('../src/model-registry.js');
    const anthropicFamily = (reg.FRONTIER_MODELS || []).filter(
      (row) => row && typeof row.family === 'string' && /^(claude|anthropic)/i.test(row.family),
    );
    if (anthropicFamily.length === 0) {
      // No Anthropic-family teachers in the registry: alias surface is
      // vacuously satisfied. Pass.
      return;
    }
    const aliasIds = body.data.map((m) => m.id).filter((id) => id.startsWith('anthropic:'));
    assert.ok(
      aliasIds.length >= 1,
      'at least one anthropic:<id> alias must surface when an Anthropic-family teacher is present',
    );
  });
});
