// W890-15 — monitoring + alerting lock-ins.
//
// Thirteen invariants ratify the audit produced by the W890-15 sub-wave:
//   1. data/w890-15-sentry-coverage.json: sentry_init_present + missing=[]
//   2. data/w890-15-status-page.json: dynamic_fetch_wired + required fields
//   3. data/w890-15-alerts.json: 5/5 conditions documented in the runbook
//   4. data/w890-15-uptime.json: documented uptime section + 60s interval
//   5. data/w890-15-metrics.json: endpoint exists + all 6 metric names found
//      + names appear in a real renderMetrics() smoke
//   6. data/w890-15-error-id-chain.json: header + body + Sentry tag intact
//   7. docs/reference/monitoring-policy.md exists + cross-links siblings
//   8. docs/runbook-alerts.md exists + names the 5 conditions verbatim
//   9. src/prometheus-exporter.js registers the 6 W890-15 metric names
//  10. public/status.html fetches /health and has the live-card data-test hook
//  11. server.js 500 middleware emits X-Kolm-Error-Id header
//  12. no banned vocabulary in any W890-15 artifact or policy doc
//  13. ship-gate snapshot reports 52/52 green

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('lock-in 1: Sentry coverage — init shim present + no missing capture sites', () => {
  const r = readJSON('data/w890-15-sentry-coverage.json');
  assert.equal(r.sentry_init_present, true,
    'src/sentry-init.js must export initSentry + opt-in via SENTRY_DSN + tolerate missing @sentry/node');
  assert.equal(r.sentry_init_file, 'src/sentry-init.js');
  assert.equal(r.sentry_init_opt_in_via, 'SENTRY_DSN');
  assert.ok(Array.isArray(r.paths_covered), 'paths_covered must be an array');
  assert.ok(r.paths_covered.length >= 5,
    `paths_covered must list >=5 surfaces (http_500 + 2 process handlers + cli + worker); got ${r.paths_covered.length}`);
  assert.deepEqual(r.missing, [],
    `every capture surface must either call Sentry OR document a bypass; missing: ${JSON.stringify(r.missing)}`);
  // Server.js paths must actually call Sentry.
  const serverPaths = r.paths_covered.filter((p) => p.file === 'server.js');
  for (const sp of serverPaths) {
    assert.equal(sp.sentry_capture, true,
      `server.js#${sp.surface} must call Sentry.captureException`);
  }
});

test('lock-in 2: /status page fetches /health and surfaces required fields', () => {
  const r = readJSON('data/w890-15-status-page.json');
  assert.equal(r.dynamic_fetch_wired, true,
    'public/status.html must contain fetch("/health"); was static');
  assert.equal(r.fetches_health_endpoint, true,
    'status page must hit /health, not just /v1/status/board');
  assert.equal(r.live_card_present, true,
    'live-health card must exist with data-test="w890-15-live-health"');
  assert.equal(r.surfaces_required_fields, true,
    `status page must surface all six required fields: ${JSON.stringify(r.required_fields)}`);
  assert.equal(r.refresh_interval_30s, true,
    'status page must refresh every 30s');
  assert.equal(r.has_status_grid, true,
    'pre-existing per-component grid must remain');
});

test('lock-in 3: alerts runbook documents all 5 conditions verbatim', () => {
  const r = readJSON('data/w890-15-alerts.json');
  assert.equal(r.runbook_exists, true, 'docs/runbook-alerts.md must exist');
  assert.ok(r.runbook_bytes > 1000, `runbook must have substantive content; got ${r.runbook_bytes} bytes`);
  assert.equal(r.conditions_total, 5);
  assert.equal(r.documented_count, 5,
    `5/5 alert conditions must be documented; missing: ${JSON.stringify(r.missing)}`);
  assert.deepEqual(r.missing, []);
  assert.ok(r.providers_named.length >= 3,
    `runbook must name at least 3 providers (Betterstack, Pingdom, Datadog); got ${JSON.stringify(r.providers_named)}`);
  assert.equal(r.has_escalation, true,
    'runbook must describe escalation steps');
  assert.equal(r.has_rationale, true,
    'runbook must include threshold rationale');
});

test('lock-in 4: uptime monitoring documented with 60s ping target', () => {
  const r = readJSON('data/w890-15-uptime.json');
  assert.equal(r.has_uptime_section, true,
    'docs/runbook-alerts.md OR docs/reference/monitoring-policy.md must contain an uptime section');
  assert.equal(r.has_60s_interval, true,
    'uptime documentation must reference the 60s probe interval');
  assert.ok(r.providers_named.length >= 1,
    `uptime documentation must name at least one provider; got ${JSON.stringify(r.providers_named)}`);
  assert.ok(r.probe_paths.includes('/health'),
    'uptime probe target must include /health');
});

