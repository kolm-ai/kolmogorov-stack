// src/compute/index.js
//
// Compute backend abstraction. Public API for picking where training runs.
//
// Mental model: every compute target — CPU, GPU, MPS, MLX, Modal, RunPod,
// Together, Vast, the user's own SSH-reachable box — is a backend. Backends
// are loaded from registry.json (capability matrix) and dispatched through
// the thin adapter modules in src/compute/backends/*.js.
//
// The picker scores every backend that survives constraint filtering
// (train_required, airgap, min_vram_gb, budget_usd) and returns the best
// available, with the runners-up and reason logged for provenance.
//
// All choices ride into the receipt:
//   receipt.compute = { backend, device, cost_usd, started_at, finished_at,
//                       provenance: { sdk_version, container_digest?, region? } }
// so anyone verifying the .kolm later can see exactly where it was built.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, 'registry.json');
const DETECT_CACHE_PATH = path.join(os.homedir(), '.kolm', 'compute-detect.json');
const DETECT_CACHE_TTL_SECONDS = 3600;

let _registryCache = null;
function loadRegistry() {
  if (_registryCache) return _registryCache;
  _registryCache = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  return _registryCache;
}

export function list() {
  return loadRegistry().backends.slice();
}

export function info(name) {
  return list().find((b) => b.name === name) || null;
}

// Load adapter module on demand. Pure dynamic import; missing modules are
// silently treated as "not available right now" rather than fatal.
async function loadAdapter(name) {
  const filename = name.replace(/[^a-z0-9-]/gi, '');
  try {
    const mod = await import(`./backends/${filename}.js`);
    return mod.default || mod;
  } catch {
    return null;
  }
}

// detect() runs every adapter's detect() and caches the result for an hour
// under ~/.kolm/compute-detect.json. Refresh with force=true.
export async function detect({ force = false } = {}) {
  if (!force && fs.existsSync(DETECT_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(DETECT_CACHE_PATH, 'utf-8'));
      const age = (Date.now() - new Date(cached.at).getTime()) / 1000;
      if (age < DETECT_CACHE_TTL_SECONDS) return cached;
    } catch { /* fall through */ }
  }
  const out = { at: new Date().toISOString(), backends: {} };
  for (const b of list()) {
    const adapter = await loadAdapter(b.name);
    if (!adapter || typeof adapter.detect !== 'function') {
      out.backends[b.name] = { available: false, reason: 'no adapter' };
      continue;
    }
    try {
      out.backends[b.name] = await adapter.detect();
    } catch (err) {
      out.backends[b.name] = { available: false, reason: String(err.message || err) };
    }
  }
  try {
    fs.mkdirSync(path.dirname(DETECT_CACHE_PATH), { recursive: true });
    fs.writeFileSync(DETECT_CACHE_PATH, JSON.stringify(out, null, 2));
  } catch { /* cache is best-effort */ }
  return out;
}

// Performance signal — accelerators outrank CPU even at the same cost.
// Plain heuristic; not a real benchmark. Used only to break ties.
const PERF_BIAS = {
  'local-cuda': 1.00,
  'local-mlx': 0.90,
  'local-mps': 0.85,
  'local-rocm': 0.85,
  'local-directml': 0.70,
  'modal': 0.95,
  'runpod': 0.92,
  'lambda': 0.90,
  'vast': 0.88,
  'together': 0.85,
  'replicate': 0.80,
  'remote-ssh': 0.85,
  'fal': 0.60,
  'local-cpu': 0.30,
};

// Score one backend 0..1 given current detection + user constraints.
// S = 0.35*available + 0.20*cost_inv + 0.15*latency_inv + 0.15*repro + 0.15*perf
function scoreBackend(b, det, constraints) {
  const available = det.available ? 1 : 0;
  // Normalize cost: $0/hr → 1.0, $5/hr → 0.0
  const cost = b.cost_per_hour_usd == null ? 0.5 : Math.max(0, 1 - b.cost_per_hour_usd / 5);
  // Normalize latency: 0s → 1.0, 120s → 0.0
  const latency = Math.max(0, 1 - (b.cold_start_seconds || 0) / 120);
  // Repro: local + open framework gets full points; managed services partial.
  const repro = b.kind === 'local' ? 1.0 : b.kind === 'self-hosted' ? 0.9 : 0.6;
  const perf = PERF_BIAS[b.name] ?? 0.5;
  return 0.35 * available + 0.20 * cost + 0.15 * latency + 0.15 * repro + 0.15 * perf;
}

