// W866 - kolm hardware detection.
//
// Single source of truth for "what GPU is on this host, and which quantization
// methods can it run natively?" Used by:
//
//   - cli/kolm.js (cmdHardware, cmdFit)
//   - src/router.js GET /v1/hardware + GET /v1/fit
//   - public/account/hardware.html (auto-detect button)
//   - W873 hardware-aware target selection in compile pipeline
//
// Detection is layered: nvidia-smi → rocm-smi → system_profiler (Mac) → wmic
// (Windows DXGI fallback) → CPU-only floor. Each layer is a separate function
// that returns a partial GpuProfile{} or null. detectHardware() composes.
//
// We do NOT report fake capabilities. If the host has no GPU, we honestly
// report `{vendor:'cpu', native_dtypes:['fp16','bf16','int8'], supported_methods:['gguf','hqq']}`
// - never invent NVFP4 support on a CPU box.
//
// Compute capability → native dtype mapping (W871 binding):
//   Blackwell 10.0+  → NVFP4, FP8, INT8, INT4
//   Hopper    9.0    → FP8, INT8, INT4
//   Ada       8.9    → INT8, INT4
//   Ampere    8.0-8.6→ INT8, INT4
//   Apple Silicon    → MLX 4/8 (separate kernel family)
//   ROCm CDNA        → FP8 (MI300+), INT8, INT4
//   CPU              → GGUF Q4_K_M default, HQQ in CPU mode

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {
  BYTES_PER_PARAM,
  estimateMemoryFit,
  pickBestFitTarget,
  safeFitError,
} from './forge-fit.js';
import {
  estimateKvCacheBytes as _estimateKvCacheBytes,
  estimateShardKvCacheBytes as _estimateShardKvCacheBytes,
  maxContextAtVram as _maxContextAtVram,
} from './kv-cache-shard.js';

export const HARDWARE_VERSION = 'forge-hardware-v1';
export const ARTIFACT_FIT_VERSION = 'w977-artifact-fit-v1';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

const QUANT_ALIASES = Object.freeze({
  q2k: 'gguf-q2k',
  q2_k: 'gguf-q2k',
  ggufq2k: 'gguf-q2k',
  q3km: 'gguf-q3km',
  q3_k_m: 'gguf-q3km',
  ggufq3km: 'gguf-q3km',
  q4km: 'gguf-q4km',
  q4_k_m: 'gguf-q4km',
  ggufq4km: 'gguf-q4km',
  q5km: 'gguf-q5km',
  q5_k_m: 'gguf-q5km',
  ggufq5km: 'gguf-q5km',
  q6k: 'gguf-q6k',
  q6_k: 'gguf-q6k',
  ggufq6k: 'gguf-q6k',
  q8: 'gguf-q8',
  q8_0: 'gguf-q8',
  ggufq8: 'gguf-q8',
  iq4xs: 'gguf-iq4xs',
  iq4_xs: 'gguf-iq4xs',
  iq3xxs: 'gguf-iq3xxs',
  iq3_xxs: 'gguf-iq3xxs',
  iq2xs: 'gguf-iq2xs',
  iq2_xs: 'gguf-iq2xs',
  gptq: 'gptq-4bit',
  gptq4bit: 'gptq-4bit',
  awq: 'awq-4bit',
  awq4bit: 'awq-4bit',
  nf4: 'int4',
  bnb4bit: 'int4',
  bitsandbytes4bit: 'int4',
  fourbit: 'int4',
  int4: 'int4',
  int8: 'int8',
  fp8: 'fp8',
  nvfp4: 'nvfp4',
  fp16: 'fp16',
  bf16: 'bf16',
  hqq: 'hqq',
  exl2: 'exl2',
  mlx4bit: 'mlx-4bit',
  mlx_4bit: 'mlx-4bit',
});