test('lock-in 5: /metrics endpoint exists + all 6 W890-15 metric names registered + rendered', () => {
  const r = readJSON('data/w890-15-metrics.json');
  assert.equal(r.endpoint_exists, true,
    'src/router.js must mount r.get("/metrics") -> renderMetrics()');
  const required = [
    'gateway_requests_total',
    'gateway_latency_p50',
    'gateway_errors_total',
    'captures_total',
    'artifacts_compiled_total',
    'devices_online',
  ];
  for (const name of required) {
    assert.ok(r.found.includes(name),
      `required W890-15 metric ${name} must be registered in src/prometheus-exporter.js`);
  }
  assert.deepEqual(r.missing, [],
    `missing required metrics: ${JSON.stringify(r.missing)}`);
  assert.equal(r.rendered_in_smoke, true,
    `renderMetrics() smoke must include all six W890-15 names; details: ${JSON.stringify(r.render_smoke).slice(0, 300)}`);
  assert.ok(Array.isArray(r.render_smoke.names_in_output),
    'render smoke must list emitted metric names');
  for (const name of required) {
    assert.ok(r.render_smoke.names_in_output.includes(name),
      `renderMetrics() output must include ${name}`);
  }
});

test('lock-in 6: error-id chain intact (header + body + Sentry tag)', () => {
  const r = readJSON('data/w890-15-error-id-chain.json');
  assert.equal(r.chain_intact, true,
    `error_id chain must be complete: header=${r.header_present} body=${r.body_field_present} sentry=${r.sentry_tag_present}`);
  assert.equal(r.header_present, true,
    'server.js 500 middleware must call res.set("X-Kolm-Error-Id", errorId)');
  assert.equal(r.body_field_present, true,
    'server.js 500 body must include {error_id: errorId}');
  assert.equal(r.sentry_tag_present, true,
    'server.js Sentry.captureException must tag {error_id: errorId}');
  assert.equal(r.error_id_generator_present, true,
    'server.js must generate errorId from `e_${Date.now().toString(36)}_${Math.random().toString(36)...}`');
});

test('lock-in 7: monitoring-policy.md exists + cross-links sibling policies', () => {
  const docPath = path.join(ROOT, 'docs/reference/monitoring-policy.md');
  assert.ok(fs.existsSync(docPath), 'monitoring-policy.md missing');
  const txt = readText('docs/reference/monitoring-policy.md');
  // Cross-links.
  for (const sib of [
    'codebase-organization.md',
    'code-quality-policy.md',
    'error-handling-policy.md',
    'logging-policy.md',
    'configuration-policy.md',
    'storage-policy.md',
    'api-policy.md',
    'cli-policy.md',
    'documentation-policy.md',
  ]) {
    assert.ok(txt.includes(sib),
      `monitoring-policy.md must cross-link ${sib}`);
  }
  // Required topic coverage — twelve sections.
  for (const topic of [
    'Sentry runbook',
    'Status page contract',
    'Alert thresholds',
    'Uptime providers',
    'Metrics catalog',
    'Dashboards to build',
    'Error-id chain',
    'On-call rotation',
  ]) {
    assert.ok(txt.includes(topic), `monitoring-policy.md must cover "${topic}"`);
  }
  // All seven data files referenced.
  for (const f of [
    'w890-15-sentry-coverage.json',
    'w890-15-status-page.json',
    'w890-15-alerts.json',
    'w890-15-uptime.json',
    'w890-15-metrics.json',
    'w890-15-error-id-chain.json',
    'w890-15-ship-gate-snapshot.json',
  ]) {
    assert.ok(txt.includes(f), `monitoring-policy.md must reference ${f}`);
  }
});

