// W788 — SLA persistent dashboard.
//
// Tests assert behavior, not page copy:
//   1) SLA_SURFACES is a frozen array (no runtime mutation drift).
//   2) sampleLatency persists to disk + appears in rollupLatency.
//   3) rollupLatency on an empty window returns the honest no_samples envelope.
//   4) p99 >= p95 >= p50 when there are enough samples.
//   5) sampleUptime + rollupUptime returns 100% on all-ok samples.
//   6) Mixed ok/fail samples roll up to the right uptime_pct.
//   7) Tenant fence: foreign tenant_id sees no samples.
//   8) dashboardData bundles latency + uptime per surface and never invents zeros.
//   9) Bad surface rejects loudly (typo in instrumentation must not silently disappear).
//  10) Router exposes /v1/sla/rollup + /v1/sla/dashboard auth-gated; CLI dispatcher
//      wires `kolm sla`; public/sw.js bumped via regex+threshold; html page exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Each test owns its own KOLM_DATA_DIR so the JSONL backing store starts
// empty. We import the module fresh via dynamic import after setting env so
// the module's lazy path resolution picks up the temp dir.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w788-'));
  process.env.KOLM_DATA_DIR = tmp;
  return tmp;
}

const { default: _default, ...sla } = await import('../src/sla-rollup.js');
const {
  SLA_SURFACES,
  sampleLatency,
  sampleUptime,
  rollupLatency,
  rollupUptime,
  dashboardData,
  _wipeLocalState,
  _samplesFilePath,
} = sla;

test('W788 #1 — SLA_SURFACES is frozen + contains the six load-bearing surface names', () => {
  assert.ok(Object.isFrozen(SLA_SURFACES), 'SLA_SURFACES must be frozen');
  for (const s of ['router_http', 'cli_compile', 'cli_distill', 'capture_log', 'intent_ask', 'bakeoff']) {
    assert.ok(SLA_SURFACES.includes(s), `SLA_SURFACES must include ${s}`);
  }
  // Mutating an array literal must throw or be a no-op (frozen array).
  let threw = false;
  try { SLA_SURFACES.push('ghost_surface'); } catch { threw = true; }
  // Strict-mode push on a frozen array throws; sloppy-mode silently noops.
  // Either way, the array must not actually gain the entry.
  assert.ok(threw || !SLA_SURFACES.includes('ghost_surface'),
    'frozen array must reject push (strict throws / sloppy noops)');
});

test('W788 #2 — sampleLatency persists to disk + rollupLatency sees the row', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_2';
  sampleLatency({ surface: 'router_http', latency_ms: 42, tenant_id: tenant });
  sampleLatency({ surface: 'router_http', latency_ms: 100, tenant_id: tenant });
  // File must exist after first sample.
  assert.ok(fs.existsSync(_samplesFilePath()), 'samples file must exist after sampleLatency');
  const out = rollupLatency({ surface: 'router_http', window_hours: 24, tenant_id: tenant });
  assert.equal(out.status, 'ok');
  assert.equal(out.count, 2);
  assert.equal(out.min, 42);
  assert.equal(out.max, 100);
});

test('W788 #3 — rollupLatency on empty window returns honest no_samples_in_window envelope', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_3';
  const out = rollupLatency({ surface: 'capture_log', window_hours: 1, tenant_id: tenant });
  assert.equal(out.status, 'no_samples_in_window');
  assert.equal(out.count, 0);
  // CRITICAL — empty window must NOT synthesize zeros. p50/p95/p99 must be
  // null so the dashboard renders the "no samples" pill, never "0ms".
  assert.equal(out.p50, null, 'empty window p50 must be null, not 0');
  assert.equal(out.p95, null, 'empty window p95 must be null, not 0');
  assert.equal(out.p99, null, 'empty window p99 must be null, not 0');
  assert.equal(out.min, null);
  assert.equal(out.max, null);
});

