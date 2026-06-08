// Device profile registry. The .kolm artifact declares a `target_device`
// at compile time; the runtime asserts that the actual host meets the
// profile before loading weights. This gives us "compile once, run on
// a specific class of device" with a verifiable receipt.
//
// Profiles include training-capable rigs (5090, 4090, A100, H100, M3 Max),
// inference-only consumer devices (iPhone 15 Pro, Pixel 8, generic laptop)
// and the lowest-common-denominator targets (WASM, CPU-only x86_64).

export const DEVICES = [
  // ----- Training rigs -----
  {
    id: 'rtx-5090',
    label: 'NVIDIA RTX 5090',
    class: 'training',
    arch: 'blackwell',
    sm: '12.0',
    vram_gb: 32,
    fp4: true,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.8',
    torch_min: '2.7',
    notes: 'Local dev rig. FA3 + FP4 inference + NVFP4 training (with torch ≥ 2.8).',
  },
  {
    id: 'rtx-4090',
    label: 'NVIDIA RTX 4090',
    class: 'training',
    arch: 'ada-lovelace',
    sm: '8.9',
    vram_gb: 24,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.1',
    torch_min: '2.4',
  },
  {
    id: 'rtx-3090',
    label: 'NVIDIA RTX 3090',
    class: 'training',
    arch: 'ampere',
    sm: '8.6',
    vram_gb: 24,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'a100-40gb',
    label: 'NVIDIA A100 40GB',
    class: 'training',
    arch: 'ampere',
    sm: '8.0',
    vram_gb: 40,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'a100-80gb',
    label: 'NVIDIA A100 80GB',
    class: 'training',
    arch: 'ampere',
    sm: '8.0',
    vram_gb: 80,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '11.8',
    torch_min: '2.2',
  },
  {
    id: 'h100-80gb',
    label: 'NVIDIA H100 80GB',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 80,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
  },
  {
    id: 'h200-141gb',
    label: 'NVIDIA H200 141GB',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 141,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
  },

  // ----- Apple Silicon -----
  {
    id: 'apple-m3-max',
    label: 'Apple M3 Max',
    class: 'training',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 64,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'mlx',
    runtime: 'mlx',
    notes: 'MLX-native training via mlx_lm. No CUDA stack.',
  },
  {
    id: 'apple-m2-pro',
    label: 'Apple M2 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 16,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'mlx',
    runtime: 'mlx',
  },

  // ----- Edge / mobile -----
  // W390: usable RAM budget for an on-device LLM after OS overhead. iPhone 15
  // Pro has 8GB total physical RAM. iOS reserves ~2GB for kernel + cached apps;
  // 3-4GB is the realistic working set for an MLC / llama.cpp arm64 weight load
  // when the foreground app is the model host. Apple Foundation Models and LM
  // Studio iOS both demonstrate Gemma 3n E2B (2.5GB Q4) running fit-in-budget
  // at this profile. Bumped from 4 -> 6 to stop the recommender from falling
  // back to Qwen 0.5B on a device that demonstrably runs Gemma 3n.
  {
    id: 'iphone-15-pro',
    label: 'iPhone 15 Pro / 16 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 6,
    effective_ram_gb: 3.8,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mlc-llm',
    mobile_profile: true,
    notes: 'A17 Pro Neural Engine. Use Q4_K_M GGUF or MLC. Verified hosts: Gemma 3n E2B, Qwen 2.5 1.5B Q4.',
  },
  {
    id: 'pixel-8-pro',
    label: 'Pixel 8 Pro / 9 Pro',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 5,
    effective_ram_gb: 3.5,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mediapipe',
    mobile_profile: true,
    notes: 'Tensor G3/G4 NPU via MediaPipe. Verified hosts: Gemma 3n E2B, Gemma 3 1B Q4.',
  },
  {
    id: 'laptop-igpu',
    label: 'Laptop iGPU (Intel / AMD)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 2,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'directml',
    notes: 'DirectML or ONNX Runtime. Q4 only. Max: 1.5B params.',
  },
  {
    id: 'cpu-x86_64',
    label: 'Generic x86_64 CPU',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 8,
    runtime: 'llama-cpp',
    notes: 'llama.cpp Q4. Max practical: 3B at ~5 tok/s.',
  },
  {
    id: 'wasm',
    label: 'WASM (browser, Cloudflare Worker)',
    class: 'inference',
    arch: 'wasm32',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 1,
    runtime: 'transformers-js',
    notes: 'transformers.js ONNX Q4. Max practical: 500M params.',
  },

  // ----- Real edge-AI dev kits -----
  {
    id: 'jetson-orin-nano-8gb',
    label: 'NVIDIA Jetson Orin Nano 8GB (Super)',
    class: 'inference',
    arch: 'aarch64',
    sm: '8.7',
    vram_gb: 8,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.2',
    runtime: 'tensorrt-llm',
    notes: 'Unified memory (CPU+GPU share 8GB LPDDR5). 67 TOPS. Run Qwen 2.5 3B Q4 ~25 tok/s.',
  },
  {
    id: 'jetson-orin-agx-64gb',
    label: 'NVIDIA Jetson AGX Orin 64GB',
    class: 'training',
    arch: 'aarch64',
    sm: '8.7',
    vram_gb: 64,
    fp4: false,
    fp8: false,
    bf16: true,
    flash_attn: 'fa2',
    cuda_min: '12.2',
    runtime: 'tensorrt-llm',
    notes: '275 TOPS. Capable of QLoRA on 7B at the edge.',
  },
  {
    id: 'raspberry-pi-5',
    label: 'Raspberry Pi 5 (8GB)',
    class: 'inference',
    arch: 'aarch64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 8,
    runtime: 'llama-cpp',
    notes: 'CPU-only. Cortex-A76 quad. Max practical: SmolLM2 1.7B Q4 ~3 tok/s, Gemma 3 1B Q4 ~2 tok/s.',
  },

  // ----- Mobile devices (NPU class) -----
  {
    id: 'iphone-16-pro',
    label: 'iPhone 16 Pro / 17 Pro',
    class: 'inference',
    arch: 'apple-silicon',
    sm: null,
    vram_gb: 6,
    effective_ram_gb: 4.0,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mlc-llm',
    mobile_profile: true,
    notes: 'A18 Pro Neural Engine. Max practical: Gemma 3n E2B, Qwen 2.5 1.5B Q4.',
  },
  {
    id: 'pixel-9-pro-tpu',
    label: 'Pixel 9 Pro (Tensor G4)',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 6,
    effective_ram_gb: 4.0,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'aicore',
    mobile_profile: true,
    notes: 'Tensor G4 + AICore. AICore exposes Gemini Nano 1.5/2.0 via system SDK. Max sideloaded: Gemma 3n E2B.',
  },
  {
    id: 'android-snapdragon-8-gen3',
    label: 'Android (Snapdragon 8 Gen 3) / Galaxy S24 Ultra',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 5,
    effective_ram_gb: 3.5,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mediapipe',
    mobile_profile: true,
    notes: 'Hexagon NPU. Use MediaPipe LLM Inference API. Max practical: Gemma 3n E2B, Gemma 3 1B Q4.',
  },
  {
    id: 'galaxy-s24-ultra',
    label: 'Samsung Galaxy S24 Ultra',
    class: 'inference',
    arch: 'arm64',
    sm: null,
    vram_gb: 6,
    effective_ram_gb: 4.0,
    fp4: false,
    fp8: false,
    bf16: false,
    runtime: 'mediapipe',
    mobile_profile: true,
    notes: '12GB physical RAM, Snapdragon 8 Gen 3 for Galaxy. Verified hosts: Gemma 3n E2B.',
  },

  // ----- Confidential compute (TEE) devices -----
  // These are server-class boxes that produce hardware attestations. Used
  // when the artifact must run inside a verified enclave. The verifier
  // consumes the device attestation + the artifact receipt together.
  {
    id: 'intel-tdx-icx',
    label: 'Intel TDX (Ice Lake / Sapphire Rapids)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 32,
    runtime: 'llama-cpp',
    tee: 'intel-tdx',
    attestation: 'pccs',
    notes: 'Intel TDX trust domain. Attestation via PCCS / Intel Trust Authority. CPU-only inference inside the TD.',
  },
  {
    id: 'amd-sev-snp',
    label: 'AMD SEV-SNP (EPYC Milan / Genoa)',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 32,
    runtime: 'llama-cpp',
    tee: 'amd-sev-snp',
    attestation: 'snp-report',
    notes: 'AMD SEV-SNP confidential VM. Attestation report verifiable against AMD root key.',
  },
  {
    id: 'aws-nitro-enclave',
    label: 'AWS Nitro Enclave',
    class: 'inference',
    arch: 'x86_64',
    sm: null,
    vram_gb: 0,
    cpu_ram_gb_min: 16,
    runtime: 'llama-cpp',
    tee: 'aws-nitro',
    attestation: 'nitro-attestation',
    notes: 'AWS Nitro Enclave isolated from parent EC2. Attestation via /dev/nsm + KMS.',
  },
  {
    id: 'nvidia-h100-cc',
    label: 'NVIDIA H100 in Confidential Compute mode',
    class: 'training',
    arch: 'hopper',
    sm: '9.0',
    vram_gb: 80,
    fp4: false,
    fp8: true,
    bf16: true,
    flash_attn: 'fa3',
    cuda_min: '12.4',
    torch_min: '2.4',
    tee: 'nvidia-cc',
    attestation: 'nras',
    notes: 'H100 CC mode pairs with TDX or SEV-SNP host. Attestation via NRAS (NVIDIA Remote Attestation Service).',
  },
];