// Every quant method the Forge knows how to dispatch. Keep in sync with
// src/quantization-oracle.js METHOD_CATALOG and tests/wave867+.
export const ALL_METHODS = Object.freeze([
  'gguf-q2k', 'gguf-q3km', 'gguf-q4km', 'gguf-q5km', 'gguf-q6k', 'gguf-q8',
  'gguf-iq4xs', 'gguf-iq3xxs', 'gguf-iq2xs',  // imatrix family (W868)
  'exl2',        // EXL2 variable bpw (W869)
  'gptq-4bit',   // GPTQ (W870)
  'awq-4bit',    // AWQ (W870)
  'nvfp4',       // Blackwell NVFP4 microscaling (W871)
  'fp8',         // Hopper FP8 E4M3 (W871)
  'hqq',         // HQQ calibration-free (W872)
  'mlx-4bit',    // Apple Silicon MLX (W869c)
  'int4',        // bitsandbytes NF4 + double (already in worker)
  'int8',        // bitsandbytes LLM.int8 (already in worker)
]);

// Compute capability → native dtype family.
// Keep this conservative: if we're not certain, we don't claim it.
function dtypesForComputeCapability(cc) {
  if (!cc || typeof cc !== 'string') return ['fp16'];
  const [major, minor] = cc.split('.').map(s => parseInt(s, 10));
  if (!Number.isFinite(major)) return ['fp16'];
  // Blackwell (consumer 10.0, datacenter 10.0+ B100/B200/GB10)
  if (major >= 10) return ['nvfp4', 'fp8', 'fp16', 'bf16', 'int8', 'int4'];
  // Hopper (H100/H200)
  if (major === 9) return ['fp8', 'fp16', 'bf16', 'int8', 'int4'];
  // Ada Lovelace (RTX 4xxx, L40)
  if (major === 8 && minor >= 9) return ['fp16', 'bf16', 'int8', 'int4'];
  // Ampere (A100, RTX 30xx)
  if (major === 8) return ['fp16', 'bf16', 'int8', 'int4'];
  // Turing (RTX 20xx, T4) - INT8 yes, INT4 limited
  if (major === 7 && minor >= 5) return ['fp16', 'int8'];
  // Volta (V100) - FP16 only
  if (major === 7) return ['fp16'];
  // Pascal and older - FP16 emulation
  return ['fp16'];
}

// Map (vendor, dtypes) → quant methods the host can run natively.
function methodsForDtypes(vendor, dtypes) {
  const set = new Set();
  // GGUF + HQQ run anywhere with enough RAM (CPU fallback is real)
  for (const m of ['gguf-q2k', 'gguf-q3km', 'gguf-q4km', 'gguf-q5km', 'gguf-q6k', 'gguf-q8',
                   'gguf-iq4xs', 'gguf-iq3xxs', 'gguf-iq2xs', 'hqq']) {
    set.add(m);
  }
  // GPU-only families
  if (vendor === 'nvidia' || vendor === 'amd' || vendor === 'intel') {
    if (dtypes.includes('int4')) {
      set.add('int4');
      set.add('gptq-4bit');
      set.add('awq-4bit');
      set.add('exl2');
    }
    if (dtypes.includes('int8')) set.add('int8');
    if (dtypes.includes('fp8')) set.add('fp8');
    if (dtypes.includes('nvfp4')) set.add('nvfp4');
  }
  if (vendor === 'apple') {
    set.add('mlx-4bit');
  }
  return Array.from(set).sort();
}

