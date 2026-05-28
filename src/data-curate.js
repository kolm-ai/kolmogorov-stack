// KOLM Data Engine — CURATE stage (T2.x).
//
// Turns a raw merged pile of {input, output} training pairs into a curated
// set fit for distillation. The pipeline is six gated stages, each toggled by
// its own opt and each recording what it dropped/changed so the Data Health
// panel can show WHY a pair did or did not survive:
//
//   a. quality   — drop pairs whose teacher output scores below minQuality
//                  (reuses scoreCandidateLocal from src/distill-preference.js).
//   b. dedup     — shell to workers/distill/scripts/dedup_pairs.py for
//                  semantic near-dup removal. DEGRADES to a no-op (recorded)
//                  if python / the script is unavailable — never fails curate.
//   c. cluster   — tag each survivor with a cluster_id (reuses _bucketKey from
//                  src/active-learning.js) and build a coverage histogram.
//   d. cot       — drop pairs whose output leaks chain-of-thought.
//   e. pii       — redact (NOT drop) emails / phones / SSN / card numbers.
//
// Caveats:
//   - dedup quality is only as good as the embedder the python script can
//     load; with the `ngram` backend it is coarse-but-deterministic, and when
//     python is missing entirely the stage is skipped and recorded as such.
//   - cluster_id from the fallback path is a 3-gram-prefix hash bucket, not a
//     learned topic — good enough to surface coverage holes, not a taxonomy.
//
// Envelope contract: every public call returns {ok:true, version:'curate-v1',
// ...} or {ok:false, error, version:'curate-v1'}. Never throws across the API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { scoreCandidateLocal } from './distill-preference.js';
import * as eventStore from './event-store.js';
import activeLearning from './active-learning.js';

export const CURATE_VERSION = 'curate-v1';

const PROVIDER = 'kolm_data_curate';

// _bucketKey lives behind active-learning's __internals export. Pull it out
// once; fall back to a local 3-word-prefix bucket if the shape ever changes so
// clustering never hard-fails the curate run.
const _bucketKeyExternal = (activeLearning
  && activeLearning.__internals
  && typeof activeLearning.__internals._bucketKey === 'function')
  ? activeLearning.__internals._bucketKey
  : null;

// ── helpers (pure) ──────────────────────────────────────────────────────────

// Chain-of-thought leakage. Two tells:
//   1. an explicit reasoning tag (<think>, <reasoning>, <|thinking|>, ...)
//   2. two or more soft reasoning openers/markers in the same text
// Mirrors the marker sets in src/distill-preference.js so the curate filter
// and the preference miner agree on what "leaked reasoning" means.
const _HARD_COT = [/<\/?think>/i, /<\/?reasoning>/i, /<\|?\s*thinking\s*\|?>/i, /<\|?\s*reasoning\s*\|?>/i];
const _SOFT_COT = [
  /^okay,?\s+so\b/i, /^alright,?\s+so\b/i, /^hmm,?\s/i, /^wait,?\s/i,
  /^so\s+(the\s+user|first|basically)/i, /^first,?\s+i\s+(should|need|will|have)/i,
  /^let\s+me\s+(think|consider|analyze|break)/i, /\bstep[- ]by[- ]step\b/i, /\blet's\s+see\b[.,]/i,
];

export function flagCot(text) {
  const s = String(text == null ? '' : text);
  if (_HARD_COT.some((re) => re.test(s))) return true;
  const softHits = _SOFT_COT.filter((re) => re.test(s)).length;
  return softHits >= 2;
}

// PII regexes. Order matters in redactPii: card/SSN before phone so a 16-digit
// card is not partially eaten by the phone matcher. Each is intentionally
// conservative — we would rather miss an exotic format than redact prose.
const _RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const _RE_CARD = /\b(?:\d[ -]?){13,16}\b/g;            // 13–16 digit card-like
const _RE_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;              // US SSN ###-##-####
const _RE_PHONE = /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/g;

export function flagPii(text) {
  const s = String(text == null ? '' : text);
  return _RE_EMAIL.test(s) || _RE_SSN.test(s) || _RE_CARD.test(s) || _RE_PHONE.test(s);
}

export function redactPii(text) {
  let s = String(text == null ? '' : text);
  // Card + SSN first (longest, most structured), then email, then phone.
  s = s.replace(_RE_CARD, '[REDACTED]');
  s = s.replace(_RE_SSN, '[REDACTED]');
  s = s.replace(_RE_EMAIL, '[REDACTED]');
  s = s.replace(_RE_PHONE, '[REDACTED]');
  return s;
}

