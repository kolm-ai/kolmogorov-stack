// W824 — Kubernetes-native deployment tests.
//
// Atomic items pinned (matches the W824 implementation):
//
//   1)  Chart.yaml is valid (yaml-ish parse + the four pinned keys)
//   2)  values.yaml has all spec keys (image, replicaCount, resources,
//       persistence, artifactRegistry)
//   3)  templates/deployment.yaml exists + contains "initContainer"
//   4)  templates/hpa.yaml has External metric type + inference_queue_depth
//   5)  preStop hook present in deployment.yaml
//   6)  src/k8s-routes.js exports registerK8sRoutes
//   7)  src/k8s-readiness.js exports setArtifactLoaded + isArtifactLoaded
//   8)  /metrics/extended returns prometheus text (mock req/res, no real HTTP)
//   9)  /ready/deep returns 503 before setArtifactLoaded(true)
//  10)  /ready/deep returns 200 after setArtifactLoaded(true)
//  11)  Helm chart shipping files present (Chart.yaml, values.yaml,
//       _helpers.tpl, README.md, .helmignore)
//  12)  service.yaml ClusterIP + port 3000
//  13)  configmap.yaml has KOLM_DATA_DIR + KOLM_ARTIFACT_ID
//  14)  deployment rolling-update strategy maxSurge=1 + maxUnavailable=0
//  15)  init container pull command shape (W824-5 spec)
//  16)  HPA target averageValue=50 (matches inference_queue_depth contract)
//  17)  K8S_READINESS_VERSION + K8S_ROUTES_VERSION pinned to w824-v1
//  18)  KOLM_ARTIFACT_LOADED env var alone flips isArtifactLoaded()
//  19)  setInferenceQueueDepth + getInferenceQueueDepth round-trip
//  20)  router.js wires registerK8sRoutes via the one-line modular mount
//  21)  sw.js wave token bumped to include -wave824-k8s suffix
//  22)  Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  K8S_READINESS_VERSION,
  setArtifactLoaded,
  isArtifactLoaded,
  readinessSnapshot,
  _resetForTests as resetReadiness,
} from '../src/k8s-readiness.js';

import {
  K8S_ROUTES_VERSION,
  registerK8sRoutes,
  renderExtendedMetrics,
  setInferenceQueueDepth,
  getInferenceQueueDepth,
} from '../src/k8s-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HELM_DIR = path.join(REPO_ROOT, 'tools', 'helm', 'kolm');
const CHART_YAML = path.join(HELM_DIR, 'Chart.yaml');
const VALUES_YAML = path.join(HELM_DIR, 'values.yaml');
const DEPLOY_YAML = path.join(HELM_DIR, 'templates', 'deployment.yaml');
const SERVICE_YAML = path.join(HELM_DIR, 'templates', 'service.yaml');
const CONFIGMAP_YAML = path.join(HELM_DIR, 'templates', 'configmap.yaml');
const HPA_YAML = path.join(HELM_DIR, 'templates', 'hpa.yaml');
const HELPERS_TPL = path.join(HELM_DIR, 'templates', '_helpers.tpl');
const HELM_README = path.join(HELM_DIR, 'README.md');
const HELM_IGNORE = path.join(HELM_DIR, '.helmignore');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Tiny line-oriented YAML field reader — enough for our shipping shape
// without taking on a js-yaml dependency. Looks for `key: value` at the
// nearest indentation; not a full parser, just a shape check.
function yamlScalar(text, key) {
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const m = re.exec(text);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '');
}

function yamlHasKey(text, key) {
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'm');
  return re.test(text);
}

// Express-like mock — registerK8sRoutes only needs r.get(path, handler).
// Captures handlers in a map so tests can invoke them with a synthetic
// req/res pair (no real HTTP, no real server).
function makeMockRouter() {
  const routes = new Map();
  return {
    routes,
    get(p, handler) { routes.set(p, handler); },
  };
}

function makeMockRes() {
  let _status = 200;
  const _headers = {};
  let _body = null;
  let _jsonBody = null;
  return {
    status(c) { _status = c; return this; },
    set(k, v) { _headers[String(k).toLowerCase()] = v; return this; },
    json(b) { _jsonBody = b; _body = JSON.stringify(b); return this; },
    send(b) { _body = b; return this; },
    get statusCode() { return _status; },
    get body() { return _body; },
    get jsonBody() { return _jsonBody; },
    get headers() { return _headers; },
  };
}

