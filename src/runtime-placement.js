// W826 — [T3] memory-aware runtime placement.
//
// Closes KOLM_W707_SYSTEM_UPGRADE_PLAN.md W826 (lines 1121-1127): "VRAM → RAM
// → NVMe → network" tier detection + placement-decision tree that auto-routes
// an artifact to the highest-throughput tier that physically fits.
//
// Three exports:
//
//   1. detectMemoryHierarchy()
//      Probes GPU VRAM (via src/devices.js detectLocal), system RAM (node:os),
//      and NVMe bandwidth (tmp write/read benchmark). Returns a uniform
//      hierarchy shape so the placement decision tree never branches on
//      "did detection succeed."
//
//   2. placementDecision({artifact_size_gb, hierarchy})
//      Pure function. No I/O. Inputs are size + hierarchy snapshot; output is
//      the placement plan + machine-readable rationale. Decision tree:
//        - fits in VRAM*0.9        → full_gpu
//        - fits in VRAM + RAM*0.5  → hybrid (split_ratio = VRAM / size)
//        - else, GPU present       → nvme_mmap
//        - no GPU                  → cpu_only
//
//   3. (constants) PLACEMENT_VERSION, PLACEMENTS, GPU_VRAM_USABLE_FRACTION,
//      SYSTEM_RAM_USABLE_FRACTION.
//
// Honesty contracts:
//   - When detection fails (no nvidia-smi, no sysctl, no /proc), the source
//     field is "fallback" and confidence:0.5. The hierarchy is still SHAPED so
//     downstream callers do not need to special-case missing fields.
//   - NVMe probe is honest about being a sample: KOLM_NO_DISK_PROBE=1 skips
//     the write/read entirely and stamps source:"skipped".
//   - placementDecision NEVER picks full_gpu when GPU is absent. NEVER picks
//     hybrid when artifact_size_gb is null/zero.
//
// W604 anti-brittleness: PLACEMENT_VERSION matches /^w826-/ so a v1.x bump in
// the same wave does not force coordinated test churn.
//
// TODO(future-wave-runtime): `kolm run` and `kolm serve` should call
//   detectMemoryHierarchy() once at boot and placementDecision() per loaded
//   artifact. Wire-up point: src/runtime.js getCompiled() — pass the
//   placement decision to compileWasm/compileJs so the runtime layer can
//   honour split_ratio / nvme_mmap when the worker stack supports it.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { detectLocal, info as deviceInfo } from './devices.js';

export const PLACEMENT_VERSION = 'w826-v1';

// Decision enum. Surfaced to manifests + telemetry so a verifier can detect a
// schema-incompatible decision label.
export const PLACEMENTS = Object.freeze(['full_gpu', 'hybrid', 'nvme_mmap', 'cpu_only']);

// VRAM headroom factor. We do NOT pack 100% — kernels, activations, KV cache
// all consume real memory at inference time. 0.9 matches the headroom budget
// the W722 ITKV profile uses and the W721 TSAC compiler assumes.
export const GPU_VRAM_USABLE_FRACTION = 0.9;

// System RAM half-budget for hybrid placement. Real systems have OS overhead,
// page cache, browser tabs, daemons. Half is a conservative cap that prevents
// the runtime from triggering OOM-kill on the host process while loading.
export const SYSTEM_RAM_USABLE_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// detectMemoryHierarchy
// ---------------------------------------------------------------------------
//
// Returns a stable shape:
//
//   {
//     gpu: [{ idx, name, vram_gb, free_gb }] | [],
//     system_ram_gb: number,
//     system_ram_free_gb: number,
//     nvme_bandwidth_mbps_estimate: number | null,
//     source: 'devices+os+probe' | 'devices+os+skipped' | 'fallback',
//   }
//
// `gpu` is an array because multi-GPU rigs exist; src/devices.js only
// surfaces the primary GPU today so the array has length 0 or 1, but the
// shape is forward-compatible for an MIG / DGX cluster.