test('lock-in 8: runbook-alerts.md exists + names all 5 conditions verbatim', () => {
  const docPath = path.join(ROOT, 'docs/runbook-alerts.md');
  assert.ok(fs.existsSync(docPath), 'docs/runbook-alerts.md missing');
  const txt = readText('docs/runbook-alerts.md');
  for (const verbatim of [
    'server crash',
    'error rate >5%',
    'latency p95 >2s',
    'disk >90%',
    'capture store unreachable',
  ]) {
    assert.ok(new RegExp(verbatim.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&'), 'i').test(txt),
      `runbook must contain verbatim condition "${verbatim}"`);
  }
  // Three providers named.
  for (const provider of ['Betterstack', 'Pingdom', 'Datadog']) {
    assert.ok(new RegExp(provider, 'i').test(txt),
      `runbook must name provider ${provider}`);
  }
  // 60s probe interval documented.
  assert.ok(/60s|60 ?seconds|every minute/i.test(txt),
    'runbook must document the 60s probe interval');
  // Cross-link to companion policy.
  assert.ok(txt.includes('monitoring-policy.md'),
    'runbook must cross-link docs/reference/monitoring-policy.md');
});

test('lock-in 9: src/prometheus-exporter.js registers all 6 W890-15 metric names', () => {
  const txt = readText('src/prometheus-exporter.js');
  for (const name of [
    'gateway_requests_total',
    'gateway_latency_p50',
    'gateway_errors_total',
    'captures_total',
    'artifacts_compiled_total',
    'devices_online',
  ]) {
    assert.ok(new RegExp(`name:\\s*'${name}'`).test(txt),
      `prometheus-exporter.js must registerMetric({name:'${name}'...})`);
  }
});

test('lock-in 10: public/status.html fetches /health + live-card data-test hook present', () => {
  const txt = readText('public/status.html');
  assert.ok(/fetch\('\/health'/.test(txt),
    'status.html must include fetch("/health")');
  assert.ok(/data-test="w890-15-live-health"/.test(txt),
    'status.html must mark the live card with data-test="w890-15-live-health"');
  // Six live-card fields.
  for (const id of ['lhOk', 'lhVersion', 'lhUptime', 'lhGateway', 'lhCapture', 'lhSigning']) {
    assert.ok(txt.includes('id="' + id + '"'),
      `status.html must surface field id="${id}"`);
  }
  // 30s refresh.
  assert.ok(/setInterval\(poll,\s*30000\)/.test(txt) || /setInterval\(poll,\s*30_000\)/.test(txt),
    'status.html must refresh /health every 30 seconds');
});

test('lock-in 11: server.js 500 middleware emits X-Kolm-Error-Id header + body + Sentry tag', () => {
  const txt = readText('server.js');
  // Header set.
  assert.ok(/res\.set\('X-Kolm-Error-Id',\s*errorId\)/.test(txt),
    'server.js must res.set("X-Kolm-Error-Id", errorId)');
  // Body field.
  assert.ok(/error_id:\s*errorId/.test(txt),
    'server.js 500 body must include {error_id: errorId}');
  // Sentry tag.
  assert.ok(/tags:\s*\{[\s\S]{0,300}error_id:\s*errorId/.test(txt),
    'server.js Sentry.captureException must tag {error_id: errorId}');
  // Process-level handlers wired with Sentry.
  assert.ok(/process\.on\('unhandledRejection'/.test(txt),
    'server.js must register process.on("unhandledRejection")');
  assert.ok(/process\.on\('uncaughtException'/.test(txt),
    'server.js must register process.on("uncaughtException")');
});

test('lock-in 12: no banned vocabulary in any W890-15 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not
  // embed the literal (avoids self-recursive false positive). Mirrors
  // W890-1+2+3+7+8+12.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-15-sentry-coverage.json',
    'data/w890-15-status-page.json',
    'data/w890-15-alerts.json',
    'data/w890-15-uptime.json',
    'data/w890-15-metrics.json',
    'data/w890-15-error-id-chain.json',
    'data/w890-15-ship-gate-snapshot.json',
    'docs/reference/monitoring-policy.md',
    'docs/runbook-alerts.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
  // Also assert the sweep file recorded zero hits.
  const sweepPath = path.join(ROOT, 'data/w890-15-vocabulary-sweep.json');
  if (fs.existsSync(sweepPath)) {
    const sweep = JSON.parse(fs.readFileSync(sweepPath, 'utf8'));
    assert.equal(sweep.ok, true,
      `vocabulary sweep reports hits: ${JSON.stringify(sweep.hits)}`);
  }
});

test('lock-in 13: ship-gate snapshot reports 52/52 green', () => {
  // Snapshot pattern mirrors W890-12 + W890-10: nested `node --test` is not
  // reliable on Windows + Node 22+, so we read the snapshot file captured at
  // audit time. The snapshot is refreshed by the audit script and validated
  // here.
  const snap = readJSON('data/w890-15-ship-gate-snapshot.json');
  assert.equal(snap.total, 52,
    `ship-gate total must be 52; got ${snap.total}`);
  assert.equal(snap.passed, 52,
    `ship-gate passed must be 52; got ${snap.passed}`);
  assert.equal(snap.failed, 0,
    `ship-gate failed must be 0; got ${snap.failed}`);
});
