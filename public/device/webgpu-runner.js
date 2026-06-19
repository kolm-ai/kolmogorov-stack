// Browser verify-then-run proof harness.
//
// This module is deliberately dependency-free. It proves the boundary the
// on-device roadmap needs: hash the exact weight bytes, verify the signed
// manifest, then execute a tiny model only after both checks pass. The tiny
// linear fixture is not an LLM engine; WebLLM/LlamaWeb integration remains a
// separate runtime target.

export const BROWSER_WEIGHT_MANIFEST_SPEC = 'kolm.browser_weight_manifest.v1';
export const BROWSER_WEIGHT_SIGNATURE_SPEC = 'kolm-browser-weight-manifest-ed25519-v1';
export const BROWSER_WEIGHT_SIGNED_FIELDS = Object.freeze([
  'schema',
  'model_id',
  'runtime',
  'weights_url',
  'weights_sha256',
  'runtime_config',
  'input',
  'output_labels',
  'created_at',
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function subtleCrypto() {
  return globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(b64) {
  const bin = globalThis.atob
    ? globalThis.atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

export function pemToDer(pem) {
  if (typeof pem !== 'string') throw new Error('public_key must be a PEM string');
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!b64) throw new Error('public_key PEM has no body');
  return base64ToBytes(b64);
}

export function canonicalWeightManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be an object');
  }
  const out = {};
  for (const key of BROWSER_WEIGHT_SIGNED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) out[key] = manifest[key];
  }
  return JSON.stringify(out);
}

export async function sha256HexBytes(bytes) {
  const subtle = subtleCrypto();
  if (!subtle) throw new Error('WebCrypto SHA-256 unavailable');
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

function fail(checks, reason) {
  return { ok: false, reason, checks };
}

export async function verifyWeightManifest(manifest, weightsBytes, opts = {}) {
  const checks = [];
  if (typeof manifest === 'string') {
    try { manifest = JSON.parse(manifest); } catch (e) { return fail(checks, `manifest JSON parse failed: ${e.message}`); }
  }
  if (!manifest || typeof manifest !== 'object') return fail(checks, 'manifest must be an object');
  if (manifest.schema !== BROWSER_WEIGHT_MANIFEST_SPEC) {
    return fail(checks, `unexpected manifest schema: ${manifest.schema || '<missing>'}`);
  }
  checks.push({ name: 'manifest schema', ok: true, detail: manifest.schema });

  if (typeof manifest.weights_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.weights_sha256)) {
    return fail(checks, 'manifest weights_sha256 must be a 64-char hex digest');
  }
  let actualSha;
  try { actualSha = await sha256HexBytes(weightsBytes); } catch (e) { return fail(checks, e.message); }
  const digestOk = actualSha.toLowerCase() === manifest.weights_sha256.toLowerCase();
  checks.push({ name: 'weights sha256 matches manifest', ok: digestOk, detail: actualSha });
  if (!digestOk) return { ok: false, reason: 'weight bytes do not match signed manifest digest', weights_sha256: actualSha, checks };

  const block = manifest.signature_ed25519;
  if (!block || typeof block !== 'object') return fail(checks, 'manifest has no signature_ed25519 block');
  if (block.spec !== BROWSER_WEIGHT_SIGNATURE_SPEC) return fail(checks, `unexpected signature spec: ${block.spec || '<missing>'}`);
  if (block.alg !== 'ed25519') return fail(checks, `unexpected signature alg: ${block.alg || '<missing>'}`);
  checks.push({ name: 'signature block present', ok: true, detail: block.spec });

  const subtle = subtleCrypto();
  if (!subtle || typeof subtle.importKey !== 'function') {
    checks.push({ name: 'native Ed25519', ok: false, detail: 'WebCrypto Ed25519 unavailable' });
    return { ok: false, reason: 'native Ed25519 unavailable; manifest signature was not checked', weights_sha256: actualSha, checks };
  }

  let der;
  try { der = pemToDer(block.public_key); } catch (e) { return fail(checks, e.message); }
  if (opts.pinnedPublicKeyPem) {
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const keyOk = norm(opts.pinnedPublicKeyPem) === norm(block.public_key);
    checks.push({ name: 'pinned manifest key', ok: keyOk, detail: keyOk ? 'matches expected key' : 'embedded key differs' });
    if (!keyOk) return { ok: false, reason: 'manifest public key does not match pinned key', weights_sha256: actualSha, checks };
  }

  let canonical;
  try { canonical = canonicalWeightManifest(manifest); } catch (e) { return fail(checks, e.message); }
  checks.push({ name: 'canonical manifest payload rebuilt', ok: true, detail: `${canonical.length} bytes` });

  let sigOk = false;
  try {
    const key = await subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    sigOk = await subtle.verify('Ed25519', key, base64UrlToBytes(block.signature), textEncoder.encode(canonical));
  } catch (e) {
    checks.push({ name: 'Ed25519 manifest signature', ok: false, detail: e.message });
    return { ok: false, reason: 'manifest signature verification raised: ' + e.message, weights_sha256: actualSha, checks };
  }
  checks.push({ name: 'Ed25519 manifest signature valid', ok: sigOk, detail: sigOk ? 'signature matches manifest' : 'signature mismatch' });
  if (!sigOk) return { ok: false, reason: 'manifest signature does not verify', weights_sha256: actualSha, checks };

  return {
    ok: true,
    weights_sha256: actualSha,
    model_id: manifest.model_id,
    runtime: manifest.runtime,
    checks,
  };
}

