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
import * as eventStore from './event-store.js';
import { computeKScoreV2 } from './kscore.js';

export const KSCORE_SERIES_VERSION = 'kts-v1';

const PROVIDER = 'kolm_kscore_series';
const DEFAULT_TENANT = 'tenant_local';

// --------------------------------------------------------------------------
// Persistence helpers (best-effort; copied pattern from the event-store spec).
// --------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: namespace || 'default',
      provider: PROVIDER, vendor: 'kolm', model: 'kscore-timeseries/v1',
      workflow_id: workflow, status: 'ok',
      prompt_tokens: 0, completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) { return { persisted: false, error: String((e && e.message) || e) }; }
}

async function _readAll({ tenant, namespace, workflow, limit = 5000 }) {
  try {
    const rows = await eventStore.listEvents({
      tenant_id: tenant, namespace: namespace || 'default',
      provider: PROVIDER, workflow_id: workflow, limit, order: 'desc',
    });
    return (rows || []).filter(r => r && r.tenant_id === tenant);
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
    const t = tenant || DEFAULT_TENANT;
    const score = Number(kscore);
    if (!Number.isFinite(score)) {
      return { ok: false, error: 'invalid_kscore', version: KSCORE_SERIES_VERSION };
    }
    const when = (typeof ts === 'string' && ts) ? ts : new Date().toISOString();
    const payload = {
      ts: when,
      kscore: score,
      artifact_id: artifact_id == null ? null : String(artifact_id),
      run_id: run_id == null ? null : String(run_id),
    };
    const res = await _persist({ tenant: t, namespace, workflow: 'kscore:point', payload });
    return {
      ok: true,
      version: KSCORE_SERIES_VERSION,
      event_id: res.persisted ? res.event_id : null,
      persisted: res.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: KSCORE_SERIES_VERSION };
  }
}

// Read every recorded point for a tenant/namespace, sorted ASCENDING by ts.
// When window_days is supplied, points older than (now - window_days) are
// dropped from the result.
export async function getKScoreSeries({ tenant, namespace, window_days } = {}) {
  try {
    const t = tenant || DEFAULT_TENANT;
    const rows = await _readAll({ tenant: t, namespace, workflow: 'kscore:point' });
    let points = [];
    for (const row of rows) {
      const p = _parsePayload(row);
      if (!p) continue;
      const score = Number(p.kscore);
      if (!Number.isFinite(score)) continue;
      const when = (typeof p.ts === 'string' && p.ts)
        ? p.ts
        : (row.created_at || new Date().toISOString());
      points.push({
        ts: when,
        kscore: score,
        artifact_id: p.artifact_id == null ? null : p.artifact_id,
        run_id: p.run_id == null ? null : p.run_id,
      });
    }

    if (window_days != null && Number.isFinite(Number(window_days))) {
      const cutoff = Date.now() - Number(window_days) * 24 * 60 * 60 * 1000;
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

    return { ok: true, version: KSCORE_SERIES_VERSION, points, n: points.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: KSCORE_SERIES_VERSION };
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
      const entries = fs.readdirSync(studentDir);
      const globbed = entries
        .filter(name => /^eval-.*\.json$/i.test(name))
        .sort()
        .map(name => path.join(studentDir, name));
      candidates = candidates.concat(globbed);
      const plain = path.join(studentDir, 'eval.json');
      if (fs.existsSync(plain)) candidates.push(plain);
    }
    for (const file of candidates) {
      try {
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
    const t = tenant || DEFAULT_TENANT;
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
          .map(name => ({ name, full: path.join(dir, name) }))
          .filter(e => {
            try { return fs.statSync(e.full).isDirectory(); } catch { return false; }
          });
      }
    } catch { subdirs = []; }

    for (const sub of subdirs) {
      scanned += 1;
      const run_id = sub.name;
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
    return { ok: false, error: String((e && e.message) || e), version: KSCORE_SERIES_VERSION };
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
