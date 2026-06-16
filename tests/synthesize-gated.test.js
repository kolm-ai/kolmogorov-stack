// tests/synthesize-gated.test.js
//
// Acceptance suite for the sensitive-data-aware GATED synthesis pipeline
// (src/synthesize-gated.js) + its HTTP route (src/lingual-routes-gated.js).
//
// This is the atom-named acceptance file the build spec required (previously
// MISSING). It proves the composition that generator-router.js (decision only)
// cannot prove alone:
//   - gatedSynthesize produces real synthetic rows and reports generated_count
//   - EVERY produced row carries the generator-routing provenance stamp
//   - the never-to-hyperscaler boundary: sensitive corpus + hosted teacher +
//     no local generator -> FAIL CLOSED, never hosted, never echoed
//   - local-generator-failure -> typed row drop accounted in dropped_count,
//     never a silent [lang]-prefixed echo
//   - the route is auth-gated (401 without tenant) and returns a tenant envelope
//
// Pure node:test. translateFn / local adapter are injected fakes - NO network,
// NO key.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gatedSynthesize,
  SYNTHESIZE_GATED_VERSION,
} from '../src/synthesize-gated.js';
import { registerGatedLingualSynthRoute } from '../src/lingual-routes-gated.js';

// Stable trigger strings (probed against the router's scanSensitive):
//   sk-key -> secret class 'openai-style-key'.
const SK = 'config has sk-abcdefghijklmnopqrstuvwxyz12345 inside';
const CLEAN = { input: 'hello world', output: 'goodbye world', lang: 'en' };
const SECRET = { input: SK, output: 'ok', lang: 'en' };

function fakeTranslate() {
  const seen = [];
  const fn = async ({ text, source_lang, target_lang, teacher }) => {
    seen.push({ text, source_lang, target_lang, teacher });
    return { text: `T(${target_lang}):${text}`, model: 'fake-local' };
  };
  return { fn, seen };
}

// env snapshot/restore
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
}

// ===========================================================================
// CORE: real synthesis + provenance stamp on every produced row
// ===========================================================================

test('gatedSynthesize: clean corpus + local teacher produces stamped rows with generated_count', async () => {
  const { fn, seen } = fakeTranslate();
  const env = await gatedSynthesize({
    tenant: 'tnt-1',
    namespace: 'ns',
    target_lang: 'es',
    count: 2,
    teacher: 'local',
    seeds: [CLEAN],
    opts: { source_captures: [CLEAN], translateFn: fn },
  });

  assert.equal(env.ok, true);
  assert.equal(env.version, SYNTHESIZE_GATED_VERSION);
  assert.equal(env.generated_count, 2);
  assert.equal(env.rows.length, 2);
  assert.ok(seen.length > 0, 'translateFn was actually invoked');

  // EVERY produced row carries the routing provenance stamp.
  for (const row of env.rows) {
    assert.equal(row.generator_locality, 'local');
    assert.equal(row.router_version, 'gr-v1');
    assert.equal(row.sensitivity_verdict.sensitivity, 'clean');
    assert.ok(row.synthetic_translation, 'underlying synth flag preserved');
    assert.ok(row.input.startsWith('T(es):'), 'rows are real translateFn output');
  }
  // Routing assertions + cost surface for the signed body / cost preview.
  assert.equal(env.routing_assertions['kolm.generator_locality'], 'local');
  assert.equal(env.routing_cost.hosted_egress_usd, 0);
});

// ===========================================================================
// NEVER-TO-HYPERSCALER: sensitive + hosted + no local generator -> fail closed
// ===========================================================================

test('gatedSynthesize: sensitive corpus + hosted teacher + NO local generator -> fail closed, never hosted', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: undefined }, async () => {
    const { fn } = fakeTranslate();
    const env = await gatedSynthesize({
      tenant: 'tnt-1',
      target_lang: 'es',
      count: 3,
      teacher: 'anthropic',
      seeds: [SECRET],
      opts: { source_captures: [SECRET], translateFn: fn },
    });
    assert.equal(env.ok, false);
    assert.equal(env.error, 'sensitive_corpus_requires_local_generator');
    assert.ok(typeof env.install_hint === 'string' && env.install_hint.length > 0);
    assert.equal(env.generated_count, 0);
    // It MUST NOT report any hosted effective locality.
    assert.notEqual(env.effectiveLocality, 'hosted');
    // The raw secret value must never appear anywhere in the fail envelope.
    assert.ok(!JSON.stringify(env).includes('sk-abcdef'));
  });
});