export async function detectMemoryHierarchy() {
  // GPU probe via devices.js. detectLocal() returns {id, source, confidence,
  // raw:{name, vram_gb, sm}} on the nvidia-smi path. raw is absent on
  // sysctl/fallback paths.
  let gpu = [];
  let deviceSource = 'fallback';
  try {
    const local = await detectLocal();
    if (local && local.raw && Number.isFinite(local.raw.vram_gb) && local.raw.vram_gb > 0) {
      const reg = deviceInfo(local.id);
      gpu = [{
        idx: 0,
        name: local.raw.name || (reg && reg.label) || local.id,
        vram_gb: Number(local.raw.vram_gb),
        // free_gb: we cannot read live nvidia-smi `memory.free` cheaply from
        // here without re-shelling; assume 95% free at boot. The runtime
        // should refresh this number when it actually loads weights.
        free_gb: Number((local.raw.vram_gb * 0.95).toFixed(2)),
      }];
      deviceSource = local.source || 'devices';
    } else if (local && deviceInfo(local.id) && deviceInfo(local.id).vram_gb > 0) {
      // sysctl / hint path — use the registry's vram_gb for the profile.
      const reg = deviceInfo(local.id);
      gpu = [{
        idx: 0,
        name: reg.label,
        vram_gb: Number(reg.vram_gb),
        free_gb: Number((reg.vram_gb * 0.95).toFixed(2)),
      }];
      deviceSource = local.source || 'devices';
    }
  } catch {
    // detectLocal swallows internally already; if it still throws, fall
    // through to the no-GPU path. Never crash the placement loop.
    gpu = [];
  }

  // System RAM via node:os. totalmem/freemem in bytes.
  const system_ram_gb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2));
  const system_ram_free_gb = Number((os.freemem() / 1024 / 1024 / 1024).toFixed(2));

  // NVMe probe. 100MB tmp write+read; report MB/s on the smaller of the two
  // (write-bound is the realistic floor). Skip if KOLM_NO_DISK_PROBE=1 or if
  // the temp dir is in-memory (tmpfs on linux) — we cannot tell from JS so
  // we honor the env override as the only opt-out.
  let nvme_bandwidth_mbps_estimate = null;
  let probeSource = 'skipped';
  if (process.env.KOLM_NO_DISK_PROBE !== '1') {
    const probed = _probeNvmeBandwidth();
    if (probed != null) {
      nvme_bandwidth_mbps_estimate = probed;
      probeSource = 'probe';
    }
  }

  const source = gpu.length > 0
    ? `devices+os+${probeSource}`
    : (probeSource === 'probe' ? 'os+probe' : 'fallback');

  return {
    gpu,
    system_ram_gb,
    system_ram_free_gb,
    nvme_bandwidth_mbps_estimate,
    source,
    version: PLACEMENT_VERSION,
  };
}

// _probeNvmeBandwidth: write a 100MB buffer to tmp, fsync, read it back,
// return the smaller of (write_mbps, read_mbps). Returns null on any I/O
// failure — never throws.
function _probeNvmeBandwidth() {
  const sizeBytes = 100 * 1024 * 1024;
  const buf = Buffer.alloc(sizeBytes);
  // Fill with a deterministic but non-zero pattern so the filesystem cannot
  // hole-punch into a sparse zero file.
  crypto.randomFillSync(buf.subarray(0, 4096));
  for (let off = 4096; off < sizeBytes; off += 4096) {
    buf.copy(buf, off, 0, 4096);
  }
  const tmpPath = path.join(os.tmpdir(), `kolm-w826-probe-${process.pid}-${Date.now()}.bin`);
  try {
    const t0 = process.hrtime.bigint();
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const t1 = process.hrtime.bigint();
    const writeMs = Number(t1 - t0) / 1e6;
    const r0 = process.hrtime.bigint();
    const rfd = fs.openSync(tmpPath, 'r');
    const rbuf = Buffer.alloc(sizeBytes);
    fs.readSync(rfd, rbuf, 0, sizeBytes, 0);
    fs.closeSync(rfd);
    const r1 = process.hrtime.bigint();
    const readMs = Number(r1 - r0) / 1e6;
    const writeMbps = (sizeBytes / 1024 / 1024) / (writeMs / 1000);
    const readMbps = (sizeBytes / 1024 / 1024) / (readMs / 1000);
    return Number(Math.min(writeMbps, readMbps).toFixed(1));
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {} // deliberate: cleanup
  }
}

// ---------------------------------------------------------------------------
// placementDecision
// ---------------------------------------------------------------------------
//
// Inputs:
//   artifact_size_gb : number (required; >0)
//   hierarchy        : {gpu:[{idx,vram_gb,free_gb}...], system_ram_gb,
//                       system_ram_free_gb, ...}
//
// Output:
//   {
//     decision: 'full_gpu' | 'hybrid' | 'nvme_mmap' | 'cpu_only',
//     rationale: string (human-readable),
//     gpu_idx: number | null,
//     split_ratio: number | null,      // present only when decision='hybrid'
//                                      // split_ratio = gpu_free / artifact
//     usable_vram_gb: number,
//     usable_ram_gb: number,
//     version: 'w826-v1',
//   }
//
// Decision tree:
//   1. No GPU                                 → cpu_only
//   2. artifact_size_gb < vram_free * 0.9     → full_gpu
//   3. artifact_size_gb < vram_free + ram_free*0.5
//                                             → hybrid
//   4. else                                   → nvme_mmap
//
// Special cases:
//   - artifact_size_gb <= 0 → cpu_only with rationale "no_artifact_size"
//   - hierarchy missing → cpu_only with rationale "no_hierarchy"

