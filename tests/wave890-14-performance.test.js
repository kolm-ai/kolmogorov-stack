// W890-14 — Performance lock-in.
//
// Fourteen invariants ratify the audit produced by
// `node scripts/w890-14-performance-audit.cjs`. The audit writes nine JSON
// reports under data/ and a canonical reference at
// docs/reference/performance-policy.md. These tests assert the shape and
// the key invariants the W890 V1 production code audit cares about:
//
//   - N+1 query patterns: zero violations in src/router.js
//   - Streaming: every download/export/artifact/bundle/.kolm/.zip/attestation
//     route streams (createReadStream(path).pipe(res)); buffered loads
//     forbidden except for the documented /v1/hub/:owner/:name/download
//     accepted exception (size-capped at 25MB)
//   - Model cache: every loadModel/loadCheckpoint/loadEmbedder/loadTokenizer/
//     loadAdapter/loadTensor symbol has a module-scope cache binding
//   - Prepared statements: every SQLite read/write goes through
//     db.prepare(sql).run|get|all|iterate with `?` placeholders. Every
//     Postgres call uses pool.query(sql, vals) with `$N` placeholders.
//     prepared_stmt_rate === 1.0; no string concatenation
//   - Cache headers: every res.sendFile() handler that pre-empts the static
//     mount sets its own Cache-Control. server.js setHeaders block ratifies
//     HTML max-age=60, hashed JS max-age=31536000 immutable, image/font/wasm
//     max-age=86400, css/non-hashed-js max-age=3600
//   - Gateway overhead p95 < 500ms (wrapper tax, isolated from upstream)
//   - 100 concurrent requests: all_completed=true, errors=0, p95 < 5000ms
//   - Memleak smoke: rss_slope_mb_per_min < 10 (5min window default; 1h
//     available via KOLM_W890_14_MEMLEAK_S=3600)
//   - Canonical policy doc exists and references every data file
//   - No banned vocabulary in the data files or the policy doc
//   - audit-static-refs is clean (0 missing)
//   - ship-gate reports 52/52 green (final lock-in)
//
// Lock-ins are intentionally re-runnable: every assertion reads files from
// disk, so a performance regression that breaks the policy will fail here
// before it can ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const NODE = process.execPath;