// --------------------------------------------------------------------------
// 1) Chart.yaml valid
// --------------------------------------------------------------------------

test('W824 #1 — Chart.yaml is valid (apiVersion v2 + pinned shape)', () => {
  assert.ok(fs.existsSync(CHART_YAML), 'Chart.yaml must exist');
  const text = fs.readFileSync(CHART_YAML, 'utf8');
  assert.equal(yamlScalar(text, 'apiVersion'), 'v2');
  assert.equal(yamlScalar(text, 'name'), 'kolm');
  assert.equal(yamlScalar(text, 'version'), '0.1.0');
  assert.equal(yamlScalar(text, 'appVersion'), '1.0.0');
});

// --------------------------------------------------------------------------
// 2) values.yaml — every spec key present
// --------------------------------------------------------------------------

test('W824 #2 — values.yaml has image, replicaCount, resources, persistence, artifactRegistry', () => {
  assert.ok(fs.existsSync(VALUES_YAML), 'values.yaml must exist');
  const text = fs.readFileSync(VALUES_YAML, 'utf8');
  for (const k of ['image', 'replicaCount', 'resources', 'persistence', 'artifactRegistry']) {
    assert.ok(yamlHasKey(text, k), `values.yaml missing top-level key "${k}"`);
  }
  // image.repository + image.tag specifically (spec-required).
  assert.ok(/^\s*repository:/m.test(text), 'image.repository must be set');
  assert.ok(/^\s*tag:/m.test(text), 'image.tag must be present (may be empty string)');
  // persistence.size defaults to 10Gi per spec.
  assert.ok(/size:\s*10Gi/.test(text), 'persistence.size must default to 10Gi');
  // replicaCount default 2.
  assert.equal(yamlScalar(text, 'replicaCount'), '2');
  // resources requests + limits both present.
  assert.ok(/requests:/.test(text) && /limits:/.test(text),
    'resources must have requests AND limits');
  // artifactRegistry.url + .secretRef present (may be empty by default).
  assert.ok(/url:\s*/.test(text), 'artifactRegistry.url must be present');
  assert.ok(/secretRef:\s*/.test(text), 'artifactRegistry.secretRef must be present');
});

// --------------------------------------------------------------------------
// 3) deployment.yaml exists + has init container
// --------------------------------------------------------------------------

test('W824 #3 — templates/deployment.yaml exists + has initContainers block', () => {
  assert.ok(fs.existsSync(DEPLOY_YAML), 'deployment.yaml must exist');
  const text = fs.readFileSync(DEPLOY_YAML, 'utf8');
  // The spec literally says "contains initContainer" — accept either form.
  assert.ok(/initContainer/i.test(text),
    'deployment.yaml must mention initContainer(s)');
  // And the spec-required pod block + Deployment kind.
  assert.ok(/^kind:\s*Deployment\b/m.test(text), 'kind must be Deployment');
  assert.ok(/apiVersion:\s*apps\/v1/.test(text), 'Deployment must use apps/v1');
});

// --------------------------------------------------------------------------
// 4) HPA — External metric on inference_queue_depth
// --------------------------------------------------------------------------

test('W824 #4 — templates/hpa.yaml has External metric type + inference_queue_depth', () => {
  assert.ok(fs.existsSync(HPA_YAML), 'hpa.yaml must exist');
  const text = fs.readFileSync(HPA_YAML, 'utf8');
  assert.ok(/kind:\s*HorizontalPodAutoscaler/.test(text), 'kind must be HPA');
  assert.ok(/type:\s*External/.test(text),
    'HPA must use External metric type per W824-4 spec');
  assert.ok(/name:\s*inference_queue_depth/.test(text),
    'HPA metric name must be inference_queue_depth');
  assert.ok(/app:\s*kolm/.test(text),
    'HPA selector.matchLabels must include app: kolm');
  assert.ok(/AverageValue/.test(text),
    'HPA target type must be AverageValue (not utilization)');
});

// --------------------------------------------------------------------------
// 5) preStop hook present
// --------------------------------------------------------------------------

