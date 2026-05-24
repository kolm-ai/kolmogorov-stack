// src/sla-rollup.js
//
// W788 — SLA persistent dashboard.
//
// Always-on latency (p50/p95/p99) and uptime samplers per surface, with a
// tenant-fenced rollup readable from /v1/sla/rollup, /v1/sla/dashboard, and
// `kolm sla rollup`. Complements src/bench-report-md.js — bench-report has
// p50/p95/p99 only for the bench run (point-in-time); this module persists
// samples to ~/.kolm/sla-samples.jsonl and rolls them over real time windows.
//
// Honest-by-design:
//   - Empty windows return { count: 0, p50: null, p95: null, p99: null,
//     status: 'no_samples_in_window' } — NEVER zeros that look like real
//     measurements. The dashboard renders the honest "no samples" pill
//     instead of pretending 0ms latency means anything.
//   - Tenant fence is defense-in-depth: the route layer pins tenant_id from
//     the auth middleware, and the loop pins it again per row.
//   - Storage is append-only JSONL via direct fs.appendFile to a dedicated
//     file (separate from event-store) — wave-cluster isolation matches
//     W461/W465 patterns. No raw request bodies are ever sampled; only
//     latency_ms + ok-boolean + surface label cross the wire.
//
// Honors:
//   - KOLM_DATA_DIR (overrides ~/.kolm — tests use a temp dir)
//   - HOME (Linux/macOS), USERPROFILE (Windows)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Frozen surface list — adding a new surface is an explicit code change.
// Routes that try to sample for a non-listed surface get rejected loudly
// so the dashboard never silently grows a "ghost" column.
export const SLA_SURFACES = Object.freeze([
  'router_http',   // generic HTTP wrapper for hot routes (whoami, health)
  'cli_compile',   // `kolm compile` end-to-end wall time
  'cli_distill',   // `kolm distill` end-to-end wall time
  'capture_log',   // POST /v1/capture/log
  'intent_ask',    // POST /v1/intent/ask
  'bakeoff',       // POST /v1/bakeoff* family
]);

const SLA_SURFACES_SET = new Set(SLA_SURFACES);

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 90; // 90-day cap so a runaway query cannot
                                  // walk an unbounded file slice.

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _baseDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}

function _samplesFile() {
  const base = _baseDir();
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'sla-samples.jsonl');
}

function _validSurface(surface) {
  return typeof surface === 'string' && SLA_SURFACES_SET.has(surface);
}

function _nowIso() { return new Date().toISOString(); }

function _appendRow(row) {
  fs.appendFileSync(_samplesFile(), JSON.stringify(row) + '\n', 'utf8');
}

// _readAllRows() reads the whole JSONL file once. The dashboard is a
// low-frequency human read (not on the request hot path), so an O(n) sweep
// per rollup is fine until samples cross 1M rows; at that point a SQLite
// or rolling-window cache would replace this. We keep the file simple so
// operators can `tail -f` it for live debugging.
function _readAllRows() {
  const file = _samplesFile();
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch { /* skip malformed lines — JSONL allows partial-write tolerance */ }
  }
  return out;
}

function _windowBounds(windowHours) {
  const hours = Math.max(1, Math.min(MAX_WINDOW_HOURS,
    Number.isFinite(Number(windowHours)) ? Number(windowHours) : DEFAULT_WINDOW_HOURS));
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  return {
    window_hours: hours,
    window_start: new Date(start).toISOString(),
    window_end: new Date(end).toISOString(),
    _startMs: start,
    _endMs: end,
  };
}

// Linear interpolation percentile so two adjacent samples don't both
// collapse onto the same value — keeps the dashboard readable when N is
// small. p must be 0..1.
function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

