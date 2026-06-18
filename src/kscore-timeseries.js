// K-Score-over-time persistence - the time-series layer for K-Score points.
//
// The rest of the distillation autopilot depends on a durable record of how a
// tenant's K-Score moves over successive runs: trend detection, regression
// gating, and the Data Health panel all read this series. This module persists
// one point per (artifact/run) measurement and reads them back in order.
//
// CONTRACT (kts-v1):
//   - Every exported async function returns an envelope:
//       success: { ok:true,  version:'kts-v1', ... }
//       failure: { ok:false, error:'<reason>', version:'kts-v1' }
//     The public API NEVER throws - internal errors are caught and surfaced as
//     ok:false.
//   - Persistence is best-effort. If the event store is unavailable, a record
//     call still returns ok:true with persisted:false rather than failing the
//     whole call. The point is simply not durably stored.
//
// Persistence rides on src/event-store.js. Each point is one event whose
// payload lives in the `feedback` field as a JSON string (the event store's
// generic side-channel for structured metadata).

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import crypto from 'node:crypto';
import * as eventStore from './event-store.js';
import { computeKScoreV2 } from './kscore.js';

export const KSCORE_SERIES_VERSION = 'kts-v1';
export const KSCORE_SERIES_LIMITS = Object.freeze({
  max_points: 5000,
  max_read_limit: 5000,
  max_backfill_runs: 10000,
  max_eval_json_bytes: 2 * 1024 * 1024,
  max_eval_candidates: 50,
  max_id_chars: 160,
  max_namespace_chars: 128,
  max_path_chars: 4096,
  max_window_days: 3650,
});

const PROVIDER = 'kolm_kscore_series';
const DEFAULT_TENANT = 'tenant_local';

function _safeText(value, fallback, maxChars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxChars);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return fallback;
  return s;
}

function _safeNamespace(value) {
  return _safeText(value == null || value === '' ? 'default' : value, 'default', KSCORE_SERIES_LIMITS.max_namespace_chars);
}

function _safeOptionalId(value) {
  if (value == null) return null;
  return _safeText(value, null, KSCORE_SERIES_LIMITS.max_id_chars);
}

function _safeTimestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function _safeLimit(value, fallback = KSCORE_SERIES_LIMITS.max_read_limit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(KSCORE_SERIES_LIMITS.max_read_limit, Math.trunc(n)));
}

function _safeWindowDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(KSCORE_SERIES_LIMITS.max_window_days, Math.trunc(n)));
}

function _errorDigest(e) {
  const s = String((e && e.message) || e || '');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function _safeDetail(e) {
  return String((e && e.message) || e || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .slice(0, 240);
}

// --------------------------------------------------------------------------
// Persistence helpers (best-effort; copied pattern from the event-store spec).
// --------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: _safeNamespace(namespace),
      provider: PROVIDER, vendor: 'kolm', model: 'kscore-timeseries/v1',
      workflow_id: workflow, status: 'ok',
      prompt_tokens: 0, completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return {
      persisted: false,
      error: 'append_event_failed',
      detail: _safeDetail(e),
      error_sha256: _errorDigest(e),
    };
  }
}

async function _readAll({ tenant, namespace, workflow, limit = 5000 }) {
  try {
    const safeLimit = _safeLimit(limit);
    const rows = await eventStore.listEvents({
      tenant_id: tenant, namespace: _safeNamespace(namespace),
      provider: PROVIDER, workflow_id: workflow, limit: safeLimit, order: 'desc',
    });
    return (Array.isArray(rows) ? rows : []).slice(0, safeLimit).filter(r => r && r.tenant_id === tenant);
  } catch { return []; }
}