// What model the trainer should default to when training ON this device.
// Picks: max model that fits in 4-bit QLoRA + 2x activation overhead + KV cache.
export const TRAIN_DEFAULT_BY_DEVICE = {
  'rtx-5090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-4090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-3090': 'Qwen/Qwen2.5-7B-Instruct',
  'a100-40gb': 'Qwen/Qwen2.5-14B-Instruct',
  'a100-80gb': 'Qwen/Qwen2.5-14B-Instruct',
  'h100-80gb': 'Qwen/Qwen2.5-14B-Instruct',
  'h200-141gb': 'Qwen/Qwen2.5-14B-Instruct',
  'apple-m3-max': 'Qwen/Qwen2.5-7B-Instruct',
  'apple-m2-pro': 'Qwen/Qwen2.5-3B-Instruct',
};

// What target the .kolm artifact should compile FOR when shipping to this device.
// Picks: max model the device can actually inference at >= 30 tok/s.
export const INFER_DEFAULT_BY_DEVICE = {
  'rtx-5090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-4090': 'Qwen/Qwen2.5-7B-Instruct',
  'rtx-3090': 'Qwen/Qwen2.5-7B-Instruct',
  'a100-40gb': 'Qwen/Qwen2.5-14B-Instruct',
  'apple-m3-max': 'Qwen/Qwen2.5-7B-Instruct',
  'apple-m2-pro': 'Qwen/Qwen2.5-3B-Instruct',
  // W390: iPhone 15 Pro + Pixel 8 Pro both run Gemma 3n E2B in production
  // (LM Studio iOS / MediaPipe sideload). Stop defaulting them to lesser Qwen.
  'iphone-15-pro': 'google/gemma-3n-E2B-it',
  'iphone-16-pro': 'google/gemma-3n-E2B-it',
  'pixel-8-pro': 'google/gemma-3n-E2B-it',
  'pixel-9-pro-tpu': 'google/gemma-3n-E2B-it',
  'android-snapdragon-8-gen3': 'google/gemma-3n-E2B-it',
  'galaxy-s24-ultra': 'google/gemma-3n-E2B-it',
  'laptop-igpu': 'Qwen/Qwen2.5-1.5B-Instruct',
  'cpu-x86_64': 'Qwen/Qwen2.5-1.5B-Instruct',
  'wasm': 'Qwen/Qwen2.5-0.5B-Instruct',
  'jetson-orin-nano-8gb': 'Qwen/Qwen2.5-3B-Instruct',
  'jetson-orin-agx-64gb': 'Qwen/Qwen2.5-7B-Instruct',
  'raspberry-pi-5': 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'intel-tdx-icx': 'Qwen/Qwen2.5-3B-Instruct',
  'amd-sev-snp': 'Qwen/Qwen2.5-3B-Instruct',
  'aws-nitro-enclave': 'Qwen/Qwen2.5-1.5B-Instruct',
  'nvidia-h100-cc': 'Qwen/Qwen2.5-14B-Instruct',
};