function passesConstraints(b, det, constraints) {
  if (constraints.train_required && !b.train) return false;
  if (constraints.airgap && !b.airgap) return false;
  if (constraints.airgap && b.airgap === 'depends' && !constraints.allow_private_remote) return false;
  if (constraints.min_vram_gb != null) {
    if (b.vram_cap_gb === null) return false;
    if (typeof b.vram_cap_gb === 'number' && b.vram_cap_gb < constraints.min_vram_gb) return false;
  }
  if (constraints.budget_usd != null && b.cost_per_hour_usd != null && b.cost_per_hour_usd > constraints.budget_usd) return false;
  if (constraints.tier_max != null && b.tier > constraints.tier_max) return false;
  if (constraints.exclude && constraints.exclude.includes(b.name)) return false;
  return true;
}

// pick() returns the best backend for the given constraints. Defaults: train
// required, no airgap, no budget cap, tier ≤ 2.
export async function pick(constraints = {}) {
  const c = { train_required: true, tier_max: 2, ...constraints };
  const det = await detect();
  const scored = list()
    .filter((b) => passesConstraints(b, det.backends[b.name] || {}, c))
    .map((b) => ({
      backend: b,
      detection: det.backends[b.name] || { available: false },
      score: scoreBackend(b, det.backends[b.name] || { available: false }, c),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { backend: null, reason: 'no backend matched constraints', alternatives: [] };
  }

  const winner = scored[0];
  return {
    backend: winner.backend.name,
    device: winner.detection.device || null,
    score: Number(winner.score.toFixed(3)),
    reason: winner.detection.available
      ? `available; score ${winner.score.toFixed(3)} (${winner.backend.kind})`
      : `best capability match (not currently available; will queue or error at runtime)`,
    alternatives: scored.slice(1, 4).map((s) => ({
      backend: s.backend.name,
      score: Number(s.score.toFixed(3)),
      available: s.detection.available,
    })),
  };
}

// use() — flip the default backend in ~/.kolm/config.json. Doesn't run anything.
export function use(name) {
  const reg = info(name);
  if (!reg) throw new Error(`unknown backend: ${name}`);
  const cfgPath = path.join(os.homedir(), '.kolm', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch { /* new file */ }
  cfg.default_compute_backend = name;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return { backend: name, written_to: cfgPath };
}

// run() — execute one training spec against a chosen backend. Returns a
// TrainResult shaped like the doc in audit-compute-providers-2026-05-14.md.
// Adapters report progress through the on_progress callback (stage, pct).
export async function run(backendName, spec, { on_progress } = {}) {
  const adapter = await loadAdapter(backendName);
  if (!adapter) throw new Error(`no adapter for backend: ${backendName}`);
  if (typeof adapter.run !== 'function') {
    throw new Error(`adapter ${backendName} has no run() — bridge through trainer`);
  }
  const started_at = new Date().toISOString();
  const result = await adapter.run(spec, { on_progress });
  const finished_at = new Date().toISOString();
  return {
    ...result,
    compute: {
      ...(result.compute || {}),
      backend: backendName,
      started_at,
      finished_at,
    },
  };
}

// Lightweight smoke test for one backend. Returns ok|fail + latency_ms.
export async function test(name) {
  const adapter = await loadAdapter(name);
  if (!adapter) return { ok: false, reason: 'no adapter' };
  if (typeof adapter.test === 'function') {
    const t0 = Date.now();
    try {
      const out = await adapter.test();
      return { ok: !!out.ok, latency_ms: Date.now() - t0, ...out };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }
  // Fallback: just detect.
  const det = await adapter.detect();
  return { ok: !!det.available, ...det };
}

export default { list, info, detect, pick, use, run, test };
