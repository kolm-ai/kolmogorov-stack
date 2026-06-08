// W888-D - Quant-ladder Pareto frontier per device.
//
// testQuants({ baseArtifactPath, deviceId, quantLadder }) walks a list of
// quant variants (Q8_0, Q6_K, ..., Q2_K), filters to the ones that actually
// fit the device's VRAM, runs a small benchmark each, and returns the rows
// sorted on the Pareto frontier (no row dominates it on BOTH size and k-score).
//
// The implementation looks for sibling artifacts named:
//   <basename-without-ext>.<quant>.gguf   (preferred)
//   <basename-without-ext>-<quant>.gguf
//   <basename-without-ext>.<quant>.kolm
// in the same directory as baseArtifactPath. Quants that have no sibling on
// disk are skipped with a "missing artifact" row in the result.
//
// Each row shape:
//   { quant, artifact_path, size_mb, fits_vram, tok_s, k_score, vram_mb_used, on_frontier, reason? }
//
// Recommendation logic:
//   - Pareto-sort by (size ascending, k_score descending)
//   - Mark on_frontier = true for any row not dominated by another
//   - Recommendation = the smallest-size row whose k_score >= kScoreGate (default 0.75)

import fs from 'node:fs';
import path from 'node:path';

import * as deviceCaps from './device-capabilities.js';
import { testDevice } from './test-device.js';

const DEFAULT_QUANT_LADDER = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'IQ4_XS', 'Q3_K_M', 'Q2_K'];
// W888-D spec ladder: [Q4_K_M, Q5_K_M, Q8_0, IQ4_XS, fp16] - the 5-quant
// frontier the deploy wizard surfaces. CLI default still uses the wider
// ladder; the spec-shape ladder is what testQuantsW888d() runs.
export const W888D_QUANT_LADDER = ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'IQ4_XS', 'fp16'];

