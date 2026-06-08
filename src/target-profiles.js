// W892-C5 - target-profile lookup table.
//
// `kolm compile --target-profile <name>` translates a friendly device name
// (jetson-orin-nx, raspberry-pi-5, iphone-15-pro, ...) into the right
// combination of (--target, runtime, context limit, expected throughput) so
// callers don't have to memorize the gguf-q4km / mlx / mediapipe matrix.
//
// Each row is the *recommended default* for a 7B-class student. Smaller or
// larger students may diverge; the row's `notes` field calls those out.
//
// The shape mirrors src/device-capabilities.js#profileFor so a downstream
// compile call can drop the row straight into manifest.target_device.

export const TARGET_PROFILES = Object.freeze({
  // ===== NVIDIA Jetson family =====
  'jetson-orin-nano': {
    name: 'jetson-orin-nano',
    label: 'NVIDIA Jetson Orin Nano (8 GB)',
    family: 'edge-gpu',
    vram_gb: 8,
    target: 'gguf-q4km',
    runtime: 'llama-cpp',
    est_tok_s_7b: 18,
    max_context: 4096,
    notes: 'Q4_K_M is the sweet spot; Q5_K_M will swap to system RAM and tank to ~6 tok/s.',
  },
  'jetson-orin-nx': {
    name: 'jetson-orin-nx',
    label: 'NVIDIA Jetson Orin NX (16 GB)',
    family: 'edge-gpu',
    vram_gb: 16,
    target: 'gguf-q5km',
    runtime: 'llama-cpp',
    est_tok_s_7b: 34,
    max_context: 8192,
    notes: 'Headroom for Q5_K_M and 8K context. TensorRT-LLM also supported via --runtime tensorrt-llm.',
  },
  'jetson-orin-agx': {
    name: 'jetson-orin-agx',
    label: 'NVIDIA Jetson AGX Orin (32 / 64 GB)',
    family: 'edge-gpu',
    vram_gb: 32,
    target: 'gguf-q8',
    runtime: 'tensorrt-llm',
    est_tok_s_7b: 78,
    max_context: 16384,
    notes: '64 GB SKU fits 13B@Q4 or 7B@FP16. Use --target nvfp4 on JetPack 6.1+ for ~2x throughput.',
  },

  // ===== Raspberry Pi (CPU-only) =====
  'raspberry-pi-5': {
    name: 'raspberry-pi-5',
    label: 'Raspberry Pi 5 (8 GB, ARM Cortex-A76)',
    family: 'cpu-edge',
    vram_gb: 0,
    cpu_ram_gb: 8,
    target: 'gguf-q4km',
    runtime: 'llama-cpp',
    est_tok_s_7b: 3.2,
    max_context: 2048,
    notes: 'No GPU; runs on 4 A76 cores via llama.cpp with -t 4. Q4_K_M ~4 GB resident; leave 2 GB for OS.',
  },
  'raspberry-pi-4': {
    name: 'raspberry-pi-4',
    label: 'Raspberry Pi 4 (4 / 8 GB, ARM Cortex-A72)',
    family: 'cpu-edge',
    vram_gb: 0,
    cpu_ram_gb: 4,
    target: 'gguf-iq3xxs',
    runtime: 'llama-cpp',
    est_tok_s_7b: 1.1,
    max_context: 1024,
    notes: 'Recommend 1-3B student instead of 7B; IQ3_XXS is the smallest viable for any meaningful task.',
  },

  // ===== Apple iPhone / iPad =====
  'iphone-15-pro': {
    name: 'iphone-15-pro',
    label: 'iPhone 15 Pro / Pro Max (A17 Pro, 8 GB)',
    family: 'mobile',
    vram_gb: 0,
    cpu_ram_gb: 8,
    target: 'mlc',
    runtime: 'mlc-llm',
    est_tok_s_7b: 12,
    max_context: 2048,
    notes: 'MLC-LLM with int4 group quant. App Store distribution requires bundling the model in your app or downloading at first launch.',
  },
  'iphone-14': {
    name: 'iphone-14',
    label: 'iPhone 14 / 14 Plus (A15 Bionic, 6 GB)',
    family: 'mobile',
    vram_gb: 0,
    cpu_ram_gb: 6,
    target: 'mlc',
    runtime: 'mlc-llm',
    est_tok_s_7b: 7,
    max_context: 1024,
    notes: '6 GB RAM is tight for 7B; consider a 3B student with this profile for headroom.',
  },

  // ===== Android =====
  'pixel-9-pro': {
    name: 'pixel-9-pro',
    label: 'Google Pixel 9 Pro (Tensor G4, 16 GB)',
    family: 'mobile',
    vram_gb: 0,
    cpu_ram_gb: 16,
    target: 'mediapipe-tflite',
    runtime: 'aicore',
    est_tok_s_7b: 14,
    max_context: 2048,
    notes: 'Pixel 9 ships Gemini Nano in AICore; for kolm models use MediaPipe LLM Inference API with the TFLite target.',
  },
  'snapdragon-8-gen-3': {
    name: 'snapdragon-8-gen-3',
    label: 'Android flagship (Snapdragon 8 Gen 3, 12-16 GB)',
    family: 'mobile',
    vram_gb: 0,
    cpu_ram_gb: 12,
    target: 'mediapipe-tflite',
    runtime: 'mediapipe',
    est_tok_s_7b: 11,
    max_context: 2048,
    notes: 'Qualcomm Hexagon NPU acceleration via MediaPipe; quality varies by OEM driver version.',
  },

  // ===== Apple Silicon (Mac) =====
  'mac-mini-m2': {
    name: 'mac-mini-m2',
    label: 'Mac mini (M2 / M2 Pro, 8-24 GB unified)',
    family: 'desktop',
    vram_gb: 24, // unified memory - treat as shared VRAM
    target: 'mlx-int4',
    runtime: 'mlx',
    est_tok_s_7b: 38,
    max_context: 8192,
    notes: 'MLX int4 groupwise quant. For 8 GB SKU drop to 3B; M2 Pro 24 GB fits 13B@Q4 comfortably.',
  },
  'mac-studio-m2-ultra': {
    name: 'mac-studio-m2-ultra',
    label: 'Mac Studio (M2 Ultra, 64-192 GB unified)',
    family: 'desktop',
    vram_gb: 192,
    target: 'mlx-bf16',
    runtime: 'mlx',
    est_tok_s_7b: 95,
    max_context: 32768,
    notes: 'Largest practical local target. Fits 70B@Q4 or full BF16 of 7-13B.',
  },
  'macbook-pro-m3-max': {
    name: 'macbook-pro-m3-max',
    label: 'MacBook Pro 16" (M3 Max, 36-128 GB unified)',
    family: 'laptop',
    vram_gb: 128,
    target: 'mlx-int4',
    runtime: 'mlx',
    est_tok_s_7b: 65,
    max_context: 16384,
    notes: 'Battery vs perf: int4 is the right default; switch to bf16 only when plugged in.',
  },

  // ===== Intel NUC / CPU desktop =====
  'intel-nuc-13': {
    name: 'intel-nuc-13',
    label: 'Intel NUC 13 Pro (Core i7-1360P, 32 GB)',
    family: 'cpu-desktop',
    vram_gb: 0,
    cpu_ram_gb: 32,
    target: 'gguf-q4km',
    runtime: 'llama-cpp',
    est_tok_s_7b: 9.5,
    max_context: 8192,
    notes: 'CPU-only. Use -t 8 (P-cores only) on llama.cpp for best tok/s; hyperthreading hurts.',
  },

  // ===== Consumer GPU (Windows / Linux dGPU) =====
  'rtx-3060-12gb': {
    name: 'rtx-3060-12gb',
    label: 'NVIDIA RTX 3060 (12 GB)',
    family: 'consumer-gpu',
    vram_gb: 12,
    target: 'gguf-q5km',
    runtime: 'llama-cpp',
    est_tok_s_7b: 55,
    max_context: 8192,
    notes: 'Sweet spot for hobbyist; Q5_K_M fits with 8K context. exl2-6.0bpw is faster but compatibility-limited.',
  },
  'rtx-4090': {
    name: 'rtx-4090',
    label: 'NVIDIA RTX 4090 (24 GB)',
    family: 'consumer-gpu',
    vram_gb: 24,
    target: 'gguf-q8',
    runtime: 'llama-cpp',
    est_tok_s_7b: 125,
    max_context: 32768,
    notes: '24 GB fits 7B@FP16 or 13B@Q5_K_M. vLLM is faster for batched serving; llama-cpp wins for single-stream.',
  },
  'rtx-5090': {
    name: 'rtx-5090',
    label: 'NVIDIA RTX 5090 (32 GB GDDR7)',
    family: 'consumer-gpu',
    vram_gb: 32,
    target: 'gguf-q8',
    runtime: 'vllm',
    est_tok_s_7b: 165,
    max_context: 32768,
    notes: 'sm_120; needs CUDA 12.8+. 32 GB fits 13B@FP16 or 7B+SHARD KV cache.',
  },

  // ===== Datacenter =====
  'a100-40gb': {
    name: 'a100-40gb',
    label: 'NVIDIA A100 (40 GB SXM4 / PCIe)',
    family: 'datacenter-gpu',
    vram_gb: 40,
    target: 'safetensors',
    runtime: 'vllm',
    est_tok_s_7b: 220,
    max_context: 32768,
    notes: 'For batched serving. Single-stream 7B is faster on a 4090; A100 wins as soon as you batch >4 requests.',
  },
  'h100-80gb': {
    name: 'h100-80gb',
    label: 'NVIDIA H100 (80 GB SXM5 / PCIe)',
    family: 'datacenter-gpu',
    vram_gb: 80,
    target: 'safetensors-fp8',
    runtime: 'tensorrt-llm',
    est_tok_s_7b: 380,
    max_context: 128000,
    notes: 'FP8 on TRT-LLM is the fastest production target for 7-70B. Use --target nvfp4 on Blackwell (H200/B100) for 2x more.',
  },

  // ===== Browser / WASM =====
  'browser-wasm': {
    name: 'browser-wasm',
    label: 'Browser (transformers.js / WebGPU)',
    family: 'browser',
    vram_gb: 4, // typical WebGPU device memory
    target: 'onnx-q4',
    runtime: 'transformers-js',
    est_tok_s_7b: 6,
    max_context: 2048,
    notes: 'Recommend <=3B for any non-toy use. WebGPU support: Chrome 113+, Edge 113+, Safari 17.4+.',
  },
});