// sampleLatency({surface, latency_ms, tenant_id, ts?}) appends one row.
// Returns the persisted row. Throws on bad surface so a typo in the
// instrumentation does not silently disappear.
export function sampleLatency({ surface, latency_ms, tenant_id, ts = null } = {}) {
  if (!_validSurface(surface)) {
    const err = new Error('sla.sampleLatency: surface must be one of ' + SLA_SURFACES.join(' | '));
    err.code = 'invalid_surface';
    throw err;
  }
  if (!tenant_id) {
    const err = new Error('sla.sampleLatency: tenant_id is required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const lat = Number(latency_ms);
  if (!Number.isFinite(lat) || lat < 0) {
    const err = new Error('sla.sampleLatency: latency_ms must be a non-negative finite number');
    err.code = 'invalid_latency';
    throw err;
  }
  const row = {
    kind: 'latency',
    surface,
    tenant_id,
    latency_ms: lat,
    ts: ts || _nowIso(),
  };
  _appendRow(row);
  return row;
}

// sampleUptime({surface, ok, tenant_id, ts?}) — one boolean availability
// sample. Used by the route wrapper to log "this surface returned a 2xx /
// did NOT return a 5xx" alongside the latency row.
export function sampleUptime({ surface, ok, tenant_id, ts = null } = {}) {
  if (!_validSurface(surface)) {
    const err = new Error('sla.sampleUptime: surface must be one of ' + SLA_SURFACES.join(' | '));
    err.code = 'invalid_surface';
    throw err;
  }
  if (!tenant_id) {
    const err = new Error('sla.sampleUptime: tenant_id is required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const row = {
    kind: 'uptime',
    surface,
    tenant_id,
    ok: !!ok,
    ts: ts || _nowIso(),
  };
  _appendRow(row);
  return row;
}

// rollupLatency({surface, window_hours, tenant_id}) — pure read. Returns:
//   {
//     surface, window_hours, window_start, window_end, tenant_id,
//     count, p50, p95, p99, min, max,
//     status: 'ok' | 'no_samples_in_window',
//   }
//
// Empty window returns status='no_samples_in_window' with p50/p95/p99 = null
// so the dashboard can render an honest empty state instead of "0ms".
export function rollupLatency({ surface, window_hours = DEFAULT_WINDOW_HOURS, tenant_id } = {}) {
  if (!_validSurface(surface)) {
    const err = new Error('sla.rollupLatency: surface must be one of ' + SLA_SURFACES.join(' | '));
    err.code = 'invalid_surface';
    throw err;
  }
  if (!tenant_id) {
    const err = new Error('sla.rollupLatency: tenant_id is required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const bounds = _windowBounds(window_hours);
  const rows = _readAllRows();
  const samples = [];
  for (const r of rows) {
    if (!r || r.kind !== 'latency') continue;
    // Defense in depth — pin tenant_id per row even though the caller
    // pinned it at the read level. Same pattern as billing-breakdown.js.
    if (r.tenant_id !== tenant_id) continue;
    if (r.surface !== surface) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < bounds._startMs || t > bounds._endMs) continue;
    const lat = Number(r.latency_ms);
    if (!Number.isFinite(lat) || lat < 0) continue;
    samples.push(lat);
  }
  if (!samples.length) {
    return {
      surface,
      tenant_id,
      window_hours: bounds.window_hours,
      window_start: bounds.window_start,
      window_end: bounds.window_end,
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
      status: 'no_samples_in_window',
    };
  }
  samples.sort((a, b) => a - b);
  return {
    surface,
    tenant_id,
    window_hours: bounds.window_hours,
    window_start: bounds.window_start,
    window_end: bounds.window_end,
    count: samples.length,
    p50: _percentile(samples, 0.50),
    p95: _percentile(samples, 0.95),
    p99: _percentile(samples, 0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    status: 'ok',
  };
}

// rollupUptime({surface, window_hours, tenant_id}) — pure read. Returns:
//   {
//     surface, window_hours, window_start, window_end, tenant_id,
//     total_samples, ok_samples, failed_samples, uptime_pct,
//     status: 'ok' | 'no_samples_in_window',
//   }
// uptime_pct is in [0..100]. Empty window returns status='no_samples_in_window'
// with uptime_pct=null so the dashboard does not render a synthesized 100%.
export function rollupUptime({ surface, window_hours = DEFAULT_WINDOW_HOURS, tenant_id } = {}) {
  if (!_validSurface(surface)) {
    const err = new Error('sla.rollupUptime: surface must be one of ' + SLA_SURFACES.join(' | '));
    err.code = 'invalid_surface';
    throw err;
  }
  if (!tenant_id) {
    const err = new Error('sla.rollupUptime: tenant_id is required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const bounds = _windowBounds(window_hours);
  const rows = _readAllRows();
  let total = 0;
  let okCount = 0;
  for (const r of rows) {
    if (!r || r.kind !== 'uptime') continue;
    // Defense in depth — pin tenant per row.
    if (r.tenant_id !== tenant_id) continue;
    if (r.surface !== surface) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < bounds._startMs || t > bounds._endMs) continue;
    total += 1;
    if (r.ok) okCount += 1;
  }
  if (total === 0) {
    return {
      surface,
      tenant_id,
      window_hours: bounds.window_hours,
      window_start: bounds.window_start,
      window_end: bounds.window_end,
      total_samples: 0,
      ok_samples: 0,
      failed_samples: 0,
      uptime_pct: null,
      status: 'no_samples_in_window',
    };
  }
  const uptime_pct = (okCount / total) * 100;
  return {
    surface,
    tenant_id,
    window_hours: bounds.window_hours,
    window_start: bounds.window_start,
    window_end: bounds.window_end,
    total_samples: total,
    ok_samples: okCount,
    failed_samples: total - okCount,
    uptime_pct,
    status: 'ok',
  };
}

// dashboardData({tenant_id, surfaces?:[], window_hours?:24}) bundles
// both rollups for every requested surface into the shape the
// /account/sla.html page renders directly.
export function dashboardData({ tenant_id, surfaces = null, window_hours = DEFAULT_WINDOW_HOURS } = {}) {
  if (!tenant_id) {
    const err = new Error('sla.dashboardData: tenant_id is required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const list = Array.isArray(surfaces) && surfaces.length
    ? surfaces.filter(s => _validSurface(s))
    : SLA_SURFACES.slice();
  const out = [];
  for (const s of list) {
    out.push({
      surface: s,
      latency: rollupLatency({ surface: s, window_hours, tenant_id }),
      uptime: rollupUptime({ surface: s, window_hours, tenant_id }),
    });
  }
  return {
    tenant_id,
    window_hours: _windowBounds(window_hours).window_hours,
    generated_at: _nowIso(),
    surfaces: out,
  };
}

// Test/util — wipes the local SLA sample file. Production callers MUST NOT
// use this; tests rely on it to keep fixtures isolated. Mirrors the
// _wipeLocalState pattern in federated-approvals.js.
export function _wipeLocalState() {
  try { fs.unlinkSync(_samplesFile()); } catch { /* idempotent */ }
}

// Inspector for tests — surfaces the absolute path of the JSONL backing
// store. Not part of the public contract.
export function _samplesFilePath() { return _samplesFile(); }

export default {
  SLA_SURFACES,
  sampleLatency,
  sampleUptime,
  rollupLatency,
  rollupUptime,
  dashboardData,
  _wipeLocalState,
  _samplesFilePath,
};