// Devices that produce hardware attestations. Used by src/confidential-compute.js
// to decide what attestation type to expect at runtime.
export const TEE_DEVICES = DEVICES.filter(d => d.tee).map(d => ({
  id: d.id,
  tee: d.tee,
  attestation: d.attestation,
}));

// W390: runtimes that target phone-class hardware. fitsOn() uses this to apply
// the mobile KV-cache headroom (sliding-window attention) instead of the
// desktop paged-attention assumption. The W211 device-class taxonomy uses
// 'inference' for both laptops and phones, so we cannot key off d.class alone.
export const MOBILE_RUNTIMES = new Set(['mlc-llm', 'mediapipe', 'aicore']);

// Is this a phone-class device? Used by the recommender to swap KV-cache
// headroom (mobile engines use sliding-window KV ~0.25-0.5GB; desktop engines
// use paged-attention full context ~2GB).
export function isMobileDevice(device) {
  if (!device) return false;
  if (device.mobile_profile === true) return true;
  if (device.class === 'mobile') return true;
  if (device.runtime && MOBILE_RUNTIMES.has(device.runtime)) return true;
  return false;
}

export function info(id) {
  return DEVICES.find(d => d.id === id) || null;
}

export function list(cls) {
  return cls ? DEVICES.filter(d => d.class === cls) : DEVICES.slice();
}

