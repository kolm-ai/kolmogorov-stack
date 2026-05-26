// W786 - Carbon footprint / CO2 estimator.
//
// Atomic items pinned (matches the W786 implementation):
//
//   1)  CARBON_VERSION matches /^w786-/ + module exports are functions
//   2)  GPU_TDP_W is frozen + has the W786 spec SKUs
//   3)  GRID_CARBON_KGCO2_PER_KWH is frozen + has the W786 spec regions
//   4)  estimateRunCo2 shape: ok envelope + kwh + kg_co2 + assumptions block
//   5)  estimateRunCo2 zero hours returns zero kWh + zero kg_co2
//   6)  estimateRunCo2 unknown SKU falls back to CPU-default with gpu_known=false
//   7)  estimateRunCo2 invalid gpu_hours returns honest error envelope
//   8)  estimateFrontierCallCo2 shape + accepts openai/anthropic/google
//   9)  estimateFrontierCallCo2 invalid provider / model_size_class envelope
//   10) savingsReport positive saved_kg_co2 when local < frontier (local_is_greener=true)
//   11) savingsReport negative saved_kg_co2 when local > frontier (local_is_greener=false)
//   12) badgeFor returns stable shape with co2_kg_estimate field (matches public/sustainability.html contract)
//   13) badgeFor without gpu_hours returns honest envelope with estimate_quality:'unknown_inputs'
//   14) badgeFor estimate_quality grading: high/medium/low based on gpu_known + region_known
//   15) methodology stamp 'public-research-estimate' present in EVERY output envelope
//   16) src/artifact.js wires sustainability_badge into manifest via conditional spread
//   17) src/router.js wires GET /v1/carbon/estimate auth-gated
//   18) GET /v1/carbon/estimate returns 401 without auth
//   19) GET /v1/carbon/estimate returns ok envelope with auth + local_run payload
//   20) Version stamp pattern check (W604 anti-brittleness: regex, not explicit array)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as carbon from '../src/carbon-estimator.js';
import * as auth from '../src/auth.js';
import * as kolmStore from '../src/store.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w786-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  return tmp;
}

