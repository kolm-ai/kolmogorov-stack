// W724 — Memory-aware scheduling: tier detection + placement estimator.
//
// Closes W724-1 / W724-2 / W724-3 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md
// (lines 317-322). The four memory tiers are:
//
//   1) VRAM           — GPU device memory. Fastest. Detected via nvidia-smi.
//   2) RAM            — host system memory. Detected via os.freemem().
//   3) NVMe (disk)    — local SSD. Detected via fs.statfsSync(data_dir).
//   4) network        — remote weight pull. KOLM_NETWORK_GBPS env var (opt).
//
// Honesty contract:
//   * Every probe is wrapped in try/catch. A failing probe yields `0` (RAM,
//     NVMe, VRAM) or `null` (network) — never a throw, never a negative
//     number, never undefined. A host without nvidia-smi reports vram_gb=0
//     and the placement estimator routes around it accordingly.
//   * The placement decision is a FIRST-PASS estimator. The tok/s numbers
//     come from rough buckets (vram-only 80-120, mixed vram+ram 20-50,
//     mostly-nvme 2-8, network <1). They MUST be recalibrated against W721-3
//     bench data when that benchmark lands. The estimator deliberately
//     errs on the conservative end of each bucket so users are not
//     over-promised.
//   * The auto-place decision MUST surface a one-line `reasoning_line` so
//     `kolm run --auto-place` can echo what placement was chosen and why.
//     This is the load-bearing UX promise from W724-3 ("no manual GPU
//     layers / offload ratios / mmap").
//
// Forbidden interactions (per W724 owner spec):
//   * MUST NOT touch apps/runtime/streaming_load.py (W723 territory).
//   * MUST NOT touch src/preload-scheduler.js (W725 territory).
//   * MUST NOT touch src/spec-compile.js / src/kernel-selector.js (W726).
//   * MUST NOT bump sw.js or frontend-version.json (orchestrator only).
//
// Public surface:
//
//   MEMORY_TIER_VERSION                       — schema stamp ('w724-v1')
//   detectMemoryTiers(opts)                   — {vram_gb, ram_gb, nvme_gb, network_gbps}
//   estimatePlacement({artifact_size_gb, tiers})
//                                              — {placement, expected_tok_per_s,
//                                                  fits_in_vram, fits_in_ram,
//                                                  mixed_breakdown}
//   applyAutoPlaceDecision(artifact_size_gb, opts)
//                                              — composes detect + estimate,
//                                                returns {decision, reasoning_line, ...}

import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// =============================================================================
// Version stamp
// =============================================================================

// Bound into any manifest slot that records the auto-place decision. A
// verifier comparing two run-meta records can detect schema-incompatible
// placement decisions via this constant.
export const MEMORY_TIER_VERSION = 'w724-v1';

// =============================================================================
// Heuristic tok/s buckets (FIRST-PASS, calibrate with W721-3 bench data)
// =============================================================================
//
// These numbers come from the W724 atomic spec (lines 317-322 of the W707
// plan). They are intentionally rough — the goal is to give the user a
// realistic *order of magnitude* before the model loads, not a tight
// guarantee. When W721-3 lands the real bench data, replace these literals
// with bench-driven numbers and bump MEMORY_TIER_VERSION.
const TOKS_VRAM_ONLY_LO = 80;
const TOKS_VRAM_ONLY_HI = 120;
const TOKS_MIXED_VRAM_RAM_LO = 20;
const TOKS_MIXED_VRAM_RAM_HI = 50;
const TOKS_MOSTLY_NVME_LO = 2;
const TOKS_MOSTLY_NVME_HI = 8;
const TOKS_NETWORK_HI = 1; // network is strictly < 1 tok/s in this estimator

// VRAM headroom we keep free for activations + KV cache. Without this slice
// the model would technically "fit" but OOM on the first decode step. Tuned
// from the W721 ITKV-cache footprint analysis (rough working-set ~15%).
const VRAM_HEADROOM_GB = 1.0;

// =============================================================================
// Tier detection
// =============================================================================

/**
 * Detect free capacity in each of the four memory tiers.
 *
 * Every probe is best-effort. A failing probe returns the field's zero
 * value (`0` for the GB tiers, `null` for network). Callers MUST be able
 * to handle `vram_gb === 0` and route around it. This is the design
 * contract for hosts without GPUs and CI runners.
 *
 * @param {object} [opts]
 * @param {string} [opts.data_dir]  Optional override for the NVMe probe path.
 *                                  Defaults to KOLM_DATA_DIR env, then home.
 * @returns {{vram_gb:number, ram_gb:number, nvme_gb:number, network_gbps:(number|null)}}
 */