// Detect the local device. Best-effort using env hints and standard probes
// invoked from the JS side. Heavy GPU probes happen in compute/backends.
export async function detectLocal() {
  // Honor explicit override first.
  if (process.env.KOLM_DEVICE) {
    const d = info(process.env.KOLM_DEVICE);
    if (d) return { id: d.id, source: 'env', confidence: 1.0 };
  }

  // Try nvidia-smi for CUDA boxes.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader']);
    const line = stdout.trim().split('\n')[0] || '';
    const m = line.match(/^([^,]+),\s*([\d.]+)\s*MiB,\s*([\d.]+)/);
    if (m) {
      const name = m[1];
      const vramMiB = Number(m[2]);
      const sm = m[3];
      const guess = matchGpuName(name, vramMiB, sm);
      if (guess) return { id: guess.id, source: 'nvidia-smi', confidence: 0.95, raw: { name, vram_gb: Number((vramMiB / 1024).toFixed(1)), sm } };
    }
  } catch { /* no nvidia-smi */ }

  // Try sysctl on macOS.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
      const brand = stdout.trim();
      if (brand.includes('M3 Max')) return { id: 'apple-m3-max', source: 'sysctl', confidence: 0.9 };
      if (brand.includes('M2 Pro')) return { id: 'apple-m2-pro', source: 'sysctl', confidence: 0.9 };
      if (brand.includes('M2 Max')) return { id: 'apple-m3-max', source: 'sysctl', confidence: 0.7, note: 'approx as m3-max profile' };
    } catch {} // deliberate: cleanup
  }

  // Fallback: generic CPU.
  return { id: 'cpu-x86_64', source: 'fallback', confidence: 0.5 };
}

function matchGpuName(name, vramMiB, sm) {
  const n = String(name);
  if (n.includes('RTX 5090')) return { id: 'rtx-5090' };
  if (n.includes('RTX 4090')) return { id: 'rtx-4090' };
  if (n.includes('RTX 3090')) return { id: 'rtx-3090' };
  if (n.includes('H200')) return { id: 'h200-141gb' };
  if (n.includes('H100')) return { id: 'h100-80gb' };
  if (n.includes('A100')) {
    if (vramMiB >= 70000) return { id: 'a100-80gb' };
    return { id: 'a100-40gb' };
  }
  return null;
}

