// W813 - Drift Detection + Alerting (embedding-distribution comparator) tests.
//
// Pins the W813 wave-brief surface:
//
//   src/drift-detect.js            - pure-compute embedding histogram + KL
//   src/drift-alert-w813.js        - alert wrapper around W215 notifications
//                                     (renamed from src/drift-alert.js to avoid
//                                      collision with W747's pre-existing
//                                      drift-alert.js distribution-shift module)
//   src/drift-config.js            - per-namespace threshold + auto_remediate
//   src/router.js                  - 5 routes: scan/status/configure/alerts/
//                                     auto-remediate (auth-gated)
//   cli/kolm.js                    - cmdW813Drift dispatcher (case 'drift' wires)
//   public/account/drift.html      - dashboard with brand-lock + data-w813
//   vercel.json                    - /account/drift -> .html rewrite
//
// W604 anti-brittleness: sw.js family lock uses `wave(\d{3,4})` regex + numeric
// threshold (never explicit array of sibling names).
//
// 30 tests total. Each test is hermetic via freshDir() + fakeStoreMod() so
// concurrent runs (--test-concurrency=1 still required) never bleed state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DRIFT_DETECT_VERSION,
  DEFAULT_KL_THRESHOLD,
  DEFAULT_FALLBACK_RATE_LIFT,
  MIN_HISTOGRAM_BINS,
  DEFAULT_HISTOGRAM_BINS,
  embeddingHistogram,
  klDivergence,
  compareDistributions,
  quantifyShift,
  buildSuggestedActionText,
} from '../src/drift-detect.js';

import {
  DRIFT_ALERT_VERSION,
  DRIFT_EVENT_TYPE,
  emitDriftAlert,
  listRecentAlerts,
} from '../src/drift-alert-w813.js';

import {
  DRIFT_CONFIG_VERSION,
  DRIFT_CONFIG_PROVIDER,
  DRIFT_CONFIG_DEFAULTS,
  validateConfig,
  setNamespaceConfig,
  getNamespaceConfig,
} from '../src/drift-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'account', 'drift.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');