// Pull the structured payload back out of an event row's `feedback` field.
function _parsePayload(row) {
  if (!row) return null;
  const raw = row.feedback;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

// Persist one K-Score measurement. `ts` defaults to now (ISO 8601).
// kscore must be a finite number - anything else returns ok:false.
export async function recordKScore({ tenant, namespace, kscore, artifact_id, run_id, ts } = {}) {
  try {
    const t = _safeText(tenant || DEFAULT_TENANT, DEFAULT_TENANT, KSCORE_SERIES_LIMITS.max_id_chars);
    const score = Number(kscore);
    if (!Number.isFinite(score)) {
      return { ok: false, error: 'invalid_kscore', version: KSCORE_SERIES_VERSION };
    }
    const when = _safeTimestamp(ts);
    const payload = {
      ts: when,
      kscore: score,
      artifact_id: _safeOptionalId(artifact_id),
      run_id: _safeOptionalId(run_id),
    };
    const res = await _persist({ tenant: t, namespace, workflow: 'kscore:point', payload });
    return {
      ok: true,
      version: KSCORE_SERIES_VERSION,
      event_id: res.persisted ? res.event_id : null,
      persisted: res.persisted === true,
      persist_error: res.persisted ? null : (res.error || 'persist_failed'),
    };
  } catch (e) {
    return { ok: false, error: 'record_failed', detail: _safeDetail(e), error_sha256: _errorDigest(e), version: KSCORE_SERIES_VERSION };
  }
}

// Read every recorded point for a tenant/namespace, sorted ASCENDING by ts.
// When window_days is supplied, points older than (now - window_days) are
// dropped from the result.
export async function getKScoreSeries({ tenant, namespace, window_days } = {}) {
  try {
    const t = _safeText(tenant || DEFAULT_TENANT, DEFAULT_TENANT, KSCORE_SERIES_LIMITS.max_id_chars);
    const rows = await _readAll({ tenant: t, namespace, workflow: 'kscore:point', limit: KSCORE_SERIES_LIMITS.max_read_limit });
    let points = [];
    for (const row of rows) {
      const p = _parsePayload(row);
      if (!p) continue;
      const score = Number(p.kscore);
      if (!Number.isFinite(score)) continue;
      const when = _safeTimestamp((typeof p.ts === 'string' && p.ts) ? p.ts : row.created_at);
      points.push({
        ts: when,
        kscore: score,
        artifact_id: _safeOptionalId(p.artifact_id),
        run_id: _safeOptionalId(p.run_id),
      });
    }

    const safeWindow = _safeWindowDays(window_days);
    if (safeWindow != null) {
      const cutoff = Date.now() - safeWindow * 24 * 60 * 60 * 1000;
      points = points.filter(p => {
        const ms = new Date(p.ts).getTime();
        return Number.isFinite(ms) ? ms >= cutoff : true;
      });
    }

    points.sort((a, b) => {
      const ta = new Date(a.ts).getTime();
      const tb = new Date(b.ts).getTime();
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
    });
    if (points.length > KSCORE_SERIES_LIMITS.max_points) {
      points = points.slice(points.length - KSCORE_SERIES_LIMITS.max_points);
    }

    return { ok: true, version: KSCORE_SERIES_VERSION, points, n: points.length };
  } catch (e) {
    return { ok: false, error: 'read_failed', detail: _safeDetail(e), error_sha256: _errorDigest(e), version: KSCORE_SERIES_VERSION };
  }
}

// Pull a usable K-Score out of an eval JSON. Prefers an explicit composite/
// mean_score/kscore field; otherwise, if the json carries enough K-Score
// inputs, fall back to computeKScoreV2 and use its composite.
function _extractScore(json) {
  if (!json || typeof json !== 'object') return null;
  for (const key of ['composite', 'mean_score', 'kscore']) {
    const v = Number(json[key]);
    if (Number.isFinite(v)) return v;
  }
  // Fall back to recomputing from K-Score inputs if the eval json carries
  // them (accuracy is the minimum signal computeKScoreV2 needs to be useful).
  if (json.accuracy != null || json.coverage != null || json.size_bytes != null) {
    try {
      const r = computeKScoreV2(json);
      if (r && Number.isFinite(Number(r.composite))) return Number(r.composite);
    } catch { /* deliberate: fall through to null */ }
  }
  return null;
}

// Find the eval json for a run subdir: prefer student/eval-*.json, then
// student/eval.json. Returns the parsed object or null.
function _findRunEval(runDir) {
  try {
    const studentDir = path.join(runDir, 'student');
    let candidates = [];
    if (fs.existsSync(studentDir) && fs.statSync(studentDir).isDirectory()) {
      const entries = fs.readdirSync(studentDir).slice(0, KSCORE_SERIES_LIMITS.max_eval_candidates);
      const globbed = entries
        .filter(name => /^eval-.*\.json$/i.test(name))
        .sort()
        .map(name => path.join(studentDir, name));
      candidates = candidates.concat(globbed);
      const plain = path.join(studentDir, 'eval.json');
      if (fs.existsSync(plain)) candidates.push(plain);
    }
    for (const file of candidates.slice(0, KSCORE_SERIES_LIMITS.max_eval_candidates)) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > KSCORE_SERIES_LIMITS.max_eval_json_bytes) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const json = JSON.parse(raw);
        if (json && typeof json === 'object') return json;
      } catch { /* deliberate: try next candidate */ }
    }
  } catch { /* deliberate: unreadable run dir */ }
  return null;
}