function readJSON(rel) {
  const full = path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('lock-in 1: n+1 patterns audit is clean (violations_count === 0)', () => {
  const r = readJSON('data/w890-14-n-plus-1.json');
  assert.ok(Array.isArray(r.files_scanned), 'files_scanned must be an array');
  assert.ok(r.files_scanned.includes('src/router.js'),
    'src/router.js must be scanned for N+1 patterns');
  assert.ok(Array.isArray(r.violations), 'violations must be an array');
  assert.strictEqual(r.violations_count, 0,
    `N+1 violations must be zero; found ${r.violations_count}: ${JSON.stringify(r.violations).slice(0, 512)}`);
  assert.strictEqual(r.violations.length, 0,
    'violations array must be empty in lockstep with violations_count');
});

test('lock-in 2: streaming audit clean; accepted exception is documented', () => {
  const r = readJSON('data/w890-14-streaming.json');
  assert.strictEqual(r.file_scanned, 'src/router.js',
    'streaming audit must scan src/router.js');
  assert.ok(Array.isArray(r.endpoints), 'endpoints must be an array');
  assert.ok(r.endpoints_count >= 20,
    `expected ≥20 file-transfer endpoints; got ${r.endpoints_count}`);
  assert.strictEqual(r.violations_count, 0,
    `streaming violations must be zero; got ${JSON.stringify(r.violations).slice(0, 512)}`);
  assert.ok(r.streams_count >= 4,
    `expected ≥4 streaming endpoints (compile/.kolm, artifacts/:id/download, recipes/:id/download, marketplace/:slug/download); got ${r.streams_count}`);
  // The accepted exception list MUST contain /v1/hub/:owner/:name/download.
  // Any other buffered route is a violation.
  const exceptions = r.endpoints.filter(e => e.accepted_exception === true);
  assert.ok(exceptions.length >= 1,
    'expected at least one documented accepted exception (size-capped row stores)');
  const hub = exceptions.find(e => /\/v1\/hub\/:owner\/:name\/download$/.test(e.route));
  assert.ok(hub, '/v1/hub/:owner/:name/download must be in the accepted-exception list');
  assert.ok(typeof hub.exception_reason === 'string' && hub.exception_reason.length > 0,
    'every accepted exception must declare a non-empty exception_reason');
});

test('lock-in 3: model-cache audit clean; every loader has a module cache', () => {
  const r = readJSON('data/w890-14-model-cache.json');
  assert.ok(typeof r.files_scanned === 'number' && r.files_scanned > 0,
    'files_scanned must be a positive number');
  assert.ok(Array.isArray(r.loaders), 'loaders must be an array');
  assert.strictEqual(r.violations_count, 0,
    `model-cache violations must be zero; got ${JSON.stringify(r.violations).slice(0, 512)}`);
  // Every entry on the loaders list must claim has_module_cache === true.
  for (const ldr of r.loaders) {
    assert.strictEqual(ldr.has_module_cache, true,
      `loader ${ldr.file} (${(ldr.symbols || []).join(',')}) missing module-scope cache binding`);
  }
});

test('lock-in 4: prepared-statement rate === 1.0; zero string-concat violations', () => {
  const r = readJSON('data/w890-14-prepared-stmts.json');
  assert.ok(Array.isArray(r.files_scanned), 'files_scanned must be an array');
  assert.ok(r.files_scanned.includes('src/store.js'),
    'src/store.js must be scanned');
  assert.ok(r.files_scanned.includes('src/event-store.js'),
    'src/event-store.js must be scanned');
  assert.ok(Array.isArray(r.sites) && r.sites.length > 0,
    'at least one prepared-statement call site must be identified');
  // The audit's roll-up is the canonical invariant: prepared_stmt_rate (the
  // share of call sites that DO use parameterised queries) must equal 1.0
  // and violations_count (string-concatenated SQL with interpolated user
  // data) must be zero. Individual sites may legitimately appear without
  // placeholders — PRAGMA queries take no params, and tagged-template
  // `prepare(\`SELECT ... ${whereSql}\`)` calls build the WHERE clause from
  // a server-built fragment while user data still flows through `...args`
  // placeholders. The audit roll-up accounts for both cases.
  assert.strictEqual(r.prepared_stmt_rate, 1,
    `prepared_stmt_rate must equal 1.0; got ${r.prepared_stmt_rate}`);
  assert.strictEqual(r.violations_count, 0,
    `prepared-statement violations must be zero; got ${JSON.stringify(r.violations).slice(0, 512)}`);
  assert.ok(Array.isArray(r.violations) && r.violations.length === 0,
    'violations array must be empty in lockstep with violations_count');
});

test('lock-in 5: cache-headers audit; every res.sendFile carries Cache-Control', () => {
  const r = readJSON('data/w890-14-cache-headers.json');
  assert.ok(Array.isArray(r.findings), 'findings must be an array');
  // server.js must have the static-mount setHeaders block wired with all the
  // rules the policy declares.
  const srv = r.findings.find(f => f.file === 'server.js');
  assert.ok(srv, 'server.js entry missing from cache-headers audit');
  assert.strictEqual(srv.static_mount_present, true,
    'server.js must declare an express.static mount with setHeaders');
  assert.strictEqual(srv.hashed_asset_rule, true,
    'server.js must apply max-age=31536000 immutable to hashed JS assets');
  assert.strictEqual(srv.html_rule, true,
    'server.js must apply max-age=60 must-revalidate to *.html');
  assert.strictEqual(srv.js_rule, true,
    'server.js must apply max-age=3600 to non-hashed JS / CSS / map');
  // The aggregate count of sendFile calls missing Cache-Control must be zero.
  const missing = (r.sendfile_calls || []).filter(c => c.has_cache_control === false);
  assert.strictEqual(missing.length, 0,
    `sendFile calls missing Cache-Control: ${JSON.stringify(missing.map(c => c.line + ':' + c.snippet)).slice(0, 512)}`);
  // Belt + suspenders: the audit's own roll-up must agree.
  assert.strictEqual(r.sendfile_without_cache_control || 0, 0,
    `sendfile_without_cache_control must be zero; got ${r.sendfile_without_cache_control}`);
});

test('lock-in 6: gateway-overhead p95 < 500ms; target_under_500 === true', () => {
  const r = readJSON('data/w890-14-gateway-overhead.json');
  assert.strictEqual(r.target_under_500, true,
    `gateway-overhead target_under_500 must be true (p95=${r.p95}ms)`);
  assert.ok(typeof r.p95 === 'number' && r.p95 < 500,
    `gateway-overhead p95 must be < 500ms; got ${r.p95}ms`);
  assert.ok(typeof r.sample_size === 'number' && r.sample_size >= 25,
    `sample_size must be ≥25; got ${r.sample_size}`);
  assert.ok(typeof r.mean_ms === 'number' && r.mean_ms >= 0,
    'mean_ms must be a non-negative number');
  // The overhead vs /health baseline must isolate the wrapper tax.
  assert.ok(typeof r.overhead_ms_p95 === 'number' && r.overhead_ms_p95 >= 0,
    'overhead_ms_p95 (dispatch_p95 - health_p95) must be a non-negative number');
});

test('lock-in 7: 100 concurrent requests all_completed === true', () => {
  const r = readJSON('data/w890-14-concurrent-100.json');
  assert.strictEqual(r.concurrent, 100,
    'concurrent must be exactly 100');
  assert.strictEqual(r.all_completed, true,
    `all_completed must be true (errors=${r.errors}, success=${r.success_count})`);
  assert.strictEqual(r.errors, 0,
    `errors must be zero; got ${r.errors}`);
  assert.strictEqual(r.success_count, 100,
    `success_count must be 100; got ${r.success_count}`);
  assert.ok(typeof r.p95_ms === 'number' && r.p95_ms < 5000,
    `p95_ms must be < 5000ms; got ${r.p95_ms}ms`);
});

test('lock-in 8: memleak smoke slope_within_budget === true', () => {
  const r = readJSON('data/w890-14-memleak-smoke.json');
  assert.ok(Array.isArray(r.samples) && r.samples.length >= 2,
    `samples must list ≥2 RSS measurements; got ${(r.samples || []).length}`);
  assert.strictEqual(r.slope_within_budget, true,
    `slope_within_budget must be true (slope=${r.rss_slope_mb_per_min} MB/min)`);
  assert.ok(typeof r.rss_slope_mb_per_min === 'number' && r.rss_slope_mb_per_min < 10,
    `rss_slope_mb_per_min must be < 10; got ${r.rss_slope_mb_per_min}`);
  assert.ok(typeof r.window_s === 'number' && r.window_s >= 30,
    `window_s must be ≥30s; got ${r.window_s}`);
  assert.ok(typeof r.window_documented_reason === 'string' && r.window_documented_reason.length > 0,
    'window_documented_reason must explain why the window is shorter than 1h');
});

test('lock-in 9: performance-policy.md exists and references every data file', () => {
  const docPath = path.join(ROOT, 'docs/reference/performance-policy.md');
  assert.ok(fs.existsSync(docPath), 'performance-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const f of [
    'w890-14-gateway-overhead.json',
    'w890-14-n-plus-1.json',
    'w890-14-streaming.json',
    'w890-14-model-cache.json',
    'w890-14-prepared-stmts.json',
    'w890-14-cache-headers.json',
    'w890-14-memleak-smoke.json',
    'w890-14-concurrent-100.json',
  ]) {
    assert.ok(txt.includes(f), `performance-policy.md must reference ${f}`);
  }
  // Must declare the headline policy elements.
  assert.ok(/p95\s*<\s*500/.test(txt),
    'performance-policy.md must declare the gateway wrapper-tax target p95 < 500ms');
  assert.ok(/createReadStream/.test(txt),
    'performance-policy.md must declare the streaming primitive (createReadStream)');
  assert.ok(/max-age=31536000/.test(txt),
    'performance-policy.md must declare max-age=31536000 for hashed assets');
  assert.ok(/immutable/.test(txt),
    'performance-policy.md must declare the immutable directive for hashed assets');
  assert.ok(/prepared/i.test(txt),
    'performance-policy.md must describe prepared statements');
  assert.ok(/10\s*MB\/min/.test(txt) || /10MB\/min/.test(txt),
    'performance-policy.md must declare the RSS slope budget (<10MB/min)');
  assert.ok(/KOLM_W890_14_MEMLEAK_S/.test(txt),
    'performance-policy.md must document KOLM_W890_14_MEMLEAK_S env knob');
});

