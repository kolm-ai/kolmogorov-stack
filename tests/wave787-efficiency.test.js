// W787 - Compute-efficiency optimizations for the distill pipeline.
//
// Atomic items pinned (matches the W787 implementation):
//
//   1)  EFFICIENCY_VERSION matches /^w787-/ (W604 anti-brittleness regex)
//   2)  EARLY_STOP_DEFAULTS shape + Object.isFrozen + numeric ranges
//   3)  PRECISION_MODES frozen + includes the five required modes
//   4)  PRECISION_HINTS keys cover every PRECISION_MODES entry
//   5)  shouldStopEarly returns stop:true with reason 'plateau' when K-Score is flat
//   6)  shouldStopEarly returns stop:false reason 'min_steps_not_met' below min_steps
//   7)  shouldStopEarly returns stop:false reason 'no_plateau' on improving K-Score
//   8)  normalizeEfficiencyOptions rejects unknown precision (throws invalid_precision_mode)
//   9)  normalizeEfficiencyOptions coerces boolean truthy gradient_checkpointing + defaults
//   10) buildEfficiencyEnv emits the wire-format env-var slice for the worker
//   11) efficiencyDoctor returns no_probe envelope when probe missing
//   12) efficiencyDoctor recommends mixed-bf16 + grad-checkpoint logic from cached probe
//   13) doc page /docs/efficiency.html exists + has the W787 ID + brand header
//   14) vercel.json rewrites /docs/efficiency -> /docs/efficiency.html
//
// W604 anti-brittleness: version regex /^w787-/, never literal equality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eff from '../src/distill-efficiency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// =============================================================================
// 1) EFFICIENCY_VERSION matches /^w787-/
// =============================================================================

test('W787 #1 - EFFICIENCY_VERSION matches /^w787-/', () => {
  assert.match(eff.EFFICIENCY_VERSION, /^w787-/);
  // Surface: every exported helper is callable.
  assert.equal(typeof eff.shouldStopEarly, 'function');
  assert.equal(typeof eff.normalizeEfficiencyOptions, 'function');
  assert.equal(typeof eff.efficiencyDoctor, 'function');
  assert.equal(typeof eff.buildEfficiencyEnv, 'function');
});

// =============================================================================
// 2) EARLY_STOP_DEFAULTS shape + frozen
// =============================================================================

test('W787 #2 - EARLY_STOP_DEFAULTS is frozen with positive numeric defaults', () => {
  assert.ok(Object.isFrozen(eff.EARLY_STOP_DEFAULTS));
  assert.equal(typeof eff.EARLY_STOP_DEFAULTS.patience, 'number');
  assert.equal(typeof eff.EARLY_STOP_DEFAULTS.delta_kscore, 'number');
  assert.equal(typeof eff.EARLY_STOP_DEFAULTS.min_steps, 'number');
  assert.ok(eff.EARLY_STOP_DEFAULTS.patience > 0);
  assert.ok(eff.EARLY_STOP_DEFAULTS.delta_kscore > 0);
  assert.ok(eff.EARLY_STOP_DEFAULTS.min_steps > 0);
});

// =============================================================================
// 3) PRECISION_MODES frozen + covers the five required modes
// =============================================================================

test('W787 #3 - PRECISION_MODES frozen + includes the five required modes', () => {
  assert.ok(Object.isFrozen(eff.PRECISION_MODES));
  // Each required mode is present; threshold pattern (>=5) is more anti-brittle
  // than exact-array equality but we still want every named mode present.
  const required = ['fp32', 'fp16', 'bf16', 'mixed-fp16', 'mixed-bf16'];
  for (const m of required) {
    assert.ok(eff.PRECISION_MODES.includes(m), `PRECISION_MODES missing '${m}'`);
  }
  assert.ok(eff.PRECISION_MODES.length >= 5);
});

// =============================================================================
// 4) PRECISION_HINTS keys cover every PRECISION_MODES entry
// =============================================================================

test('W787 #4 - PRECISION_HINTS covers every PRECISION_MODES entry', () => {
  for (const m of eff.PRECISION_MODES) {
    assert.ok(typeof eff.PRECISION_HINTS[m] === 'string' && eff.PRECISION_HINTS[m].length > 10,
      `PRECISION_HINTS missing or too short for '${m}'`);
  }
});

// =============================================================================
// 5) shouldStopEarly returns plateau on a flat K-Score history
// =============================================================================