test('W824 #5 — deployment.yaml has preStop hook (W824-6)', () => {
  const text = fs.readFileSync(DEPLOY_YAML, 'utf8');
  assert.ok(/preStop:/.test(text), 'preStop key must be present');
  // The spec command shape: `sleep N && kill -TERM 1`. We accept any
  // value for N (literal integer OR a Helm template like
  // `{{ .Values.preStop.drainSeconds }}` with spaces inside the braces).
  assert.ok(/sleep\s+.+?\s*&&\s*kill\s+-TERM\s+1/.test(text),
    'preStop command must drain then SIGTERM pid 1 per W824-6 spec');
});

// --------------------------------------------------------------------------
// 6) k8s-routes.js exports registerK8sRoutes
// --------------------------------------------------------------------------

test('W824 #6 — src/k8s-routes.js exports registerK8sRoutes', () => {
  assert.equal(typeof registerK8sRoutes, 'function');
  assert.equal(registerK8sRoutes.name, 'registerK8sRoutes');
});

// --------------------------------------------------------------------------
// 7) k8s-readiness.js exports setArtifactLoaded + isArtifactLoaded
// --------------------------------------------------------------------------

test('W824 #7 — src/k8s-readiness.js exports setArtifactLoaded + isArtifactLoaded', () => {
  assert.equal(typeof setArtifactLoaded, 'function');
  assert.equal(typeof isArtifactLoaded, 'function');
  assert.equal(setArtifactLoaded.name, 'setArtifactLoaded');
  assert.equal(isArtifactLoaded.name, 'isArtifactLoaded');
});

// --------------------------------------------------------------------------
// 8) /metrics/extended returns prometheus text
// --------------------------------------------------------------------------

test('W824 #8 — /metrics/extended returns Prometheus exposition text', async () => {
  resetReadiness();
  const r = makeMockRouter();
  registerK8sRoutes(r);
  const handler = r.routes.get('/metrics/extended');
  assert.equal(typeof handler, 'function', 'GET /metrics/extended must be registered');
  const res = makeMockRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  // Content-Type set to Prometheus text format.
  assert.ok(/text\/plain/.test(String(res.headers['content-type'] || '')),
    'response must declare text/plain content-type');
  // Body has the four W824-3 spec metrics with HELP+TYPE lines.
  const body = String(res.body || '');
  for (const m of [
    'kolm_inferences_total',
    'kolm_latency_seconds',
    'kolm_fallback_rate',
    'kolm_inference_queue_depth',
  ]) {
    assert.ok(body.includes('# HELP ' + m), 'body missing HELP for ' + m);
    assert.ok(body.includes('# TYPE ' + m), 'body missing TYPE for ' + m);
  }
});

// --------------------------------------------------------------------------
// 9) /ready/deep returns 503 before setArtifactLoaded(true)
// --------------------------------------------------------------------------

test('W824 #9 — /ready/deep returns 503 before setArtifactLoaded(true)', async () => {
  resetReadiness();
  delete process.env.KOLM_ARTIFACT_LOADED;
  const r = makeMockRouter();
  registerK8sRoutes(r);
  const handler = r.routes.get('/ready/deep');
  assert.equal(typeof handler, 'function', 'GET /ready/deep must be registered');
  const res = makeMockRes();
  await handler({}, res);
  assert.equal(res.statusCode, 503, 'cold pod must return 503');
  assert.equal(res.jsonBody.ok, false);
  assert.equal(res.jsonBody.error, 'artifact_not_loaded');
  assert.equal(res.jsonBody.artifact_loaded, false);
  assert.equal(res.jsonBody.version, K8S_READINESS_VERSION);
});

// --------------------------------------------------------------------------
// 10) /ready/deep returns 200 after setArtifactLoaded(true)
// --------------------------------------------------------------------------

test('W824 #10 — /ready/deep returns 200 after setArtifactLoaded(true)', async () => {
  resetReadiness();
  delete process.env.KOLM_ARTIFACT_LOADED;
  setArtifactLoaded(true, { reason: 'warm_complete' });
  const r = makeMockRouter();
  registerK8sRoutes(r);
  const handler = r.routes.get('/ready/deep');
  const res = makeMockRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200, 'loaded pod must return 200');
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.artifact_loaded, true);
  assert.equal(res.jsonBody.source, 'memory');
  assert.equal(res.jsonBody.reason, 'warm_complete');
  assert.equal(res.jsonBody.version, K8S_READINESS_VERSION);
});

// --------------------------------------------------------------------------
// 11) Helm shipping files present
// --------------------------------------------------------------------------