function freshDir(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w813d-${label || 'x'}-`));
  const dot = path.join(tmp, '.kolm');
  fs.mkdirSync(dot, { recursive: true });
  process.env.KOLM_DATA_DIR = dot;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = dot;
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Deterministic in-memory store fake (for drift-config tenant-fence test).
function fakeStoreMod(rowsByTable) {
  return {
    all(table) {
      return rowsByTable[table] || [];
    },
  };
}

// Deterministic in-memory event-store fake. Captures appended rows so we can
// re-feed them on listEvents (for the W813-3 alert tests + W813-2 config tests).
function fakeEventStore() {
  const rows = [];
  return {
    rows,
    async appendEvent(ev) {
      const row = {
        event_id: 'ev_' + crypto.randomBytes(6).toString('hex'),
        created_at: new Date().toISOString(),
        ...ev,
      };
      rows.push(row);
      return row;
    },
    async listEvents({ tenant_id, namespace, provider, limit = 50, order = 'desc' } = {}) {
      let out = rows.slice();
      if (tenant_id) out = out.filter((r) => r.tenant_id === tenant_id);
      if (namespace) out = out.filter((r) => r.namespace === namespace);
      if (provider) out = out.filter((r) => r.provider === provider);
      out.sort((a, b) => {
        const ta = Date.parse(a.created_at || '') || 0;
        const tb = Date.parse(b.created_at || '') || 0;
        return order === 'desc' ? tb - ta : ta - tb;
      });
      return out.slice(0, limit);
    },
  };
}

// Deterministic dense-embedding fabrication. Same seed -> same array.
function makeEmbeds(n, dim, seed) {
  let s = (seed >>> 0) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(dim);
    for (let j = 0; j < dim; j++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      row[j] = (s / 4294967296) - 0.5; // in [-0.5, 0.5)
    }
    out.push(row);
  }
  return out;
}

// Bias one set of embeddings toward a direction to produce a real shift.
function makeShiftedEmbeds(n, dim, seed, shift) {
  const out = makeEmbeds(n, dim, seed);
  for (const row of out) {
    for (let j = 0; j < dim; j++) row[j] += shift;
  }
  return out;
}

// =============================================================================
// W813 #1 - Version stamps stable across all 3 modules
// =============================================================================
test('W813 #1 - version stamps === w813-v1 across detect/alert/config', () => {
  freshDir('t1');
  assert.equal(DRIFT_DETECT_VERSION, 'w813-v1');
  assert.equal(DRIFT_ALERT_VERSION, 'w813-v1');
  assert.equal(DRIFT_CONFIG_VERSION, 'w813-v1');
});

// =============================================================================
// W813 #2 - W813-2 spec defaults pinned
// =============================================================================
test('W813 #2 - DEFAULT_KL_THRESHOLD === 0.10 + DEFAULT_FALLBACK_RATE_LIFT === 0.20', () => {
  freshDir('t2');
  assert.equal(DEFAULT_KL_THRESHOLD, 0.10);
  assert.equal(DEFAULT_FALLBACK_RATE_LIFT, 0.20);
  // Frozen defaults object also wired.
  assert.equal(DRIFT_CONFIG_DEFAULTS.kl_threshold, 0.10);
  assert.equal(DRIFT_CONFIG_DEFAULTS.fallback_rate_lift, 0.20);
  assert.equal(DRIFT_CONFIG_DEFAULTS.auto_remediate_drift, false,
    'fail-safe: auto_remediate_drift MUST default false (W813-5)');
  assert.ok(Object.isFrozen(DRIFT_CONFIG_DEFAULTS),
    'DRIFT_CONFIG_DEFAULTS must be frozen to prevent runtime mutation');
});

// =============================================================================
// W813 #3 - embeddingHistogram pure + deterministic
// =============================================================================
test('W813 #3 - embeddingHistogram pure + deterministic for same input', () => {
  freshDir('t3');
  const embeds = makeEmbeds(40, 12, 0xCAFEBABE);
  const a = embeddingHistogram(embeds, { bins: 16 });
  const b = embeddingHistogram(embeds, { bins: 16 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.bin_counts, b.bin_counts,
    'embeddingHistogram MUST be deterministic - same input twice -> same counts');
  assert.equal(a.total_samples, 40);
  // Counts sum to total.
  const sum = a.bin_counts.reduce((s, c) => s + c, 0);
  assert.equal(sum, 40, `bin counts must sum to total_samples; got ${sum} vs 40`);
});

// =============================================================================
// W813 #4 - embeddingHistogram honest envelope on empty / bad input
// =============================================================================
test('W813 #4 - embeddingHistogram honest envelope on empty / bad input', () => {
  freshDir('t4');
  for (const bad of [null, undefined, [], 'not-an-array', {}, 42, [[]]]) {
    const r = embeddingHistogram(bad);
    assert.equal(r.ok, false,
      `bad input ${JSON.stringify(bad)} MUST return ok:false; got ${JSON.stringify(r)}`);
    assert.ok(r.error, 'error code must be present');
    assert.equal(r.version, 'w813-v1');
  }
  // Mixed dimension -> honest envelope.
  const mixed = embeddingHistogram([[1, 2, 3], [4, 5]]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error, 'embedding_dim_mismatch');
});

// =============================================================================
// W813 #5 - klDivergence: KL(p, p) === 0
// =============================================================================
test('W813 #5 - klDivergence symmetric on identical histograms === 0', () => {
  freshDir('t5');
  const embeds = makeEmbeds(40, 8, 0xDEADBEEF);
  const h = embeddingHistogram(embeds, { bins: 16 });
  const kl = klDivergence(h, h);
  assert.equal(kl.ok, true);
  assert.ok(kl.kl >= 0, 'KL must be non-negative');
  assert.ok(kl.kl < 1e-9,
    `KL(p,p) MUST be effectively 0 (got ${kl.kl}) - epsilon smoothing should still cancel`);
});

// =============================================================================
// W813 #6 - klDivergence: zero-bin epsilon smoothing never produces NaN/Inf
// =============================================================================
test('W813 #6 - klDivergence epsilon-smoothed: zero bins never produce NaN/Infinity', () => {
  freshDir('t6');
  const p = { bin_counts: [10, 0, 0, 0, 0, 0, 0, 0], total_samples: 10 };
  const q = { bin_counts: [0, 0, 0, 0, 0, 0, 0, 10], total_samples: 10 };
  const r = klDivergence(p, q);
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.kl),
    `KL MUST be finite under epsilon smoothing; got ${r.kl}`);
  assert.ok(r.kl > 0,
    `disjoint-support distributions MUST yield strictly positive KL; got ${r.kl}`);
});

// =============================================================================
// W813 #7 - klDivergence: shape mismatch -> honest envelope
// =============================================================================
test('W813 #7 - klDivergence shape mismatch returns honest envelope', () => {
  freshDir('t7');
  const p = { bin_counts: [1, 2, 3, 4], total_samples: 10 };
  const q = { bin_counts: [1, 2, 3, 4, 5, 6, 7, 8], total_samples: 36 };
  const r = klDivergence(p, q);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_mismatch');
  assert.equal(r.version, 'w813-v1');
});

// =============================================================================
// W813 #8 - klDivergence: monotonic - bigger shift -> bigger KL
// =============================================================================
test('W813 #8 - klDivergence monotonic with shift size', () => {
  freshDir('t8');
  const base = makeEmbeds(80, 6, 0x12345678);
  const small = makeShiftedEmbeds(80, 6, 0x12345678, 0.1);
  const large = makeShiftedEmbeds(80, 6, 0x12345678, 0.6);
  const hb = embeddingHistogram(base.concat(small), { bins: 24 });
  // Re-bin separately against same edges (use compareDistributions for proper alignment)
  const cmpSmall = compareDistributions({
    live_embeddings: small,
    training_embeddings: base,
  });
  const cmpLarge = compareDistributions({
    live_embeddings: large,
    training_embeddings: base,
  });
  assert.equal(cmpSmall.ok, true);
  assert.equal(cmpLarge.ok, true);
  assert.ok(cmpLarge.kl_divergence >= cmpSmall.kl_divergence,
    `larger shift MUST yield larger KL; got small=${cmpSmall.kl_divergence} vs large=${cmpLarge.kl_divergence}`);
});

// =============================================================================
// W813 #9 - compareDistributions: insufficient samples -> honest envelope
// =============================================================================
test('W813 #9 - compareDistributions: insufficient samples -> honest envelope', () => {
  freshDir('t9');
  const tiny = makeEmbeds(4, 8, 1);
  const r = compareDistributions({
    live_embeddings: tiny,
    training_embeddings: tiny,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_samples');
  assert.ok(r.hint.includes('embeddings'));
  assert.equal(r.min_samples_per_set, MIN_HISTOGRAM_BINS * 2);
});

// =============================================================================
// W813 #10 - compareDistributions: identical -> drift_detected:false
// =============================================================================
test('W813 #10 - compareDistributions identical sets -> drift_detected:false', () => {
  freshDir('t10');
  const a = makeEmbeds(64, 16, 0xAA);
  const r = compareDistributions({
    live_embeddings: a,
    training_embeddings: a,
  });
  assert.equal(r.ok, true);
  assert.equal(r.drift_detected, false,
    `identical embeddings MUST yield drift_detected:false; got ${JSON.stringify(r)}`);
  assert.equal(r.kl_drift_detected, false);
  assert.equal(r.severity, 'none');
  assert.equal(r.suggested_action_text,
    'no action required; live distribution within tolerance of training distribution');
});

// =============================================================================
// W813 #11 - compareDistributions: divergent -> drift_detected:true
// =============================================================================
test('W813 #11 - compareDistributions: massively-shifted -> drift_detected:true', () => {
  freshDir('t11');
  const base = makeEmbeds(120, 12, 0xBBBB);
  const shifted = makeShiftedEmbeds(120, 12, 0xCCCC, 2.0);
  const r = compareDistributions({
    live_embeddings: shifted,
    training_embeddings: base,
    opts: { kl_threshold: 0.05 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.drift_detected, true,
    `disjoint shifted sets MUST yield drift_detected:true; got ${JSON.stringify(r)}`);
  assert.ok(r.kl_divergence > 0);
  assert.ok(['minor', 'moderate', 'severe'].includes(r.severity),
    `severity MUST be one of {minor, moderate, severe} when drift_detected; got ${r.severity}`);
});

// =============================================================================
// W813 #12 - compareDistributions: fallback-rate drift fires OR semantics
// =============================================================================
test('W813 #12 - compareDistributions: fallback-rate drift fires independent of KL', () => {
  freshDir('t12');
  const a = makeEmbeds(64, 8, 0xD1);
  const r = compareDistributions({
    live_embeddings: a,
    training_embeddings: a, // KL ~ 0
    opts: {
      live_fallback_rate: 0.55,
      training_fallback_rate: 0.20,
      // delta = 0.35 > default 0.20 lift -> fallback_drift_detected
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kl_drift_detected, false);
  assert.equal(r.fallback_drift_detected, true);
  assert.equal(r.drift_detected, true,
    'drift_detected MUST be OR(kl_drift, fallback_drift); both signals matter');
  assert.ok(r.fallback_rate_delta != null);
  assert.ok(r.fallback_rate_delta > 0.20);
});

// =============================================================================
// W813 #13 - severity ladder: none / minor / moderate / severe
// =============================================================================
test('W813 #13 - severity ladder pinned to {none, minor, moderate, severe}', () => {
  freshDir('t13');
  const a = makeEmbeds(64, 8, 0xE2);
  const noneCase = compareDistributions({ live_embeddings: a, training_embeddings: a });
  assert.equal(noneCase.severity, 'none');

  // Force a severe case by huge fallback delta (5x threshold).
  const severeCase = compareDistributions({
    live_embeddings: a,
    training_embeddings: a,
    opts: { live_fallback_rate: 1.0, training_fallback_rate: 0.0 },
  });
  assert.equal(severeCase.severity, 'severe',
    `fallback delta 1.0 / lift 0.20 = 5x excess -> severe; got ${severeCase.severity}`);
});

// =============================================================================
// W813 #14 - buildSuggestedActionText: W813-4 spec template verbatim
// =============================================================================
test('W813 #14 - buildSuggestedActionText emits W813-4 spec template verbatim', () => {
  freshDir('t14');
  const txt = buildSuggestedActionText({
    shifts: [
      { cluster_id: 'support', label: 'support', delta_pct: 18.6, training_pct: 20, live_pct: 38.6, direction: 'increase' },
      { cluster_id: 'general', label: 'general', delta_pct: -5, training_pct: 70, live_pct: 65, direction: 'decrease' },
    ],
  });
  // Spec contract: "your traffic shifted N% more X queries; re-distill recommended"
  assert.match(txt,
    /^your traffic shifted \d+% more support queries; re-distill recommended$/,
    `buildSuggestedActionText template MUST match the W813-4 spec literal; got ${JSON.stringify(txt)}`);
  // No-shift case stays honest.
  const noneTxt = buildSuggestedActionText({ shifts: [] });
  assert.match(noneTxt, /no action required/);
});

// =============================================================================
// W813 #15 - quantifyShift: ranked by |delta_pct| desc
// =============================================================================
test('W813 #15 - quantifyShift ranks clusters by |delta_pct| desc', () => {
  freshDir('t15');
  const r = quantifyShift({
    live_clusters: { a: 80, b: 10, c: 10 },
    training_clusters: { a: 20, b: 50, c: 30 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.shifts.length, 3);
  // Top shift must be cluster 'a' (delta 60 -> the dominant signal)
  assert.equal(r.shifts[0].cluster_id, 'a');
  assert.ok(Math.abs(r.shifts[0].delta_pct) >= Math.abs(r.shifts[1].delta_pct));
  assert.ok(Math.abs(r.shifts[1].delta_pct) >= Math.abs(r.shifts[2].delta_pct));
});

// =============================================================================
// W813 #16 - emitDriftAlert: event_type === 'drift_detected'
// =============================================================================
test('W813 #16 - emitDriftAlert: DRIFT_EVENT_TYPE === drift_detected', async () => {
  freshDir('t16');
  assert.equal(DRIFT_EVENT_TYPE, 'drift_detected');
  const fakeES = fakeEventStore();
  const env = await emitDriftAlert({
    tenant_id: 't_me',
    namespace: 'prod',
    drift_result: { drift_detected: true, severity: 'moderate', kl_divergence: 0.22 },
    opts: { eventStore: fakeES },
  });
  assert.equal(env.ok, true);
  assert.equal(env.event_type, 'drift_detected');
  assert.equal(env.payload.event_type, 'drift_detected');
  assert.match(env.alert_id, /^da_/, 'alert_id MUST be prefixed da_');
});

// =============================================================================
// W813 #17 - emitDriftAlert: tenant_id_required honest envelope
// =============================================================================
test('W813 #17 - emitDriftAlert: tenant_id_required honest envelope', async () => {
  freshDir('t17');
  for (const bad of [null, undefined, '', 42, {}]) {
    const env = await emitDriftAlert({
      tenant_id: bad,
      namespace: 'prod',
      drift_result: { drift_detected: true },
    });
    assert.equal(env.ok, false);
    assert.equal(env.error, 'tenant_id_required',
      `bad tenant_id ${JSON.stringify(bad)} MUST surface tenant_id_required; got ${JSON.stringify(env)}`);
  }
});

// =============================================================================
// W813 #18 - emitDriftAlert: lazy-import fallback never crashes
// =============================================================================
test('W813 #18 - emitDriftAlert: returns honest notification_* triple every time', async () => {
  freshDir('t18');
  const fakeES = fakeEventStore();
  // Path A: explicit sender succeeds.
  const okEnv = await emitDriftAlert({
    tenant_id: 't_me',
    namespace: 'prod',
    drift_result: { drift_detected: true },
    opts: {
      eventStore: fakeES,
      notifications_sender: async () => ({ ok: true }),
    },
  });
  assert.equal(okEnv.ok, true);
  assert.equal(okEnv.notification_attempted, true);
  assert.equal(okEnv.notification_sent, true);
  assert.equal(okEnv.notification_error, null);

  // Path B: explicit sender THROWS - envelope still ok:true with error captured.
  const throwEnv = await emitDriftAlert({
    tenant_id: 't_me',
    namespace: 'prod',
    drift_result: { drift_detected: true },
    opts: {
      eventStore: fakeES,
      notifications_sender: async () => { throw new Error('boom'); },
    },
  });
  assert.equal(throwEnv.ok, true,
    'envelope must still be ok:true even if dispatch throws; never silent-fail');
  assert.equal(throwEnv.notification_attempted, true);
  assert.equal(throwEnv.notification_sent, false);
  assert.match(throwEnv.notification_error || '', /boom/);
  // alert_id always present.
  assert.match(throwEnv.alert_id, /^da_/);
});

// =============================================================================
// W813 #19 - listRecentAlerts: tenant-fenced (W411 defense-in-depth)
// =============================================================================
test('W813 #19 - listRecentAlerts: W411 tenant-fenced - cross-tenant rows never leak', async () => {
  freshDir('t19');
  const fakeES = fakeEventStore();
  await emitDriftAlert({
    tenant_id: 't_me',
    namespace: 'prod',
    drift_result: { drift_detected: true, severity: 'moderate' },
    opts: { eventStore: fakeES },
  });
  await emitDriftAlert({
    tenant_id: 't_other',
    namespace: 'prod',
    drift_result: { drift_detected: true, severity: 'severe' },
    opts: { eventStore: fakeES },
  });
  const mine = await listRecentAlerts({
    tenant_id: 't_me', limit: 50, opts: { eventStore: fakeES },
  });
  assert.equal(mine.ok, true);
  assert.equal(mine.alerts.length, 1);
  assert.equal(mine.alerts[0].tenant_id, 't_me');
  // Inverse direction: t_other only sees its own row.
  const theirs = await listRecentAlerts({
    tenant_id: 't_other', limit: 50, opts: { eventStore: fakeES },
  });
  assert.equal(theirs.alerts.length, 1);
  assert.equal(theirs.alerts[0].tenant_id, 't_other');
});

// =============================================================================
// W813 #20 - validateConfig strict bounds
// =============================================================================
test('W813 #20 - validateConfig strict bounds: rejects out-of-range never silently coerces', () => {
  freshDir('t20');
  // Valid input
  const ok = validateConfig({ kl_threshold: 0.5, fallback_rate_lift: 0.3, auto_remediate_drift: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.kl_threshold, 0.5);
  // Out of range KL.
  for (const bad of [0, -0.01, 11, 1000, NaN, Infinity]) {
    const r = validateConfig({ kl_threshold: bad });
    assert.equal(r.ok, false,
      `kl_threshold ${bad} MUST be rejected; got ${JSON.stringify(r)}`);
    assert.match(r.error || '', /kl_threshold_/);
  }
  // Out of range fallback rate.
  for (const bad of [0, -0.01, 1.01, 50]) {
    const r = validateConfig({ fallback_rate_lift: bad });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /fallback_rate_lift_/);
  }
  // Strict boolean for auto_remediate.
  for (const bad of [0, 1, 'true', 'false', null, undefined]) {
    if (bad === undefined) continue; // undefined means "no override" -> ok
    const r = validateConfig({ auto_remediate_drift: bad });
    assert.equal(r.ok, false,
      `auto_remediate_drift ${JSON.stringify(bad)} MUST be rejected (strict boolean); got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'auto_remediate_drift_not_boolean');
  }
});

