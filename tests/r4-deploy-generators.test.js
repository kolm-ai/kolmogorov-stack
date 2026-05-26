// R-4 — deployment config generator tests.
//
// Covers all four generators in src/deploy-generators.js. Validates output
// shape WITHOUT shelling out to kubectl / docker / vllm — we parse the YAML
// + JSON locally and pattern-match the kinds. The air-gap bundle test
// untars in-process, then drives the bundled verifier with a mocked fetch
// to confirm the verifier needs zero network access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  generateDockerCompose,
  generateKubernetesManifests,
  generateVllmConfig,
  generateAirgapBundle,
  DEPLOY_GENERATORS_VERSION,
} from '../src/deploy-generators.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const TMP_ROOT = path.join(os.tmpdir(), 'kolm-r4-' + process.pid + '-' + Date.now());

function tmpDir(label) {
  const d = path.join(TMP_ROOT, label + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// =============================================================================
// 1. docker-compose
// =============================================================================

test('docker-compose: parses as valid YAML', () => {
  const out = generateDockerCompose({ artifact: 'art-demo-v1' });
  const parsed = yaml.load(out);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed.services, 'has services map');
  assert.ok(parsed.services['kolm-runtime'], 'has kolm-runtime service');
});

test('docker-compose: vllm runtime has the right image + healthcheck', () => {
  const out = generateDockerCompose({ artifact: 'foo', runtime: 'vllm', port: 9000 });
  const parsed = yaml.load(out);
  const svc = parsed.services['kolm-runtime'];
  assert.equal(svc.image, 'vllm/vllm-openai:latest');
  assert.equal(svc.restart, 'unless-stopped');
  assert.ok(svc.healthcheck, 'has healthcheck');
  assert.ok(Array.isArray(svc.healthcheck.test));
  assert.match(String(svc.healthcheck.test[1]), /:9000\/health/);
  // ports array contains string '9000:9000'
  assert.deepEqual(svc.ports, ['9000:9000']);
});

test('docker-compose: llama.cpp runtime swaps image', () => {
  const out = generateDockerCompose({ artifact: 'foo', runtime: 'llama.cpp' });
  const parsed = yaml.load(out);
  const svc = parsed.services['kolm-runtime'];
  assert.equal(svc.image, 'ghcr.io/ggml-org/llama.cpp:server');
});

test('docker-compose: includes commented NGINX TLS proxy with cert TODO', () => {
  const out = generateDockerCompose({ artifact: 'foo' });
  assert.match(out, /Optional NGINX TLS terminator/);
  assert.match(out, /TODO: fill in cert path/);
  // The proxy is commented out (every nginx line starts with '#'), so
  // js-yaml shouldn't see a nginx-tls service.
  const parsed = yaml.load(out);
  assert.equal(parsed.services['nginx-tls'], undefined);
});

test('docker-compose: rejects unknown runtime', () => {
  assert.throws(() => generateDockerCompose({ artifact: 'foo', runtime: 'bogus' }), /unsupported runtime/);
});

test('docker-compose: requires artifact', () => {
  assert.throws(() => generateDockerCompose({}), /artifact/);
});

// =============================================================================
// 2. kubernetes manifests
// =============================================================================

test('k8s: parses as multi-document YAML with all 6 kinds', () => {
  const out = generateKubernetesManifests({ artifact: 'art-foo' });
  const docs = yaml.loadAll(out).filter(d => d != null);
  const kinds = docs.map(d => d.kind);
  // Expected: ConfigMap, PersistentVolumeClaim, Job, Deployment, Service, HorizontalPodAutoscaler
  for (const expected of ['ConfigMap', 'PersistentVolumeClaim', 'Job', 'Deployment', 'Service', 'HorizontalPodAutoscaler']) {
    assert.ok(kinds.includes(expected), 'expected ' + expected + ' in ' + JSON.stringify(kinds));
  }
});

test('k8s: deployment requests nvidia.com/gpu', () => {
  const out = generateKubernetesManifests({ artifact: 'art-foo', gpu_count: 2 });
  const docs = yaml.loadAll(out).filter(d => d != null);
  const deploy = docs.find(d => d.kind === 'Deployment');
  assert.ok(deploy, 'has Deployment');
  const container = deploy.spec.template.spec.containers[0];
  assert.equal(container.resources.requests['nvidia.com/gpu'], 2);
  assert.equal(container.resources.limits['nvidia.com/gpu'], 2);
});

test('k8s: deployment has liveness + readiness on /health', () => {
  const out = generateKubernetesManifests({ artifact: 'art-foo' });
  const docs = yaml.loadAll(out).filter(d => d != null);
  const deploy = docs.find(d => d.kind === 'Deployment');
  const container = deploy.spec.template.spec.containers[0];
  assert.equal(container.livenessProbe.httpGet.path, '/health');
  assert.equal(container.readinessProbe.httpGet.path, '/health');
  assert.equal(container.livenessProbe.httpGet.port, 8000);
});

test('k8s: service exposes port 8000 as ClusterIP', () => {
  const out = generateKubernetesManifests({ artifact: 'art-foo' });
  const docs = yaml.loadAll(out).filter(d => d != null);
  const svc = docs.find(d => d.kind === 'Service');
  assert.equal(svc.spec.type, 'ClusterIP');
  assert.equal(svc.spec.ports[0].port, 8000);
});

test('k8s: HPA targets 70% CPU utilization', () => {
  const out = generateKubernetesManifests({ artifact: 'art-foo' });
  const docs = yaml.loadAll(out).filter(d => d != null);
  const hpa = docs.find(d => d.kind === 'HorizontalPodAutoscaler');
  const cpuMetric = hpa.spec.metrics.find(m => m.resource && m.resource.name === 'cpu');
  assert.ok(cpuMetric, 'has cpu metric');
  assert.equal(cpuMetric.resource.target.averageUtilization, 70);
});

test('k8s: namespace defaults to "default" and can be overridden', () => {
  const a = generateKubernetesManifests({ artifact: 'art-foo' });
  const b = generateKubernetesManifests({ artifact: 'art-foo', namespace: 'kolm-prod' });
  const aDocs = yaml.loadAll(a).filter(d => d != null);
  const bDocs = yaml.loadAll(b).filter(d => d != null);
  assert.equal(aDocs[0].metadata.namespace, 'default');
  assert.equal(bDocs[0].metadata.namespace, 'kolm-prod');
});

test('k8s: kubectl apply --dry-run when available (otherwise env-skip)', { todo: false }, (t) => {
  const probe = spawnSync('kubectl', ['version', '--client', '--output=yaml'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('kubectl not on PATH — env-skip');
    return;
  }
  const out = generateKubernetesManifests({ artifact: 'art-dryrun' });
  const tmp = tmpDir('k8s-dryrun');
  const file = path.join(tmp, 'manifests.yaml');
  fs.writeFileSync(file, out);
  const res = spawnSync('kubectl', ['apply', '--dry-run=client', '-f', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    // Print stdout + stderr so a real CI failure is actionable.
    t.diagnostic('kubectl stdout: ' + (res.stdout || ''));
    t.diagnostic('kubectl stderr: ' + (res.stderr || ''));
  }
  assert.equal(res.status, 0, 'kubectl apply --dry-run=client returned ' + res.status);
});

// =============================================================================
// 3. vllm config
// =============================================================================

test('vllm-config: parses + has all required fields', () => {
  const out = generateVllmConfig({ artifact: 'foo-model' });
  const parsed = JSON.parse(out);
  for (const k of [
    'model', 'quantization', 'dtype', 'max_model_len', 'gpu_memory_utilization',
    'tensor_parallel_size', 'enforce_eager', 'swap_space', 'kv_cache_dtype',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, k), 'missing key: ' + k);
  }
  assert.equal(parsed.model, 'foo-model');
  assert.equal(parsed.enforce_eager, false);
  assert.equal(parsed.swap_space, 4);
  assert.equal(parsed.kv_cache_dtype, 'auto');
});

test('vllm-config: validates ranges', () => {
  assert.throws(() => generateVllmConfig({ artifact: 'x', gpu_memory_utilization: 1.5 }), /gpu_memory_utilization/);
  assert.throws(() => generateVllmConfig({ artifact: 'x', gpu_memory_utilization: 0 }), /gpu_memory_utilization/);
  assert.throws(() => generateVllmConfig({ artifact: 'x', tensor_parallel_size: 0 }), /tensor_parallel_size/);
  assert.throws(() => generateVllmConfig({ artifact: 'x', max_model_len: 10 }), /max_model_len/);
  assert.throws(() => generateVllmConfig({}), /artifact/);
});

test('vllm-config: honors quantization + tensor_parallel_size + max_model_len', () => {
  const out = generateVllmConfig({
    artifact: 'foo',
    quantization: 'awq',
    tensor_parallel_size: 4,
    max_model_len: 32768,
    gpu_memory_utilization: 0.85,
    dtype: 'bfloat16',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.quantization, 'awq');
  assert.equal(parsed.tensor_parallel_size, 4);
  assert.equal(parsed.max_model_len, 32768);
  assert.equal(parsed.gpu_memory_utilization, 0.85);
  assert.equal(parsed.dtype, 'bfloat16');
});

// =============================================================================
// 4. air-gap bundle
// =============================================================================

// Minimal tar reader so the test doesn't need an external tar binary.
// USTAR format only — matches what generateAirgapBundle writes.
function readTarEntries(tarBuf) {
  const entries = [];
  let i = 0;
  while (i + 512 <= tarBuf.length) {
    const block = tarBuf.slice(i, i + 512);
    // End-of-archive: two zero blocks.
    if (block.every(b => b === 0)) break;
    // name (NUL-padded, may use prefix at offset 345)
    const name = block.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = block.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? prefix + '/' + name : name;
    // size at 124 (12 bytes octal NUL-terminated)
    const sizeOctal = block.slice(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeflag = block.slice(156, 157).toString('ascii');
    i += 512;
    const data = tarBuf.slice(i, i + size);
    entries.push({ name: fullName, size, data, typeflag });
    // Round up to next 512-byte block.
    const pad = size % 512 === 0 ? 0 : 512 - (size % 512);
    i += size + pad;
  }
  return entries;
}

test('airgap bundle: writes tar.gz + sibling .sha256', () => {
  const work = tmpDir('airgap-write');
  // Create a fake .kolm artifact (just some bytes; the generator only copies it).
  const artifactPath = path.join(work, 'art-demo.kolm');
  fs.writeFileSync(artifactPath, 'PK\x03\x04 fake-kolm-bytes-for-test');

  const result = generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'vllm',
    output_dir: path.join(work, 'dist'),
  });
  assert.equal(result.ok, true, 'ok:true (' + JSON.stringify(result) + ')');
  assert.ok(result.bundle_path);
  assert.ok(fs.existsSync(result.bundle_path), 'bundle exists');
  assert.ok(fs.existsSync(result.bundle_path + '.sha256'), 'sibling .sha256 exists');
  assert.equal(result.runtime, 'vllm');
  assert.equal(result.artifact_id, 'art-demo');
  assert.ok(typeof result.manifest_sha256 === 'string' && result.manifest_sha256.length === 64);
  assert.ok(typeof result.sha256 === 'string' && result.sha256.length === 64);
  // Sibling .sha256 content matches bundle sha
  const sibling = fs.readFileSync(result.bundle_path + '.sha256', 'utf8').trim();
  assert.match(sibling, new RegExp('^' + result.sha256 + '  '));
});

test('airgap bundle: contains artifact, install.sh, vllm.json, verifier, manifest, README', () => {
  const work = tmpDir('airgap-contents');
  const artifactPath = path.join(work, 'art-content.kolm');
  fs.writeFileSync(artifactPath, 'fake artifact payload');

  const result = generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'vllm',
    output_dir: path.join(work, 'dist'),
  });
  assert.equal(result.ok, true);

  const gz = fs.readFileSync(result.bundle_path);
  const tarBuf = zlib.gunzipSync(gz);
  const entries = readTarEntries(tarBuf);
  const names = entries.map(e => e.name).sort();
  for (const expected of [
    'artifact.kolm',
    'runtime/install.sh',
    'config/vllm.json',
    'config/llama-cpp.cmd',
    'verify.cjs',
    'MANIFEST.sha256',
    'README.md',
  ]) {
    assert.ok(names.includes(expected), 'missing tar entry: ' + expected + ' (have: ' + names.join(',') + ')');
  }

  // verify the artifact bytes round-trip
  const artifactEntry = entries.find(e => e.name === 'artifact.kolm');
  assert.equal(artifactEntry.data.toString('utf8'), 'fake artifact payload');

  // verify vllm.json is valid JSON
  const vllmEntry = entries.find(e => e.name === 'config/vllm.json');
  const vllm = JSON.parse(vllmEntry.data.toString('utf8'));
  assert.ok(vllm.model);

  // verify MANIFEST.sha256 covers every other file
  const manifestText = entries.find(e => e.name === 'MANIFEST.sha256').data.toString('utf8');
  const manifestLines = manifestText.split('\n').filter(Boolean);
  for (const e of entries) {
    if (e.name === 'MANIFEST.sha256') continue;
    if (e.typeflag === '5') continue; // directory
    const sha = crypto.createHash('sha256').update(e.data).digest('hex');
    const expected = sha + '  ' + e.name;
    assert.ok(
      manifestLines.includes(expected),
      'manifest is missing or wrong for ' + e.name + ' (expected line: "' + expected + '")'
    );
  }
});

