// W730 — Prometheus exporter + /metrics endpoint + dashboard JSON tests.
//
// Atomic items pinned (matches the W730 implementation):
//
//   1) PROMETHEUS_EXPORTER_VERSION exported and pinned to 'w730-v1'
//   2) registerMetric / incCounter / setGauge / observeHistogram are exported
//   3) renderMetrics returns Prometheus text format (HELP+TYPE lines)
//   4) Counter increment + render shows expected sample line
//   5) Gauge set + render shows expected sample line
//   6) Histogram observe + render shows _bucket, _sum, _count lines
//   7) GET /metrics returns 200 with text/plain content-type
//   8) KOLM_METRICS_BEARER set + no header → 401 with invalid_metrics_bearer
//   9) KOLM_METRICS_BEARER set + correct header → 200
//  10) dashboards/kolm-runtime.json exists and JSON.parse() succeeds
//  11) dashboards/kolm-runtime.json has all 6 panels with the named PromQL
//  12) public/docs/observability/prometheus.html exists with brand-lock content
//  13) CLI cmdW730Metrics dispatcher present + uniquely named
//  14) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//  15) _resetForTests() called between tests
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing tokens
// (version stamp, metric type words, sample row regex, file existence,
// JSON.parse success, panel title presence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PROMETHEUS_EXPORTER_VERSION,
  registerMetric,
  incCounter,
  setGauge,
  observeHistogram,
  renderMetrics,
  listRegisteredMetrics,
  _resetForTests,
} from '../src/prometheus-exporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DASHBOARD_PATH = path.join(REPO_ROOT, 'dashboards', 'kolm-runtime.json');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'observability', 'prometheus.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

// Each test gets a fresh data dir + a wiped exporter registry so cross-test
// state cannot poison the renderer. _resetForTests() restores the canonical
// pre-registered metrics so callers don't have to re-register them.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w730-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Clean the metrics bearer between tests so #7 sees public mode and #8/#9
  // see explicit gated mode under deterministic conditions.
  delete process.env.KOLM_METRICS_BEARER;
  _resetForTests();
  return tmp;
}

// =============================================================================
// 1) Version stamp
// =============================================================================

test('W730 #1 — PROMETHEUS_EXPORTER_VERSION is "w730-v1"', () => {
  freshDir();
  assert.equal(PROMETHEUS_EXPORTER_VERSION, 'w730-v1',
    `expected version 'w730-v1'; got ${JSON.stringify(PROMETHEUS_EXPORTER_VERSION)}`);
});

// =============================================================================
// 2) Public surface exports
// =============================================================================

test('W730 #2 — registerMetric / incCounter / setGauge / observeHistogram exported as functions', () => {
  freshDir();
  for (const [name, fn] of [
    ['registerMetric', registerMetric],
    ['incCounter', incCounter],
    ['setGauge', setGauge],
    ['observeHistogram', observeHistogram],
    ['renderMetrics', renderMetrics],
    ['listRegisteredMetrics', listRegisteredMetrics],
    ['_resetForTests', _resetForTests],
  ]) {
    assert.equal(typeof fn, 'function', `expected ${name} to be a function; got ${typeof fn}`);
  }
});

// =============================================================================
// 3) renderMetrics produces Prometheus text format
// =============================================================================