// ============================================================================
// W409s - device target PROFILES.
//
// Orthogonal axis to DEVICES (W211/W372 fleet registry). PROFILES describes
// the W409s "target device class" contract used by `kolm devices detect`
// and `kolm devices recommend`. The .kolm artifact manifest declares which
// profile it supports; the runtime asserts at load time.
//
// Each profile carries:
//   id                       slug
//   name                     human-readable
//   profile_class            'mobile-android' | 'mobile-ios' | 'desktop-cpu'
//                            | 'desktop-gpu' | 'workstation' | 'server' | 'embedded'
//   ram_gb                   total system RAM (or unified)
//   vram_gb                  discrete VRAM, or null when unified
//   arch                     'arm64' | 'x64' | 'wasm32'
//   cuda_capability          'sm_xx' or null
//   neural_engine            bool - Apple ANE / Tensor NPU / Hexagon NPU
//   accelerator              short label for the accelerator
//   min_artifact_size_mb     smallest artifact this profile makes sense for
//   max_artifact_size_mb     largest artifact this profile can host
//   supported_targets        ['js','wasm','gguf','onnx','native-cuda','native-metal']
//   offline_capable          bool - can run without network egress
//   runtime_status           'production' | 'foundation'
// - 'foundation' means "we have the device profile
//                              and the artifact schema but NO runtime ships
//                              yet; do not claim iOS/Android runtime as ready".
// ============================================================================
export const PROFILE_CLASSES = [
  'mobile-android', 'mobile-ios', 'desktop-cpu', 'desktop-gpu',
  'workstation', 'server', 'embedded',
];

export const SUPPORTED_TARGETS = ['js', 'wasm', 'gguf', 'onnx', 'native-cuda', 'native-metal'];