test('W824 #11 — Helm chart shipping files all present', () => {
  for (const f of [CHART_YAML, VALUES_YAML, HELPERS_TPL, HELM_README, HELM_IGNORE,
                   DEPLOY_YAML, SERVICE_YAML, CONFIGMAP_YAML, HPA_YAML]) {
    assert.ok(fs.existsSync(f), 'missing required Helm chart file: ' + f);
  }
});

// --------------------------------------------------------------------------
// 12) service.yaml ClusterIP + port 3000
// --------------------------------------------------------------------------

test('W824 #12 — service.yaml is ClusterIP + port 3000', () => {
  const text = fs.readFileSync(SERVICE_YAML, 'utf8');
  assert.ok(/kind:\s*Service/.test(text));
  // The chart uses template values for the type — confirm via the values
  // file default + the template referencing the variable.
  assert.ok(/\.Values\.service\.type/.test(text),
    'service.yaml must reference .Values.service.type');
  const valsText = fs.readFileSync(VALUES_YAML, 'utf8');
  assert.ok(/type:\s*ClusterIP/.test(valsText),
    'values.yaml service.type must default to ClusterIP');
  assert.ok(/port:\s*3000/.test(valsText),
    'values.yaml service.port must default to 3000');
});

// --------------------------------------------------------------------------
// 13) configmap.yaml has KOLM_DATA_DIR + KOLM_ARTIFACT_ID
// --------------------------------------------------------------------------

test('W824 #13 — configmap.yaml has KOLM_DATA_DIR + KOLM_ARTIFACT_ID', () => {
  const text = fs.readFileSync(CONFIGMAP_YAML, 'utf8');
  assert.ok(/kind:\s*ConfigMap/.test(text));
  assert.ok(/KOLM_DATA_DIR:/.test(text), 'KOLM_DATA_DIR env key missing');
  assert.ok(/KOLM_ARTIFACT_ID:/.test(text), 'KOLM_ARTIFACT_ID env key missing');
});

// --------------------------------------------------------------------------
// 14) Rolling-update strategy
// --------------------------------------------------------------------------