// =============================================================================
// W813 #21 - setNamespaceConfig: confirm:true required
// =============================================================================
test('W813 #21 - setNamespaceConfig requires confirm:true (durable persist gate)', async () => {
  freshDir('t21');
  const fakeES = fakeEventStore();
  const noConfirm = await setNamespaceConfig({
    tenant_id: 't_me',
    namespace: 'prod',
    kl_threshold: 0.5,
    opts: { eventStore: fakeES },
  });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.error, 'confirm_required');
  // With confirm:true succeeds.
  const ok = await setNamespaceConfig({
    tenant_id: 't_me',
    namespace: 'prod',
    kl_threshold: 0.5,
    confirm: true,
    opts: { eventStore: fakeES },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.kl_threshold, 0.5);
  assert.equal(ok.config.fallback_rate_lift, DEFAULT_FALLBACK_RATE_LIFT,
    'merged config MUST keep defaults for unspecified fields');
  assert.equal(ok.config.auto_remediate_drift, false,
    'auto_remediate_drift MUST default false even after override (fail-safe)');
});

// =============================================================================
// W813 #22 - getNamespaceConfig defaults when no override
// =============================================================================
test('W813 #22 - getNamespaceConfig returns DEFAULTS when no override persisted', async () => {
  freshDir('t22');
  const fake = fakeStoreMod({ events: [] });
  const env = await getNamespaceConfig({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(env.ok, true);
  assert.equal(env.config.kl_threshold, 0.10);
  assert.equal(env.config.fallback_rate_lift, 0.20);
  assert.equal(env.config.auto_remediate_drift, false);
  assert.equal(env.source, 'default');
});

// =============================================================================
// W813 #23 - getNamespaceConfig: tenant-fenced (W411 defense-in-depth)
// =============================================================================
test('W813 #23 - getNamespaceConfig: W411 tenant-fenced via storeMod.all + per-row filter', async () => {
  freshDir('t23');
  // Two rows: one for t_me, one for t_other - the t_other override MUST NOT leak.
  const rows = [
    {
      tenant_id: 't_other',
      namespace: 'prod',
      provider: DRIFT_CONFIG_PROVIDER,
      created_at: new Date(Date.now() - 1000).toISOString(),
      feedback: JSON.stringify({
        kind: 'drift_config_override',
        config: { kl_threshold: 0.99, fallback_rate_lift: 0.99, auto_remediate_drift: true },
      }),
    },
  ];
  const fake = fakeStoreMod({ events: rows });
  const env = await getNamespaceConfig({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(env.ok, true);
  // t_me has NO override - must fall back to defaults; t_other's row must not bleed.
  assert.equal(env.config.kl_threshold, 0.10);
  assert.equal(env.config.auto_remediate_drift, false,
    'cross-tenant auto_remediate MUST NEVER leak (P0 trust violation)');
  assert.equal(env.source, 'default');
});

// =============================================================================
// W813 #24 - Route: GET /v1/drift/status 401 w/o auth, 200 w/ auth
// =============================================================================
test('W813 #24 - GET /v1/drift/status 401 w/o auth; 200 envelope on auth', async () => {
  freshDir('t24');
  process.env.KOLM_STORE_DRIVER = 'json';

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/drift/status?namespace=prod`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/drift/status?namespace=prod`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w813-v1');
    assert.equal(env.namespace, 'prod');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W813 #25 - Route: POST /v1/drift/configure 400 without confirm:true
// =============================================================================
test('W813 #25 - POST /v1/drift/configure 400 confirm_required without confirm:true', async () => {
  freshDir('t25');
  process.env.KOLM_STORE_DRIVER = 'json';

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/drift/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'prod', kl_threshold: 0.3 }),
    });
    assert.equal(noAuth.status, 401);

    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/drift/configure`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + t.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'prod', kl_threshold: 0.3 }),
    });
    assert.equal(noConfirm.status, 400);
    const ncj = await noConfirm.json();
    assert.equal(ncj.error, 'confirm_required');

    const ok = await fetch(`http://127.0.0.1:${port}/v1/drift/configure`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + t.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'prod', kl_threshold: 0.3, confirm: true }),
    });
    assert.equal(ok.status, 200);
    const okj = await ok.json();
    assert.equal(okj.ok, true);
    assert.equal(okj.config.kl_threshold, 0.3);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W813 #26 - Route: POST /v1/drift/auto-remediate dry_run defaults TRUE
// =============================================================================
test('W813 #26 - POST /v1/drift/auto-remediate: dry_run defaults TRUE (W813-5 silent-trigger guard)', async () => {
  freshDir('t26');
  process.env.KOLM_STORE_DRIVER = 'json';

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // Default body - dry_run unspecified -> must default TRUE -> triggered:false.
    const r = await fetch(`http://127.0.0.1:${port}/v1/drift/auto-remediate`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + t.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'prod' }),
    });
    assert.equal(r.status, 200);
    const env = await r.json();
    assert.equal(env.ok, true);
    assert.equal(env.dry_run, true,
      'dry_run MUST default true even when body omits it (silent-trigger guard)');
    assert.equal(env.triggered, false,
      'triggered MUST be false under dry_run regardless of namespace cfg');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W813 #27 - public/account/drift.html: brand-lock + data-w813 anchors
// =============================================================================
test('W813 #27 - public/account/drift.html: brand-lock + data-w813 anchors', () => {
  freshDir('t27');
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand eyebrow exact lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'drift.html MUST carry brand-lock eyebrow "Open-source AI workbench"');
  // Required anchors.
  for (const anchor of [
    'data-w813="brand-eyebrow"',
    'data-w813="h1"',
    'data-w813="lede"',
    'data-w813="current-status"',
    'data-w813="quantified-shift"',
    'data-w813="suggested-action"',
    'data-w813="recent-alerts"',
    'data-w813="per-namespace-config"',
    'data-w813="cli-quickstart"',
    'data-w813="version-stamp"',
  ]) {
    assert.ok(html.includes(anchor),
      `drift.html MUST carry anchor ${anchor}; not found`);
  }
  // Version stamp present.
  assert.ok(html.includes('w813-v1'),
    'drift.html footer MUST stamp w813-v1');
  // No emojis (standing directive).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  assert.ok(!emojiRe.test(html),
    `drift.html MUST NOT contain emojis (standing directive); found one in source`);
});