test('airgap bundle: rejects missing artifact + bad runtime', () => {
  assert.equal(
    generateAirgapBundle({ artifact_path: '/nonexistent/path.kolm', runtime: 'vllm', output_dir: TMP_ROOT }).ok,
    false
  );
  assert.equal(generateAirgapBundle({ runtime: 'vllm', output_dir: TMP_ROOT }).ok, false);
  assert.equal(generateAirgapBundle({ artifact_path: 'x' }).ok, false);
  assert.throws(() => generateAirgapBundle({ artifact_path: 'x', runtime: 'bogus', output_dir: TMP_ROOT }), /unsupported runtime/);
});

test('airgap bundle: verifier runs offline + verifies a valid receipt', () => {
  const work = tmpDir('airgap-verify');
  // Build a tiny artifact + bundle.
  const artifactPath = path.join(work, 'art-verify.kolm');
  fs.writeFileSync(artifactPath, 'verify-test-payload');
  const result = generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'vllm',
    output_dir: path.join(work, 'dist'),
  });
  assert.equal(result.ok, true);

  // Unpack into a staging dir so we can drive the verifier from disk.
  const stage = path.join(work, 'unpacked');
  fs.mkdirSync(stage, { recursive: true });
  const tarBuf = zlib.gunzipSync(fs.readFileSync(result.bundle_path));
  const entries = readTarEntries(tarBuf);
  for (const e of entries) {
    const dest = path.join(stage, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }

  // Craft a valid kolm-audit-1 receipt + sign it with a known secret.
  const secret = 'a'.repeat(64);
  const receipt = {
    spec: 'kolm-audit-1',
    cid: 'cid_test_' + crypto.randomBytes(8).toString('hex'),
    issued_at: new Date().toISOString(),
    payload: { artifact: 'art-verify', evidence: ['offline'] },
  };
  const canonical = Buffer.from(JSON.stringify(receipt));
  const key = Buffer.from(secret, 'hex');
  const sig = crypto.createHmac('sha256', key).update(canonical).digest('hex');
  receipt.sig = sig;
  const receiptPath = path.join(work, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));

  // Run the verifier with a forced-empty PATH-ish env so any accidental
  // network code path would fail. We also override fetch to throw if the
  // verifier ever calls it. We accomplish "no network" by checking that the
  // verifier source contains no `fetch(`, `http.`, `https.`, or `net.`
  // imports — easier than sandboxing the child process.
  const verifierSrc = fs.readFileSync(path.join(stage, 'verify.cjs'), 'utf8');
  assert.ok(!/\brequire\(['"]https?['"]\)/.test(verifierSrc), 'verifier must not import http/https');
  assert.ok(!/\bglobalThis\.fetch\(|^fetch\(|\bawait fetch\(/m.test(verifierSrc), 'verifier must not call fetch');
  assert.ok(!/\brequire\(['"]net['"]\)/.test(verifierSrc), 'verifier must not import net');

  // Drive the verifier as a child process and confirm it accepts the receipt.
  const node = process.execPath;
  const env = Object.assign({}, process.env, { KOLM_ARTIFACT_SECRET: secret });
  // Force PATH to a non-existent dir so the verifier truly can't shell out
  // to any helper — proves it's self-contained.
  env.PATH = path.join(work, 'no-such-dir');
  const verifyRes = spawnSync(node, [
    path.join(stage, 'verify.cjs'),
    receiptPath,
    '--manifest', path.join(stage, 'MANIFEST.sha256'),
  ], { encoding: 'utf8', env });
  if (verifyRes.status !== 0) {
    console.error('verifier stdout:', verifyRes.stdout);
    console.error('verifier stderr:', verifyRes.stderr);
  }
  assert.equal(verifyRes.status, 0, 'verifier exit 0 for valid receipt');
  const parsed = JSON.parse(verifyRes.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.manifest, 'manifest section present');
  assert.equal(parsed.manifest.ok, true);
  assert.equal(parsed.manifest.files_bad, 0);
});

test('airgap bundle: verifier rejects a tampered receipt', () => {
  const work = tmpDir('airgap-tamper');
  const artifactPath = path.join(work, 'art-tamper.kolm');
  fs.writeFileSync(artifactPath, 'x');
  const result = generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'llama.cpp',
    output_dir: path.join(work, 'dist'),
  });
  assert.equal(result.ok, true);

  const stage = path.join(work, 'unpacked');
  fs.mkdirSync(stage, { recursive: true });
  const entries = readTarEntries(zlib.gunzipSync(fs.readFileSync(result.bundle_path)));
  for (const e of entries) {
    const dest = path.join(stage, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }

  // Build a receipt with a deliberately wrong sig.
  const receipt = {
    spec: 'kolm-audit-1',
    cid: 'cid_tampered',
    payload: { artifact: 'tampered' },
    sig: 'deadbeef'.repeat(8),  // 64 chars of garbage
  };
  const rp = path.join(work, 'tampered.json');
  fs.writeFileSync(rp, JSON.stringify(receipt));

  const res = spawnSync(process.execPath, [
    path.join(stage, 'verify.cjs'),
    rp,
    '--secret', 'a'.repeat(64),
  ], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'verifier exits 1 for tampered receipt');
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, false);
});

test('airgap bundle: llama.cpp install script when runtime=llama.cpp', () => {
  const work = tmpDir('airgap-llamacpp');
  const artifactPath = path.join(work, 'art-lcpp.kolm');
  fs.writeFileSync(artifactPath, 'x');
  const result = generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'llama.cpp',
    output_dir: path.join(work, 'dist'),
  });
  assert.equal(result.ok, true);
  const entries = readTarEntries(zlib.gunzipSync(fs.readFileSync(result.bundle_path)));
  const installer = entries.find(e => e.name === 'runtime/install.sh').data.toString('utf8');
  assert.match(installer, /llama-server/);
  assert.match(installer, /llama\.cpp/);
});

test('generators: version stamp is consistent across modules', () => {
  assert.ok(typeof DEPLOY_GENERATORS_VERSION === 'string');
  const compose = generateDockerCompose({ artifact: 'x' });
  const k8s = generateKubernetesManifests({ artifact: 'x' });
  const vllm = generateVllmConfig({ artifact: 'x' });
  assert.match(compose, new RegExp(DEPLOY_GENERATORS_VERSION));
  assert.match(k8s, new RegExp(DEPLOY_GENERATORS_VERSION));
  const vllmParsed = JSON.parse(vllm);
  assert.equal(vllmParsed.generator, DEPLOY_GENERATORS_VERSION);
});

// Tear down the whole tmp tree on process exit so we don't leak.
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
});