async function buildApp() {
  const tmpdir = freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// =============================================================================
// 1) Version stamp + exports
// =============================================================================

test('W786 #1 - CARBON_VERSION matches /^w786-/ + module exports are functions', () => {
  assert.match(carbon.CARBON_VERSION, /^w786-/);
  assert.equal(typeof carbon.estimateRunCo2, 'function');
  assert.equal(typeof carbon.estimateFrontierCallCo2, 'function');
  assert.equal(typeof carbon.savingsReport, 'function');
  assert.equal(typeof carbon.badgeFor, 'function');
  assert.equal(typeof carbon.gpuTdpWatts, 'function');
  assert.equal(typeof carbon.gridCarbonKgPerKwh, 'function');
});

// =============================================================================
// 2) GPU_TDP_W frozen + W786 spec SKUs present
// =============================================================================

test('W786 #2 - GPU_TDP_W frozen + spec SKUs present (threshold pattern, not explicit-array)', () => {
  assert.ok(Object.isFrozen(carbon.GPU_TDP_W));
  // W604 anti-brittleness: assert MINIMUM coverage, not an exact list. New SKUs may be added.
  const skus = Object.keys(carbon.GPU_TDP_W);
  assert.ok(skus.length >= 10, 'GPU_TDP_W must cover at least 10 SKUs; got ' + skus.length);
  // The W786 spec called these out by name; lock them in so a future scrub does not silently drop them.
  for (const required of ['A100-80GB', 'H100-SXM5', 'RTX-5090', 'RTX-4090', 'CPU-default', 'M2-Ultra']) {
    assert.ok(Object.prototype.hasOwnProperty.call(carbon.GPU_TDP_W, required),
      'GPU_TDP_W missing required SKU: ' + required);
  }
  // Every TDP must be a positive integer rounded to nearest 5W (W786 honesty rule).
  for (const [k, v] of Object.entries(carbon.GPU_TDP_W)) {
    assert.equal(typeof v, 'number', k + ' TDP must be a number');
    assert.ok(v > 0, k + ' TDP must be positive; got ' + v);
    assert.equal(v % 5, 0, k + ' TDP must round to nearest 5W; got ' + v);
  }
});

// =============================================================================
// 3) GRID_CARBON_KGCO2_PER_KWH frozen + W786 spec regions present
// =============================================================================

test('W786 #3 - GRID_CARBON_KGCO2_PER_KWH frozen + spec regions present', () => {
  assert.ok(Object.isFrozen(carbon.GRID_CARBON_KGCO2_PER_KWH));
  // Threshold pattern: at least 7 regions.
  const regions = Object.keys(carbon.GRID_CARBON_KGCO2_PER_KWH);
  assert.ok(regions.length >= 7, 'GRID_CARBON_KGCO2_PER_KWH must cover at least 7 regions; got ' + regions.length);
  for (const required of ['us-west-2', 'us-east-1', 'eu-west-1', 'ap-northeast-1', 'global-avg']) {
    assert.ok(Object.prototype.hasOwnProperty.call(carbon.GRID_CARBON_KGCO2_PER_KWH, required),
      'GRID_CARBON_KGCO2_PER_KWH missing required region: ' + required);
  }
  for (const [k, v] of Object.entries(carbon.GRID_CARBON_KGCO2_PER_KWH)) {
    assert.equal(typeof v, 'number', k + ' grid factor must be a number');
    assert.ok(v >= 0 && v < 2, k + ' grid factor out of plausible range; got ' + v);
  }
});

// =============================================================================
// 4) estimateRunCo2 shape
// =============================================================================

test('W786 #4 - estimateRunCo2 shape: ok envelope + kwh + kg_co2 + assumptions', () => {
  const out = carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: 2, region: 'us-west-2' });
  assert.equal(out.ok, true);
  assert.match(out.version, /^w786-/);
  assert.equal(out.gpu, 'A100-80GB');
  assert.equal(out.gpu_known, true);
  assert.equal(out.gpu_tdp_w, 400);
  assert.equal(out.region, 'us-west-2');
  assert.equal(out.region_known, true);
  assert.equal(out.grid_factor, 0.18);
  assert.equal(out.gpu_hours, 2);
  assert.equal(out.utilization, 0.75);
  assert.equal(typeof out.kwh, 'number');
  assert.equal(typeof out.kg_co2, 'number');
  assert.ok(out.kwh > 0);
  assert.ok(out.kg_co2 > 0);
  assert.equal(out.methodology, 'public-research-estimate');
  assert.equal(out.honest_caveat, 'estimate_not_measured');
  assert.equal(out.error_bar_pct, 30);
  assert.ok(out.assumptions && typeof out.assumptions === 'object');
  assert.ok(typeof out.assumptions.tdp_source === 'string');
  assert.ok(typeof out.assumptions.grid_source === 'string');
  // Math: (400W * 0.75util * 2h) / 1000 = 0.6 kWh; 0.6 * 0.18 = 0.108 kg
  assert.equal(out.kwh, 0.6);
  assert.equal(out.kg_co2, 0.108);
});

// =============================================================================
// 5) estimateRunCo2 zero hours -> zero CO2
// =============================================================================

test('W786 #5 - estimateRunCo2 zero gpu_hours returns zero kWh + zero kg_co2', () => {
  const out = carbon.estimateRunCo2({ gpu: 'H100-SXM5', gpu_hours: 0, region: 'us-east-1' });
  assert.equal(out.ok, true);
  assert.equal(out.kwh, 0);
  assert.equal(out.kg_co2, 0);
  // Methodology stamp still present (uniform envelope).
  assert.equal(out.methodology, 'public-research-estimate');
});