function _bucketKeyFor(pair) {
  // _bucketKey reads `prompt` (the input side) for its 3-gram cluster. Shape
  // the pair so external + fallback agree on what text drives the cluster.
  const probe = { prompt: _pairInput(pair), output: _pairOutput(pair) };
  if (_bucketKeyExternal) {
    try {
      const k = _bucketKeyExternal(probe);
      if (k) return String(k);
    } catch (_) { /* fall through to local bucket */ }
  }
  const words = String(_pairInput(pair) || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const prefix = words.slice(0, 3).join(' ');
  return 'cluster_' + (prefix || 'empty');
}

function _pairInput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.input === 'string') return p.input;
  if (typeof p.prompt === 'string') return p.prompt;
  return '';
}

function _pairOutput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.output === 'string') return p.output;
  if (typeof p.teacher_output === 'string') return p.teacher_output;
  if (typeof p.response === 'string') return p.response;
  return '';
}

function _setPairOutput(p, value) {
  // Write the redacted value back onto whichever output field the pair uses,
  // so we don't silently change the row's schema mid-pipeline.
  if (typeof p.output === 'string') { p.output = value; return; }
  if (typeof p.teacher_output === 'string') { p.teacher_output = value; return; }
  if (typeof p.response === 'string') { p.response = value; return; }
  p.output = value;
}

function _dataRoot() {
  return process.env.KOLM_DATA_DIR || os.homedir();
}

function _nsDir(namespace) {
  return path.join(_dataRoot(), '.kolm', 'data', String(namespace || 'default'));
}

function _readJsonl(file) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (_) { return out; } // missing file → empty corpus; caller decides
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); }
    catch (_) { /* skip a single malformed JSONL line */ }
  }
  return out;
}

function _writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body + (rows && rows.length ? '\n' : ''), 'utf8');
}

// ── persistence (best-effort, exact pattern) ────────────────────────────────

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'data-curate/v1',
      workflow_id: workflow,
      status: 'ok',
      prompt_tokens: 0,
      completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return { persisted: false, error: String((e && e.message) || e) };
  }
}

// ── dedup stage (shells to python; degrades) ────────────────────────────────

// Returns { kept: <pairs[]>, report_note: string }. On any failure the kept
// list is the input unchanged and report_note carries 'skipped:<reason>'.
function _dedupViaPython(pairs, namespace, threshold) {
  const py = process.env.KOLM_PYTHON || 'python';
  const script = path.resolve(_findRepoRoot(), 'workers', 'distill', 'scripts', 'dedup_pairs.py');
  if (!fs.existsSync(script)) {
    return { kept: pairs, note: 'skipped:script_missing' };
  }
  let tmpDir;
  try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-curate-dedup-')); }
  catch (e) { return { kept: pairs, note: 'skipped:tmp_failed:' + String((e && e.message) || e) }; }
  const inPath = path.join(tmpDir, 'in.jsonl');
  const outPath = path.join(tmpDir, 'out.jsonl');
  const repPath = path.join(tmpDir, 'report.json');
  try {
    _writeJsonl(inPath, pairs);
    const args = [
      script,
      '--embedder', 'ngram',
      '--pairs', inPath,
      '--out', outPath,
      '--threshold', String(threshold),
      '--report', repPath,
    ];
    const res = spawnSync(py, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(py),
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? String(res.error.message) : ('exit_' + res.status);
      return { kept: pairs, note: 'skipped:' + why };
    }
    // The machine-readable summary is the LAST non-empty stdout line as JSON.
    const stdout = (res.stdout || '').toString();
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    let summary = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { summary = JSON.parse(lines[i]); break; }
      catch (_) { /* keep scanning upward for the JSON summary */ }
    }
    if (!summary || summary.ok !== true) {
      const why = summary && summary.error ? summary.error : 'no_summary';
      return { kept: pairs, note: 'skipped:' + why };
    }
    if (!fs.existsSync(outPath)) {
      return { kept: pairs, note: 'skipped:no_output_file' };
    }
    const kept = _readJsonl(outPath);
    return {
      kept,
      note: 'ok',
      n_in: summary.n_in,
      n_kept: summary.n_kept,
      n_removed: summary.n_removed,
      backend: summary.backend,
    };
  } catch (e) {
    return { kept: pairs, note: 'skipped:' + String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    catch (_) { /* tmp cleanup best-effort */ }
  }
}

