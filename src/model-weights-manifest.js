// W386 - model-weights manifest.
//
// Authoritative download registry for the frontier model catalog in
// src/model-registry.js. Maps each model_id (verified or candidate) +
// quant variant to a REAL HuggingFace repo + the exact files we need to
// stream-download for local inference.
//
// Design rules:
//   1. Every hf_repo must be a currently-existing repo. Where the W217
//      catalog row is hypothetical/2026-future (e.g. Qwen3.6-27B), we
//      fall back to the closest current-real shipping equivalent
//      (Qwen2.5-32B-Instruct GGUF) and record the fallback in `notes`.
//   2. We prefer single-file GGUFs from well-known re-quant repos
//      (unsloth, bartowski, lmstudio-community) so a download is one
//      HTTP stream, not a 12-shard juggling act.
//   3. We do NOT hardcode SHA256 - that requires touching the network.
//      Caller verifies via the .sha256 file on HF (download alongside
//      the GGUF) or skips verification with --no-verify. If a manifest
//      row includes `sha256`, the puller will verify; otherwise it
//      logs `sha256_unpinned` and accepts the byte count.
//   4. `tier` is the EDGE/MOBILE/LAPTOP/WORKSTATION/DATACENTER bucket
//      keyed off TOTAL DOWNLOAD SIZE, not VRAM. A 5GB Q4 download is
//      "laptop" even if the Q8 fp16 of the same model would be
//      "workstation". This is the right axis for "what should I pull
//      first?" decisions.
//   5. `unavailable: true` on a row means a network probe (HEAD with
//      Range bytes=0-1023) confirmed the URL 404s. Probe-then-mark is
//      done at runtime by `kolm models prefetch`; the static manifest
//      ships with `unavailable: false` for everything and the puller
//      flips it if reality disagrees.
//
// Public API:
//   ALL_VARIANTS - flat array of every (model_id, variant) row.
//   variantsFor(modelId) - all variants for one model.
//   tierTotalBytes(tier) - sum of bytes needed to pull a whole tier.
//   getVariant(id, v) - one row by composite key.
//   listTiers() - distinct tier labels in display order.
//
// W386 - heavy-ML-dep rule: this file is PURE METADATA. No imports of
// torch, transformers, llama.cpp bindings, etc. The puller is a
// node:https stream + crypto.createHash. Stays in default install.

import crypto from 'node:crypto';
import { buildSignatureBlock as buildEd25519Block, verifySignatureBlock as verifyEd25519Block } from './ed25519.js';

export const TIERS = ['edge', 'mobile', 'laptop', 'workstation', 'datacenter'];
export const MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA = 'kolm.model_weight_artifact_manifest.v1';
export const MODEL_WEIGHT_ARTIFACT_SIGNATURE_SPEC = 'kolm-model-weight-artifact-manifest-ed25519-v1';
export const MODEL_WEIGHT_ARTIFACT_MANIFEST_FILENAME = 'model.weight.manifest.json';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SUPPORTED_WEIGHT_ARTIFACT_FORMATS = new Set([
  'gguf',
  'mlc',
  'onnx',
  'wasm',
  'safetensors',
  'tokenizer',
  'config',
  'native',
  'other',
]);
const SUPPORTED_WEIGHT_RUNTIME_TARGETS = new Set([
  'llama.cpp',
  'llama.cpp-webgpu',
  'webllm',
  'onnxruntime-node',
  'onnxruntime-web',
  'webgpu',
  'native',
  'mlc',
]);

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeArtifactPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!s) throw new Error('weight artifact file path is required');
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) {
    throw new Error(`weight artifact file path must be relative, got ${JSON.stringify(p)}`);
  }
  if (s.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`weight artifact file path cannot contain empty or .. segments: ${JSON.stringify(p)}`);
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new Error(`weight artifact file path contains control characters: ${JSON.stringify(p)}`);
  }
  return s;
}

function inferArtifactFormat(file) {
  const path = String(file.path || file.filename || '').toLowerCase();
  const explicit = file.format ? String(file.format).toLowerCase() : null;
  if (explicit && SUPPORTED_WEIGHT_ARTIFACT_FORMATS.has(explicit)) return explicit;
  if (path.endsWith('.gguf')) return 'gguf';
  if (path.endsWith('.onnx')) return 'onnx';
  if (path.endsWith('.wasm')) return 'wasm';
  if (path.endsWith('.safetensors')) return 'safetensors';
  if (path.endsWith('.json')) {
    if (path.includes('tokenizer')) return 'tokenizer';
    return 'config';
  }
  if (path.endsWith('.bin') || path.includes('-mlc/') || path.includes('_mlc/')) return 'mlc';
  return 'other';
}