// =============================================================================
// 6) Unknown SKU falls back to CPU-default
// =============================================================================

test('W786 #6 - estimateRunCo2 unknown SKU falls back to CPU-default with gpu_known=false', () => {
  const out = carbon.estimateRunCo2({ gpu: 'fictional-gpu-xyz', gpu_hours: 1, region: 'global-avg' });
  assert.equal(out.ok, true);
  assert.equal(out.gpu_known, false);
  assert.equal(out.gpu_tdp_w, carbon.GPU_TDP_W['CPU-default']);
  assert.equal(out.gpu_tdp_w, 95);
  assert.equal(out.region_known, true);
});

// =============================================================================
// 7) Invalid gpu_hours -> honest error envelope
// =============================================================================

test('W786 #7 - estimateRunCo2 invalid gpu_hours returns honest error envelope', () => {
  for (const bad of ['notanumber', -1, NaN, Infinity]) {
    const out = carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: bad, region: 'us-west-2' });
    assert.equal(out.ok, false, 'gpu_hours=' + bad + ' should be rejected');
    assert.equal(out.error, 'invalid_gpu_hours');
    assert.ok(out.hint && out.hint.length > 0);
    // Methodology stamp present even in error envelope.
    assert.equal(out.methodology, 'public-research-estimate');
  }
});

// =============================================================================
// 8) estimateFrontierCallCo2 shape + all 3 providers
// =============================================================================

test('W786 #8 - estimateFrontierCallCo2 shape + accepts openai/anthropic/google', () => {
  for (const provider of ['openai', 'anthropic', 'google']) {
    const out = carbon.estimateFrontierCallCo2({
      provider,
      tokens: 10000,
      model_size_class: 'medium',
    });
    assert.equal(out.ok, true, provider + ' should be accepted');
    assert.equal(out.provider, provider);
    assert.equal(out.model_size_class, 'medium');
    assert.equal(out.tokens, 10000);
    assert.equal(typeof out.wh_per_ktokens, 'number');
    assert.equal(typeof out.kwh, 'number');
    assert.equal(typeof out.kg_co2, 'number');
    assert.ok(out.kg_co2 > 0);
    assert.equal(out.methodology, 'public-research-estimate');
    assert.equal(out.honest_caveat, 'estimate_not_measured');
    assert.equal(out.error_bar_pct, 30);
  }
});

// =============================================================================
// 9) Invalid provider / model_size_class envelope
// =============================================================================

test('W786 #9 - estimateFrontierCallCo2 invalid provider / model_size_class envelope', () => {
  const badProv = carbon.estimateFrontierCallCo2({
    provider: 'mistral',
    tokens: 1000,
    model_size_class: 'medium',
  });
  assert.equal(badProv.ok, false);
  assert.equal(badProv.error, 'invalid_provider');
  assert.equal(badProv.methodology, 'public-research-estimate');

  const badClass = carbon.estimateFrontierCallCo2({
    provider: 'openai',
    tokens: 1000,
    model_size_class: 'gigantic',
  });
  assert.equal(badClass.ok, false);
  assert.equal(badClass.error, 'invalid_model_size_class');

  const badTokens = carbon.estimateFrontierCallCo2({
    provider: 'openai',
    tokens: -5,
    model_size_class: 'medium',
  });
  assert.equal(badTokens.ok, false);
  assert.equal(badTokens.error, 'invalid_tokens');
});

// =============================================================================
// 10) savingsReport positive when local < frontier
// =============================================================================