// =============================================================================
// W813 #28 - cli/kolm.js: cmdW813Drift exactly once + case 'drift' wires to it
// =============================================================================
test('W813 #28 - cli/kolm.js: cmdW813Drift defined exactly once + case drift wires', () => {
  freshDir('t28');
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Exactly one function definition (not counting comments/case statements).
  const defMatches = cli.match(/^async function cmdW813Drift\b/gm) || [];
  assert.equal(defMatches.length, 1,
    `cmdW813Drift MUST be defined exactly once at top level; got ${defMatches.length}`);
  // case 'drift': wires to cmdW813Drift.
  assert.match(cli,
    /case 'drift':\s+await withErrorContext\('drift',\s+\(\)\s*=>\s*cmdW813Drift\(rest\)\);/,
    `case 'drift': MUST wire to cmdW813Drift; pattern not found`);
});

// =============================================================================
// W813 #29 - vercel.json: /account/drift rewrite
// =============================================================================
test('W813 #29 - vercel.json carries /account/drift -> drift.html rewrite', () => {
  freshDir('t29');
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const vc = JSON.parse(raw);
  const rewrites = vc.rewrites || [];
  const match = rewrites.find((r) => r && r.source === '/account/drift' && r.destination === '/account/drift.html');
  assert.ok(match,
    `vercel.json MUST carry rewrite {/account/drift -> /account/drift.html}; got ${JSON.stringify(rewrites.filter((r) => /drift/.test(r.source || '')))}`);
});