test('W788 #4 — p99 >= p95 >= p50 with a non-trivial sample set', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_4';
  // Seed 100 samples uniformly distributed 1..100ms.
  for (let i = 1; i <= 100; i++) {
    sampleLatency({ surface: 'intent_ask', latency_ms: i, tenant_id: tenant });
  }
  const out = rollupLatency({ surface: 'intent_ask', window_hours: 24, tenant_id: tenant });
  assert.equal(out.status, 'ok');
  assert.equal(out.count, 100);
  assert.ok(out.p99 >= out.p95, 'p99 must be >= p95 (got p99=' + out.p99 + ', p95=' + out.p95 + ')');
  assert.ok(out.p95 >= out.p50, 'p95 must be >= p50 (got p95=' + out.p95 + ', p50=' + out.p50 + ')');
  // Median of 1..100 falls between 50 and 51 via linear interpolation.
  assert.ok(out.p50 >= 49 && out.p50 <= 52, 'p50 should be near 50 (got ' + out.p50 + ')');
});

test('W788 #5 — sampleUptime + rollupUptime returns 100% on all-ok samples', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_5';
  for (let i = 0; i < 10; i++) {
    sampleUptime({ surface: 'bakeoff', ok: true, tenant_id: tenant });
  }
  const out = rollupUptime({ surface: 'bakeoff', window_hours: 24, tenant_id: tenant });
  assert.equal(out.status, 'ok');
  assert.equal(out.total_samples, 10);
  assert.equal(out.ok_samples, 10);
  assert.equal(out.failed_samples, 0);
  assert.equal(out.uptime_pct, 100);
});

test('W788 #6 — mixed ok/fail samples produce the correct uptime_pct', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_6';
  for (let i = 0; i < 9; i++) sampleUptime({ surface: 'cli_compile', ok: true, tenant_id: tenant });
  sampleUptime({ surface: 'cli_compile', ok: false, tenant_id: tenant });
  const out = rollupUptime({ surface: 'cli_compile', window_hours: 24, tenant_id: tenant });
  assert.equal(out.total_samples, 10);
  assert.equal(out.ok_samples, 9);
  assert.equal(out.failed_samples, 1);
  assert.equal(out.uptime_pct, 90);
  // Empty window for uptime must also be honest.
  const empty = rollupUptime({ surface: 'cli_distill', window_hours: 24, tenant_id: tenant });
  assert.equal(empty.status, 'no_samples_in_window');
  assert.equal(empty.uptime_pct, null, 'empty uptime must be null, not 100');
});

test('W788 #7 — tenant fence: foreign tenant_id sees no samples', () => {
  freshDir();
  _wipeLocalState();
  // Tenant A logs latency; tenant B reads — must see nothing.
  sampleLatency({ surface: 'router_http', latency_ms: 99, tenant_id: 'tenant_w788_7_A' });
  sampleLatency({ surface: 'router_http', latency_ms: 88, tenant_id: 'tenant_w788_7_A' });
  sampleUptime({ surface: 'router_http', ok: true, tenant_id: 'tenant_w788_7_A' });
  const foreign = rollupLatency({ surface: 'router_http', window_hours: 24, tenant_id: 'tenant_w788_7_B' });
  assert.equal(foreign.status, 'no_samples_in_window', 'foreign tenant must see no_samples_in_window');
  assert.equal(foreign.count, 0);
  const foreignUp = rollupUptime({ surface: 'router_http', window_hours: 24, tenant_id: 'tenant_w788_7_B' });
  assert.equal(foreignUp.status, 'no_samples_in_window');
  // Owning tenant must still see its own data.
  const own = rollupLatency({ surface: 'router_http', window_hours: 24, tenant_id: 'tenant_w788_7_A' });
  assert.equal(own.count, 2);
});

test('W788 #8 — dashboardData bundles latency + uptime per surface; preserves honest empty states', () => {
  freshDir();
  _wipeLocalState();
  const tenant = 'tenant_w788_8';
  sampleLatency({ surface: 'router_http', latency_ms: 50, tenant_id: tenant });
  sampleUptime({ surface: 'router_http', ok: true, tenant_id: tenant });
  const data = dashboardData({ tenant_id: tenant, window_hours: 24 });
  assert.equal(data.tenant_id, tenant);
  assert.ok(Array.isArray(data.surfaces));
  assert.equal(data.surfaces.length, SLA_SURFACES.length, 'dashboard returns one row per known surface');
  const byName = Object.fromEntries(data.surfaces.map(s => [s.surface, s]));
  // router_http has a real sample.
  assert.equal(byName.router_http.latency.status, 'ok');
  assert.equal(byName.router_http.latency.count, 1);
  assert.equal(byName.router_http.uptime.status, 'ok');
  // Every other surface must report no_samples_in_window — NEVER fake zeros.
  for (const s of SLA_SURFACES) {
    if (s === 'router_http') continue;
    assert.equal(byName[s].latency.status, 'no_samples_in_window');
    assert.equal(byName[s].latency.p50, null);
    assert.equal(byName[s].uptime.status, 'no_samples_in_window');
    assert.equal(byName[s].uptime.uptime_pct, null);
  }
});