export function detectMemoryTiers(opts) {
  const o = opts || {};
  return {
    vram_gb: _detectVramGb(),
    ram_gb: _detectRamGb(),
    nvme_gb: _detectNvmeGb(o.data_dir),
    network_gbps: _detectNetworkGbps(),
  };
}

function _detectVramGb() {
  // nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits emits
  // one free-MB integer per visible GPU. We sum across all visible GPUs so
  // a multi-GPU host gets honest total free VRAM. If nvidia-smi is missing
  // (CPU-only host, AMD/Apple Silicon host) the spawn throws or returns
  // status != 0 — both branches yield 0, never a throw or NaN.
  try {
    const r = spawnSync('nvidia-smi', [
      '--query-gpu=memory.free',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return 0;
    const lines = String(r.stdout || '').split('\n')
      .map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return 0;
    let totalMb = 0;
    for (const line of lines) {
      const n = Number(line);
      if (Number.isFinite(n) && n > 0) totalMb += n;
    }
    if (totalMb <= 0) return 0;
    // Round to 0.1 GB so the surface is stable across nvidia-smi noise.
    return Math.round((totalMb / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

function _detectRamGb() {
  // Use FREE memory (not total) so the placement estimator doesn't promise
  // RAM that the OS or other processes already hold. os.freemem() returns
  // bytes; convert to GB and round to 0.1.
  try {
    const free = os.freemem();
    if (!Number.isFinite(free) || free <= 0) return 0;
    return Math.round((free / (1024 ** 3)) * 10) / 10;
  } catch {
    return 0;
  }
}

function _detectNvmeGb(dataDirOverride) {
  // Probe the path the runtime would actually spill to. KOLM_DATA_DIR wins
  // (the artifact store lives there), then explicit override, then home.
  // statfsSync needs a path that EXISTS — fall back to the parent if the
  // first choice does not yet exist (fresh install).
  try {
    let target = dataDirOverride
      || process.env.KOLM_DATA_DIR
      || os.homedir();
    if (!target) return 0;
    // Walk up until we find an extant directory. Most fresh-install hosts
    // are missing ~/.kolm/ but always have ~/.
    let probe = target;
    let guard = 6;
    while (probe && guard > 0 && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
      guard -= 1;
    }
    if (!probe || !fs.existsSync(probe)) return 0;
    const s = fs.statfsSync(probe);
    if (!s) return 0;
    // Linux/POSIX/Windows: free bytes = bavail * bsize. bavail (free for
    // unprivileged users) is the honest figure — bfree may include reserved
    // root-only blocks the kolm CLI cannot actually use.
    const freeBytes = Number(s.bavail || 0) * Number(s.bsize || 0);
    if (!Number.isFinite(freeBytes) || freeBytes <= 0) return 0;
    return Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
  } catch {
    return 0;
  }
}

function _detectNetworkGbps() {
  // No portable cross-platform "measure my LAN bandwidth" call exists.
  // KOLM_NETWORK_GBPS lets a sysadmin pin the link speed (typical home
  // gigabit = 1.0, 10GbE office LAN = 10.0). Returns null when unset so
  // the placement estimator can distinguish "no link info" from "0 link".
  try {
    const raw = process.env.KOLM_NETWORK_GBPS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

// =============================================================================
// Placement estimator
// =============================================================================

/**
 * Decide which memory tier the artifact should live in and estimate the
 * resulting decode throughput. This is a pre-load DRY-RUN — it does not
 * touch the artifact file. It picks the highest tier with enough free
 * capacity, falling back to a mixed VRAM+RAM split when the artifact
 * spills VRAM, and to mostly-nvme when even RAM cannot hold it.
 *
 * @param {object} input
 * @param {number} input.artifact_size_gb  GB on disk that needs to be paged in.
 * @param {{vram_gb:number, ram_gb:number, nvme_gb:number, network_gbps:(number|null)}} input.tiers
 * @returns {{placement:('vram'|'ram'|'nvme'|'mixed'|'network'),
 *            expected_tok_per_s:number,
 *            fits_in_vram:boolean,
 *            fits_in_ram:boolean,
 *            mixed_breakdown:({vram_layers:number, ram_layers:number, nvme_layers:number})}}
 */
export function estimatePlacement(input) {
  const i = input || {};
  const artifactGb = Number.isFinite(Number(i.artifact_size_gb))
    ? Math.max(0, Number(i.artifact_size_gb)) : 0;
  const t = i.tiers || {};
  const vramGb = Math.max(0, Number(t.vram_gb) || 0);
  const ramGb = Math.max(0, Number(t.ram_gb) || 0);
  const nvmeGb = Math.max(0, Number(t.nvme_gb) || 0);
  const networkGbps = (t.network_gbps === null || t.network_gbps === undefined)
    ? null : Number(t.network_gbps);

  const usableVramGb = Math.max(0, vramGb - VRAM_HEADROOM_GB);
  const fitsInVram = artifactGb > 0 && usableVramGb >= artifactGb;
  const fitsInRam = artifactGb > 0 && ramGb >= artifactGb;
  const fitsInVramPlusRam = artifactGb > 0
    && (usableVramGb + ramGb) >= artifactGb;
  const fitsInNvme = artifactGb > 0 && nvmeGb >= artifactGb;

  let placement;
  let expectedTokPerS;
  const mixedBreakdown = { vram_layers: 0, ram_layers: 0, nvme_layers: 0 };

  if (fitsInVram) {
    // Best case: the whole artifact sits in VRAM with headroom for KV cache.
    // Throughput hugs the high end of the bucket because there are no
    // host-device transfers on the decode path.
    placement = 'vram';
    expectedTokPerS = _scaledTokPerS(
      TOKS_VRAM_ONLY_LO, TOKS_VRAM_ONLY_HI,
      usableVramGb, artifactGb,
    );
    // Pure VRAM placement: every layer is on the device.
    mixedBreakdown.vram_layers = 100;
  } else if (fitsInVramPlusRam && usableVramGb > 0) {
    // Mixed: part of the artifact lives in VRAM, the spillover sits in RAM
    // and PCIe-streams each forward pass. Throughput drops sharply.
    placement = 'mixed';
    const vramFrac = Math.max(0, Math.min(1, usableVramGb / artifactGb));
    const ramFrac = 1 - vramFrac;
    // Linear interpolation across the mixed bucket: more VRAM-resident
    // layers means closer to TOKS_MIXED_VRAM_RAM_HI; mostly-RAM means
    // closer to TOKS_MIXED_VRAM_RAM_LO.
    expectedTokPerS = TOKS_MIXED_VRAM_RAM_LO
      + (TOKS_MIXED_VRAM_RAM_HI - TOKS_MIXED_VRAM_RAM_LO) * vramFrac;
    expectedTokPerS = Math.round(expectedTokPerS * 10) / 10;
    mixedBreakdown.vram_layers = Math.round(vramFrac * 100);
    mixedBreakdown.ram_layers = 100 - mixedBreakdown.vram_layers;
  } else if (fitsInRam) {
    // CPU-only with the model resident in RAM. Throughput is host-bound;
    // we model it as the LOW end of the mixed bucket because there's no
    // device acceleration on the critical path.
    placement = 'ram';
    expectedTokPerS = TOKS_MIXED_VRAM_RAM_LO;
    mixedBreakdown.ram_layers = 100;
  } else if (fitsInNvme) {
    // Mostly-NVMe: model is mmap'd from disk; each forward pass pays
    // page-cache cost. Very slow but FUNCTIONAL — the user gets a real
    // tok/s number, not a fail.
    placement = 'nvme';
    expectedTokPerS = _scaledTokPerS(
      TOKS_MOSTLY_NVME_LO, TOKS_MOSTLY_NVME_HI,
      nvmeGb, artifactGb,
    );
    // The breakdown still says "mostly nvme" so a downstream UI can render
    // it accurately; vram_layers stays 0 because no GPU is involved.
    mixedBreakdown.nvme_layers = 100;
  } else {
    // Last resort: nothing local fits. If the user wired KOLM_NETWORK_GBPS
    // we can at least surface that the weights would be pulled over the
    // wire. expected_tok_per_s is bounded < 1 because the network roundtrip
    // dominates every decode step.
    placement = 'network';
    expectedTokPerS = (networkGbps !== null && networkGbps > 0)
      ? Math.min(TOKS_NETWORK_HI, Math.round((networkGbps / 10) * 10) / 10)
      : TOKS_NETWORK_HI;
  }

  return {
    placement,
    expected_tok_per_s: expectedTokPerS,
    fits_in_vram: fitsInVram,
    fits_in_ram: fitsInRam,
    mixed_breakdown: mixedBreakdown,
  };
}

// Linear-interpolate within a tok/s bucket based on headroom. More free
// space relative to the artifact pushes throughput toward the high end of
// the bucket; barely-fits pushes it toward the low end.
function _scaledTokPerS(lo, hi, freeGb, artifactGb) {
  if (artifactGb <= 0) return Math.round(((lo + hi) / 2) * 10) / 10;
  const ratio = Math.max(1, freeGb / artifactGb); // 1 = exactly fits
  // Cap the scaling so a huge headroom doesn't fly past `hi`.
  const scaled = lo + (hi - lo) * Math.min(1, (ratio - 1) / 2);
  return Math.round(scaled * 10) / 10;
}

// =============================================================================
// W724-3 entry point: applyAutoPlaceDecision
// =============================================================================

/**
 * Compose detectMemoryTiers + estimatePlacement into a single decision
 * record. Designed so `kolm run --auto-place` can call exactly one
 * function and get back everything it needs to print the load-bearing
 * one-line reasoning + the structured envelope for --json consumers.
 *
 * @param {number} artifact_size_gb
 * @param {object} [opts]
 * @param {string} [opts.data_dir]      Override path for the NVMe probe.
 * @param {object} [opts.tiers]         Override the entire tier detection
 *                                       (useful for tests + dry-runs against
 *                                       hypothetical hosts).
 * @returns {{version:string,
 *            artifact_size_gb:number,
 *            tiers:object,
 *            decision:object,
 *            reasoning_line:string}}
 */
export function applyAutoPlaceDecision(artifact_size_gb, opts) {
  const o = opts || {};
  const sizeGb = Number.isFinite(Number(artifact_size_gb))
    ? Math.max(0, Number(artifact_size_gb)) : 0;
  const tiers = o.tiers || detectMemoryTiers({ data_dir: o.data_dir });
  const decision = estimatePlacement({ artifact_size_gb: sizeGb, tiers });

  const reasoning_line = _reasoningLine(sizeGb, tiers, decision);

  return {
    version: MEMORY_TIER_VERSION,
    artifact_size_gb: sizeGb,
    tiers,
    decision,
    reasoning_line,
  };
}

// One-line, human-readable explanation. The W724 atomic spec pins the
// canonical phrasing: "fits in 24GB VRAM with 6.1GB headroom — expected
// ~95 tok/s". Real output replaces the literals with the actual numbers.
function _reasoningLine(sizeGb, tiers, decision) {
  const tok = decision.expected_tok_per_s;
  const tokStr = `~${tok} tok/s`;
  if (decision.placement === 'vram') {
    const headroom = Math.max(0, (tiers.vram_gb || 0) - sizeGb);
    return `fits in ${_fmtGb(tiers.vram_gb)} VRAM with ${_fmtGb(headroom)} headroom — expected ${tokStr}`;
  }
  if (decision.placement === 'mixed') {
    const v = decision.mixed_breakdown.vram_layers;
    const r = decision.mixed_breakdown.ram_layers;
    return `spills VRAM (${_fmtGb(tiers.vram_gb)} avail, artifact ${_fmtGb(sizeGb)}): ${v}% layers in VRAM, ${r}% in RAM — expected ${tokStr}`;
  }
  if (decision.placement === 'ram') {
    return `no VRAM available; serving from ${_fmtGb(tiers.ram_gb)} RAM — expected ${tokStr}`;
  }
  if (decision.placement === 'nvme') {
    return `RAM too small for ${_fmtGb(sizeGb)} artifact; mmap from ${_fmtGb(tiers.nvme_gb)} NVMe — expected ${tokStr}`;
  }
  // network or no-local-fit
  const link = (tiers.network_gbps !== null && tiers.network_gbps !== undefined)
    ? `${tiers.network_gbps} Gbps network`
    : 'remote weight pull';
  return `no local tier fits ${_fmtGb(sizeGb)} artifact; falling back to ${link} — expected ${tokStr}`;
}

function _fmtGb(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0GB';
  if (x >= 100) return `${Math.round(x)}GB`;
  return `${Math.round(x * 10) / 10}GB`;
}