// =============================================================================
// W813 #30 - W604 anti-brittleness: sw.js sibling check via regex + threshold
// =============================================================================
test('W813 #30 - W604: sw.js cache slug matches wave(\\d{3,4}) regex with threshold >= 761', () => {
  freshDir('t30');
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  // First non-empty line should be the cache constant.
  const cacheLine = sw.split('\n').find((l) => /CACHE\s*=\s*['"]/.test(l));
  assert.ok(cacheLine, 'sw.js MUST define a CACHE constant on first usable line');
  // Regex find all wave references and confirm at least one is >= 761.
  const waveMatches = cacheLine.match(/wave?(\d{3,4})/gi) || [];
  // Also accept the bare w<digits> form which is what kolm's sw.js uses
  // ("kolm-v55-...-w770-..."). Both patterns count as a wave token.
  const wToken = cacheLine.match(/-w(\d{3,4})-/gi) || [];
  const tokens = waveMatches.concat(wToken);
  // Extract numeric portions.
  const nums = tokens.map((m) => {
    const num = m.replace(/[^0-9]/g, '');
    return Number(num);
  }).filter((n) => Number.isFinite(n));
  assert.ok(nums.length > 0,
    `sw.js cache constant MUST carry at least one wave token (wave\\d{3,4} or -w\\d{3,4}-); got cacheLine=${JSON.stringify(cacheLine)}`);
  const max = Math.max(...nums);
  assert.ok(max >= 761,
    `W604 anti-brittleness: sw.js cache slug max wave token MUST be >= 761; got ${max} from ${JSON.stringify(tokens)}`);
});