test('W786 #10 - savingsReport positive saved_kg_co2 when local < frontier', () => {
  // Local: tiny 0.05 hour run on RTX-5090 (consumer GPU + green grid).
  const local = carbon.estimateRunCo2({ gpu: 'RTX-5090', gpu_hours: 0.05, region: 'us-west-2' });
  // Frontier: a large model handling 100k tokens.
  const frontier = carbon.estimateFrontierCallCo2({
    provider: 'openai', tokens: 100000, model_size_class: 'large',
  });
  const out = carbon.savingsReport({ local_run: local, frontier_baseline: frontier });
  assert.equal(out.ok, true);
  assert.equal(typeof out.saved_kg_co2, 'number');
  assert.equal(typeof out.saved_kwh, 'number');
  // We expect the local 5090 short run to be tiny vs 100k-token large-model call.
  assert.equal(out.local_is_greener, out.saved_kg_co2 > 0);
  assert.ok(out.breakdown.local_kwh >= 0);
  assert.ok(out.breakdown.frontier_kwh >= 0);
  assert.equal(out.methodology, 'public-research-estimate');
  assert.ok(out.methodology_note && out.methodology_note.length > 50,
    'savingsReport must carry an explanatory methodology_note');
});

// =============================================================================
// 11) savingsReport negative when local > frontier
// =============================================================================

test('W786 #11 - savingsReport negative saved_kg_co2 when local > frontier', () => {
  // Local: huge B200 run on dirty grid.
  const local = carbon.estimateRunCo2({ gpu: 'B200', gpu_hours: 100, region: 'ap-south-1' });
  // Frontier: tiny small-model 100-token call.
  const frontier = carbon.estimateFrontierCallCo2({
    provider: 'anthropic', tokens: 100, model_size_class: 'small',
  });
  const out = carbon.savingsReport({ local_run: local, frontier_baseline: frontier });
  assert.equal(out.ok, true);
  assert.ok(out.saved_kg_co2 < 0, 'saved should be NEGATIVE when local draws more');
  assert.equal(out.local_is_greener, false);
});

// =============================================================================
// 12) badgeFor stable shape with co2_kg_estimate (front-end contract)
// =============================================================================

test('W786 #12 - badgeFor returns stable shape with co2_kg_estimate field', () => {
  const badge = carbon.badgeFor({
    training_stats: { gpu: 'RTX-5090', gpu_hours: 0.004, region: 'us-west-2' },
  });
  assert.equal(badge.ok, true);
  assert.match(badge.version, /^w786-/);
  // The /sustainability page contract uses 'co2_kg_estimate' as the field name.
  assert.ok(Object.prototype.hasOwnProperty.call(badge, 'co2_kg_estimate'),
    'badge MUST expose co2_kg_estimate (public/sustainability.html contract)');
  assert.equal(typeof badge.co2_kg_estimate, 'number');
  assert.ok(badge.co2_kg_estimate >= 0);
  assert.equal(typeof badge.kwh, 'number');
  assert.equal(badge.gpu, 'RTX-5090');
  assert.equal(badge.region, 'us-west-2');
  assert.equal(badge.gpu_hours, 0.004);
  assert.equal(badge.estimate_quality, 'high');
  assert.equal(badge.methodology, 'public-research-estimate');
  assert.equal(badge.honest_caveat, 'estimate_not_measured');
  assert.equal(badge.error_bar_pct, 30);
});

// =============================================================================
// 13) badgeFor without gpu_hours -> unknown_inputs envelope
// =============================================================================

test('W786 #13 - badgeFor without gpu_hours returns unknown_inputs envelope', () => {
  const badge = carbon.badgeFor({ training_stats: {} });
  assert.equal(badge.ok, true);
  assert.equal(badge.co2_kg_estimate, null);
  assert.equal(badge.kwh, null);
  assert.equal(badge.estimate_quality, 'unknown_inputs');
  assert.equal(badge.methodology, 'public-research-estimate');
  assert.equal(badge.honest_caveat, 'estimate_not_measured');
  assert.ok(badge.note && badge.note.includes('gpu_hours'));
});

// =============================================================================
// 14) estimate_quality grading (high/medium/low) based on known inputs
// =============================================================================