test('W787 #5 - shouldStopEarly returns stop:true reason:plateau on flat K-Score', () => {
  // 60 steps, last 4 vary by <0.005 -> plateau (patience=3, delta=0.005).
  const history = [];
  for (let i = 0; i < 56; i++) history.push(0.7 + i * 0.001);
  // Tail: 4 nearly-identical values (delta well under 0.005).
  history.push(0.910);
  history.push(0.9101);
  history.push(0.9102);
  history.push(0.9103);
  const r = eff.shouldStopEarly({ kscore_history: history });
  assert.equal(r.stop, true);
  assert.equal(r.reason, 'plateau');
  assert.ok(r.observed_delta < 0.005);
});

// =============================================================================
// 6) shouldStopEarly: min_steps_not_met below the floor
// =============================================================================

test('W787 #6 - shouldStopEarly returns stop:false reason:min_steps_not_met below floor', () => {
  // Only 10 samples, all flat - still under min_steps=50 default.
  const history = new Array(10).fill(0.9);
  const r = eff.shouldStopEarly({ kscore_history: history });
  assert.equal(r.stop, false);
  assert.equal(r.reason, 'min_steps_not_met');
});

// =============================================================================
// 7) shouldStopEarly: no_plateau on improving K-Score
// =============================================================================

test('W787 #7 - shouldStopEarly returns stop:false reason:no_plateau on improving K-Score', () => {
  // 60 steps, last 4 span 0.05 (well above delta=0.005).
  const history = [];
  for (let i = 0; i < 60; i++) history.push(0.5 + i * 0.01);
  const r = eff.shouldStopEarly({ kscore_history: history });
  assert.equal(r.stop, false);
  assert.equal(r.reason, 'no_plateau');
  assert.ok(r.observed_delta > 0.005);
});

// =============================================================================
// 8) normalizeEfficiencyOptions throws on unknown precision
// =============================================================================

test('W787 #8 - normalizeEfficiencyOptions rejects unknown precision_mode', () => {
  assert.throws(
    () => eff.normalizeEfficiencyOptions({ precision_mode: 'fp8-quantized' }),
    (e) => e.code === 'invalid_precision_mode' && /precision_mode must be one of/.test(e.message),
  );
  // Empty object -> defaults applied cleanly (no throw).
  const ok = eff.normalizeEfficiencyOptions({});
  assert.ok(eff.PRECISION_MODES.includes(ok.precision_mode));
  assert.equal(ok.gradient_checkpointing, false);
  assert.equal(ok.early_stop.enabled, false);
  assert.match(ok.version, /^w787-/);
});

// =============================================================================
// 9) normalizeEfficiencyOptions coerces truthy gradient_checkpointing
// =============================================================================

test('W787 #9 - normalizeEfficiencyOptions coerces boolean gradient_checkpointing + defaults', () => {
  const a = eff.normalizeEfficiencyOptions({
    precision_mode: 'bf16',
    gradient_checkpointing: true,
    early_stop_config: { enabled: true, patience: 5 },
  });
  assert.equal(a.precision_mode, 'bf16');
  assert.equal(a.gradient_checkpointing, true);
  assert.equal(a.early_stop.enabled, true);
  assert.equal(a.early_stop.patience, 5);
  // delta + min_steps inherit defaults
  assert.equal(a.early_stop.delta_kscore, eff.EARLY_STOP_DEFAULTS.delta_kscore);
  assert.equal(a.early_stop.min_steps, eff.EARLY_STOP_DEFAULTS.min_steps);
  // String 'true' is accepted too (CLI string-coerced).
  const b = eff.normalizeEfficiencyOptions({ gradient_checkpointing: 'true' });
  assert.equal(b.gradient_checkpointing, true);
});

// =============================================================================
// 10) buildEfficiencyEnv emits wire-format env-var slice
// =============================================================================

test('W787 #10 - buildEfficiencyEnv emits KOLM_PRECISION + KOLM_GRAD_CHECKPOINT + KOLM_EARLY_STOP_* envs', () => {
  const n = eff.normalizeEfficiencyOptions({
    precision_mode: 'mixed-bf16',
    gradient_checkpointing: true,
    early_stop_config: { enabled: true, patience: 7, delta_kscore: 0.01, min_steps: 100 },
  });
  const env = eff.buildEfficiencyEnv(n);
  assert.equal(env.KOLM_PRECISION, 'mixed-bf16');
  assert.equal(env.KOLM_GRAD_CHECKPOINT, '1');
  assert.equal(env.KOLM_EARLY_STOP, '1');
  assert.equal(env.KOLM_EARLY_STOP_PATIENCE, '7');
  assert.equal(env.KOLM_EARLY_STOP_DELTA, '0.01');
  assert.equal(env.KOLM_EARLY_STOP_MIN_STEPS, '100');
  // When early_stop is off, only the bool envs are present.
  const n2 = eff.normalizeEfficiencyOptions({ precision_mode: 'fp32' });
  const env2 = eff.buildEfficiencyEnv(n2);
  assert.equal(env2.KOLM_EARLY_STOP, '0');
  assert.equal(env2.KOLM_GRAD_CHECKPOINT, '0');
  assert.equal(env2.KOLM_EARLY_STOP_PATIENCE, undefined);
});