// Scan a runs directory for distillation run subdirs, extract a K-Score from
// each run's eval json, and record one point per run. IDEMPOTENT: any run_id
// already present in the series is skipped (so re-running backfill never
// double-counts a run).
export async function backfillKScoreSeries({ tenant, namespace, runs_dir } = {}) {
  try {
    const t = _safeText(tenant || DEFAULT_TENANT, DEFAULT_TENANT, KSCORE_SERIES_LIMITS.max_id_chars);
    if (typeof runs_dir === 'string' && runs_dir.length > KSCORE_SERIES_LIMITS.max_path_chars) {
      return { ok: false, error: 'runs_dir_too_large', version: KSCORE_SERIES_VERSION };
    }
    const dir = (typeof runs_dir === 'string' && runs_dir)
      ? runs_dir
      : path.join(os.homedir(), '.kolm', 'distill-runs');

    let scanned = 0;
    let recorded = 0;
    let skipped = 0;

    // Existing run_ids in the series - used for idempotent skipping.
    const existing = await getKScoreSeries({ tenant: t, namespace });
    const seen = new Set(
      (existing.ok && Array.isArray(existing.points) ? existing.points : [])
        .map(p => p.run_id)
        .filter(id => id != null)
    );

    let subdirs = [];
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        subdirs = fs.readdirSync(dir)
          .slice(0, KSCORE_SERIES_LIMITS.max_backfill_runs)
          .map(name => ({ name, full: path.join(dir, name) }))
          .filter(e => {
            try { return fs.statSync(e.full).isDirectory(); } catch { return false; }
          });
      }
    } catch { subdirs = []; }

    for (const sub of subdirs) {
      scanned += 1;
      const run_id = _safeOptionalId(sub.name);
      if (!run_id) { skipped += 1; continue; }
      if (seen.has(run_id)) { skipped += 1; continue; }
      const json = _findRunEval(sub.full);
      if (!json) continue;
      const score = _extractScore(json);
      if (score == null) continue;
      const rec = await recordKScore({
        tenant: t, namespace, kscore: score,
        artifact_id: json.artifact_id == null ? null : json.artifact_id,
        run_id,
      });
      if (rec && rec.ok) {
        recorded += 1;
        seen.add(run_id); // guard against duplicate subdir names within one scan
      }
    }

    return { ok: true, version: KSCORE_SERIES_VERSION, recorded, skipped, scanned };
  } catch (e) {
    return { ok: false, error: 'backfill_failed', detail: _safeDetail(e), error_sha256: _errorDigest(e), version: KSCORE_SERIES_VERSION };
  }
}

// Pure summary of a series result (or a bare points array). Returns
// {min,max,latest,trend,n}. trend compares first vs last point:
//   'up'   last > first
//   'down' last < first
//   'flat' equal, or fewer than 2 points.
export function renderSeriesSummary(series) {
  const points = Array.isArray(series)
    ? series
    : (series && Array.isArray(series.points) ? series.points : []);
  const scores = points
    .map(p => Number(p && p.kscore))
    .filter(v => Number.isFinite(v));
  const n = scores.length;
  if (n === 0) {
    return { min: null, max: null, latest: null, trend: 'flat', n: 0 };
  }
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const first = scores[0];
  const latest = scores[n - 1];
  let trend = 'flat';
  if (n >= 2) {
    if (latest > first) trend = 'up';
    else if (latest < first) trend = 'down';
  }
  return { min, max, latest, trend, n };
}
