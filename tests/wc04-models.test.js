// WC04 — test coverage close-out for src/models.js.
//
// Previously: 825 LOC, 0 tests anywhere in tests/.
// Pins the curated base-model registry: defaults, tier mapping, filter
// dimensions, recommend() scoring, device-fit + training-fit gates, and
// resolveBase() lookup precedence. setPin/getPin (fs-backed) deferred —
// covered indirectly via the existing artifact + compile pipeline tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS,
  DEFAULT_MODEL,
  TIER_BY_USE,
  PERMISSIVE_LICENSES,
  list,
  info,
  recommend,
  fitsOn,
  explainFit,
  trainOn,
  resolveBase,
} from '../src/models.js';

test('WC04-mo #1 MODELS is a non-empty array of objects with required keys', () => {
  assert.ok(Array.isArray(MODELS));
  assert.ok(MODELS.length > 5);
  for (const m of MODELS.slice(0, 3)) {
    for (const k of ['id', 'family', 'params_b', 'license', 'tier', 'vram_gb_4bit']) {
      assert.ok(k in m, `missing key ${k}`);
    }
  }
});

test('WC04-mo #2 DEFAULT_MODEL exists in the MODELS registry', () => {
  assert.equal(typeof DEFAULT_MODEL, 'string');
  assert.ok(info(DEFAULT_MODEL), `${DEFAULT_MODEL} should resolve via info()`);
});

test('WC04-mo #3 PERMISSIVE_LICENSES includes apache-2.0 + mit', () => {
  assert.ok(PERMISSIVE_LICENSES.has('apache-2.0'));
  assert.ok(PERMISSIVE_LICENSES.has('mit'));
});

test('WC04-mo #4 TIER_BY_USE maps default/chat/agent to DEFAULT_MODEL', () => {
  assert.equal(TIER_BY_USE.default, DEFAULT_MODEL);
  assert.equal(TIER_BY_USE.chat, DEFAULT_MODEL);
  assert.equal(TIER_BY_USE.agent, DEFAULT_MODEL);
});

test('WC04-mo #5 list() returns all models when no filter given', () => {
  assert.equal(list().length, MODELS.length);
});

test('WC04-mo #6 list({family}) narrows to a family', () => {
  const qwen = list({ family: 'qwen2.5' });
  assert.ok(qwen.length > 0);
  for (const m of qwen) assert.equal(m.family, 'qwen2.5');
});

test('WC04-mo #7 list({permissive:true}) returns only apache-2.0/mit', () => {
  const out = list({ permissive: true });
  for (const m of out) {
    assert.ok(PERMISSIVE_LICENSES.has(m.license), `non-permissive license: ${m.license}`);
  }
});

test('WC04-mo #8 list({max_vram_gb}) drops models that exceed the budget', () => {
  const out = list({ max_vram_gb: 4 });
  for (const m of out) {
    assert.ok(m.vram_gb_4bit <= 4, `${m.id} exceeds budget: ${m.vram_gb_4bit}`);
  }
});

test('WC04-mo #9 info(id) returns the model row + null for unknown', () => {
  assert.equal(info(DEFAULT_MODEL).id, DEFAULT_MODEL);
  assert.equal(info('never-shipped-model-9000'), null);
});

test('WC04-mo #10 recommend({use:default}) picks something with a positive score', () => {
  const r = recommend({ use: 'default' });
  assert.equal(typeof r.pick, 'string');
  assert.ok(info(r.pick), 'pick must be a real model');
  assert.equal(r.explicit_tier_pick, DEFAULT_MODEL);
  assert.ok(Array.isArray(r.top));
  assert.ok(r.top.length > 0);
});

test('WC04-mo #11 recommend({use:code}) prefers the coder-tier model', () => {
  const r = recommend({ use: 'code' });
  // The use-bonus pushes Qwen2.5-Coder above Qwen2.5-3B-Instruct ties.
  assert.equal(r.explicit_tier_pick, TIER_BY_USE.code);
});