// =============================================================================
// 11) efficiencyDoctor: no_probe envelope when probe missing
// =============================================================================

test('W787 #11 - efficiencyDoctor returns no_probe envelope when local.json absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w787-'));
  const missingProbe = path.join(tmp, 'no-such-probe.json');
  const env = eff.efficiencyDoctor({ probePath: missingProbe });
  assert.equal(env.ok, false);
  assert.equal(env.source, 'no_probe');
  assert.equal(env.probe_path, missingProbe);
  assert.match(env.hint, /kolm devices detect/);
  assert.match(env.version, /^w787-/);
});

// =============================================================================
// 12) efficiencyDoctor recommends mixed-bf16 + grad-checkpoint from probe
// =============================================================================

test('W787 #12 - efficiencyDoctor recommends mixed-bf16 from Ampere probe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w787-'));
  const probePath = path.join(tmp, 'local.json');
  // Ampere-class GPU (sm 8.6) with 12 GB VRAM -> mixed-bf16 + grad-checkpoint.
  fs.writeFileSync(probePath, JSON.stringify({
    compute_capability: '8.6',
    vram_mib: 12 * 1024,
  }));
  const env = eff.efficiencyDoctor({ probePath });
  assert.equal(env.ok, true);
  assert.equal(env.source, 'cached_probe');
  assert.equal(env.recommendation.precision_mode, 'mixed-bf16');
  assert.equal(env.recommendation.gradient_checkpointing, true);
  assert.equal(env.recommendation.early_stop_enabled, true);
  // Hopper-class with 80 GB VRAM -> mixed-bf16 but grad-checkpoint OFF.
  const probePath2 = path.join(tmp, 'local-h100.json');
  fs.writeFileSync(probePath2, JSON.stringify({
    compute_capability: '9.0',
    vram_mib: 80 * 1024,
  }));
  const env2 = eff.efficiencyDoctor({ probePath: probePath2 });
  assert.equal(env2.recommendation.precision_mode, 'mixed-bf16');
  assert.equal(env2.recommendation.gradient_checkpointing, false);
  // Pre-Volta -> fp32 + grad-checkpoint on.
  const probePath3 = path.join(tmp, 'local-old.json');
  fs.writeFileSync(probePath3, JSON.stringify({
    compute_capability: '6.1',
    vram_mib: 6 * 1024,
  }));
  const env3 = eff.efficiencyDoctor({ probePath: probePath3 });
  assert.equal(env3.recommendation.precision_mode, 'fp32');
  assert.equal(env3.recommendation.gradient_checkpointing, true);
});

// =============================================================================
// 13) /docs/efficiency.html exists + has W787 markers + brand header
// =============================================================================

test('W787 #13 - public/docs/efficiency.html exists with W787 IDs + brand H1', () => {
  const docPath = path.join(REPO_ROOT, 'public', 'docs', 'efficiency.html');
  assert.ok(fs.existsSync(docPath), `expected doc page at ${docPath}`);
  const html = fs.readFileSync(docPath, 'utf8');
  // W604 brand contract: eyebrow + H1 from MEMORY.
  assert.match(html, /Open-source AI workbench/);
  assert.match(html, /Frontier AI on your own infrastructure/);
  // Three section pills surfaced (regex+threshold pattern -- not array match).
  // NOTE: the internal "W787" wave prefix was deliberately scrubbed from the
  // user-visible pill text in commit 3a57dd4f ("Public-surface polish ... drops
  // internal release-tag noise from user-visible strings"). The three numbered
  // section pills (-1/-2/-3) remain; we pin the count, not the internal tag.
  const pillMatches = html.match(/<span class="pill ok">-[123]<\/span>/g) || [];
  assert.ok(pillMatches.length >= 3, `expected at least 3 numbered section pills, got ${pillMatches.length}`);
  // The CLI sample teaches every flag.
  assert.match(html, /--precision/);
  assert.match(html, /--gradient-checkpointing/);
  assert.match(html, /--early-stop-patience/);
});

// =============================================================================
// 14) vercel.json rewrites /docs/efficiency -> /docs/efficiency.html
// =============================================================================

test('W787 #14 - vercel.json rewrites /docs/efficiency to /docs/efficiency.html', () => {
  const vercelPath = path.join(REPO_ROOT, 'vercel.json');
  const j = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
  const hit = (j.rewrites || []).find(
    (r) => r.source === '/docs/efficiency' && r.destination === '/docs/efficiency.html',
  );
  assert.ok(hit, 'expected /docs/efficiency rewrite in vercel.json');
});