test('W730 #3 — renderMetrics emits # HELP + # TYPE lines for canonical metrics', () => {
  freshDir();
  const out = renderMetrics();
  assert.equal(typeof out, 'string', `renderMetrics must return string; got ${typeof out}`);
  // HELP/TYPE lines are load-bearing — every Prometheus scraper relies on
  // them. The exact metric name is also load-bearing for the dashboard.
  assert.ok(/^# HELP /m.test(out),
    `output must contain a "# HELP" line; got first 400 chars: ${out.slice(0, 400)}`);
  assert.ok(/^# TYPE /m.test(out),
    `output must contain a "# TYPE" line; got first 400 chars: ${out.slice(0, 400)}`);
  // Canonical metric names must be pre-registered at module load.
  for (const name of [
    'kolm_capture_total',
    'kolm_load_queue_depth',
    'kolm_runtime_gpu_memory_bytes',
    'kolm_runtime_kernel_selected_total',
    'kolm_accelerate_acceptance_rate',
    'kolm_http_request_duration_seconds',
  ]) {
    assert.ok(out.includes(`# HELP ${name} `),
      `expected HELP line for "${name}" in renderMetrics output`);
    assert.ok(out.includes(`# TYPE ${name} `),
      `expected TYPE line for "${name}" in renderMetrics output`);
  }
});

// =============================================================================
// 4) Counter increment surfaces as a sample row with the right labels
// =============================================================================

test('W730 #4 — incCounter produces a sample row with sorted label key=value pairs', () => {
  freshDir();
  incCounter('kolm_capture_total', { tenant: 'tenant_abc', namespace: 'ns1' }, 3);
  incCounter('kolm_capture_total', { tenant: 'tenant_abc', namespace: 'ns1' }, 2);
  const out = renderMetrics();
  // Labels are sorted alphabetically (namespace before tenant). Sample
  // value is the sum of both increments (5).
  assert.ok(/^kolm_capture_total\{namespace="ns1",tenant="tenant_abc"\}\s+5$/m.test(out),
    `expected counter row "kolm_capture_total{namespace=ns1,tenant=tenant_abc} 5"; got:\n${out}`);
});

// =============================================================================
// 5) Gauge set surfaces as a sample row with the right value
// =============================================================================

test('W730 #5 — setGauge overwrites previous value and emits a sample row', () => {
  freshDir();
  setGauge('kolm_load_queue_depth', {}, 0);
  setGauge('kolm_load_queue_depth', {}, 42);
  const out = renderMetrics();
  // No labels → no curly braces. Latest set wins.
  assert.ok(/^kolm_load_queue_depth\s+42$/m.test(out),
    `expected gauge row "kolm_load_queue_depth 42"; got:\n${out}`);
});

// =============================================================================
// 6) Histogram observe surfaces _bucket / _sum / _count lines
// =============================================================================

test('W730 #6 — observeHistogram emits _bucket (incl +Inf), _sum, _count lines', () => {
  freshDir();
  observeHistogram('kolm_accelerate_acceptance_rate', { task_class: 'rag' }, 0.7);
  observeHistogram('kolm_accelerate_acceptance_rate', { task_class: 'rag' }, 0.9);
  const out = renderMetrics();
  // Per-bucket samples have a `le="<upper>"` label.
  assert.ok(/kolm_accelerate_acceptance_rate_bucket\{le="\+Inf",task_class="rag"\}\s+2/.test(out),
    `expected +Inf bucket row with count 2; got:\n${out}`);
  // _sum (total observed) and _count (number of observations).
  assert.ok(/kolm_accelerate_acceptance_rate_sum\{task_class="rag"\}\s+1\.6/.test(out),
    `expected _sum row of 1.6; got:\n${out}`);
  assert.ok(/kolm_accelerate_acceptance_rate_count\{task_class="rag"\}\s+2/.test(out),
    `expected _count row of 2; got:\n${out}`);
  // At least one finite-le bucket row must appear too.
  assert.ok(/kolm_accelerate_acceptance_rate_bucket\{le="0\.\d+",task_class="rag"\}\s+\d+/.test(out),
    `expected at least one finite-le bucket row; got:\n${out}`);
});

// =============================================================================
// 7) GET /metrics returns 200 with text/plain content-type
// =============================================================================