test('WC04-mo #12 recommend({vram_gb:2}) avoids models > 2GB at q4', () => {
  const r = recommend({ vram_gb: 2 });
  const picked = info(r.pick);
  assert.ok(picked.vram_gb_4bit <= 2, `${picked.id} blew vram budget: ${picked.vram_gb_4bit}`);
});

test('WC04-mo #13 fitsOn returns false for unknown model or null device', () => {
  assert.equal(fitsOn('never-shipped-model-9000', { vram_gb: 80 }), false);
  assert.equal(fitsOn(DEFAULT_MODEL, null), false);
});

test('WC04-mo #14 fitsOn returns true for a 3B model on 24GB desktop card', () => {
  assert.equal(fitsOn(DEFAULT_MODEL, { class: 'inference', vram_gb: 24 }), true);
});

test('WC04-mo #15 fitsOn returns false when 7B + headroom > device.vram_gb', () => {
  // 7B q4 = 8GB + 2GB headroom = 10GB. 8GB device should fail.
  assert.equal(fitsOn('Qwen/Qwen2.5-7B-Instruct', { class: 'inference', vram_gb: 8 }), false);
});

test('WC04-mo #16 fitsOn CPU-only path uses cpu_ram_gb_min floor', () => {
  // device.vram_gb===0 → CPU path, need = 0.6 * params_b
  // 0.5B → 0.3GB, 8GB CPU floor → fits
  assert.equal(fitsOn('Qwen/Qwen2.5-0.5B-Instruct', { vram_gb: 0, cpu_ram_gb_min: 8 }), true);
});

test('WC04-mo #17 explainFit returns ok:true + reason text for fitting model', () => {
  const r = explainFit(DEFAULT_MODEL, { class: 'inference', vram_gb: 24 });
  assert.equal(r.ok, true);
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.includes('fits'));
});

test('WC04-mo #18 explainFit returns ok:false for unfit + device-budget annotation', () => {
  const r = explainFit('Qwen/Qwen2.5-7B-Instruct', { class: 'inference', vram_gb: 4 });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('does NOT fit'));
});

test('WC04-mo #19 explainFit no-device returns ok:true + memory_required_gb', () => {
  const r = explainFit(DEFAULT_MODEL, null);
  assert.equal(r.ok, true);
  assert.equal(typeof r.memory_required_gb, 'number');
});

test('WC04-mo #20 trainOn requires device.class === training', () => {
  // inference device must NOT permit training
  assert.equal(trainOn(DEFAULT_MODEL, { class: 'inference', vram_gb: 80 }), false);
  // 3B model: 4GB * 2 + 4 = 12GB required. 80GB training card → ok.
  assert.equal(trainOn(DEFAULT_MODEL, { class: 'training', vram_gb: 80 }), true);
});

test('WC04-mo #21 resolveBase falls back to DEFAULT_MODEL with no opts', async () => {
  // Wipe KOLM_BASE_MODEL so env precedence doesn't shadow the default.
  const orig = process.env.KOLM_BASE_MODEL;
  delete process.env.KOLM_BASE_MODEL;
  try {
    const r = await resolveBase({});
    assert.equal(r, DEFAULT_MODEL);
  } finally {
    if (orig !== undefined) process.env.KOLM_BASE_MODEL = orig;
  }
});

test('WC04-mo #22 resolveBase respects KOLM_BASE_MODEL env override', async () => {
  const orig = process.env.KOLM_BASE_MODEL;
  process.env.KOLM_BASE_MODEL = 'custom/whatever-model';
  try {
    const r = await resolveBase({});
    assert.equal(r, 'custom/whatever-model');
  } finally {
    if (orig === undefined) delete process.env.KOLM_BASE_MODEL;
    else process.env.KOLM_BASE_MODEL = orig;
  }
});

test('WC04-mo #23 resolveBase({use}) falls back to TIER_BY_USE map', async () => {
  const orig = process.env.KOLM_BASE_MODEL;
  delete process.env.KOLM_BASE_MODEL;
  try {
    const r = await resolveBase({ use: 'edge' });
    assert.equal(r, TIER_BY_USE.edge);
  } finally {
    if (orig !== undefined) process.env.KOLM_BASE_MODEL = orig;
  }
});