// Walk up from this module to the repo root (the dir holding workers/). We are
// at <root>/src/data-curate.js so the parent of __dirname is the root.
function _findRepoRoot() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(here, '..');
}

// ── main API ────────────────────────────────────────────────────────────────

export async function curatePairs({ tenant, namespace, pairs, in_path, out_path, opts } = {}) {
  try {
    const tenantId = tenant || 'tenant_local';
    const ns = namespace || 'default';
    const o = Object.assign({
      quality: true,
      minQuality: 0.35,
      dedup: true,
      dedupThreshold: 0.92,
      cluster: true,
      pii: true,
      cot: true,
    }, opts || {});

    const inFile = in_path || path.join(_nsDir(ns), 'raw-pairs.jsonl');
    const outFile = out_path || path.join(_nsDir(ns), 'curated-pairs.jsonl');

    // Source: explicit array if given, else read the raw jsonl.
    let work = Array.isArray(pairs) ? pairs.slice() : _readJsonl(inFile);
    const nIn = work.length;

    const report = {
      quality_filtered: 0,
      deduped: 0,
      cot_flagged: 0,
      pii_redacted: 0,
      clusters: 0,
      coverage: {},
      dedup: 'not_run',
    };

    // a. quality — drop low-scoring teacher outputs.
    if (o.quality) {
      const minQ = Number.isFinite(Number(o.minQuality)) ? Number(o.minQuality) : 0.35;
      const survivors = [];
      for (const p of work) {
        let score = 0;
        try { score = Number(scoreCandidateLocal(_pairOutput(p)).score) || 0; }
        catch (_) { score = 0; } // a scoring failure drops the pair conservatively
        if (score < minQ) report.quality_filtered += 1;
        else survivors.push(p);
      }
      work = survivors;
    }

    // b. dedup — semantic near-dup removal via python (degrades to no-op).
    if (o.dedup) {
      const ded = _dedupViaPython(work, ns, o.dedupThreshold);
      if (ded.note === 'ok') {
        report.deduped = Math.max(0, work.length - ded.kept.length);
        report.dedup = 'ok';
        work = ded.kept;
      } else {
        report.dedup = ded.note; // 'skipped:<reason>'
        // work unchanged — dedup degraded, pipeline continues.
      }
    }

    // c. cluster — tag each survivor + build coverage histogram.
    if (o.cluster) {
      const coverage = {};
      for (const p of work) {
        const cid = _bucketKeyFor(p);
        p.cluster_id = cid;
        coverage[cid] = (coverage[cid] || 0) + 1;
      }
      report.coverage = coverage;
      report.clusters = Object.keys(coverage).length;
    }

    // d. cot — drop chain-of-thought leakage.
    if (o.cot) {
      const survivors = [];
      for (const p of work) {
        if (flagCot(_pairOutput(p))) report.cot_flagged += 1;
        else survivors.push(p);
      }
      work = survivors;
    }

    // e. pii — redact (NOT drop). Survives the pair, scrubs the output.
    if (o.pii) {
      for (const p of work) {
        const out = _pairOutput(p);
        if (flagPii(out)) {
          _setPairOutput(p, redactPii(out));
          report.pii_redacted += 1;
        }
      }
    }

    const nKept = work.length;
    const nRemoved = nIn - nKept;

    let wrote = false;
    let writeError = null;
    try { _writeJsonl(outFile, work); wrote = true; }
    catch (e) { writeError = String((e && e.message) || e); }

    const persist = await _persist({
      tenant: tenantId,
      namespace: ns,
      workflow: 'data_curate:run',
      payload: {
        n_in: nIn,
        n_kept: nKept,
        n_removed: nRemoved,
        out_path: outFile,
        report,
      },
    });

    return {
      ok: true,
      version: CURATE_VERSION,
      n_in: nIn,
      n_kept: nKept,
      n_removed: nRemoved,
      in_path: Array.isArray(pairs) ? null : inFile,
      out_path: outFile,
      wrote,
      write_error: writeError,
      report,
      persist,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: CURATE_VERSION };
  }
}

export default {
  CURATE_VERSION,
  curatePairs,
  flagCot,
  flagPii,
  redactPii,
};