// Parse `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`.
// Returns GpuProfile[] or null on failure.
function detectNvidia() {
  try {
    const res = spawnSync('nvidia-smi', [
      '--query-gpu=name,memory.total,compute_cap,driver_version',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const gpus = res.stdout.trim().split('\n').map(line => {
      const [name, memMb, cc, driver] = line.split(',').map(s => s.trim());
      return {
        vendor: 'nvidia',
        name: name || 'NVIDIA GPU',
        vram_gb: Math.round(parseFloat(memMb || '0') / 1024 * 10) / 10,
        compute_capability: cc || null,
        driver_version: driver || null,
        native_dtypes: dtypesForComputeCapability(cc),
      };
    }).filter(g => g.vram_gb > 0);
    return gpus.length ? gpus : null;
  } catch { return null; }
}

// AMD ROCm via rocm-smi --showmeminfo VRAM --showproductname --json
function detectAmd() {
  try {
    const res = spawnSync('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json'],
      { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout);
    const gpus = [];
    for (const [cardKey, info] of Object.entries(parsed)) {
      if (!cardKey.startsWith('card')) continue;
      const name = info['Card series'] || info['Card model'] || 'AMD GPU';
      const vramBytes = parseInt(info['VRAM Total Memory (B)'] || '0', 10);
      // CDNA3 (MI300) supports FP8; rest INT8/INT4
      const isCdna3 = /MI3\d{2}/i.test(name);
      gpus.push({
        vendor: 'amd',
        name,
        vram_gb: Math.round(vramBytes / 1024 / 1024 / 1024 * 10) / 10,
        compute_capability: isCdna3 ? 'cdna3' : 'cdna',
        native_dtypes: isCdna3 ? ['fp8', 'fp16', 'bf16', 'int8', 'int4']
                                : ['fp16', 'bf16', 'int8', 'int4'],
      });
    }
    return gpus.length ? gpus : null;
  } catch { return null; }
}

// Apple Silicon via system_profiler SPDisplaysDataType -json
function detectApple() {
  if (os.platform() !== 'darwin') return null;
  try {
    const res = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'],
      { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout);
    const displays = parsed.SPDisplaysDataType || [];
    const apple = displays.find(d => /Apple/i.test(d.sppci_model || d._name || ''));
    if (!apple) return null;
    const name = apple.sppci_model || apple._name || 'Apple Silicon';
    // Unified memory: pull from sysctl hw.memsize
    const memRes = spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8', timeout: 2000 });
    const unifiedGb = memRes.status === 0
      ? Math.round(parseInt(memRes.stdout.trim(), 10) / 1024 / 1024 / 1024)
      : 0;
    return [{
      vendor: 'apple',
      name,
      vram_gb: unifiedGb,  // unified memory: all of system RAM is addressable
      compute_capability: 'apple-silicon',
      native_dtypes: ['fp16', 'bf16', 'int8', 'int4'],
    }];
  } catch { return null; }
}

// Windows DXGI fallback via wmic. Cheap, covers Intel iGPU + DirectML class.
function detectWindowsDxgi() {
  if (os.platform() !== 'win32') return null;
  try {
    const res = spawnSync('wmic', ['path', 'Win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv'],
      { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) return null;
    const lines = res.stdout.trim().split('\n').slice(1);
    const gpus = lines.map(line => {
      const parts = line.split(',');
      if (parts.length < 3) return null;
      const ramBytes = parseInt(parts[1] || '0', 10);
      const name = (parts[2] || '').trim();
      if (!name) return null;
      const vendor = /nvidia/i.test(name) ? 'nvidia'
                   : /amd|radeon/i.test(name) ? 'amd'
                   : /intel/i.test(name) ? 'intel'
                   : 'unknown';
      return {
        vendor,
        name,
        vram_gb: Math.round(ramBytes / 1024 / 1024 / 1024 * 10) / 10,
        compute_capability: null,
        native_dtypes: ['fp16', 'int8'],
      };
    }).filter(g => g && g.vram_gb > 0);
    return gpus.length ? gpus : null;
  } catch { return null; }
}

// CPU-only honest baseline. NEVER returns null - every host has a CPU.
function cpuProfile() {
  const totalRam = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  return [{
    vendor: 'cpu',
    name: `CPU (${os.cpus().length} cores, ${os.cpus()[0]?.model || 'unknown'})`,
    vram_gb: totalRam,
    compute_capability: 'cpu',
    native_dtypes: ['fp16', 'bf16', 'int8'],
  }];
}

/**
 * Detect every GPU on this host plus a CPU floor. Honest about absence.
 * @returns {Object} { primary: GpuProfile, all: GpuProfile[], detected_at: ISO }
 *   GpuProfile = { vendor, name, vram_gb, compute_capability, native_dtypes,
 *                  supported_methods }
 */
export function detectHardware() {
  const detected = [];
  for (const fn of [detectNvidia, detectAmd, detectApple, detectWindowsDxgi]) {
    const gpus = fn();
    if (gpus) detected.push(...gpus);
  }
  if (detected.length === 0) detected.push(...cpuProfile());
  // Annotate each with supported_methods
  for (const g of detected) {
    g.supported_methods = methodsForDtypes(g.vendor, g.native_dtypes);
  }
  // Primary = highest VRAM
  const primary = detected.slice().sort((a, b) => b.vram_gb - a.vram_gb)[0];
  return {
    primary,
    all: detected,
    detected_at: new Date().toISOString(),
    forge_hardware_version: HARDWARE_VERSION,
  };
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveInt(value, fallback) {
  const n = positiveNumber(value);
  return n == null ? fallback : Math.max(1, Math.trunc(n));
}

function firstPositive(...values) {
  for (const value of values) {
    const n = positiveNumber(value);
    if (n != null) return n;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeQuantMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (BYTES_PER_PARAM[raw]) return raw;

  const compact = raw.replace(/[^a-z0-9]+/g, '');
  if (QUANT_ALIASES[raw]) return QUANT_ALIASES[raw];
  if (QUANT_ALIASES[compact]) return QUANT_ALIASES[compact];
  if (/gptq/.test(raw)) return 'gptq-4bit';
  if (/awq/.test(raw)) return 'awq-4bit';
  if (/q4[_-]?k[_-]?m|q4km/.test(raw)) return 'gguf-q4km';
  if (/q5[_-]?k[_-]?m|q5km/.test(raw)) return 'gguf-q5km';
  if (/q6[_-]?k|q6k/.test(raw)) return 'gguf-q6k';
  if (/q8[_-]?0|q8/.test(raw)) return 'gguf-q8';
  if (/mlx.*4/.test(raw)) return 'mlx-4bit';
  if (/4\s*bit|nf4|int4/.test(raw)) return 'int4';
  return null;
}

function normalizeKvPrecision(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['fp16', 'bf16', 'fp8', 'int8', 'int4'].includes(raw)) return raw;
  if (/fp8/.test(raw)) return 'fp8';
  if (/int8/.test(raw)) return 'int8';
  if (/int4|4\s*bit/.test(raw)) return 'int4';
  return 'fp16';
}

function parseManifestJson(text, source) {
  if (Buffer.byteLength(String(text || ''), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('artifact_manifest_too_large');
  }
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('artifact_manifest_not_object');
  }
  return { ok: true, manifest, source };
}

export function readArtifactManifest(artifactPath) {
  const target = String(artifactPath || '').trim();
  if (!target) return { ok: false, reason: 'artifact_path_missing', manifest: null, source: null };
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const manifestPath = `${target.replace(/[\\/]+$/, '')}/manifest.json`;
      const manifestStat = fs.statSync(manifestPath);
      if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('artifact_manifest_too_large');
      return parseManifestJson(fs.readFileSync(manifestPath, 'utf8'), 'directory:manifest.json');
    }
    if (!stat.isFile()) return { ok: false, reason: 'artifact_path_not_file', manifest: null, source: null };

    const lower = target.toLowerCase();
    if (lower.endsWith('.json') || lower.endsWith('.manifest')) {
      if (stat.size > MAX_MANIFEST_BYTES) throw new Error('artifact_manifest_too_large');
      return parseManifestJson(fs.readFileSync(target, 'utf8'), 'json:file');
    }

    const zip = new AdmZip(target);
    const entry = zip.getEntry('manifest.json');
    if (!entry) return { ok: false, reason: 'artifact_manifest_missing', manifest: null, source: 'zip' };
    const data = entry.getData();
    if (data.length > MAX_MANIFEST_BYTES) throw new Error('artifact_manifest_too_large');
    return parseManifestJson(data.toString('utf8'), 'zip:manifest.json');
  } catch (error) {
    return {
      ok: false,
      reason: 'artifact_manifest_unreadable',
      error: String(error && error.message || error).slice(0, 160),
      manifest: null,
      source: null,
    };
  }
}

export function artifactFitDescriptor(manifest = {}) {
  const target = manifest.target_device && typeof manifest.target_device === 'object'
    ? manifest.target_device
    : {};
  const runtime = manifest.runtime_profile && typeof manifest.runtime_profile === 'object'
    ? manifest.runtime_profile
    : {};
  const runtimeConfig = manifest.runtime_target_config && typeof manifest.runtime_target_config === 'object'
    ? manifest.runtime_target_config
    : {};
  const training = manifest.training && typeof manifest.training === 'object'
    ? manifest.training
    : {};
  const weightManifest = manifest.model_weight_artifact_manifest && typeof manifest.model_weight_artifact_manifest === 'object'
    ? manifest.model_weight_artifact_manifest
    : {};
  const quantBlock = manifest.quant_descriptor || manifest.kernel_descriptor ||
    manifest.quantization_config || manifest.quantize_config || manifest.quantization || {};
  const quantObject = quantBlock && typeof quantBlock === 'object' ? quantBlock : {};

  const model_params_b = firstPositive(
    manifest.model_params_b,
    manifest.params_b,
    manifest.total_params_b,
    manifest.active_params_b,
    runtime.model_params_b,
    runtime.params_b,
    runtimeConfig.model_params_b,
    runtimeConfig.params_b,
    training.student_params_b,
    training.params_b,
    weightManifest.model_params_b,
    weightManifest.params_b,
    target.model_params_b,
    target.params_b,
  );
  const memory_requirement_mb = firstPositive(
    manifest.memory_requirement_mb,
    runtime.memory_requirement_mb,
    runtimeConfig.memory_requirement_mb,
    weightManifest.memory_requirement_mb,
    target.memory_requirement_mb,
  );
  const quant = normalizeQuantMethod(firstString(
    manifest.quant,
    manifest.quantization,
    manifest.quant_method,
    quantObject.method,
    quantObject.quant,
    quantObject.quantization,
    quantObject.quant_method,
    runtime.quant,
    runtimeConfig.quant,
    weightManifest.quant,
    weightManifest.quantization,
  ));

  return {
    version: ARTIFACT_FIT_VERSION,
    model_params_b,
    quant,
    context: positiveInt(
      manifest.context_length ?? manifest.max_context ?? runtime.context_length ??
        runtimeConfig.context_length ?? weightManifest.context_length,
      8192,
    ),
    batch: positiveInt(
      manifest.batch ?? manifest.batch_size ?? runtime.batch ?? runtimeConfig.batch_size,
      1,
    ),
    kv_precision: normalizeKvPrecision(firstString(
      manifest.kv_precision,
      runtime.kv_precision,
      runtimeConfig.kv_precision,
    ) || 'fp16'),
    memory_requirement_mb,
    base_model: firstString(manifest.base_model, training.student, runtime.base_model, weightManifest.base_model),
    has_estimator_inputs: model_params_b != null,
    has_declared_memory: memory_requirement_mb != null,
  };
}

function supportedMethodsForPrimary(primary = {}) {
  if (Array.isArray(primary.supported_methods) && primary.supported_methods.length > 0) {
    return primary.supported_methods.slice();
  }
  return methodsForDtypes(primary.vendor || 'cpu', Array.isArray(primary.native_dtypes) ? primary.native_dtypes : []);
}

function fallbackArtifactFit(hw, manifestRead) {
  const primary = hw.primary || {};
  const supported = supportedMethodsForPrimary(primary);
  const fits = positiveNumber(primary.vram_gb) >= 4 && primary.vendor !== 'cpu';
  return {
    fits,
    primary,
    reason: manifestRead && manifestRead.reason
      ? `manifest_${manifestRead.reason}`
      : (fits ? 'gpu_class_with_sufficient_vram' : (primary.vendor === 'cpu' ? 'cpu_only_falls_back_to_gguf' : 'insufficient_vram')),
    recommended_targets: supported.slice(0, 3),
    manifest_source: manifestRead ? manifestRead.source : null,
    artifact: null,
    fit: null,
    target_pick: null,
    forge_hardware_version: HARDWARE_VERSION,
    artifact_fit_version: ARTIFACT_FIT_VERSION,
  };
}

/**
 * Will this artifact run on this hardware?
 * @param {string} artifactPath path to .kolm artifact, manifest directory, or manifest JSON
 * @returns {Object} { fits: bool, primary, reason, recommended_targets[] }
 */
export function willArtifactFit(artifactPath, opts = {}) {
  const hw = opts.hardware || detectHardware();
  const primary = hw.primary || {};
  const vram_gb = positiveNumber(primary.vram_gb);
  const supported = supportedMethodsForPrimary(primary);
  const manifestRead = opts.manifest
    ? { ok: true, manifest: opts.manifest, source: 'opts.manifest' }
    : readArtifactManifest(artifactPath);
  if (!manifestRead.ok) return fallbackArtifactFit(hw, manifestRead);

  const artifact = artifactFitDescriptor(manifestRead.manifest);
  if (!vram_gb) return {
    fits: false,
    primary,
    reason: 'hardware_vram_unknown',
    recommended_targets: supported.slice(0, 3),
    manifest_source: manifestRead.source,
    artifact,
    fit: null,
    target_pick: null,
    forge_hardware_version: HARDWARE_VERSION,
    artifact_fit_version: ARTIFACT_FIT_VERSION,
  };

  if (artifact.has_estimator_inputs) {
    let fit = null;
    let target_pick = null;
    try {
      if (artifact.quant) {
        fit = estimateMemoryFit({
          model_params_b: artifact.model_params_b,
          quant: artifact.quant,
          vram_gb,
          context: artifact.context,
          batch: artifact.batch,
          kv_precision: artifact.kv_precision,
        });
      }
      target_pick = pickBestFitTarget({
        model_params_b: artifact.model_params_b,
        vram_gb,
        context: artifact.context,
        batch: artifact.batch,
        kv_precision: artifact.kv_precision,
        supported_methods: supported,
      });
    } catch (error) {
      return {
        fits: false,
        primary,
        reason: safeFitError(error),
        recommended_targets: supported.slice(0, 3),
        manifest_source: manifestRead.source,
        artifact,
        fit,
        target_pick,
        forge_hardware_version: HARDWARE_VERSION,
        artifact_fit_version: ARTIFACT_FIT_VERSION,
      };
    }
    const quantSupported = artifact.quant ? supported.includes(artifact.quant) : Boolean(target_pick && target_pick.picked);
    const fits = artifact.quant
      ? Boolean(fit && fit.fits && quantSupported)
      : Boolean(target_pick && target_pick.picked);
    const recommended = artifact.quant && quantSupported
      ? [artifact.quant, ...supported.filter((m) => m !== artifact.quant)].slice(0, 3)
      : [target_pick && target_pick.picked, ...supported].filter(Boolean).slice(0, 3);
    return {
      fits,
      primary,
      reason: fits
        ? 'manifest_estimate_fits'
        : (quantSupported ? 'manifest_estimate_exceeds_vram' : 'artifact_quant_not_supported_by_primary'),
      recommended_targets: recommended,
      manifest_source: manifestRead.source,
      artifact,
      fit,
      target_pick,
      forge_hardware_version: HARDWARE_VERSION,
      artifact_fit_version: ARTIFACT_FIT_VERSION,
    };
  }

  if (artifact.has_declared_memory) {
    const required_gb = Math.round((artifact.memory_requirement_mb / 1024) * 10) / 10;
    const fits = required_gb <= vram_gb;
    return {
      fits,
      primary,
      reason: fits ? 'manifest_memory_requirement_fits' : 'manifest_memory_requirement_exceeds_vram',
      recommended_targets: supported.slice(0, 3),
      manifest_source: manifestRead.source,
      artifact: { ...artifact, required_gb },
      fit: null,
      target_pick: null,
      forge_hardware_version: HARDWARE_VERSION,
      artifact_fit_version: ARTIFACT_FIT_VERSION,
    };
  }

  return fallbackArtifactFit(hw, { ...manifestRead, reason: 'missing_fit_fields' });
}

/**
 * Estimate which models fit at Q4 given primary GPU VRAM.
 * Rough: Q4 ≈ 0.55 bytes/param + 2x KV cache scaling.
 * @returns {Array<{params_b, fits, est_vram_gb}>}
 */
export function modelFitGrid() {
  const hw = detectHardware();
  const vram = hw.primary.vram_gb;
  const sizes = [7, 14, 27, 32, 70, 123, 235, 400];
  return sizes.map(b => {
    const estVram = Math.round(b * 0.55 * 10) / 10;  // Q4 weights only
    const fits = estVram <= vram * 0.85;             // 15% headroom
    const tight = estVram > vram * 0.7 && estVram <= vram * 0.85;
    return { params_b: b, est_vram_gb: estVram, fits, tight };
  });
}

/**
 * KV cache footprint in bytes for one decode-only context length.
 *
 * Delegates to src/kv-cache-shard.js so the math stays in one place and
 * the test suite (tests/wrapper-shard.test.js) pins exactly one
 * implementation. `useShard=false` returns the default FP16 ceiling that
 * memory-fit planners have used since W866; `useShard=true` returns the
 * Shard-compressed ceiling and is what the "with Shard" column in the
 * dry-run fit table reports.
 *
 * modelConfig requires {num_hidden_layers, num_key_value_heads, head_dim}.
 * Pre-GQA architectures should set num_key_value_heads=num_attention_heads.
 *
 * @param {{num_hidden_layers:number,num_key_value_heads:number,head_dim:number}} modelConfig
 * @param {number} contextLength
 * @param {boolean} [useShard=false]
 * @returns {number} bytes
 */
export function kvCacheSize(modelConfig, contextLength, useShard = false) {
  if (!modelConfig || typeof modelConfig !== 'object') {
    throw new TypeError('modelConfig must be {num_hidden_layers, num_key_value_heads, head_dim}');
  }
  const { num_hidden_layers, num_key_value_heads, head_dim } = modelConfig;
  const args = { num_hidden_layers, num_key_value_heads, head_dim, context_length: contextLength };
  return useShard ? _estimateShardKvCacheBytes(args) : _estimateKvCacheBytes(args);
}

/**
 * "How long a context fits in this VRAM budget?" for both KV cache modes.
 * Surfaces in the dry-run fit table so the buyer sees the unlock.
 *
 * @param {{num_hidden_layers:number,num_key_value_heads:number,head_dim:number}} modelConfig
 * @param {number} vramBytesForKv  bytes of VRAM allocated to the KV cache
 * @returns {{default_max_ctx:number, shard_max_ctx:number, shard_unlock_x:number}}
 */
export function maxContextBothModes(modelConfig, vramBytesForKv) {
  if (!modelConfig || typeof modelConfig !== 'object') {
    throw new TypeError('modelConfig must be {num_hidden_layers, num_key_value_heads, head_dim}');
  }
  const defaultMax = _maxContextAtVram({
    vram_bytes_for_kv: vramBytesForKv,
    model_arch: modelConfig,
    use_shard: false,
  });
  const shardMax = _maxContextAtVram({
    vram_bytes_for_kv: vramBytesForKv,
    model_arch: modelConfig,
    use_shard: true,
  });
  const unlock = defaultMax > 0 ? Math.round((shardMax / defaultMax) * 100) / 100 : 0;
  return { default_max_ctx: defaultMax, shard_max_ctx: shardMax, shard_unlock_x: unlock };
}