function runtimeTargetsForFormat(format) {
  if (format === 'gguf') return ['llama.cpp', 'llama.cpp-webgpu'];
  if (format === 'onnx') return ['onnxruntime-node', 'onnxruntime-web'];
  if (format === 'mlc') return ['webllm', 'mlc'];
  if (format === 'wasm') return ['webgpu'];
  if (format === 'native') return ['native'];
  return [];
}

function normalizeRuntimeTargets(targets, files = []) {
  const inferred = [];
  for (const file of files) {
    for (const t of runtimeTargetsForFormat(file.format || inferArtifactFormat(file))) inferred.push(t);
  }
  const all = [...(Array.isArray(targets) ? targets : []), ...inferred]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const deduped = Array.from(new Set(all));
  for (const t of deduped) {
    if (!SUPPORTED_WEIGHT_RUNTIME_TARGETS.has(t)) {
      throw new Error(`unsupported weight runtime target ${JSON.stringify(t)}`);
    }
  }
  return deduped.sort();
}

export function normalizeWeightArtifactFile(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('weight artifact file must be an object');
  }
  const path = normalizeArtifactPath(file.path || file.filename);
  const bytes = Number(file.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`weight artifact file ${path} requires positive integer bytes`);
  }
  const sha256 = String(file.sha256 || '').toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`weight artifact file ${path} requires lowercase 64-hex sha256`);
  }
  const format = inferArtifactFormat({ ...file, path });
  const role = String(file.role || (format === 'wasm' ? 'model_lib' : 'weights'));
  const row = {
    path,
    bytes,
    sha256,
    format,
    role,
  };
  const runtimeTargets = normalizeRuntimeTargets(file.runtime_targets || [], [row]);
  if (runtimeTargets.length) row.runtime_targets = runtimeTargets;
  if (file.source_url) row.source_url = String(file.source_url);
  if (file.source_revision) row.source_revision = String(file.source_revision);
  return row;
}

export function hashWeightArtifactFiles(files) {
  const rows = (files || []).map(normalizeWeightArtifactFile).sort((a, b) => a.path.localeCompare(b.path));
  return sha256Hex(canonicalJson(rows.map((f) => ({
    path: f.path,
    bytes: f.bytes,
    sha256: f.sha256,
    format: f.format,
    role: f.role,
    runtime_targets: f.runtime_targets || [],
    source_url: f.source_url || null,
    source_revision: f.source_revision || null,
  }))));
}

export function buildModelWeightArtifactManifest({
  artifact_id,
  model_id,
  variant,
  runtime_targets,
  files,
  source,
  created_at,
  policy,
} = {}) {
  const normalizedFiles = (files || []).map(normalizeWeightArtifactFile).sort((a, b) => a.path.localeCompare(b.path));
  if (normalizedFiles.length === 0) {
    throw new Error('model weight artifact manifest requires at least one file');
  }
  const targets = normalizeRuntimeTargets(runtime_targets || [], normalizedFiles);
  if (targets.length === 0) {
    throw new Error('model weight artifact manifest requires at least one runtime target');
  }
  const totalBytes = normalizedFiles.reduce((a, f) => a + f.bytes, 0);
  const weightsSha256 = hashWeightArtifactFiles(normalizedFiles);
  return {
    schema: MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA,
    artifact_id: String(artifact_id || `${model_id || 'unknown'}:${variant || 'default'}`),
    model_id: String(model_id || 'unknown'),
    variant: String(variant || 'default'),
    runtime_targets: targets,
    source: source && typeof source === 'object' ? { ...source } : null,
    created_at: created_at || new Date().toISOString(),
    file_count: normalizedFiles.length,
    total_bytes: totalBytes,
    weights_sha256: weightsSha256,
    files: normalizedFiles,
    policy: {
      require_signature: policy?.require_signature !== false,
      no_unsigned_auto_fetch: policy?.no_unsigned_auto_fetch !== false,
      ...(policy?.cache_backend ? { cache_backend: String(policy.cache_backend) } : {}),
    },
  };
}

export function canonicalModelWeightArtifactManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('model weight artifact manifest must be an object');
  }
  const files = (manifest.files || []).map(normalizeWeightArtifactFile).sort((a, b) => a.path.localeCompare(b.path));
  const signed = {
    schema: manifest.schema,
    artifact_id: manifest.artifact_id,
    model_id: manifest.model_id,
    variant: manifest.variant,
    runtime_targets: normalizeRuntimeTargets(manifest.runtime_targets || [], files),
    source: manifest.source || null,
    created_at: manifest.created_at,
    file_count: files.length,
    total_bytes: files.reduce((a, f) => a + f.bytes, 0),
    weights_sha256: hashWeightArtifactFiles(files),
    files,
    policy: manifest.policy || null,
    signature_spec: MODEL_WEIGHT_ARTIFACT_SIGNATURE_SPEC,
  };
  return canonicalJson(signed);
}

export function signModelWeightArtifactManifest(manifest, signer, opts = {}) {
  if (!signer || !signer.privateKey || !signer.publicKey) {
    throw new Error('signModelWeightArtifactManifest requires an Ed25519 signer');
  }
  const payloadCanonical = canonicalModelWeightArtifactManifest(manifest);
  return {
    ...manifest,
    signature_spec: MODEL_WEIGHT_ARTIFACT_SIGNATURE_SPEC,
    signature_ed25519: buildEd25519Block({
      privateKey: signer.privateKey,
      publicKey: signer.publicKey,
      key_fingerprint: signer.key_fingerprint,
      payloadCanonical,
      signed_at: opts.signed_at || manifest.created_at || new Date().toISOString(),
    }),
  };
}