test('W730 #7 — GET /metrics returns 200 with text/plain Prometheus content-type', async () => {
  freshDir();
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';

  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200, `expected 200; got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.ok(/text\/plain/.test(ct),
      `content-type must be text/plain; got "${ct}"`);
    assert.ok(/version=0\.0\.4/.test(ct),
      `content-type must include version=0.0.4; got "${ct}"`);
    const body = await res.text();
    assert.ok(/^# HELP /m.test(body),
      `body must include "# HELP" line; got first 400 chars: ${body.slice(0, 400)}`);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 8) KOLM_METRICS_BEARER set + no header → 401 invalid_metrics_bearer
// =============================================================================

test('W730 #8 — KOLM_METRICS_BEARER set + missing header → 401 with invalid_metrics_bearer envelope', async () => {
  freshDir();
  process.env.KOLM_PRODUCTION = '1';
  process.env.KOLM_METRICS_BEARER = 'w730-test-bearer-' + crypto.randomBytes(6).toString('hex');
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 401, `expected 401 with no header; got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    assert.equal(body.ok, false, `envelope must report ok:false; got ${JSON.stringify(body)}`);
    assert.equal(body.error, 'invalid_metrics_bearer',
      `envelope error must be "invalid_metrics_bearer"; got ${JSON.stringify(body.error)}`);
  } finally {
    await new Promise(r => srv.close(r));
    delete process.env.KOLM_METRICS_BEARER;
  }
});

// =============================================================================
// 9) KOLM_METRICS_BEARER set + correct header → 200
// =============================================================================

test('W730 #9 — KOLM_METRICS_BEARER set + correct Authorization header → 200 with metrics body', async () => {
  freshDir();
  process.env.KOLM_PRODUCTION = '1';
  const bearer = 'w730-test-bearer-' + crypto.randomBytes(6).toString('hex');
  process.env.KOLM_METRICS_BEARER = bearer;
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    assert.equal(res.status, 200, `expected 200 with matching bearer; got ${res.status}`);
    const body = await res.text();
    assert.ok(/^# HELP /m.test(body),
      `body must include "# HELP" line; got first 400 chars: ${body.slice(0, 400)}`);
  } finally {
    await new Promise(r => srv.close(r));
    delete process.env.KOLM_METRICS_BEARER;
  }
});

// =============================================================================
// 10) dashboards/kolm-runtime.json exists and parses
// =============================================================================

test('W730 #10 — dashboards/kolm-runtime.json exists and JSON.parse() succeeds', () => {
  freshDir();
  assert.ok(fs.existsSync(DASHBOARD_PATH),
    `expected dashboard file at ${DASHBOARD_PATH}`);
  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    assert.fail(`dashboard JSON must be valid; got parse error: ${e.message}`);
  }
  assert.equal(typeof parsed, 'object', 'dashboard must parse to an object');
  assert.equal(parsed.schemaVersion, 38,
    `expected Grafana 10 schemaVersion 38; got ${parsed.schemaVersion}`);
  // Templating MUST be an empty list to keep the dashboard portable across
  // Prometheus deployments without manual var setup.
  assert.deepEqual(parsed.templating, { list: [] },
    `templating.list must be empty array; got ${JSON.stringify(parsed.templating)}`);
});

// =============================================================================
// 11) dashboard has all six panels with the named PromQL expressions
// =============================================================================