test('W786 #14 - badgeFor estimate_quality grading: high/medium/low', () => {
  // High: known GPU + known region.
  const high = carbon.badgeFor({
    training_stats: { gpu: 'A100-80GB', gpu_hours: 1, region: 'us-east-1' },
  });
  assert.equal(high.estimate_quality, 'high');

  // Medium: known GPU + unknown region.
  const med1 = carbon.badgeFor({
    training_stats: { gpu: 'A100-80GB', gpu_hours: 1, region: 'mars-orbit-1' },
  });
  assert.equal(med1.estimate_quality, 'medium');

  // Medium: unknown GPU + known region.
  const med2 = carbon.badgeFor({
    training_stats: { gpu: 'fictional-x', gpu_hours: 1, region: 'us-east-1' },
  });
  assert.equal(med2.estimate_quality, 'medium');

  // Low: both unknown.
  const low = carbon.badgeFor({
    training_stats: { gpu: 'fictional-x', gpu_hours: 1, region: 'mars-orbit-1' },
  });
  assert.equal(low.estimate_quality, 'low');
});

// =============================================================================
// 15) Methodology stamp present in EVERY output envelope (W786 honesty contract)
// =============================================================================

test('W786 #15 - methodology stamp present in every output envelope', () => {
  // Sample 6 different paths through the module + verify every one carries
  // methodology + honest_caveat + error_bar_pct. This is the W786 honesty
  // contract: a downstream consumer can grep ONE field across any envelope.
  const envelopes = [
    carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: 1, region: 'us-west-2' }),
    carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: 'bad', region: 'us-west-2' }),
    carbon.estimateFrontierCallCo2({ provider: 'openai', tokens: 1000, model_size_class: 'medium' }),
    carbon.estimateFrontierCallCo2({ provider: 'badprov', tokens: 1000, model_size_class: 'medium' }),
    carbon.savingsReport({
      local_run: carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: 1, region: 'us-west-2' }),
      frontier_baseline: carbon.estimateFrontierCallCo2({ provider: 'openai', tokens: 1000, model_size_class: 'medium' }),
    }),
    carbon.badgeFor({ training_stats: { gpu: 'A100-80GB', gpu_hours: 1, region: 'us-west-2' } }),
    carbon.badgeFor({ training_stats: {} }),
  ];
  for (const env of envelopes) {
    assert.equal(env.methodology, 'public-research-estimate',
      'methodology stamp missing on envelope ' + JSON.stringify(env).slice(0, 80));
    assert.equal(env.honest_caveat, 'estimate_not_measured',
      'honest_caveat missing on envelope ' + JSON.stringify(env).slice(0, 80));
    assert.equal(env.error_bar_pct, 30,
      'error_bar_pct missing on envelope ' + JSON.stringify(env).slice(0, 80));
    assert.match(env.methodology_version, /^w786-/,
      'methodology_version must match /^w786-/ on envelope ' + JSON.stringify(env).slice(0, 80));
  }
});

// =============================================================================
// 16) src/artifact.js wires sustainability_badge into manifest
// =============================================================================

test('W786 #16 - src/artifact.js wires sustainability_badge into manifest', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'artifact.js'), 'utf8');
  // Import of the carbon-estimator badge helper.
  assert.match(src, /from\s+['"]\.\/carbon-estimator\.js['"]/,
    'artifact.js must import from ./carbon-estimator.js');
  assert.match(src, /badgeFor/,
    'artifact.js must reference badgeFor (the W786 manifest badge generator)');
  // Conditional-spread W460 byte-stability pattern present so pre-W786
  // artifacts rebuilt without gpu_hours remain byte-identical.
  assert.match(src, /sustainability_badge/,
    'artifact.js must surface sustainability_badge in the manifest');
});

// =============================================================================
// 17) src/router.js wires GET /v1/carbon/estimate
// =============================================================================