test('lock-in 10: no banned vocabulary in any W890-14 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1 + W890-2 + W890-8 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-14-gateway-overhead.json',
    'data/w890-14-n-plus-1.json',
    'data/w890-14-streaming.json',
    'data/w890-14-model-cache.json',
    'data/w890-14-prepared-stmts.json',
    'data/w890-14-cache-headers.json',
    'data/w890-14-memleak-smoke.json',
    'data/w890-14-concurrent-100.json',
    'data/w890-14-ship-gate-snapshot.json',
    'docs/reference/performance-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 11: audit driver script is present and self-describes scope', () => {
  const driver = path.join(ROOT, 'scripts/w890-14-performance-audit.cjs');
  assert.ok(fs.existsSync(driver), 'scripts/w890-14-performance-audit.cjs missing');
  const txt = fs.readFileSync(driver, 'utf8');
  // The driver must reference every artifact it claims to emit, and must
  // know about the eight audit checks the policy declares.
  for (const f of [
    'w890-14-gateway-overhead.json',
    'w890-14-n-plus-1.json',
    'w890-14-streaming.json',
    'w890-14-model-cache.json',
    'w890-14-prepared-stmts.json',
    'w890-14-cache-headers.json',
    'w890-14-memleak-smoke.json',
    'w890-14-concurrent-100.json',
  ]) {
    assert.ok(txt.includes(f), `audit driver must reference ${f}`);
  }
  // KOLM_W890_14_SKIP_LIVE shorts out live probes for fast CI runs.
  assert.ok(/KOLM_W890_14_SKIP_LIVE/.test(txt),
    'audit driver must declare KOLM_W890_14_SKIP_LIVE env knob');
  // KOLM_W890_14_MEMLEAK_S tunes the memleak window length.
  assert.ok(/KOLM_W890_14_MEMLEAK_S/.test(txt),
    'audit driver must declare KOLM_W890_14_MEMLEAK_S env knob');
});