test('gatedSynthesize: sensitive corpus + LOCAL teacher synthesizes locally and forces local stamp', async () => {
  const { fn } = fakeTranslate();
  const env = await gatedSynthesize({
    tenant: 'tnt-1',
    target_lang: 'es',
    count: 1,
    teacher: 'local',
    seeds: [SECRET],
    opts: { source_captures: [SECRET], translateFn: fn },
  });
  assert.equal(env.ok, true);
  assert.equal(env.decision.effectiveLocality, 'local');
  assert.equal(env.rows[0].generator_locality, 'local');
  assert.equal(env.rows[0].sensitivity_verdict.sensitivity, 'sensitive');
});

// ===========================================================================
// ROW-DROP ACCOUNTING + NO ECHO when the local generator is unconfigured.
// We do NOT inject a translateFn here; on the forced-local path the router's
// REAL adapter is wired in. With no KOLM_LOCAL_TEACHER_URL the adapter throws
// a typed error per row (dropped), and NO [lang]-prefixed echo is produced.
// ===========================================================================

test('gatedSynthesize: forced-local with unconfigured generator drops rows, never echoes', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:11434' }, async () => {
    // local generator "reachable" by URL policy, but we inject a fetch that
    // 500s so every translate throws -> every row dropped, none echoed.
    const env = await gatedSynthesize({
      tenant: 'tnt-1',
      target_lang: 'es',
      count: 3,
      teacher: 'anthropic', // hosted requested -> forced local (sensitive)
      seeds: [SECRET],
      opts: {
        source_captures: [SECRET],
        fetch: async () => ({ status: 500, json: async () => ({}) }),
      },
    });
    assert.equal(env.ok, true, 'forced-local routing succeeded');
    assert.equal(env.decision.forced_local, true);
    assert.equal(env.generated_count, 0, 'all rows dropped on adapter failure');
    assert.equal(env.dropped_count, 3, 'drop is accounted, not silent');
    // No row, so no echo possible; assert nothing [es]-prefixed leaked.
    assert.ok(!JSON.stringify(env.rows).includes('[es]'));
  });
});

// ===========================================================================
// SHAPE GUARDS
// ===========================================================================

test('gatedSynthesize: missing tenant / target_lang fail loud', async () => {
  const a = await gatedSynthesize({ target_lang: 'es' });
  assert.equal(a.ok, false);
  assert.equal(a.error, 'tenant_required');

  const b = await gatedSynthesize({ tenant: 't' });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'target_lang_required');
});

// ===========================================================================
// HTTP ROUTE: auth gate + tenant envelope
// ===========================================================================

function makeApp() {
  const routes = {};
  return {
    post(p, h) { routes['POST ' + p] = h; },
    get(p, h) { routes['GET ' + p] = h; },
    _routes: routes,
  };
}

function makeRes() {
  return {
    _status: 200,
    _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

test('route: POST /v1/lingual/synthesize/gated 401 without tenant', async () => {
  const app = makeApp();
  registerGatedLingualSynthRoute(app);
  const h = app._routes['POST /v1/lingual/synthesize/gated'];
  assert.equal(typeof h, 'function', 'route registered');
  const res = makeRes();
  await h({ body: {} }, res);
  assert.equal(res._status, 401);
  assert.equal(res._json.error, 'auth_required');
});

test('route: POST /v1/lingual/synthesize/gated returns tenant-fenced envelope', async () => {
  const app = makeApp();
  registerGatedLingualSynthRoute(app);
  const h = app._routes['POST /v1/lingual/synthesize/gated'];
  const res = makeRes();
  const { fn } = fakeTranslate();
  // Inject the DI translateFn via body is not supported; instead use 'local'
  // teacher + source_captures so the route exercises the real composition with
  // the local echo path gated behind ciStub. We avoid echo by asserting status
  // shape, not row text. Use a clean corpus + an injected translateFn by
  // calling gatedSynthesize directly is covered above; here we assert the route
  // wiring + tenant fence + 422 mapping.
  await h({
    tenant_record: { id: 'tnt-9' },
    body: { target_lang: 'es', count: 1, teacher: 'anthropic', seeds: [SECRET], source_captures: [SECRET] },
  }, res);
  // sensitive + hosted + (no local url in CI) -> 422 fail-closed boundary.
  assert.equal(res._status, 422);
  assert.equal(res._json.error, 'sensitive_corpus_requires_local_generator');
  assert.ok(res._json.install_hint);
});

test('SOURCE: synthesize-gated is ASCII-only and has no honest/honesty word', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  for (const f of ['synthesize-gated.js', 'lingual-routes-gated.js']) {
    const src = fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
    for (let i = 0; i < src.length; i += 1) {
      assert.ok(src.charCodeAt(i) < 128, 'non-ASCII byte in ' + f + ' at ' + i);
    }
    assert.ok(!/honest|honesty/i.test(src), f + ' must not use the word honest/honesty');
  }
});