export function parseTinyLinearWeights(bytes) {
  const obj = JSON.parse(textDecoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  if (obj.schema !== 'kolm.tiny_linear.weights.v1') throw new Error('unsupported tiny model schema');
  if (!Number.isInteger(obj.input_dim) || !Number.isInteger(obj.output_dim)) throw new Error('invalid tiny model dims');
  if (!Array.isArray(obj.weights) || obj.weights.length !== obj.output_dim) throw new Error('invalid tiny model weights');
  if (!Array.isArray(obj.bias) || obj.bias.length !== obj.output_dim) throw new Error('invalid tiny model bias');
  for (const row of obj.weights) {
    if (!Array.isArray(row) || row.length !== obj.input_dim) throw new Error('invalid tiny model weight row');
    for (const value of row) if (!Number.isFinite(Number(value))) throw new Error('non-finite tiny model weight');
  }
  for (const value of obj.bias) if (!Number.isFinite(Number(value))) throw new Error('non-finite tiny model bias');
  return obj;
}

export function runTinyLinearCpu(model, input) {
  if (!Array.isArray(input) || input.length !== model.input_dim) throw new Error('input length does not match tiny model');
  const logits = model.weights.map((row, outIdx) => {
    let acc = Number(model.bias[outIdx] || 0);
    for (let i = 0; i < row.length; i += 1) acc += Number(row[i]) * Number(input[i]);
    return Number(acc.toFixed(6));
  });
  let best = 0;
  for (let i = 1; i < logits.length; i += 1) if (logits[i] > logits[best]) best = i;
  return {
    runtime: 'cpu-js',
    logits,
    prediction_index: best,
    prediction: Array.isArray(model.labels) ? model.labels[best] : String(best),
  };
}

export async function runTinyLinearWebGpu(model, input) {
  if (!globalThis.navigator || !navigator.gpu) {
    return { ok: false, reason: 'WebGPU unavailable' };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, reason: 'WebGPU adapter unavailable' };
  const device = await adapter.requestDevice();
  const flatWeights = new Float32Array(model.weights.flat().map(Number));
  const bias = new Float32Array(model.bias.map(Number));
  const inVec = new Float32Array(input.map(Number));
  const outVec = new Float32Array(model.output_dim);
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const weightsBuf = device.createBuffer({ size: flatWeights.byteLength, usage, mappedAtCreation: true });
  new Float32Array(weightsBuf.getMappedRange()).set(flatWeights);
  weightsBuf.unmap();
  const biasBuf = device.createBuffer({ size: bias.byteLength, usage, mappedAtCreation: true });
  new Float32Array(biasBuf.getMappedRange()).set(bias);
  biasBuf.unmap();
  const inputBuf = device.createBuffer({ size: inVec.byteLength, usage, mappedAtCreation: true });
  new Float32Array(inputBuf.getMappedRange()).set(inVec);
  inputBuf.unmap();
  const outputBuf = device.createBuffer({ size: outVec.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: outVec.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: `
const INPUT_DIM: u32 = ${model.input_dim}u;
const OUTPUT_DIM: u32 = ${model.output_dim}u;
@group(0) @binding(0) var<storage, read> weights: array<f32>;
@group(0) @binding(1) var<storage, read> bias: array<f32>;
@group(0) @binding(2) var<storage, read> input_vec: array<f32>;
@group(0) @binding(3) var<storage, read_write> output_vec: array<f32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let out_idx = gid.x;
  if (out_idx >= OUTPUT_DIM) { return; }
  var acc = bias[out_idx];
  for (var i: u32 = 0u; i < INPUT_DIM; i = i + 1u) {
    acc = acc + weights[out_idx * INPUT_DIM + i] * input_vec[i];
  }
  output_vec[out_idx] = acc;
}` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: weightsBuf } },
      { binding: 1, resource: { buffer: biasBuf } },
      { binding: 2, resource: { buffer: inputBuf } },
      { binding: 3, resource: { buffer: outputBuf } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(model.output_dim);
  pass.end();
  encoder.copyBufferToBuffer(outputBuf, 0, readBuf, 0, outVec.byteLength);
  device.queue.submit([encoder.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const logits = Array.from(new Float32Array(readBuf.getMappedRange())).map((v) => Number(v.toFixed(6)));
  readBuf.unmap();
  let best = 0;
  for (let i = 1; i < logits.length; i += 1) if (logits[i] > logits[best]) best = i;
  return {
    ok: true,
    runtime: 'webgpu',
    logits,
    prediction_index: best,
    prediction: Array.isArray(model.labels) ? model.labels[best] : String(best),
  };
}

async function fetchJsonAndBytes(manifestUrl, fetchImpl) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('fetch unavailable');
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const weightUrl = new URL(manifest.weights_url, new URL(manifestUrl, globalThis.location ? location.href : 'http://localhost/')).toString();
  const weightsResponse = await fetcher(weightUrl);
  if (!weightsResponse.ok) throw new Error(`weights fetch failed: ${weightsResponse.status}`);
  return { manifest, weightsBytes: new Uint8Array(await weightsResponse.arrayBuffer()) };
}

export async function runVerifiedTinyModel({
  manifestUrl = '/device/fixtures/tiny-linear.manifest.json',
  manifest = null,
  weightsBytes = null,
  input = null,
  preferWebGpu = true,
  fetchImpl = null,
} = {}) {
  if (!manifest || !weightsBytes) {
    const loaded = await fetchJsonAndBytes(manifestUrl, fetchImpl);
    manifest = loaded.manifest;
    weightsBytes = loaded.weightsBytes;
  }
  const verified = await verifyWeightManifest(manifest, weightsBytes);
  if (!verified.ok) return { ok: false, stage: 'verify', ...verified };
  const model = parseTinyLinearWeights(weightsBytes);
  const runInput = input || manifest.input || Array.from({ length: model.input_dim }, () => 0);
  let execution = null;
  if (preferWebGpu) {
    const gpu = await runTinyLinearWebGpu(model, runInput);
    if (gpu.ok) execution = gpu;
  }
  if (!execution) execution = runTinyLinearCpu(model, runInput);
  return {
    ok: true,
    stage: 'run',
    model_id: manifest.model_id,
    weights_sha256: verified.weights_sha256,
    input: runInput,
    execution,
    checks: verified.checks,
  };
}

function renderChecks(checks) {
  return checks.map((check) => `<li><b>${check.ok ? 'pass' : 'fail'}</b> ${check.name}: <span>${check.detail || ''}</span></li>`).join('');
}

function bootDemo() {
  const btn = document.getElementById('deviceRunBtn');
  const out = document.getElementById('deviceRunOut');
  const status = document.getElementById('deviceRunStatus');
  if (!btn || !out || !status) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'checking';
    out.textContent = 'Hashing weights and verifying the signed manifest...';
    try {
      const result = await runVerifiedTinyModel();
      if (!result.ok) {
        status.textContent = 'failed';
        out.innerHTML = `<p class="vrf__empty">Verification failed: ${result.reason || 'unknown'}</p><ul>${renderChecks(result.checks || [])}</ul>`;
        return;
      }
      status.textContent = result.execution.runtime;
      out.innerHTML = [
        `<p class="vrf__empty"><b class="ok-text">Verified and executed.</b> Prediction: ${result.execution.prediction}</p>`,
        `<div class="vw__fields"><div><b>model</b><span>${result.model_id}</span></div><div><b>runtime</b><span>${result.execution.runtime}</span></div><div><b>weights</b><span>${result.weights_sha256.slice(0, 16)}...</span></div><div><b>logits</b><span>${result.execution.logits.join(', ')}</span></div></div>`,
        `<ul>${renderChecks(result.checks)}</ul>`,
      ].join('');
    } catch (e) {
      status.textContent = 'error';
      out.textContent = e && e.message ? e.message : String(e);
    } finally {
      btn.disabled = false;
    }
  });
}

if (typeof window !== 'undefined') {
  window.kolmDeviceRunner = {
    runVerifiedTinyModel,
    verifyWeightManifest,
    canonicalWeightManifest,
    sha256HexBytes,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootDemo);
  else bootDemo();
}