test('W824 #14 — deployment.yaml uses RollingUpdate with maxSurge=1 + maxUnavailable=0', () => {
  const dep = fs.readFileSync(DEPLOY_YAML, 'utf8');
  assert.ok(/type:\s*RollingUpdate/.test(dep),
    'deployment strategy.type must be RollingUpdate');
  // The template references .Values.rollingUpdate.{maxSurge,maxUnavailable},
  // so check both the template wiring AND the values defaults.
  assert.ok(/maxSurge:\s*\{\{\s*\.Values\.rollingUpdate\.maxSurge/.test(dep),
    'deployment must template maxSurge from values');
  assert.ok(/maxUnavailable:\s*\{\{\s*\.Values\.rollingUpdate\.maxUnavailable/.test(dep),
    'deployment must template maxUnavailable from values');
  const vals = fs.readFileSync(VALUES_YAML, 'utf8');
  assert.ok(/maxSurge:\s*1/.test(vals), 'maxSurge default must be 1');
  assert.ok(/maxUnavailable:\s*0/.test(vals), 'maxUnavailable default must be 0 (zero-downtime)');
});

// --------------------------------------------------------------------------
// 15) Init container pull command shape (W824-5)
// --------------------------------------------------------------------------

test('W824 #15 — init container runs the spec pull command', () => {
  const text = fs.readFileSync(DEPLOY_YAML, 'utf8');
  // Spec: command: ["sh","-c","kolm pull $KOLM_ARTIFACT_ID --to /artifacts/"]
  assert.ok(/kolm\s+pull\s+\$KOLM_ARTIFACT_ID\s+--to\s+\/artifacts\//.test(text),
    'init container must run the W824-5 pull command');
  assert.ok(/KOLM_ARTIFACT_ID/.test(text),
    'init container env must reference KOLM_ARTIFACT_ID');
});

// --------------------------------------------------------------------------
// 16) HPA targetQueueDepth contract
// --------------------------------------------------------------------------

test('W824 #16 — HPA target averageValue = "50" (matches inference_queue_depth contract)', () => {
  const hpa = fs.readFileSync(HPA_YAML, 'utf8');
  // Template uses .Values.hpa.targetQueueDepth; check defaults too.
  assert.ok(/averageValue:\s*\{\{\s*\.Values\.hpa\.targetQueueDepth/.test(hpa),
    'HPA must template averageValue from .Values.hpa.targetQueueDepth');
  const vals = fs.readFileSync(VALUES_YAML, 'utf8');
  assert.ok(/targetQueueDepth:\s*50/.test(vals),
    'values.hpa.targetQueueDepth must default to 50');
});

// --------------------------------------------------------------------------
// 17) Version stamps
// --------------------------------------------------------------------------

test('W824 #17 — K8S_READINESS_VERSION + K8S_ROUTES_VERSION are "w824-v1"', () => {
  assert.equal(K8S_READINESS_VERSION, 'w824-v1');
  assert.equal(K8S_ROUTES_VERSION, 'w824-v1');
});

// --------------------------------------------------------------------------
// 18) KOLM_ARTIFACT_LOADED env var honors readiness
// --------------------------------------------------------------------------

test('W824 #18 — KOLM_ARTIFACT_LOADED env var alone flips isArtifactLoaded()', () => {
  resetReadiness();
  delete process.env.KOLM_ARTIFACT_LOADED;
  assert.equal(isArtifactLoaded(), false, 'cold start must be not-loaded');
  process.env.KOLM_ARTIFACT_LOADED = '1';
  try {
    assert.equal(isArtifactLoaded(), true, 'env=1 must flip to loaded');
    const snap = readinessSnapshot();
    assert.equal(snap.source, 'env', 'snapshot source must be "env" when only env is set');
    assert.equal(snap.artifact_loaded, true);
  } finally {
    delete process.env.KOLM_ARTIFACT_LOADED;
  }
  assert.equal(isArtifactLoaded(), false, 'unsetting env must revert to not-loaded');
});

// --------------------------------------------------------------------------
// 19) Inference queue depth round-trip
// --------------------------------------------------------------------------

test('W824 #19 — setInferenceQueueDepth + getInferenceQueueDepth round-trip', async () => {
  setInferenceQueueDepth(0);
  assert.equal(getInferenceQueueDepth(), 0);
  setInferenceQueueDepth(42);
  assert.equal(getInferenceQueueDepth(), 42);
  // Negative + non-finite reject loudly.
  assert.throws(() => setInferenceQueueDepth(-1), /non-negative/);
  assert.throws(() => setInferenceQueueDepth(NaN), /non-negative finite/);
  // Renderer surfaces the gauge value.
  setInferenceQueueDepth(7);
  const text = await renderExtendedMetrics();
  assert.ok(/kolm_inference_queue_depth\s+7\b/.test(text),
    'renderExtendedMetrics must emit the current queue depth (got=' + text.slice(0, 200) + ')');
  setInferenceQueueDepth(0); // reset for downstream tests
});

// --------------------------------------------------------------------------
// 20) router.js wires the modular mount
// --------------------------------------------------------------------------

test('W824 #20 — router.js wires registerK8sRoutes via one-line modular mount', () => {
  const text = fs.readFileSync(ROUTER_PATH, 'utf8');
  assert.ok(/registerK8sRoutes\s+as\s+__registerK8sRoutes_w824/.test(text),
    'router.js must import registerK8sRoutes under the w824 alias');
  assert.ok(/__registerK8sRoutes_w824\(r\)/.test(text),
    'router.js must call __registerK8sRoutes_w824(r) inside the router builder');
});

// --------------------------------------------------------------------------
// 21) sw.js wave token bumped
// --------------------------------------------------------------------------

test('W824 #21 — public/sw.js cache slug includes the wave824 suffix', () => {
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  assert.ok(/-wave824-k8s/.test(sw),
    'sw.js cache slug must include "-wave824-k8s" so clients invalidate');
});

// --------------------------------------------------------------------------
// 22) Family lock-in (W604 anti-brittleness)
// --------------------------------------------------------------------------

test('W824 #22 — sw.js wave family uses regex + numeric threshold (≥824)', () => {
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const matches = Array.from(sw.matchAll(/wave(\d{3,4})/g)).map((m) => Number(m[1]));
  assert.ok(matches.length >= 1, 'sw.js must mention at least one wave token');
  // W824 must be in the set OR there must be a higher wave that supersedes it.
  // Use threshold check (regex + max-wave ≥ 824) to keep the test future-proof
  // when later waves bump the cache further.
  const max = Math.max(...matches);
  assert.ok(max >= 824, 'sw.js max wave token must be ≥ 824 (got ' + max + ')');
});