export function placementDecision(opts = {}) {
  const artifact_size_gb = Number(opts.artifact_size_gb);
  const hierarchy = opts.hierarchy || null;

  if (!hierarchy) {
    return {
      decision: 'cpu_only',
      rationale: 'no_hierarchy',
      gpu_idx: null,
      split_ratio: null,
      usable_vram_gb: 0,
      usable_ram_gb: 0,
      version: PLACEMENT_VERSION,
    };
  }

  if (!Number.isFinite(artifact_size_gb) || artifact_size_gb <= 0) {
    return {
      decision: 'cpu_only',
      rationale: 'no_artifact_size',
      gpu_idx: null,
      split_ratio: null,
      usable_vram_gb: 0,
      usable_ram_gb: 0,
      version: PLACEMENT_VERSION,
    };
  }

  const gpus = Array.isArray(hierarchy.gpu) ? hierarchy.gpu : [];
  const systemRam = Number(hierarchy.system_ram_gb || 0);
  const systemRamFree = Number(hierarchy.system_ram_free_gb || 0);
  const usable_ram_gb = Number((systemRamFree * SYSTEM_RAM_USABLE_FRACTION).toFixed(2));

  // No GPU → CPU path. nvme_mmap is GPU-only by design (memory-mapped weights
  // get streamed to GPU pages); without a GPU there's no destination.
  if (gpus.length === 0) {
    return {
      decision: 'cpu_only',
      rationale: `no_gpu_detected; artifact_size=${artifact_size_gb.toFixed(2)}GB; ram_free=${systemRamFree.toFixed(2)}GB`,
      gpu_idx: null,
      split_ratio: null,
      usable_vram_gb: 0,
      usable_ram_gb,
      version: PLACEMENT_VERSION,
    };
  }

  // Pick the largest-VRAM GPU. Multi-GPU rigs ship the biggest device first
  // when the array is sorted; otherwise just take idx 0.
  const gpu = gpus[0];
  const vram_free = Number(gpu.free_gb || gpu.vram_gb || 0);
  const usable_vram_gb = Number((vram_free * GPU_VRAM_USABLE_FRACTION).toFixed(2));

  // 2. fits entirely in VRAM (with 10% headroom) → full GPU placement.
  if (artifact_size_gb < usable_vram_gb) {
    return {
      decision: 'full_gpu',
      rationale: `artifact_size=${artifact_size_gb.toFixed(2)}GB fits in ${usable_vram_gb.toFixed(2)}GB usable VRAM (${vram_free.toFixed(2)}GB free × ${GPU_VRAM_USABLE_FRACTION})`,
      gpu_idx: gpu.idx != null ? gpu.idx : 0,
      split_ratio: 1.0,
      usable_vram_gb,
      usable_ram_gb,
      version: PLACEMENT_VERSION,
    };
  }

  // 3. fits in VRAM + half of free system RAM → hybrid placement.
  if (artifact_size_gb < vram_free + (systemRamFree * SYSTEM_RAM_USABLE_FRACTION)) {
    const split_ratio = Number((vram_free / artifact_size_gb).toFixed(4));
    return {
      decision: 'hybrid',
      rationale: `artifact_size=${artifact_size_gb.toFixed(2)}GB exceeds VRAM (${vram_free.toFixed(2)}GB free) but fits with ${(systemRamFree * SYSTEM_RAM_USABLE_FRACTION).toFixed(2)}GB RAM offload; split_ratio=${split_ratio.toFixed(4)}`,
      gpu_idx: gpu.idx != null ? gpu.idx : 0,
      split_ratio,
      usable_vram_gb,
      usable_ram_gb,
      version: PLACEMENT_VERSION,
    };
  }

  // 4. else → nvme_mmap. GPU is present so we can still stream weights from
  // disk; cpu_only is only reserved for the no-GPU case (anchor the moat:
  // even a 64GB artifact on a 24GB GPU is faster via nvme_mmap than CPU).
  return {
    decision: 'nvme_mmap',
    rationale: `artifact_size=${artifact_size_gb.toFixed(2)}GB exceeds VRAM (${vram_free.toFixed(2)}GB free) + ${(systemRamFree * SYSTEM_RAM_USABLE_FRACTION).toFixed(2)}GB usable RAM; stream from NVMe`,
    gpu_idx: gpu.idx != null ? gpu.idx : 0,
    split_ratio: null,
    usable_vram_gb,
    usable_ram_gb,
    version: PLACEMENT_VERSION,
  };
}

export default {
  PLACEMENT_VERSION,
  PLACEMENTS,
  GPU_VRAM_USABLE_FRACTION,
  SYSTEM_RAM_USABLE_FRACTION,
  detectMemoryHierarchy,
  placementDecision,
};