export function verifyModelWeightArtifactManifest(manifest, opts = {}) {
  try {
    if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest missing' };
    if (manifest.schema !== MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA) {
      return { ok: false, reason: `unexpected schema ${JSON.stringify(manifest.schema)}` };
    }
    const files = (manifest.files || []).map(normalizeWeightArtifactFile).sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) return { ok: false, reason: 'files missing' };
    const runtimeTargets = normalizeRuntimeTargets(manifest.runtime_targets || [], files);
    if (runtimeTargets.length === 0) return { ok: false, reason: 'runtime_targets missing' };
    const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    if (manifest.file_count !== files.length) return { ok: false, reason: 'file_count mismatch' };
    if (manifest.total_bytes !== totalBytes) return { ok: false, reason: 'total_bytes mismatch' };
    const expectedWeights = hashWeightArtifactFiles(files);
    if (manifest.weights_sha256 !== expectedWeights) return { ok: false, reason: 'weights_sha256 mismatch' };
    if (opts.require_signature || manifest.policy?.require_signature === true) {
      if (manifest.signature_spec !== MODEL_WEIGHT_ARTIFACT_SIGNATURE_SPEC) {
        return { ok: false, reason: 'signature_spec missing or unexpected' };
      }
      const sig = verifyEd25519Block(manifest.signature_ed25519, canonicalModelWeightArtifactManifest(manifest));
      if (!sig.ok) return { ok: false, reason: `signature invalid: ${sig.reason}` };
    }
    return {
      ok: true,
      file_count: files.length,
      total_bytes: totalBytes,
      weights_sha256: expectedWeights,
      runtime_targets: runtimeTargets,
    };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

export function serializeModelWeightArtifactManifest(manifest) {
  return JSON.stringify(manifest, null, 2);
}

export function hashModelWeightArtifactManifest(manifest) {
  return sha256Hex(Buffer.from(serializeModelWeightArtifactManifest(manifest), 'utf8'));
}

// Convenience: bytes to human.
export function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// Helper: compose a HuggingFace resolve URL for a single file.
//   hf_repo:   "Qwen/Qwen2.5-7B-Instruct-GGUF"
//   revision:  "main"  (or 40-char SHA)
//   file_path: "qwen2.5-7b-instruct-q4_k_m.gguf"
export function hfResolveUrl(hf_repo, revision, file_path) {
  const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${enc(hf_repo)}/resolve/${encodeURIComponent(revision)}/${enc(file_path)}`;
}

// ---------------------------------------------------------------------------
// ALL_VARIANTS - the manifest.
//
// Byte counts below come from public HuggingFace size metadata as of
// 2026-05-18. They are not network-verified by this module; the puller
// records the actual Content-Length when it streams.
//
// Where W217 lists a 2026-future model id, we map to the closest
// currently-shipping equivalent and the notes field calls it out.
// ---------------------------------------------------------------------------
export const ALL_VARIANTS = [
  // ========================================================================
  // EDGE TIER (≤2 GB). Pull on first install, runs on a phone or a 4GB GPU.
  // ========================================================================
  {
    model_id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'smollm2-1.7b-instruct-q4_k_m.gguf', bytes: 1_055_640_000 }],
    total_bytes: 1_055_640_000,
    tier: 'edge',
    notes: 'SmolLM2 1.7B Q4_K_M; canonical edge default.',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', bytes: 397_807_456 }],
    total_bytes: 397_807_456,
    tier: 'edge',
    notes: 'Smallest Qwen 2.5; runs CPU-only in <1s on a laptop.',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
    variant: 'q8_0',
    hf_repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-0.5b-instruct-q8_0.gguf', bytes: 531_065_792 }],
    total_bytes: 531_065_792,
    tier: 'edge',
    notes: 'Q8_0 retains ~99% of fp16 quality for the 0.5B.',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen2.5-1.5B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', bytes: 986_047_584 }],
    total_bytes: 986_047_584,
    tier: 'edge',
    notes: 'Qwen 2.5 1.5B Q4; mobile-class.',
    unavailable: false,
  },
  {
    model_id: 'microsoft/Phi-3.5-mini-instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Phi-3.5-mini-instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Phi-3.5-mini-instruct-Q4_K_M.gguf', bytes: 2_393_232_672 }],
    total_bytes: 2_393_232_672,
    tier: 'edge',
    notes: 'Phi 3.5 mini Q4; sits at the edge/laptop boundary.',
    unavailable: false,
  },
  // Mobile gemma 3n. W349 picked it as the mobile recommendation. There is
  // no public GGUF for the e2b multimodal variant yet, so we ship the
  // closest GGUF: gemma-2-2b-it Q4 (which is what Pixel users actually
  // run today).
  {
    model_id: 'google/gemma-3n-e2b-it',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/gemma-2-2b-it-GGUF',
    hf_revision: 'main',
    files: [{ path: 'gemma-2-2b-it-Q4_K_M.gguf', bytes: 1_708_582_240 }],
    total_bytes: 1_708_582_240,
    tier: 'edge',
    notes: 'Fallback: Gemma 2 2B-it Q4 (Gemma 3n e2b GGUF not yet published).',
    unavailable: false,
  },

  // ========================================================================
  // MOBILE TIER (2-4 GB). Fits on a flagship phone or laptop iGPU.
  // ========================================================================
  {
    model_id: 'Qwen/Qwen2.5-3B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-3b-instruct-q4_k_m.gguf', bytes: 1_929_902_720 }],
    total_bytes: 1_929_902_720,
    tier: 'mobile',
    notes: 'Qwen 2.5 3B Q4; the kolm baseline-recipe daily driver.',
    unavailable: false,
  },
  {
    model_id: 'meta-llama/Llama-3.2-3B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', bytes: 2_019_377_152 }],
    total_bytes: 2_019_377_152,
    tier: 'mobile',
    notes: 'Llama 3.2 3B Q4; comparison default for English-first.',
    unavailable: false,
  },
  {
    model_id: 'meta-llama/Llama-3.2-1B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', bytes: 808_504_672 }],
    total_bytes: 808_504_672,
    tier: 'mobile',
    notes: 'Llama 3.2 1B Q4; phone-class.',
    unavailable: false,
  },

  // ========================================================================
  // LAPTOP TIER (4-12 GB). RTX 3070 / M1/M2 Max / 16GB workstation.
  // ========================================================================
  {
    model_id: 'Qwen/Qwen2.5-7B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-7b-instruct-q4_k_m.gguf', bytes: 4_683_073_344 }],
    total_bytes: 4_683_073_344,
    tier: 'laptop',
    notes: 'Qwen 2.5 7B Q4; the canonical 8GB-VRAM daily driver.',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen2.5-7B-Instruct',
    variant: 'q8_0',
    hf_repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-7b-instruct-q8_0.gguf', bytes: 8_098_524_352 }],
    total_bytes: 8_098_524_352,
    tier: 'laptop',
    notes: 'Qwen 2.5 7B Q8_0; ~99% quality vs fp16.',
    unavailable: false,
  },
  {
    model_id: 'meta-llama/Llama-3.1-8B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', bytes: 4_920_739_840 }],
    total_bytes: 4_920_739_840,
    tier: 'laptop',
    notes: 'Llama 3.1 8B Q4; comparison default.',
    unavailable: false,
  },
  {
    model_id: 'mistralai/Mistral-7B-Instruct-v0.3',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf', bytes: 4_368_440_416 }],
    total_bytes: 4_368_440_416,
    tier: 'laptop',
    notes: 'Mistral 7B Q4; Apache 2.0 alternate to Qwen 7B.',
    unavailable: false,
  },
  {
    model_id: 'google/gemma-2-9b-it',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/gemma-2-9b-it-GGUF',
    hf_revision: 'main',
    files: [{ path: 'gemma-2-9b-it-Q4_K_M.gguf', bytes: 5_761_057_792 }],
    total_bytes: 5_761_057_792,
    tier: 'laptop',
    notes: 'Gemma 2 9B Q4; 140-language alternate.',
    unavailable: false,
  },
  // Qwen3-Coder fallback to Qwen2.5-Coder (current real shipping coder model).
  {
    model_id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', bytes: 4_683_073_344 }],
    total_bytes: 4_683_073_344,
    tier: 'laptop',
    notes: 'Fallback: Qwen 2.5 Coder 7B Q4 (Qwen3-Coder-30B-A3B GGUF not yet shipped).',
    unavailable: false,
  },

  // ========================================================================
  // WORKSTATION TIER (12-50 GB). RTX 4090/5090, single A100, Apple M3 Ultra.
  // ========================================================================
  {
    model_id: 'Qwen/Qwen2.5-14B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-14b-instruct-q4_k_m.gguf', bytes: 8_988_109_120 }],
    total_bytes: 8_988_109_120,
    tier: 'workstation',
    notes: 'Qwen 2.5 14B Q4; fits 12GB+ GPUs with KV-cache room.',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen2.5-32B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-32b-instruct-q4_k_m.gguf', bytes: 19_851_348_768 }],
    total_bytes: 19_851_348_768,
    tier: 'workstation',
    notes: 'Qwen 2.5 32B Q4; canonical RTX 5090 daily driver.',
    unavailable: false,
  },
  // Qwen 3.6/3.5 not shipped; fall back to Qwen 2.5 32B as the closest dense.
  {
    model_id: 'Qwen/Qwen3.6-27B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-32b-instruct-q4_k_m.gguf', bytes: 19_851_348_768 }],
    total_bytes: 19_851_348_768,
    tier: 'workstation',
    notes: 'Fallback: Qwen 2.5 32B Q4 (Qwen 3.6 27B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen3.5-27B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-32b-instruct-q4_k_m.gguf', bytes: 19_851_348_768 }],
    total_bytes: 19_851_348_768,
    tier: 'workstation',
    notes: 'Fallback: Qwen 2.5 32B Q4 (Qwen 3.5 27B not yet shipped).',
    unavailable: false,
  },
  // Gemma 3 27B fallback to the closest stable GGUF bundle until the operator
  // pins an exact Gemma 3 27B quantized artifact.
  {
    model_id: 'google/gemma-3-27b-it',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/gemma-2-27b-it-GGUF',
    hf_revision: 'main',
    files: [{ path: 'gemma-2-27b-it-Q4_K_M.gguf', bytes: 16_645_383_456 }],
    total_bytes: 16_645_383_456,
    tier: 'workstation',
    notes: 'Operational fallback: Gemma 2 27B-it Q4 for Gemma-family workstation tests; pin an exact Gemma 3 27B quantized bundle before claiming Gemma 3 weight parity.',
    unavailable: false,
  },
  {
    model_id: 'google/gemma-2-27b-it',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/gemma-2-27b-it-GGUF',
    hf_revision: 'main',
    files: [{ path: 'gemma-2-27b-it-Q4_K_M.gguf', bytes: 16_645_383_456 }],
    total_bytes: 16_645_383_456,
    tier: 'workstation',
    notes: 'Gemma 2 27B Q4; runs on RTX 4090/5090.',
    unavailable: false,
  },
  // Carnice / Hermes 4.3 / etc. - fall back to the closest current.
  {
    model_id: 'cerebras/Carnice-35B-A3B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-32b-instruct-q4_k_m.gguf', bytes: 19_851_348_768 }],
    total_bytes: 19_851_348_768,
    tier: 'workstation',
    notes: 'Fallback: Qwen 2.5 32B Q4 (Carnice 35B-A3B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'NousResearch/Hermes-4.3-36B',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Hermes-3-Llama-3.1-8B-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf', bytes: 4_920_739_840 }],
    total_bytes: 4_920_739_840,
    tier: 'laptop',
    notes: 'Fallback: Hermes 3 Llama 8B Q4 (Hermes 4.3 36B not yet shipped).',
    unavailable: false,
  },

  // ========================================================================
  // DATACENTER TIER (50GB+). Full 70B+ at Q5/Q6, MoE quantizations, etc.
  // Pull-on-demand; not part of `kolm models prefetch` default tier.
  // ========================================================================
  {
    model_id: 'Qwen/Qwen2.5-72B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-72B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-72b-instruct-q4_k_m.gguf', bytes: 47_415_700_032 }],
    total_bytes: 47_415_700_032,
    tier: 'datacenter',
    notes: 'Qwen 2.5 72B Q4; fits DGX Spark 128GB unified.',
    unavailable: false,
  },
  {
    model_id: 'meta-llama/Llama-3.1-70B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Meta-Llama-3.1-70B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Meta-Llama-3.1-70B-Instruct-Q4_K_M.gguf', bytes: 42_520_393_376 }],
    total_bytes: 42_520_393_376,
    tier: 'datacenter',
    notes: 'Llama 3.1 70B Q4; H100 80GB at Q4 or DGX Spark at Q6.',
    unavailable: false,
  },
  // Step / DeepSeek v4 PRO/Flash / GLM 4.7/4.5 / Qwen3-VL / Kimi K2.5 - all
  // 2026-future. We do NOT ship fake URLs; the row references the closest
  // current shipping model and the notes call out the gap.
  {
    model_id: 'deepseek-ai/DeepSeek-V4-PRO-1.6T',
    variant: 'q2_k',
    hf_repo: 'bartowski/DeepSeek-V2.5-1210-GGUF',
    hf_revision: 'main',
    files: [{ path: 'DeepSeek-V2.5-1210-IQ2_M.gguf', bytes: 76_900_000_000 }],
    total_bytes: 76_900_000_000,
    tier: 'datacenter',
    notes: 'Fallback: DeepSeek V2.5 IQ2 (DeepSeek V4 PRO 1.6T not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-158B',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/DeepSeek-V2.5-1210-GGUF',
    hf_revision: 'main',
    files: [{ path: 'DeepSeek-V2.5-1210-Q4_K_M.gguf', bytes: 142_400_000_000 }],
    total_bytes: 142_400_000_000,
    tier: 'datacenter',
    notes: 'Fallback: DeepSeek V2.5 Q4_K_M (DeepSeek V4 Flash 158B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'stepfun-ai/step3.5-flash-reap-121b',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-72B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-72b-instruct-q4_k_m.gguf', bytes: 47_415_700_032 }],
    total_bytes: 47_415_700_032,
    tier: 'datacenter',
    notes: 'Fallback: Qwen 2.5 72B Q4 (Step 3.5 Flash REAP 121B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'zai-org/GLM-4.7-Flash',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/glm-4-9b-chat-GGUF',
    hf_revision: 'main',
    files: [{ path: 'glm-4-9b-chat-Q4_K_M.gguf', bytes: 5_958_376_352 }],
    total_bytes: 5_958_376_352,
    tier: 'laptop',
    notes: 'Fallback: GLM 4 9B chat Q4 (GLM 4.7 Flash 70B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'zai-org/GLM-4.5-Air-REAP-82B-A12B',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/glm-4-9b-chat-GGUF',
    hf_revision: 'main',
    files: [{ path: 'glm-4-9b-chat-Q4_K_M.gguf', bytes: 5_958_376_352 }],
    total_bytes: 5_958_376_352,
    tier: 'laptop',
    notes: 'Fallback: GLM 4 9B chat Q4 (GLM 4.5 Air REAP 82B-A12B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Qwen2-VL-7B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Qwen2-VL-7B-Instruct-Q4_K_M.gguf', bytes: 4_683_073_344 }],
    total_bytes: 4_683_073_344,
    tier: 'laptop',
    notes: 'Fallback: Qwen2-VL 7B Q4 (Qwen3-VL 235B-A22B not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'moonshotai/Kimi-K2.5-1T',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-72B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-72b-instruct-q4_k_m.gguf', bytes: 47_415_700_032 }],
    total_bytes: 47_415_700_032,
    tier: 'datacenter',
    notes: 'Fallback: Qwen 2.5 72B Q4 (Kimi K2.5 1T not yet shipped).',
    unavailable: false,
  },
  {
    model_id: 'nvidia/Nemotron-3-Nano-Omni-30B-A3B',
    variant: 'q4_k_m',
    hf_repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'qwen2.5-32b-instruct-q4_k_m.gguf', bytes: 19_851_348_768 }],
    total_bytes: 19_851_348_768,
    tier: 'workstation',
    notes: 'Fallback: Qwen 2.5 32B Q4 (Nemotron 3 Nano Omni 30B-A3B not yet shipped).',
    unavailable: false,
  },
  // Bonus: meta-llama/Llama-3.1-405B-Instruct at Q4 is 230GB+ - listed but
  // exceeds disk budget for most users.
  {
    model_id: 'meta-llama/Llama-3.1-405B-Instruct',
    variant: 'q4_k_m',
    hf_repo: 'bartowski/Meta-Llama-3.1-70B-Instruct-GGUF',
    hf_revision: 'main',
    files: [{ path: 'Meta-Llama-3.1-70B-Instruct-Q4_K_M.gguf', bytes: 42_520_393_376 }],
    total_bytes: 42_520_393_376,
    tier: 'datacenter',
    notes: 'Fallback: Llama 3.1 70B Q4 (405B Q4 ~230GB exceeds default disk budget).',
    unavailable: false,
  },
];

// ---------------------------------------------------------------------------
// Public accessors.
// ---------------------------------------------------------------------------

export function variantsFor(modelId) {
  return ALL_VARIANTS.filter((v) => v.model_id === modelId);
}

export function getVariant(modelId, variant) {
  return ALL_VARIANTS.find((v) => v.model_id === modelId && v.variant === variant) || null;
}

export function tierTotalBytes(tier) {
  return ALL_VARIANTS.filter((v) => v.tier === tier).reduce((a, v) => a + (v.total_bytes || 0), 0);
}

export function listTiers() { return TIERS.slice(); }

export function listVariantsByTier(tier) {
  return ALL_VARIANTS.filter((v) => v.tier === tier);
}

export function listModelIds() {
  return Array.from(new Set(ALL_VARIANTS.map((v) => v.model_id)));
}

// Sanity: every model in the W217 frontier+candidate catalog should have at
// least one variant row here. This is asserted by the wave386 test suite.
export function coverageReport(frontierIds, candidateIds) {
  const covered = new Set(listModelIds());
  const missing_frontier = (frontierIds || []).filter((id) => !covered.has(id));
  const missing_candidate = (candidateIds || []).filter((id) => !covered.has(id));
  return {
    total_variants: ALL_VARIANTS.length,
    distinct_models: covered.size,
    missing_frontier,
    missing_candidate,
  };
}

export default {
  TIERS,
  MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA,
  MODEL_WEIGHT_ARTIFACT_SIGNATURE_SPEC,
  MODEL_WEIGHT_ARTIFACT_MANIFEST_FILENAME,
  ALL_VARIANTS,
  fmtBytes,
  hfResolveUrl,
  normalizeWeightArtifactFile,
  hashWeightArtifactFiles,
  buildModelWeightArtifactManifest,
  canonicalModelWeightArtifactManifest,
  signModelWeightArtifactManifest,
  verifyModelWeightArtifactManifest,
  serializeModelWeightArtifactManifest,
  hashModelWeightArtifactManifest,
  variantsFor,
  getVariant,
  tierTotalBytes,
  listTiers,
  listVariantsByTier,
  listModelIds,
  coverageReport,
};