// All profile names in the public lookup. Used for help text + the CLI's
// `--list-target-profiles` print + ship-gate completeness checks.
export const TARGET_PROFILE_NAMES = Object.freeze(Object.keys(TARGET_PROFILES));

export function lookup(profileName) {
  if (!profileName) return null;
  const key = String(profileName).toLowerCase().trim();
  return TARGET_PROFILES[key] || null;
}

export function list() {
  return TARGET_PROFILE_NAMES.map(n => TARGET_PROFILES[n]);
}

// Render the lookup table as a fixed-column text block for the CLI. Mirrors
// the format used by `kolm models list` so the visual rhythm is consistent.
export function formatTable() {
  const rows = list();
  const colName = Math.max(...rows.map(r => r.name.length), 4);
  const colTarget = Math.max(...rows.map(r => r.target.length), 6);
  const colRuntime = Math.max(...rows.map(r => r.runtime.length), 7);
  const header = [
    'PROFILE'.padEnd(colName),
    'TARGET'.padEnd(colTarget),
    'RUNTIME'.padEnd(colRuntime),
    'VRAM',
    'TOK/S (7B)',
  ].join('  ');
  const sep = '-'.repeat(header.length);
  const body = rows.map(r => [
    r.name.padEnd(colName),
    r.target.padEnd(colTarget),
    r.runtime.padEnd(colRuntime),
    String(r.vram_gb).padStart(4) + 'G',
    String(r.est_tok_s_7b).padStart(5),
  ].join('  '));
  return [header, sep, ...body].join('\n');
}

// JSON shape for /v1/target-profiles and `kolm compile --list-target-profiles --json`.
export function asJson() {
  return {
    ok: true,
    count: TARGET_PROFILE_NAMES.length,
    profiles: list(),
    schema_version: 'target-profile-v1',
  };
}

export default {
  TARGET_PROFILES,
  TARGET_PROFILE_NAMES,
  lookup,
  list,
  formatTable,
  asJson,
};