test('W730 #11 — dashboard has six panels covering the canonical metrics', () => {
  freshDir();
  const parsed = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  assert.ok(Array.isArray(parsed.panels),
    `panels must be an array; got ${typeof parsed.panels}`);
  assert.equal(parsed.panels.length, 6,
    `expected 6 panels; got ${parsed.panels.length}`);
  // Each panel must have a title + at least one target with an `expr`.
  for (const p of parsed.panels) {
    assert.equal(typeof p.title, 'string', `panel.title must be a string; got ${typeof p.title} on panel id ${p.id}`);
    assert.ok(Array.isArray(p.targets) && p.targets.length >= 1,
      `panel "${p.title}" must have >=1 target`);
    for (const t of p.targets) {
      assert.equal(typeof t.expr, 'string',
        `target on panel "${p.title}" must have an "expr" string`);
    }
  }
  // Concatenate every PromQL expression and check that all six canonical
  // metric families appear at least once. Threshold-based regex so panel
  // re-ordering or wording tweaks don't break this lock-in.
  const allExprs = parsed.panels.flatMap(p => p.targets.map(t => t.expr)).join('\n');
  for (const needle of [
    'kolm_capture_total',
    'kolm_load_queue_depth',
    'kolm_runtime_gpu_memory_bytes',
    'kolm_runtime_kernel_selected_total',
    'kolm_accelerate_acceptance_rate_bucket',
    'kolm_http_request_duration_seconds_bucket',
  ]) {
    assert.ok(allExprs.includes(needle),
      `dashboard PromQL must reference "${needle}"; got combined exprs:\n${allExprs}`);
  }
});

// =============================================================================
// 12) public/docs/observability/prometheus.html exists with brand-lock content
// =============================================================================

test('W730 #12 — /docs/observability/prometheus.html exists with brand-lock content', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock matches the W724 memory-tiers.html shell: ks-nav + ks-footer.
  for (const needle of [
    'kolm.ai',          // brand
    'class="ks-nav"',   // nav shell
    'ks-footer',        // footer shell
    '/metrics',         // the endpoint we document
    'Prometheus',       // topic word
    'Grafana',          // topic word
    'kolm_capture_total', // canonical metric name
  ]) {
    assert.ok(html.includes(needle),
      `prometheus.html must mention "${needle}"`);
  }
});

// =============================================================================
// 13) CLI cmdW730Metrics dispatcher present + uniquely named
// =============================================================================

test('W730 #13 — cli/kolm.js defines cmdW730Metrics dispatcher exactly once', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729 precedent so parallel
  // wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW730Metrics\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW730Metrics dispatcher definition; got ${defs.length}`);
  // Must also be wired from at least one routing site (either dispatchRepl
  // or main()'s switch).
  assert.ok(cli.includes('cmdW730Metrics(rest)'),
    `cmdW730Metrics must be routed from the CLI dispatcher`);
});

// =============================================================================
// 14) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W730 #14 — wave730 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  // Walk the tests directory and count files matching wave(\d{3,4}). The
  // W604 anti-brittleness directive FORBIDS explicit-array family checks.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W730 itself +
  // siblings like W724/W726). Threshold is forward-compat: adding more
  // wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 15) _resetForTests wipes samples but keeps canonical metrics registered
// =============================================================================

test('W730 #15 — _resetForTests wipes user samples but re-pre-registers canonical metrics', () => {
  freshDir();
  incCounter('kolm_capture_total', { tenant: 't1', namespace: 'n1' }, 10);
  let before = renderMetrics();
  assert.ok(/^kolm_capture_total\{namespace="n1",tenant="t1"\}\s+10$/m.test(before),
    `pre-reset render must include the incremented row; got:\n${before}`);
  _resetForTests();
  const after = renderMetrics();
  // The HELP+TYPE block survives (canonical metric re-registered) but the
  // tenant-labeled sample row is gone.
  assert.ok(after.includes('# HELP kolm_capture_total '),
    `post-reset render must still include canonical HELP line`);
  assert.ok(!/^kolm_capture_total\{namespace="n1",tenant="t1"\}/m.test(after),
    `post-reset render must NOT include the pre-reset sample row; got:\n${after}`);
  // listRegisteredMetrics confirms canonical metrics survive the reset.
  const list = listRegisteredMetrics();
  const names = list.map(m => m.name);
  assert.ok(names.includes('kolm_capture_total'),
    `canonical metric "kolm_capture_total" must remain registered after reset`);
  assert.ok(names.includes('kolm_http_request_duration_seconds'),
    `canonical metric "kolm_http_request_duration_seconds" must remain registered after reset`);
});