function _findQuantSibling(baseArtifactPath, quant) {
  const dir = path.dirname(baseArtifactPath);
  const base = path.basename(baseArtifactPath).replace(/\.(kolm|gguf)$/i, '');
  const candidates = [
    path.join(dir, `${base}.${quant}.gguf`),
    path.join(dir, `${base}.${quant.toLowerCase()}.gguf`),
    path.join(dir, `${base}-${quant}.gguf`),
    path.join(dir, `${base}-${quant.toLowerCase()}.gguf`),
    path.join(dir, `${base}.${quant}.kolm`),
    path.join(dir, `${base}-${quant}.kolm`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Pareto sort: a row R is on the frontier if no other row dominates it on
// BOTH dimensions (lower size AND higher k-score). Tied rows are kept.
function _markPareto(rows) {
  for (const r of rows) {
    if (!r.fits_vram || r.tok_s == null || r.k_score == null) {
      r.on_frontier = false;
      continue;
    }
    const dominated = rows.some(other => {
      if (other === r) return false;
      if (!other.fits_vram || other.tok_s == null || other.k_score == null) return false;
      const smallerOrEqual = (other.size_mb || 0) <= (r.size_mb || 0);
      const higherScore    = (other.k_score || 0) >  (r.k_score || 0);
      const equalScore     = (other.k_score || 0) === (r.k_score || 0);
      const strictSmaller  = (other.size_mb || 0) <  (r.size_mb || 0);
      // other dominates r if (size <= AND k_score > r.k_score) OR (size < AND k_score == r.k_score)
      return (smallerOrEqual && higherScore) || (strictSmaller && equalScore);
    });
    r.on_frontier = !dominated;
  }
  return rows;
}

export async function testQuants({
  baseArtifactPath,
  deviceId,
  quantLadder = DEFAULT_QUANT_LADDER,
  kScoreGate = 0.75,
  port = 8080,
  runtime = 'llama.cpp',
  autoInstall = false,
  SSHConnectionClass = null,
} = {}) {
  if (!baseArtifactPath) {
    const e = new Error('baseArtifactPath is required'); e.code = 'KOLM_E_BAD_ARGS'; throw e;
  }
  if (!deviceId) {
    const e = new Error('deviceId is required'); e.code = 'KOLM_E_BAD_ARGS'; throw e;
  }
  const device = await deviceCaps.getDevice(deviceId);
  if (!device) {
    const e = new Error(`unknown device: ${deviceId}`); e.code = 'KOLM_E_UNKNOWN_DEVICE'; throw e;
  }

  // VRAM budget for the device. Prefer hardware_snapshot then ram_gb*1024.
  const hwVram = (device.hardware_snapshot && device.hardware_snapshot.gpu_vram_mb)
                 || (device.gpu && device.gpu.vram_gb ? device.gpu.vram_gb * 1024 : null);
  // Fallback: try detectHardwareRemote on first miss.
  let deviceVramMb = hwVram;
  if (!deviceVramMb) {
    try {
      const snap = await deviceCaps.detectHardwareRemote(deviceId);
      deviceVramMb = snap && snap.snapshot && snap.snapshot.gpu_vram_mb || null;
    } catch {} // deliberate: cleanup
  }

  const rows = [];
  for (const quant of quantLadder) {
    const artifact = _findQuantSibling(baseArtifactPath, quant);
    if (!artifact) {
      rows.push({
        quant,
        artifact_path: null,
        size_mb: null,
        fits_vram: false,
        tok_s: null,
        k_score: null,
        vram_mb_used: null,
        on_frontier: false,
        reason: 'missing artifact on disk',
      });
      continue;
    }
    const sizeBytes = fs.statSync(artifact).size;
    const sizeMb = Math.round(sizeBytes / 1024 / 1024);
    // Rough VRAM-fit heuristic: model bytes + 30% activation overhead.
    const estVramMb = Math.round(sizeMb * 1.3);
    const fits = !deviceVramMb || estVramMb <= deviceVramMb;
    if (!fits) {
      rows.push({
        quant,
        artifact_path: artifact,
        size_mb: sizeMb,
        fits_vram: false,
        tok_s: null,
        k_score: null,
        vram_mb_used: estVramMb,
        on_frontier: false,
        reason: `does not fit (est ${estVramMb} MB > ${deviceVramMb} MB)`,
      });
      continue;
    }
    // Run a tiny bench (one context, no shard pivot - quant comparison is the axis here).
    try {
      const td = await testDevice({
        artifactPath: artifact, deviceId,
        contexts: [4096], port, runtime, autoInstall, SSHConnectionClass,
      });
      const benchRow = (td.rows || []).find(r => !r.shard_enabled) || (td.rows || [])[0] || {};
      rows.push({
        quant,
        artifact_path: artifact,
        size_mb: sizeMb,
        fits_vram: true,
        tok_s: benchRow.tok_s != null ? benchRow.tok_s : null,
        k_score: benchRow.k_score != null ? benchRow.k_score : null,
        vram_mb_used: estVramMb,
        on_frontier: false, // filled in by _markPareto below
        reason: td.ok ? null : (td.reason || 'bench failed'),
      });
    } catch (e) {
      rows.push({
        quant,
        artifact_path: artifact,
        size_mb: sizeMb,
        fits_vram: true,
        tok_s: null,
        k_score: null,
        vram_mb_used: estVramMb,
        on_frontier: false,
        reason: `bench error: ${e && e.message ? e.message : String(e)}`,
      });
    }
  }

  _markPareto(rows);

  // Recommendation: smallest size whose k_score >= gate.
  const candidates = rows
    .filter(r => r.fits_vram && r.tok_s != null && r.k_score != null && r.k_score >= kScoreGate)
    .sort((a, b) => (a.size_mb || 0) - (b.size_mb || 0));
  const recommendation = candidates[0] || null;

  return {
    ok: true,
    device_id: deviceId,
    device_vram_mb: deviceVramMb,
    base_artifact_path: baseArtifactPath,
    quant_ladder: quantLadder,
    k_score_gate: kScoreGate,
    rows,
    recommendation: recommendation ? {
      quant: recommendation.quant,
      artifact_path: recommendation.artifact_path,
      size_mb: recommendation.size_mb,
      tok_s: recommendation.tok_s,
      k_score: recommendation.k_score,
    } : null,
  };
}

// W888-D spec wrapper: returns rows shaped {quant, k_score, tokens_per_sec,
// vram_used_gb, pareto_frontier} + a `recommended` field naming the quant
// the device should use. Internally just delegates to testQuants() with the
// W888-D 5-quant ladder.
export async function testQuantsW888d({
  baseArtifactPath, deviceId, kScoreGate = 0.75, port = 8080, runtime = 'llama.cpp',
  autoInstall = false, SSHConnectionClass = null,
} = {}) {
  const res = await testQuants({
    baseArtifactPath, deviceId,
    quantLadder: W888D_QUANT_LADDER,
    kScoreGate, port, runtime, autoInstall, SSHConnectionClass,
  });
  return {
    ok: res.ok,
    device_id: res.device_id,
    base_artifact_path: res.base_artifact_path,
    quant_ladder: res.quant_ladder,
    rows: res.rows.map((r) => ({
      quant: r.quant,
      k_score: r.k_score,
      tokens_per_sec: r.tok_s,
      vram_used_gb: r.vram_mb_used != null ? Number((r.vram_mb_used / 1024).toFixed(2)) : null,
      size_mb: r.size_mb,
      pareto_frontier: !!r.on_frontier,
      reason: r.reason || null,
    })),
    recommended: res.recommendation ? res.recommendation.quant : null,
    recommendation: res.recommendation,
  };
}

export default { testQuants, testQuantsW888d, _markPareto, W888D_QUANT_LADDER };