test('W788 #9 — bad surface / missing tenant rejects loudly with .code', () => {
  freshDir();
  _wipeLocalState();
  // Bad surface on sampleLatency.
  let err1 = null;
  try { sampleLatency({ surface: 'ghost', latency_ms: 1, tenant_id: 'x' }); } catch (e) { err1 = e; }
  assert.ok(err1 && err1.code === 'invalid_surface', 'bad surface must throw .code=invalid_surface');
  // Missing tenant on rollupLatency.
  let err2 = null;
  try { rollupLatency({ surface: 'router_http', window_hours: 24 }); } catch (e) { err2 = e; }
  assert.ok(err2 && err2.code === 'tenant_id_required', 'missing tenant must throw .code=tenant_id_required');
  // Negative latency rejected.
  let err3 = null;
  try { sampleLatency({ surface: 'router_http', latency_ms: -5, tenant_id: 'x' }); } catch (e) { err3 = e; }
  assert.ok(err3 && err3.code === 'invalid_latency', 'negative latency must throw .code=invalid_latency');
  // Bad surface on rollupUptime.
  let err4 = null;
  try { rollupUptime({ surface: 'ghost', tenant_id: 'x' }); } catch (e) { err4 = e; }
  assert.ok(err4 && err4.code === 'invalid_surface');
});

test('W788 #10 — router exposes /v1/sla/{rollup,dashboard,series} + CLI wires sla verb + sw.js wave>=788 + sla.html lives', () => {
  // Router source-pin: imports sla-rollup + exposes three routes.
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /from\s+['"]\.\/sla-rollup\.js['"]/, 'router must import sla-rollup.js');
  assert.match(router, /r\.get\(['"]\/v1\/sla\/rollup['"]/,    'router must wire GET /v1/sla/rollup');
  assert.match(router, /r\.get\(['"]\/v1\/sla\/dashboard['"]/, 'router must wire GET /v1/sla/dashboard');
  assert.match(router, /r\.get\(['"]\/v1\/sla\/series['"]/,    'router must wire GET /v1/sla/series');
  // 4 hot routes must call the W788 tracker.
  const trackerHits = router.match(/_w788SlaTrack\(req,\s*res/g) || [];
  assert.ok(trackerHits.length >= 4,
    'router must call _w788SlaTrack on >=4 hot routes (got ' + trackerHits.length + ')');

  // CLI dispatcher wires `kolm sla`.
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /case\s+['"]sla['"]:\s*await\s+withErrorContext\(['"]sla['"],\s*\(\)\s*=>\s*cmdSla\(rest\)\)/,
    'CLI dispatcher must wire `kolm sla` to cmdSla');
  assert.match(cli, /async function cmdSla/, 'cmdSla must be defined');
  // CLI mentions the rollup subcommand + supports --surface flag.
  assert.match(cli, /sub === 'rollup'/, 'cmdSla must handle `rollup` subcommand');
  assert.match(cli, /--surface/, 'cmdSla must mention --surface');

  // sw.js wave token (regex+threshold pattern — NEVER explicit array).
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'sw.js must define CACHE');
  const waveMatches = [...m[1].matchAll(/wave(\d{3,4})/g)].map(x => parseInt(x[1], 10));
  assert.ok(waveMatches.length, 'sw.js CACHE slug must include at least one waveNNN token');
  assert.ok(waveMatches.some(n => n >= 788),
    'sw.js CACHE slug must reference the W788+ family (saw waves: ' + waveMatches.join(',') + ')');

  // SLA dashboard page exists with the persistent-rollup wiring marker.
  const slaPath = path.join(REPO_ROOT, 'public', 'account', 'sla.html');
  assert.ok(fs.existsSync(slaPath), '/account/sla.html must exist');
  const slaHtml = fs.readFileSync(slaPath, 'utf8');
  assert.match(slaHtml, /w788-3-sla/, 'sla.html must carry the W788-3 marker');
  assert.match(slaHtml, /\/v1\/sla\/dashboard/, 'sla.html script must fetch /v1/sla/dashboard');
});
