// W935 - platform/monitoring/sampling contract hardening.
//
// Directly covers the remaining low-level helpers in this bucket so the
// master component sheet can prove they have explicit behavioral coverage.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as store from '../src/store.js';
import * as eventStore from '../src/event-store.js';
import { ROUTING_DECISIONS_TABLE } from '../src/routing-events.js';
import { computeSavings } from '../src/autopilot-savings.js';
import {
  CARBON_LIMITS,
  estimateFrontierCallCo2,
  estimateRunCo2,
} from '../src/carbon-estimator.js';
import {
  MONITORING_LIMITS,
  snapshot,
} from '../src/continuous-monitoring.js';
import {
  _resetForTests as resetDriftAlerts,
  registerWebhook,
} from '../src/drift-alert-store.js';
import {
  DRIFT_CONFIG_DEFAULTS,
  DRIFT_CONFIG_PROVIDER,
  getNamespaceConfig,
} from '../src/drift-config.js';
import {
  buildSamplingSpec,
  estimateExtractedFrames,
} from '../src/frame-sampler.js';
import {
  localVllmCall,
  probeReachability,
} from '../src/gateway-mode.js';
import {
  KSCORE_SERIES_LIMITS,
  backfillKScoreSeries,
  getKScoreSeries,
  recordKScore,
} from '../src/kscore-timeseries.js';
import {
  assessLanguageCoverage,
  sampleBalanced,
} from '../src/lang-balanced-sampler.js';
import {
  LANG_DETECT_LIMITS,
  detectLang,
  detectLangSegments,
  langStats,
} from '../src/lang-detect.js';
import {
  LOG_IMPORTER_DEFAULTS,
  importAgentLogs,
} from '../src/log-importer.js';
import {
  getRegionGateways,
  routeRequest,
  testFailover,
} from '../src/multi-region.js';
import {
  PROMETHEUS_LIMITS,
  _resetForTests as resetPrometheus,
  incCounter,
  listRegisteredMetrics,
  registerMetric,
  renderMetrics,
} from '../src/prometheus-exporter.js';
import {
  REGION_SAMPLER_LIMITS,
  sampleForDistillation,
} from '../src/region-aware-sampler.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function uniqueTenant(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

test('W935 autopilot savings, carbon estimates, and monitoring snapshots are bounded and honest', async () => {
  const tenant = uniqueTenant('tenant_w935_savings');
  try {
    const now = new Date().toISOString();
    store.insert(ROUTING_DECISIONS_TABLE, {
      tenant,
      tenant_id: tenant,
      namespace: 'prod',
      route: 'student',
      student_cost_micro_usd: 5,
      teacher_cost_micro_usd: 200,
      ts: now,
    });
    store.insert(ROUTING_DECISIONS_TABLE, {
      tenant,
      tenant_id: tenant,
      namespace: 'prod',
      route: 'teacher',
      student_cost_micro_usd: 0,
      teacher_cost_micro_usd: 300,
      ts: now,
    });
    store.insert(ROUTING_DECISIONS_TABLE, {
      tenant,
      tenant_id: tenant,
      namespace: 'prod',
      route: 'typo-route',
      student_cost_micro_usd: 0,
      teacher_cost_micro_usd: 999,
      ts: now,
    });

    const savings = await computeSavings({ tenant_id: tenant, namespace: 'prod', window_days: 7 });
    assert.equal(savings.ok, true);
    assert.equal(savings.total_saved_micro_usd, 200);
    assert.equal(savings.baseline_micro_usd, 1504);
    assert.equal(savings.breakdown_by_day[0].routes.student, 1);
    assert.equal(savings.breakdown_by_day[0].routes.teacher, 1);
    assert.equal(savings.breakdown_by_day[0].routes.unknown, 1);
  } finally {
    store.remove(ROUTING_DECISIONS_TABLE, (r) => r && (r.tenant === tenant || r.tenant_id === tenant));
  }

  const badRun = estimateRunCo2({ gpu: 'RTX-4090', gpu_hours: CARBON_LIMITS.max_gpu_hours + 1 });
  assert.equal(badRun.ok, false);
  assert.equal(badRun.error, 'invalid_gpu_hours');

  const unknownRun = estimateRunCo2({
    gpu: `mystery\n${'x'.repeat(200)}`,
    region: 'bad\rregion',
    gpu_hours: 1,
  });
  assert.equal(unknownRun.ok, true);
  assert.equal(unknownRun.gpu.length <= CARBON_LIMITS.max_label_chars, true);
  assert.doesNotMatch(unknownRun.gpu + unknownRun.region, /[\r\n]/);

  const badCall = estimateFrontierCallCo2({
    provider: 'openai',
    model_size_class: 'medium',
    tokens: CARBON_LIMITS.max_tokens + 1,
  });
  assert.equal(badCall.ok, false);
  assert.equal(badCall.error, 'invalid_tokens');

  let auditQuery = null;
  const mon = await snapshot('tenant-w935', {
    now: 'not a date',
    eventStore: {
      listEvents: async (query) => {
        auditQuery = query;
        return [{ tenant_id: 'tenant-w935' }, { tenant_id: 'foreign' }];
      },
    },
    signalProviders: {
      audit_log: async () => ({ ok: true, value: 1, status: 'impossible_status' }),
    },
  });
  assert.equal(mon.ok, true);
  assert.doesNotThrow(() => new Date(mon.generated_at).toISOString());
  const auditControl = mon.controls.find((c) => c.source === 'audit_log');
  assert.equal(auditControl.current_value, 1);
  assert.notEqual(auditControl.status, 'impossible_status');

  await snapshot('tenant-w935', {
    eventStore: {
      listEvents: async (query) => {
        auditQuery = query;
        return [{ tenant_id: 'tenant-w935' }, { tenant_id: 'foreign' }];
      },
    },
  });
  assert.equal(auditQuery.limit, MONITORING_LIMITS.max_signal_rows);
});

