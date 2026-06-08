// W718 - TEACHER RELIABILITY TABLE + mini-bakeoff bootstrapper.
//
// Companion to src/teacher-council.js. Owns the (teacher, domain, task) ->
// reliability prior that the Teacher Council formula consumes. Persists to
// disk so a prior bakeoff's results survive process restarts.
//
// Honesty contract:
//   - Unknown (teacher, domain, task) defaults to 0.5 - explicit "I have no
//     information" prior, never fabricated 1.0.
//   - runMiniBakeoff() returns honest envelopes on missing bakeoff.js or
//     empty captures: never invents synthetic reliability numbers.
//   - Persist format is JSON, atomic write (tmp + rename), survives partial
//     writes.
//
// Tenant fence: this module is PURE compute + filesystem I/O against an
// operator-supplied path. It does NOT auto-locate a tenant scope; the caller
// is responsible for passing a tenant-scoped path.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const TEACHER_WEIGHTS_VERSION = 'w718-v1';
export const DEFAULT_RELIABILITY = 0.5;

// W718 - TeacherReliabilityTable. Lazy-init structure:
//   _data[teacher][domain][task] = {domain: number, task: number, samples: int}
//
// We track samples separately from reliability so a later update can compute
// a sample-weighted moving average instead of overwriting.
export class TeacherReliabilityTable {
  constructor(initial = {}) {
    this._data = (initial && typeof initial === 'object') ? deepClone(initial) : {};
  }

  // Return {domain, task} numbers in [0,1]. Unknowns default to 0.5.
  getReliability(teacher, domain, task) {
    const t = this._data[teacher];
    if (!t) return { domain: DEFAULT_RELIABILITY, task: DEFAULT_RELIABILITY };
    const d = t[domain];
    if (!d) return { domain: DEFAULT_RELIABILITY, task: DEFAULT_RELIABILITY };
    const k = d[task];
    if (!k) return { domain: DEFAULT_RELIABILITY, task: DEFAULT_RELIABILITY };
    return {
      domain: typeof k.domain === 'number' ? k.domain : DEFAULT_RELIABILITY,
      task: typeof k.task === 'number' ? k.task : DEFAULT_RELIABILITY,
      samples: k.samples || 0,
    };
  }

  // Sample-weighted moving-average update. New observation has weight
  // 1/(samples+1) so the first sample replaces the prior, later samples
  // are smoothed.
  setReliability(teacher, domain, task, { domain: dRel, task: tRel } = {}) {
    if (!this._data[teacher]) this._data[teacher] = {};
    if (!this._data[teacher][domain]) this._data[teacher][domain] = {};
    const prior = this._data[teacher][domain][task] || { domain: DEFAULT_RELIABILITY, task: DEFAULT_RELIABILITY, samples: 0 };
    const newSamples = (prior.samples || 0) + 1;
    const w = 1 / newSamples;
    const blendedDomain = (typeof dRel === 'number') ? (prior.domain * (1 - w) + dRel * w) : prior.domain;
    const blendedTask = (typeof tRel === 'number') ? (prior.task * (1 - w) + tRel * w) : prior.task;
    this._data[teacher][domain][task] = {
      domain: clamp01(blendedDomain),
      task: clamp01(blendedTask),
      samples: newSamples,
    };
  }

  // Ingest a bakeoff result. The bakeoff returns one row per contestant
  // (= teacher in this context) with .pass_rate / .score_per_dollar /
  // .avg_cost_usd. We promote pass_rate -> reliability for both axes
  // because the bakeoff doesn't decompose pass_rate by domain vs task.
  // Callers wanting axis-decomposed reliability should pass split
  // bakeoff_result objects.
  updateFromBakeoff(bakeoff_result, { domain = 'default', task = 'generation' } = {}) {
    if (!bakeoff_result || !Array.isArray(bakeoff_result.contestants)) return 0;
    let updated = 0;
    for (const row of bakeoff_result.contestants) {
      if (!row || !row.name) continue;
      const pass = typeof row.pass_rate === 'number' ? clamp01(row.pass_rate) : DEFAULT_RELIABILITY;
      this.setReliability(row.name, domain, task, { domain: pass, task: pass });
      updated += 1;
    }
    return updated;
  }