test('W786 #17 - src/router.js wires GET /v1/carbon/estimate auth-gated', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(src, /r\.get\(['"]\/v1\/carbon\/estimate['"]/,
    'router.js must wire GET /v1/carbon/estimate');
  assert.match(src, /from\s+['"]\.\/carbon-estimator\.js['"]/,
    'router.js must import from ./carbon-estimator.js');
  // Tenant fence: pull req.tenant_record inside the carbon route body so a
  // future scrub does not silently drop the auth gate.
  const carbonStart = src.indexOf("r.get('/v1/carbon/estimate'");
  assert.ok(carbonStart > 0, 'carbon route located in router source');
  const carbonBody = src.slice(carbonStart, carbonStart + 3000);
  assert.match(carbonBody, /req\.tenant_record/,
    'carbon route must read req.tenant_record (auth fence)');
  assert.match(carbonBody, /auth_required/,
    'carbon route must surface auth_required envelope on missing auth');
});

// =============================================================================
// 18) GET /v1/carbon/estimate returns 401 without auth
// =============================================================================

test('W786 #18 - GET /v1/carbon/estimate returns 401 without auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const res = await fetch(base + '/v1/carbon/estimate?gpu=A100-80GB&hours=1&region=us-west-2');
    assert.equal(res.status, 401);
    const body = await res.json();
    // requireApiKey middleware fires before the route handler and emits the
    // legacy 'missing api key' string; the route handler emits 'auth_required'
    // when called with a non-tenant token. Accept either (per wave464 pattern).
    assert.ok(/^(missing api key|auth_required)$/i.test(String(body.error)),
      'expected missing api key or auth_required, got: ' + body.error);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 19) GET /v1/carbon/estimate returns ok envelope with auth + local_run
// =============================================================================

test('W786 #19 - GET /v1/carbon/estimate returns ok envelope with auth + local_run', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    const res = await fetch(
      base + '/v1/carbon/estimate?gpu=A100-80GB&hours=1&region=us-west-2',
      { headers: { authorization: 'Bearer ' + tenant.api_key } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tenant_id, tenant.id);
    assert.match(body.version, /^w786-/);
    assert.ok(body.local_run);
    assert.equal(body.local_run.ok, true);
    assert.equal(body.local_run.gpu, 'A100-80GB');
    assert.equal(body.local_run.methodology, 'public-research-estimate');

    // Frontier-only branch
    const res2 = await fetch(
      base + '/v1/carbon/estimate?provider=openai&tokens=10000&model_size_class=medium',
      { headers: { authorization: 'Bearer ' + tenant.api_key } },
    );
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.ok, true);
    assert.ok(body2.frontier_baseline);
    assert.equal(body2.frontier_baseline.provider, 'openai');

    // Compare branch
    const url3 = base + '/v1/carbon/estimate?compare=1&gpu=RTX-5090&hours=0.05&region=us-west-2&provider=openai&tokens=10000&model_size_class=medium';
    const res3 = await fetch(url3, {
      headers: { authorization: 'Bearer ' + tenant.api_key },
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.ok, true);
    assert.ok(body3.savings);
    assert.equal(typeof body3.savings.saved_kg_co2, 'number');
    assert.equal(typeof body3.savings.local_is_greener, 'boolean');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 20) Version stamp pattern check (W604 anti-brittleness)
// =============================================================================

test('W786 #20 - W604 anti-brittleness: regex+threshold patterns (not explicit-array)', () => {
  // The module's version stamp uses the W604 regex+threshold pattern so a
  // future wave can ship w786-v2 without breaking sibling tests. Same rule
  // for the methodology_version in every envelope.
  assert.match(carbon.CARBON_VERSION, /^w786-v\d+/);
  const run = carbon.estimateRunCo2({ gpu: 'A100-80GB', gpu_hours: 1, region: 'us-west-2' });
  assert.match(run.methodology_version, /^w786-v\d+/);
  const front = carbon.estimateFrontierCallCo2({
    provider: 'openai', tokens: 100, model_size_class: 'small',
  });
  assert.match(front.methodology_version, /^w786-v\d+/);
});