test('W935 drift, frame sampling, and local gateway helpers redact and normalize risky inputs', async () => {
  const tenant = uniqueTenant('tenant_w935_drift');
  resetDriftAlerts(tenant);
  try {
    const wh = registerWebhook({
      tenant_id: tenant,
      namespace: '__proto__',
      webhook_url: 'https://hooks.example/path?token=ok#fragment',
      jsd_threshold: 0.12,
    });
    assert.equal(wh.namespace, 'default');
    assert.equal(wh.webhook_url, 'https://hooks.example/path?token=ok');
    assert.throws(() => registerWebhook({
      tenant_id: tenant,
      namespace: 'prod',
      webhook_url: 'https://user:pass@hooks.example/path',
    }), /webhook_url/);
  } finally {
    resetDriftAlerts(tenant);
  }

  const cfg = await getNamespaceConfig({
    tenant_id: 'tenant-w935',
    namespace: 'prod',
    opts: {
      storeMod: {
        all: () => [
          {
            tenant_id: 'tenant-w935',
            namespace: 'prod',
            provider: DRIFT_CONFIG_PROVIDER,
            created_at: '2026-01-02T00:00:00.000Z',
            feedback: JSON.stringify({
              kind: 'drift_config_override',
              config: { kl_threshold: 999, fallback_rate_lift: 0.3, auto_remediate_drift: true },
            }),
          },
          {
            tenant_id: 'tenant-w935',
            namespace: 'prod',
            provider: DRIFT_CONFIG_PROVIDER,
            created_at: '2026-01-01T00:00:00.000Z',
            feedback: JSON.stringify({
              kind: 'drift_config_override',
              config: { kl_threshold: 0.2, fallback_rate_lift: 0.3, auto_remediate_drift: true },
            }),
          },
        ],
      },
    },
  });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.source, 'override');
  assert.equal(cfg.config.kl_threshold, 0.2);
  assert.notDeepEqual(cfg.config, DRIFT_CONFIG_DEFAULTS);

  assert.equal(estimateExtractedFrames(10, 'uniform', 1, 1.8), 1);
  assert.equal(buildSamplingSpec({ video_duration_s: 10, fps_target: 999 }).error, 'bad_fps_target');
  assert.equal(buildSamplingSpec({ video_duration_s: 90_000 }).error, 'bad_duration');

  const badBase = await localVllmCall({
    model: 'local',
    messages: [{ role: 'user', content: 'ping' }],
    base_url: 'file:///C:/secret/model?token=raw',
  });
  assert.equal(badBase.ok, false);
  assert.equal(badBase.error, 'invalid_base_url');
  assert.doesNotMatch(JSON.stringify(badBase), /secret|token|file:\/\//);
  assert.equal((await probeReachability({ vllm_url: 'file:///secret', ollama_url: 'file:///secret' })).vllm_reachable, false);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('SECRET_BODY_'.repeat(800));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const out = await localVllmCall({
      model: 'local',
      messages: [{ role: 'user', content: 'ping' }],
      base_url: `http://127.0.0.1:${port}/base?token=raw#frag`,
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'vllm_response_unparseable');
    assert.match(out.raw_body_sha256, /^[a-f0-9]{64}$/);
    assert.equal(out.raw_body_truncated, true);
    assert.equal(out.raw_body_bytes > 4096, true);
    assert.doesNotMatch(JSON.stringify(out), /SECRET_BODY|token=raw|frag/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W935 K-Score series and log importers cap file, path, URL, and error surfaces', async () => {
  const tenant = uniqueTenant('tenant_w935_kscore');
  try {
    const rec = await recordKScore({
      tenant,
      namespace: 'prod',
      kscore: 0.73,
      artifact_id: `artifact\n${'a'.repeat(300)}`,
      run_id: `run\r${'b'.repeat(300)}`,
      ts: 'not-a-date',
    });
    assert.equal(rec.ok, true);

    const series = await getKScoreSeries({ tenant, namespace: 'prod', window_days: 999999 });
    assert.equal(series.ok, true);
    assert.equal(series.points.length >= 1, true);
    const point = series.points.find((p) => p.run_id && p.run_id.startsWith('run'));
    assert.ok(point);
    assert.equal(point.run_id.length <= KSCORE_SERIES_LIMITS.max_id_chars, true);
    assert.doesNotMatch(point.run_id + point.artifact_id, /[\r\n]/);
    assert.doesNotThrow(() => new Date(point.ts).toISOString());
  } finally {
    await eventStore.purgeEvents({ tenant_id: tenant });
  }

  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w935-kscore-'));
  try {
    const runDir = path.join(runsDir, 'run-big', 'student');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'eval.json'), '{"composite":0.9,"pad":"' + 'x'.repeat(KSCORE_SERIES_LIMITS.max_eval_json_bytes) + '"}');
    const backfill = await backfillKScoreSeries({ tenant: uniqueTenant('tenant_w935_backfill'), namespace: 'prod', runs_dir: runsDir });
    assert.equal(backfill.ok, true);
    assert.equal(backfill.scanned, 1);
    assert.equal(backfill.recorded, 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }

  const badCredUrl = await importAgentLogs({
    source: 'url',
    url: 'https://user:pass@example.com/logs',
    fetchImpl: async () => new Response('never'),
  });
  assert.equal(badCredUrl.ok, false);
  assert.equal(badCredUrl.reason, 'invalid_url');
  assert.doesNotMatch(JSON.stringify(badCredUrl), /user|pass/);

  let seenUrl = null;
  let seenHeaders = null;
  const tooLarge = await importAgentLogs({
    source: 'url',
    url: 'https://example.com/logs?ok=1#secret',
    maxBytes: LOG_IMPORTER_DEFAULTS.DEFAULT_MAX_BYTES * 10,
    headers: {
      Authorization: 'Bearer tenant-token',
      Host: 'evil.example',
      'X-Good': 'yes',
      'X-Bad': 'line\nbreak',
    },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return new Response('x', {
        status: 200,
        headers: { 'content-length': String(LOG_IMPORTER_DEFAULTS.DEFAULT_MAX_BYTES + 1) },
      });
    },
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'too_large');
  assert.equal(seenUrl, 'https://example.com/logs?ok=1');
  assert.equal(seenHeaders.authorization, 'Bearer tenant-token');
  assert.equal(seenHeaders['x-good'], 'yes');
  assert.equal(seenHeaders.host, undefined);
  assert.equal(seenHeaders['x-bad'], undefined);
  assert.doesNotMatch(JSON.stringify(tooLarge), /secret|tenant-token/);
});

test('W935 language balancing, language detection, metrics, multi-region, and region sampler reject unsafe keys', async () => {
  const balanced = await sampleBalanced({
    captures: [{ cid: 'cap\none', input: 'hello' }],
    target_langs: ['__proto__', 'EN', 'en'],
    max_n: 10,
    lang_detect: () => ({ lang: 'EN', fallback: false }),
  });
  assert.equal(balanced.ok, true);
  assert.deepEqual(balanced.target_langs, ['en']);
  assert.deepEqual(balanced.samples, ['cap one']);
  assert.equal(balanced.by_lang.en, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(balanced.by_lang, '__proto__'), false);

  const coverage = await assessLanguageCoverage({
    captures: [{ event_id: 'c1', input: 'hello' }],
    target_langs: ['constructor', 'ES'],
    lang_detect: () => ({ lang: 'ES', fallback: false }),
  });
  assert.deepEqual(coverage.target_langs, ['es']);
  assert.equal(coverage.by_lang.es, 1);

  const lateSignal = `${'hello '.repeat(5000)} the and is in to of that with`;
  const detected = detectLang(lateSignal);
  assert.equal(detected.fallback, true, 'signals beyond the bounded text window must not decide language');
  assert.equal(detectLangSegments('a '.repeat(2000)).length <= LANG_DETECT_LIMITS.max_segments, true);
  const stats = langStats(new Array(LANG_DETECT_LIMITS.max_rows + 5).fill({ input: 'the and is in' }));
  assert.equal(stats.total, LANG_DETECT_LIMITS.max_rows);
  assert.equal(stats.input_total, LANG_DETECT_LIMITS.max_rows + 5);

  resetPrometheus();
  registerMetric({ name: 'w935_requests_total', type: 'counter', help: 'ok', labelnames: ['tenant'] });
  assert.throws(() => registerMetric({
    name: 'w935_requests_total',
    type: 'counter',
    help: 'ok',
    labelnames: ['tenant', 'namespace'],
  }), /different labelnames/);
  const longTenant = `${'a'.repeat(PROMETHEUS_LIMITS.max_label_value_chars)}SECRET`;
  incCounter('w935_requests_total', { tenant: longTenant }, 1);
  const rendered = renderMetrics();
  assert.match(rendered, /w935_requests_total/);
  assert.doesNotMatch(rendered, /SECRET/);
  registerMetric({ name: 'w935_latency_seconds', type: 'histogram', help: 'latency', buckets: [5, 1, 1, -1, Infinity, 2] });
  const hist = listRegisteredMetrics().find((m) => m.name === 'w935_latency_seconds');
  assert.deepEqual(hist.buckets, [1, 2, 5]);

  const env = {
    KOLM_REGION_GATEWAY_URLS: JSON.stringify({
      us: 'https://user:pass@us.example/path',
      eu: 'https://eu.example/base?token=raw#frag',
      unknown: 'https://unknown.example',
    }),
    KOLM_REGION: 'eu',
  };
  const gateways = getRegionGateways({ env });
  assert.deepEqual(gateways, { eu: 'https://eu.example/base' });
  const routed = routeRequest({
    request_hash: 'hash\nsecret',
    residency_requirement: 'eu',
    opts: { env },
  });
  assert.equal(routed.ok, true);
  assert.equal(routed.gateway_url, 'https://eu.example/base');
  assert.equal(routed.request_hash, 'hash secret');
  assert.doesNotMatch(JSON.stringify(routed), /token=raw|frag|user|pass/);

  const seenProbeUrls = [];
  const failover = await testFailover({
    opts: {
      env,
      timeout_ms: 1,
      fetch: async (url) => {
        seenProbeUrls.push(String(url));
        return new Response('ok', { status: 200 });
      },
    },
  });
  assert.equal(failover.ok, true);
  assert.deepEqual(seenProbeUrls, ['https://eu.example/base/v1/health']);

  const tenant = uniqueTenant('tenant_w935_region');
  const queries = [];
  const regionSample = await sampleForDistillation({
    tenant_id: tenant,
    namespace: 'prod',
    target_region: 'EU_WEST',
    max_n: 999999,
    eventStore: {
      listEvents: async (query) => {
        queries.push(query);
        if (query.namespace === 'kolm.residency') {
          return [
            {
              tenant_id: tenant,
              namespace: 'kolm.residency',
              provider: 'kolm_data_residency',
              model: 'capture-tag',
              request_hash: 'cap\none',
              response_redacted: 'EU_WEST',
            },
            {
              tenant_id: tenant,
              namespace: 'kolm.residency',
              provider: 'kolm_data_residency',
              model: 'capture-tag',
              request_hash: 'cap-two',
              response_redacted: '__proto__',
            },
          ];
        }
        return [
          { tenant_id: tenant, event_id: 'cap\none', namespace: 'prod', provider: 'openai' },
          { tenant_id: tenant, event_id: 'cap-two', namespace: 'prod', provider: 'openai' },
          { tenant_id: 'foreign', event_id: 'cap-foreign', namespace: 'prod', provider: 'openai' },
        ];
      },
    },
  });
  assert.equal(regionSample.ok, true);
  assert.deepEqual(regionSample.samples, ['cap one']);
  assert.equal(regionSample.count_after_sampling <= REGION_SAMPLER_LIMITS.max_sample_rows, true);
  assert.ok(queries.every((q) => q.limit === REGION_SAMPLER_LIMITS.max_scan_rows));
});

test('W935 platform-monitoring verifier is wired into depth after provider compliance', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:platform-monitoring-contracts'],
    'node --test --test-concurrency=1 tests/wave935-platform-monitoring-contracts.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:data-curation && npm run verify:capture-data-contracts && npm run verify:provider-compliance-contracts && npm run verify:platform-monitoring-contracts && npm run verify:benchmark-evidence/,
  );

  for (const rel of [
    'src/autopilot-savings.js',
    'src/carbon-estimator.js',
    'src/continuous-monitoring.js',
    'src/drift-alert-store.js',
    'src/drift-config.js',
    'src/frame-sampler.js',
    'src/gateway-mode.js',
    'src/kscore-timeseries.js',
    'src/lang-balanced-sampler.js',
    'src/lang-detect.js',
    'src/log-importer.js',
    'src/multi-region.js',
    'src/prometheus-exporter.js',
    'src/region-aware-sampler.js',
  ]) {
    assert.match(read(rel), /./, `${rel} must stay present and directly covered by W935`);
  }
});