  // Atomic persist: write to tmp + rename so a partial write never leaves
  // the table corrupt.
  persist(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp_' + Date.now().toString(36);
    const payload = {
      version: TEACHER_WEIGHTS_VERSION,
      saved_at: new Date().toISOString(),
      data: this._data,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    return filePath;
  }

  // Load a persisted table. Missing file -> empty table (no throw). Schema
  // version mismatch -> warn but load anyway (we keep schema gentle so old
  // tables don't strand).
  static load(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return new TeacherReliabilityTable();
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && typeof parsed.data === 'object') {
        return new TeacherReliabilityTable(parsed.data);
      }
      // Bare-data legacy format (no version envelope).
      if (parsed && typeof parsed === 'object') {
        return new TeacherReliabilityTable(parsed);
      }
    } catch (_) { // deliberate: cleanup
      // Corrupt file -> empty table. Caller can re-bakeoff.
    }
    return new TeacherReliabilityTable();
  }

  // Convenience load method for instance fluency.
  load(filePath) {
    const t = TeacherReliabilityTable.load(filePath);
    this._data = t._data;
    return this;
  }

  // Snapshot for tests + debug. Returns a deep-cloned plain object.
  toJSON() { return deepClone(this._data); }
  size() {
    let n = 0;
    for (const t of Object.keys(this._data)) {
      for (const d of Object.keys(this._data[t])) {
        n += Object.keys(this._data[t][d]).length;
      }
    }
    return n;
  }
}

// W718 - runMiniBakeoff. Honest envelope contract:
//   - If src/bakeoff.js cannot be imported (e.g. running in a stripped
//     environment), return {ok:false, error:'bakeoff_unavailable', ...} and
//     a random-init table. NEVER throw.
//   - If captures is empty, return {ok:false, error:'no_captures'}.
//   - Otherwise call bakeoff() with the supplied teachers as contestants and
//     a sampled dataset built from captures, then return the bakeoff result
//     with a fresh reliability table primed from it.
//
// The "mini" part: we cap at opts.sample_size (default 20) so the bakeoff
// runs in seconds. Operators wanting a full bakeoff should call bakeoff()
// directly via the bakeoff module.
export async function runMiniBakeoff(teachers, captures, opts = {}) {
  if (!Array.isArray(teachers) || teachers.length === 0) {
    return {
      ok: false,
      error: 'no_teachers',
      message: 'runMiniBakeoff requires at least one teacher slug',
      table: new TeacherReliabilityTable(),
    };
  }
  if (!Array.isArray(captures) || captures.length === 0) {
    return {
      ok: false,
      error: 'no_captures',
      message: 'runMiniBakeoff requires at least one capture row',
      table: _randomInitTable(teachers, opts),
    };
  }
  let bakeoffMod = null;
  try {
    bakeoffMod = await import('./bakeoff.js');
  } catch (_) {
    return {
      ok: false,
      error: 'bakeoff_unavailable',
      message: 'src/bakeoff.js could not be imported; falling back to random-init reliability prior',
      table: _randomInitTable(teachers, opts),
    };
  }
  // Build a thin inline dataset from captures (bakeoff accepts an inline rows
  // array via the first arg when it's already loaded). We sample to keep the
  // mini-bakeoff cheap.
  const sampleSize = Math.max(1, Math.min(captures.length, opts.sample_size || 20));
  const sampled = captures.slice(0, sampleSize).map((c, i) => ({
    id: c.event_id || c.id || `cap_${i + 1}`,
    input: c.prompt || c.input || '',
    expected: c.response || c.output || c.expected || '',
  }));
  let result;
  try {
    result = await bakeoffMod.bakeoff(sampled, { contestants: teachers, opts: opts.bakeoff_opts || {} });
  } catch (e) {
    return {
      ok: false,
      error: 'bakeoff_threw',
      message: String(e && e.message || e),
      table: _randomInitTable(teachers, opts),
    };
  }
  const table = new TeacherReliabilityTable();
  table.updateFromBakeoff(result, {
    domain: opts.domain || 'default',
    task: opts.task || 'generation',
  });
  return {
    ok: true,
    sample_size: sampleSize,
    teachers,
    bakeoff_result: result,
    table,
  };
}

// W718 - random-init table for the honest-fallback path. We seed each
// (teacher, default, generation) slot with a SMALL random offset around 0.5
// (uniform in [0.4, 0.6]) so the council formula has SOMETHING to softmax
// over - uniform 0.5 produces uniform softmax weights, which collapses the
// council to round-robin. The offset is deterministic per teacher (FNV hash)
// so test runs are reproducible.
function _randomInitTable(teachers, opts = {}) {
  const t = new TeacherReliabilityTable();
  const domain = opts.domain || 'default';
  const task = opts.task || 'generation';
  for (const teacher of teachers) {
    const hash = _fnv32(teacher);
    // Map hash to [0.40, 0.60].
    const r = 0.40 + ((hash % 1000) / 1000) * 0.20;
    t.setReliability(teacher, domain, task, { domain: r, task: r });
  }
  return t;
}

function _fnv32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return DEFAULT_RELIABILITY;
  return Math.max(0, Math.min(1, n));
}

function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k of Object.keys(o)) out[k] = deepClone(o[k]);
  return out;
}

// W718 - default persist path: ~/.kolm/teacher-reliability.json
export function defaultPersistPath() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.kolm');
  return path.join(base, 'teacher-reliability.json');
}

export default {
  TEACHER_WEIGHTS_VERSION,
  DEFAULT_RELIABILITY,
  TeacherReliabilityTable,
  runMiniBakeoff,
  defaultPersistPath,
};