export const PROFILES = [
  // ----- Mobile (foundation - runtime not yet shipped) -----
  {
    id: 'iphone-15-pro-profile',
    name: 'iPhone 15 Pro / 16 Pro',
    profile_class: 'mobile-ios',
    ram_gb: 8,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: true,
    accelerator: 'A17 Pro Neural Engine',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 4096,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'foundation',
    notes: 'Profile + manifest schema only. No iOS runtime ships yet. Will host Gemma 3n E2B / Phi-3.5 mini Q4 once runtime lands.',
  },
  {
    id: 'iphone-16-pro-profile',
    name: 'iPhone 16 Pro / 17 Pro',
    profile_class: 'mobile-ios',
    ram_gb: 8,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: true,
    accelerator: 'A18 Pro Neural Engine',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 6144,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'foundation',
    notes: 'A18 Pro NPU. Foundation - same caveat as iPhone 15 Pro profile.',
  },
  {
    id: 'pixel-8-pro-profile',
    name: 'Pixel 8 Pro / 9 Pro',
    profile_class: 'mobile-android',
    ram_gb: 12,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: true,
    accelerator: 'Tensor G3 / G4 + AICore',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 4096,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'foundation',
    notes: 'Tensor G3/G4 NPU. Foundation - no Android runtime ships yet.',
  },
  {
    id: 'galaxy-s24-ultra-profile',
    name: 'Samsung Galaxy S24 Ultra',
    profile_class: 'mobile-android',
    ram_gb: 12,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: true,
    accelerator: 'Hexagon NPU (Snapdragon 8 Gen 3 for Galaxy)',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 4096,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'foundation',
    notes: 'Hexagon NPU. Foundation - no Android runtime ships yet.',
  },

  // ----- Desktop (CPU) -----
  {
    id: 'desktop-cpu-x64',
    name: 'Generic desktop / laptop CPU (x86_64)',
    profile_class: 'desktop-cpu',
    ram_gb: 16,
    vram_gb: null,
    arch: 'x64',
    cuda_capability: null,
    neural_engine: false,
    accelerator: 'CPU only (AVX2/AVX-512)',
    min_artifact_size_mb: 1,
    max_artifact_size_mb: 8192,
    supported_targets: ['js', 'wasm', 'gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'production',
    notes: 'llama.cpp + ONNX Runtime + transformers.js. Production runtime ships.',
  },
  {
    id: 'desktop-cpu-arm64',
    name: 'ARM laptop / Apple Silicon CPU-only',
    profile_class: 'desktop-cpu',
    ram_gb: 16,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: false,
    accelerator: 'CPU only (NEON)',
    min_artifact_size_mb: 1,
    max_artifact_size_mb: 8192,
    supported_targets: ['js', 'wasm', 'gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'production',
  },

  // ----- Desktop (GPU) -----
  {
    id: 'desktop-gpu-rtx-3090',
    name: 'RTX 3090 (24GB) desktop',
    profile_class: 'desktop-gpu',
    ram_gb: 32,
    vram_gb: 24,
    arch: 'x64',
    cuda_capability: 'sm_86',
    neural_engine: false,
    accelerator: 'NVIDIA RTX 3090',
    min_artifact_size_mb: 100,
    max_artifact_size_mb: 24576,
    supported_targets: ['gguf', 'onnx', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },
  {
    id: 'desktop-gpu-rtx-4090',
    name: 'RTX 4090 (24GB) desktop',
    profile_class: 'desktop-gpu',
    ram_gb: 32,
    vram_gb: 24,
    arch: 'x64',
    cuda_capability: 'sm_89',
    neural_engine: false,
    accelerator: 'NVIDIA RTX 4090',
    min_artifact_size_mb: 100,
    max_artifact_size_mb: 24576,
    supported_targets: ['gguf', 'onnx', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },
  {
    id: 'desktop-gpu-rtx-5090',
    name: 'RTX 5090 (32GB) desktop',
    profile_class: 'desktop-gpu',
    ram_gb: 64,
    vram_gb: 32,
    arch: 'x64',
    cuda_capability: 'sm_120',
    neural_engine: false,
    accelerator: 'NVIDIA RTX 5090',
    min_artifact_size_mb: 100,
    max_artifact_size_mb: 32768,
    supported_targets: ['gguf', 'onnx', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },

  // ----- Workstation -----
  {
    id: 'workstation-dgx-spark',
    name: 'NVIDIA DGX Spark (128GB unified)',
    profile_class: 'workstation',
    ram_gb: 128,
    vram_gb: 128,
    arch: 'arm64',
    cuda_capability: 'sm_100',
    neural_engine: false,
    accelerator: 'GB10 Grace-Blackwell',
    min_artifact_size_mb: 1024,
    max_artifact_size_mb: 131072,
    supported_targets: ['gguf', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },
  {
    id: 'workstation-m3-ultra-512',
    name: 'Apple M3 Ultra (512GB unified)',
    profile_class: 'workstation',
    ram_gb: 512,
    vram_gb: 512,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: true,
    accelerator: 'M3 Ultra GPU + ANE',
    min_artifact_size_mb: 1024,
    max_artifact_size_mb: 524288,
    supported_targets: ['gguf', 'native-metal'],
    offline_capable: true,
    runtime_status: 'production',
  },

  // ----- Server -----
  {
    id: 'server-h100-80',
    name: 'NVIDIA H100 80GB datacenter',
    profile_class: 'server',
    ram_gb: 256,
    vram_gb: 80,
    arch: 'x64',
    cuda_capability: 'sm_90',
    neural_engine: false,
    accelerator: 'NVIDIA H100',
    min_artifact_size_mb: 1024,
    max_artifact_size_mb: 81920,
    supported_targets: ['gguf', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },
  {
    id: 'server-cpu',
    name: 'CPU server (256GB+ DDR5)',
    profile_class: 'server',
    ram_gb: 256,
    vram_gb: null,
    arch: 'x64',
    cuda_capability: null,
    neural_engine: false,
    accelerator: 'CPU only',
    min_artifact_size_mb: 1,
    max_artifact_size_mb: 262144,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'production',
  },

  // ----- Embedded -----
  {
    id: 'embedded-jetson-orin-nano',
    name: 'NVIDIA Jetson Orin Nano 8GB',
    profile_class: 'embedded',
    ram_gb: 8,
    vram_gb: 8,
    arch: 'arm64',
    cuda_capability: 'sm_87',
    neural_engine: false,
    accelerator: 'Ampere GPU + 67 TOPS',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 8192,
    supported_targets: ['gguf', 'onnx', 'native-cuda'],
    offline_capable: true,
    runtime_status: 'production',
  },
  {
    id: 'embedded-raspberry-pi-5',
    name: 'Raspberry Pi 5 (8GB)',
    profile_class: 'embedded',
    ram_gb: 8,
    vram_gb: null,
    arch: 'arm64',
    cuda_capability: null,
    neural_engine: false,
    accelerator: 'Cortex-A76 CPU',
    min_artifact_size_mb: 50,
    max_artifact_size_mb: 4096,
    supported_targets: ['gguf', 'onnx'],
    offline_capable: true,
    runtime_status: 'production',
  },
];

export function listProfiles(filter = {}) {
  let out = PROFILES.slice();
  if (filter.profile_class)        out = out.filter(p => p.profile_class === filter.profile_class);
  if (filter.arch)                 out = out.filter(p => p.arch === filter.arch);
  if (filter.offline_capable != null) out = out.filter(p => !!p.offline_capable === !!filter.offline_capable);
  if (filter.runtime_status)       out = out.filter(p => p.runtime_status === filter.runtime_status);
  if (filter.supported_target)     out = out.filter(p => Array.isArray(p.supported_targets) && p.supported_targets.includes(filter.supported_target));
  return out;
}

export function showProfile(id) {
  return PROFILES.find(p => p.id === id) || null;
}

// Detect the device profile that best matches the current system. Reads:
//   - nvidia-smi  for NVIDIA GPUs
//   - system_profiler / sysctl  for macOS
//   - wmic       for Windows GPU fallback
//   - os.totalmem() + os.arch()  for RAM + CPU arch baseline
// Returns { profile_id, profile, source, confidence, raw }.
// Caller hints may force a specific shape (POST /v1/devices/detect uses this).
export async function detectProfile(hints = {}) {
  const os = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const arch = hints.arch || (os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x64' : os.arch());
  const ram_gb = hints.ram_gb != null ? Number(hints.ram_gb) : Math.round(os.totalmem() / 1024 / 1024 / 1024);
  let raw = { arch, ram_gb, platform: process.platform };
  let pick = null;
  let source = 'fallback';
  let confidence = 0.5;

  // Hint override - caller passed an explicit profile_class or accelerator
  // hint. Useful for the server POST endpoint to test specific shapes.
  if (hints.profile_id) {
    const p = showProfile(hints.profile_id);
    if (p) return { profile_id: p.id, profile: p, source: 'hint', confidence: 1.0, raw: { ...raw, hints } };
  }
  if (hints.profile_class && PROFILE_CLASSES.includes(hints.profile_class)) {
    const candidates = listProfiles({ profile_class: hints.profile_class, arch });
    if (candidates.length) {
      const best = candidates.find(c => Math.abs(c.ram_gb - ram_gb) <= 32) || candidates[0];
      return { profile_id: best.id, profile: best, source: 'hint', confidence: 0.9, raw: { ...raw, hints } };
    }
  }

  // nvidia-smi probe.
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader'], { timeout: 5000 });
    const line = (stdout || '').trim().split('\n')[0] || '';
    const m = line.match(/^([^,]+),\s*([\d.]+)\s*MiB,\s*([\d.]+)/);
    if (m) {
      const name = m[1];
      const vramMiB = Number(m[2]);
      const sm = m[3];
      raw.gpu_name = name;
      raw.vram_gb = Number((vramMiB / 1024).toFixed(1));
      raw.compute_cap = sm;
      if (/RTX 5090/i.test(name)) pick = showProfile('desktop-gpu-rtx-5090');
      else if (/RTX 4090/i.test(name)) pick = showProfile('desktop-gpu-rtx-4090');
      else if (/RTX 3090/i.test(name)) pick = showProfile('desktop-gpu-rtx-3090');
      else if (/H100/i.test(name)) pick = showProfile('server-h100-80');
      else if (/Jetson Orin Nano/i.test(name)) pick = showProfile('embedded-jetson-orin-nano');
      else if (/DGX Spark|GB10/i.test(name)) pick = showProfile('workstation-dgx-spark');
      if (pick) { source = 'nvidia-smi'; confidence = 0.95; }
    }
  } catch {} // deliberate: cleanup

  // macOS sysctl / system_profiler.
  if (!pick && process.platform === 'darwin') {
    try {
      const { stdout } = await run('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 3000 });
      const brand = (stdout || '').trim();
      raw.cpu_brand = brand;
      if (/M3 Ultra/.test(brand)) pick = showProfile('workstation-m3-ultra-512');
      else if (/Apple M/.test(brand)) pick = showProfile('desktop-cpu-arm64');
      if (pick) { source = 'sysctl'; confidence = 0.85; }
    } catch {} // deliberate: cleanup
  }

  // Windows wmic GPU fallback.
  if (!pick && process.platform === 'win32') {
    try {
      const { stdout } = await run('wmic', ['path', 'win32_VideoController', 'get', 'name'], { timeout: 5000 });
      const name = (stdout || '').split(/\r?\n/).slice(1).find(l => l.trim()) || '';
      raw.gpu_name = name.trim();
      if (/RTX 5090/i.test(name)) pick = showProfile('desktop-gpu-rtx-5090');
      else if (/RTX 4090/i.test(name)) pick = showProfile('desktop-gpu-rtx-4090');
      else if (/RTX 3090/i.test(name)) pick = showProfile('desktop-gpu-rtx-3090');
      if (pick) { source = 'wmic'; confidence = 0.7; }
    } catch {} // deliberate: cleanup
  }

  // Honest fallback - match CPU arch + RAM only.
  if (!pick) {
    pick = arch === 'arm64' ? showProfile('desktop-cpu-arm64') : showProfile('desktop-cpu-x64');
    source = 'fallback';
    confidence = 0.5;
  }

  return {
    profile_id: pick.id,
    profile: pick,
    source,
    confidence,
    raw,
  };
}

// Recommend a target + quantization for either the current device, or for an
// artifact whose manifest declares supported_targets + memory_requirement_mb +
// quantization_required + offline_capable. Honest fallback if no profile
// matches - returns reason:'no_compatible_profile'.
export async function recommendForProfile(opts = {}) {
  const target = opts.profile || (await detectProfile(opts.hints || {})).profile;
  if (!target) {
    return { ok: false, reason: 'no_profile' };
  }
  // Artifact constraints if provided.
  const art = opts.artifact || null;
  let chosenTarget = null;
  let quant = null;

  // Pick the highest-fidelity runtime that both sides support. Order matters:
  // native-cuda > native-metal > gguf > onnx > wasm > js.
  const priority = ['native-cuda', 'native-metal', 'gguf', 'onnx', 'wasm', 'js'];
  const deviceTargets = new Set(target.supported_targets || []);
  const artTargets = art && Array.isArray(art.supported_targets) ? new Set(art.supported_targets) : null;
  for (const t of priority) {
    if (deviceTargets.has(t) && (!artTargets || artTargets.has(t))) { chosenTarget = t; break; }
  }
  if (!chosenTarget) {
    return { ok: false, reason: 'no_compatible_target', device: target.id, artifact: art ? art.id : null };
  }

  // Pick quant. Default ladder: device-class → recommended quant.
  // mobile-* → Q4; desktop-cpu → Q4; desktop-gpu → Q6 (24GB+ VRAM); workstation/server → Q8; embedded → Q4.
  const cls = target.profile_class;
  if (art && art.quantization_required) {
    quant = art.quantization_required;
  } else if (cls === 'mobile-ios' || cls === 'mobile-android') quant = 'Q4';
  else if (cls === 'desktop-cpu') quant = 'Q4';
  else if (cls === 'desktop-gpu') quant = (target.vram_gb || 0) >= 24 ? 'Q6' : 'Q4';
  else if (cls === 'workstation') quant = 'Q8';
  else if (cls === 'server') quant = (target.vram_gb || 0) >= 80 ? 'Q8' : 'Q4';
  else if (cls === 'embedded') quant = 'Q4';
  else quant = 'Q4';

  // Memory fit check. If artifact declares memory_requirement_mb, ensure the
  // device max_artifact_size_mb is at least that much.
  if (art && typeof art.memory_requirement_mb === 'number') {
    if (art.memory_requirement_mb > (target.max_artifact_size_mb || 0)) {
      return { ok: false, reason: 'artifact_exceeds_device_memory', want_mb: art.memory_requirement_mb, have_mb: target.max_artifact_size_mb, device: target.id };
    }
  }

  // Offline-capable gate.
  let offline_ok = !!target.offline_capable;
  if (art && art.offline_capable === true && !offline_ok) {
    return { ok: false, reason: 'offline_required_but_device_not_offline_capable', device: target.id };
  }

  return {
    ok: true,
    profile_id: target.id,
    profile_class: target.profile_class,
    target: chosenTarget,
    quant,
    offline_capable: offline_ok,
    runtime_status: target.runtime_status,
    artifact_id: art ? art.id : null,
  };
}

export default { DEVICES, TRAIN_DEFAULT_BY_DEVICE, INFER_DEFAULT_BY_DEVICE, TEE_DEVICES, MOBILE_RUNTIMES, list, info, detectLocal, isMobileDevice,
  PROFILES, PROFILE_CLASSES, SUPPORTED_TARGETS, listProfiles, showProfile, detectProfile, recommendForProfile };
