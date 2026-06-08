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
import os from 'node:os';
import {
  estimateKvCacheBytes as _estimateKvCacheBytes,
  estimateShardKvCacheBytes as _estimateShardKvCacheBytes,
  maxContextAtVram as _maxContextAtVram,
} from './kv-cache-shard.js';

export const HARDWARE_VERSION = 'forge-hardware-v1';

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

/**
 * Will this artifact run on this hardware?
 * @param {string} _artifactPath path to .kolm artifact (TODO: parse manifest)
 * @returns {Object} { fits: bool, primary, reason, recommended_targets[] }
 */
export function willArtifactFit(_artifactPath) {
  const hw = detectHardware();
  // For now: any artifact fits if vram >= 4 GB and primary is GPU-class.
  // TODO W873: parse manifest, compute exact VRAM from quant + ctx + batch.
  const fits = hw.primary.vram_gb >= 4 && hw.primary.vendor !== 'cpu';
  return {
    fits,
    primary: hw.primary,
    reason: fits ? 'gpu_class_with_sufficient_vram'
                 : (hw.primary.vendor === 'cpu' ? 'cpu_only_falls_back_to_gguf'
                                                : 'insufficient_vram'),
    recommended_targets: hw.primary.supported_methods.slice(0, 3),
  };
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