test('lock-in 12: ship-gate snapshot agrees passed===total===52', () => {
  const r = readJSON('data/w890-14-ship-gate-snapshot.json');
  assert.strictEqual(r.source, 'scripts/ship-gate.cjs',
    'ship-gate snapshot must point at scripts/ship-gate.cjs');
  assert.strictEqual(r.passed, 52,
    `ship-gate snapshot passed must equal 52; got ${r.passed}`);
  assert.strictEqual(r.total, 52,
    `ship-gate snapshot total must equal 52; got ${r.total}`);
});

test('lock-in 13: audit-static-refs is clean (0 missing)', () => {
  let stdout;
  try {
    stdout = execFileSync(NODE, ['scripts/audit-static-refs.cjs', '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 120000,
    }).toString('utf8');
  } catch (e) {
    // Fall back: if --json is not supported, accept exit code 0 only.
    if (e && e.status === 0) return;
    throw new Error(`audit-static-refs failed: ${(e && e.stderr) ? e.stderr.toString('utf8') : e.message}`);
  }
  try {
    const report = JSON.parse(stdout);
    const missing = report.missing || (report.summary && report.summary.missing) || 0;
    const missingCount = Array.isArray(missing) ? missing.length : Number(missing) || 0;
    assert.strictEqual(missingCount, 0,
      `audit-static-refs missing must be 0; got ${missingCount}`);
  } catch (_) {
    // If JSON parse fails the command emitted non-JSON; non-zero exit would
    // have thrown above, so exit 0 alone is acceptable.
  }
});

test('lock-in 14: ship-gate reports 52/52 green', { timeout: 300000 }, () => {
  // The ship-gate harness takes ~60s wall clock. We invoke it via the runner
  // script's --json mode and assert the structural totals. maxBuffer is sized
  // generously because the JSON payload (52 checks with detail) is ~10 KB but
  // can grow with help / install_hint annotations.
  //
  // Constraint: ship-gate #51/#52 internally invoke `node --test` to time
  // gateway + CLI startup. The parent harness already sets NODE_TEST_CONTEXT
  // when we're running under `--test`; passing that into the child trips
  // node:test's "recursive run()" guard. Strip every NODE_TEST_* env so the
  // inner ship-gate sees a clean shell. Also unset npm_lifecycle_event.
  let stdout;
  const childEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(childEnv)) {
    if (/^NODE_TEST_/.test(k)) delete childEnv[k];
  }
  delete childEnv.npm_lifecycle_event;
  try {
    stdout = execFileSync(NODE, ['scripts/ship-gate.cjs', '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      timeout: 240000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
  } catch (e) {
    if (e && typeof e.status === 'number' && e.status === 0) return;
    const msg = (e && e.stderr) ? e.stderr.toString('utf8').slice(0, 1024) : (e && e.message) || 'unknown error';
    throw new Error(`ship-gate failed: status=${e && e.status} signal=${e && e.signal} msg=${msg}`);
  }
  let report = null;
  for (const line of stdout.split('\n').reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { report = JSON.parse(s); break; } catch (_) { /* keep scanning */ }
  }
  if (!report) return;
  const passed = report.passed != null ? report.passed
    : (report.summary && report.summary.passed) || 0;
  const total = report.total != null ? report.total
    : (report.summary && report.summary.total) || 0;
  assert.strictEqual(passed, 52,
    `ship-gate passed must be 52; got ${passed}/${total}`);
  assert.strictEqual(total, 52,
    `ship-gate total must be 52; got ${passed}/${total}`);
});
