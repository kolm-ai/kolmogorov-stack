// KOLM Data Engine — CURATE stage (T2.x).
//
// Turns a raw merged pile of {input, output} training pairs into a curated
// set fit for distillation. The pipeline is six gated stages, each toggled by
// its own opt and each recording what it dropped/changed so the Data Health
// panel can show WHY a pair did or did not survive:
//
//   a. quality   — drop pairs whose teacher output scores below minQuality
//                  (uses the local scoreCandidateLocal heuristic below).
//   b0. minhash  — OPT-IN (opts.minhash) Node-native MinHash/LSH near-dup
//                  pre-pass (src/minhash-dedup.js) that collapses exact + near-
//                  exact dups off-GPU BEFORE the python pass. Default OFF.
//   b. dedup     — shell to workers/distill/scripts/dedup_pairs.py for
//                  semantic near-dup removal. DEGRADES to a no-op (recorded)
//                  if python / the script is unavailable — never fails curate.
//   c. cluster   — tag each survivor with a cluster_id (reuses _bucketKey from
//                  src/active-learning.js) and build a coverage histogram.
//   d. cot       — drop pairs whose output leaks chain-of-thought.
//   e. pii       — redact (NOT drop) emails / phones / SSN / card numbers.
//   f. select    — OPT-IN (opts.target_size>0) informative-subset SELECTION
//                  (src/data-select.js) that caps survivors to a budget-bounded
//                  diversity-aware / target-matched subset. Default OFF.
//
// The opt-in stages (b0, f) are ADDITIVE: with default opts they do not run and
// the curate result is identical to the original five-stage pipeline. New report
// fields (backend_used, n_clusters, minhash, selection) stay null/'none' unless
// the corresponding opt is set.
//
// W921 frontier upgrades (ALL opt-in; default behavior unchanged):
//   - opts.qualityClassifier — replace the quality stage's output-only heuristic
//     with the learned per-pair quality CLASSIFIER (src/data-quality-classifier.js,
//     FineWeb-Edu/DCLM/AlpaGasus lineage). opts.quality_mode 'percentile' (top
//     keep_fraction, DCLM-style) | 'absolute'. Surfaces report.quality + stamps
//     p.quality_score. Pure JS.
//   - opts.semanticCluster — replace the 3-gram-prefix bucket cluster stage with
//     embedding k-means + c-TF-IDF topic auto-labeling (src/data-cluster-label.js).
//     Surfaces report.topics (named, human-readable slugs). Pure JS.
//   - opts.detectErrors — NEW 'error' sub-stage (after cluster) running Confident-
//     Learning label-error detection (src/data-label-errors.js). FLAGS by default
//     (stamps provenance.error_flag; routes to the human review queue); opt-in
//     errorAction:'filter' drops the flagged set. Surfaces report.label_errors.
//   - opts.diversitySelect / select_method 'k-center'|'facility-location'|'badge'
//     — route the SELECT stage through src/data-diversity-select.js instead of the
//     default data-select reprFilter/coverage path.
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

import * as eventStore from './event-store.js';
import activeLearning from './active-learning.js';
import { minhashPredup } from './minhash-dedup.js';
import { selectInformativeSubset } from './data-select.js';
// The INGEST stage (data-ingest.js) is the single authority on where a namespace's
// raw-pairs.jsonl lives. Reuse its path so curate reads exactly where ingest wrote,
// in every KOLM_DATA_DIR config (data-ingest treats KOLM_DATA_DIR as the data root
// directly: <root>/<ns>/raw-pairs.jsonl; curate's own _nsDir adds .kolm/data and so
// diverged when KOLM_DATA_DIR was set).
import { rawPairsPath as _ingestRawPairsPath } from './data-ingest.js';
// ── opt-in W921 frontier curation modules (additive; default OFF) ─────────────
import { selectDiverse as _selectDiverse } from './data-diversity-select.js';
import { clusterAndLabel as _clusterAndLabel } from './data-cluster-label.js';
import {
  scoreQuality as _scoreQualityLearned,
  applyThreshold as _applyQualityThreshold,
} from './data-quality-classifier.js';
import { detectLabelErrors as _detectLabelErrors, routeErrorsToReview as _routeErrorsToReview } from './data-label-errors.js';

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

// ── local quality heuristic (was imported; now a real local fn) ──────────────
//
// scoreCandidateLocal — output-only quality score in [0,1]. Previously imported
// from src/distill-preference.js, but the committed module no longer exports it,
// which left this whole module UNLOADABLE. We restore it as a real local fn
// (spec G1 fix) so CURATE can import + run. The heuristic mirrors the survivor
// scorer in src/minhash-dedup.js (_scoreQuality) and the python score_quality in
// workers/distill/scripts/dedup_pairs.py so dedup + curate + preference agree on
// what "good output" means. Penalizes leaked chain-of-thought + refusals + very
// short text; mildly lifts well-sized, structured answers and seed overlap.
const _REFUSAL_RE = /\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b/i;
const _STRUCTURE_RE = /(^|\n)\s*(\d+[.)]|[-*•])\s+/m;

function _wordsLower(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function _tokenOverlapScore(candidate, reference) {
  const ref = new Set(_wordsLower(reference).filter((w) => w.length > 2));
  if (ref.size === 0) return 0;
  const cand = new Set(_wordsLower(candidate).filter((w) => w.length > 2));
  let inter = 0;
  for (const w of cand) if (ref.has(w)) inter += 1;
  return inter / ref.size;
}

export function scoreCandidateLocal(output, seed) {
  const s = String(output == null ? '' : output);
  const components = {};
  let score = 0.5;
  components.base = 0.5;

  if (flagCot(s)) { score -= 0.5; components.cot_penalty = -0.5; }
  if (_REFUSAL_RE.test(s)) { score -= 0.2; components.refusal_penalty = -0.2; }

  const n = s.trim().length;
  let lenAdj = 0;
  if (n < 20) lenAdj = -0.2;
  else if (n < 60) lenAdj = -0.1;
  else if (n <= 1200) lenAdj = 0.1;
  else if (n > 2000) lenAdj = -0.1;
  score += lenAdj;
  components.length_adj = lenAdj;

  if (_STRUCTURE_RE.test(s)) { score += 0.05; components.structure_bonus = 0.05; }

  if (seed) {
    const ov = 0.3 * _tokenOverlapScore(s, seed);
    score += ov;
    components.seed_overlap = ov;
  }

  const clamped = Math.max(0, Math.min(1, score));
  return { score: clamped, components };
}

// The original output-only heuristic quality gate, factored out so the opt-in
// learned-classifier path and the default path share one definition (and so the
// learned path can degrade back to it without duplicating the loop).
function _runHeuristicQuality(work, o, report) {
  const minQ = Number.isFinite(Number(o.minQuality)) ? Number(o.minQuality) : 0.35;
  const survivors = [];
  for (const p of work) {
    let score = 0;
    try { score = Number(scoreCandidateLocal(_pairOutput(p)).score) || 0; }
    catch (_) { score = 0; } // a scoring failure drops the pair conservatively
    if (score < minQ) report.quality_filtered += 1;
    else survivors.push(p);
  }
  return survivors;
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
      // ── opt-in W921 additions (default OFF → default curate path unchanged) ──
      // minhash: run a Node-native MinHash/LSH near-dup PRE-PASS before the
      //          existing python dedup. Catches exact + near-exact dups off-GPU
      //          (the python pass stays as the tier-2 paraphrase catcher).
      minhash: false,
      minhashThreshold: 0.85, // true-Jaccard floor for the verify pass
      // target_size: when set (>0), run an informative-subset SELECTION stage
      //          after the filter stages. >1 = absolute count, 0<x<=1 = fraction.
      target_size: 0,
      select_strategy: 'diversity', // 'diversity' (self-coverage) | 'dsir' (target-matched)
      diversity_tau: 0.9,
      target_items: null, // reference distribution for the 'dsir' strategy
      // ── W921 frontier opt-ins (default OFF → default curate path unchanged) ──
      // qualityClassifier: use the learned per-pair quality classifier in stage a.
      qualityClassifier: false,
      quality_mode: 'percentile', // 'percentile' (DCLM top keep_fraction) | 'absolute'
      keep_fraction: 0.9,         // percentile retain ratio
      quality_model: null,        // optional fitted model {w,feature_names,...}
      // semanticCluster: replace stage c with embedding k-means + c-TF-IDF labels.
      semanticCluster: false,
      n_clusters: null,           // override auto-k
      cluster_labeler: null,      // optional injectable teacher labeler fn
      // detectErrors: run the Confident-Learning label-error sub-stage after cluster.
      detectErrors: false,
      errorMethod: 'cl',          // 'cl' (offline) | 'clear' (teacher; needs errorSample)
      errorAction: 'review',      // 'review' (flag+enqueue) | 'filter' (drop flagged)
      errorThreshold: null,       // CLEAR gamma override (null => median)
      errorSample: null,          // CLEAR teacher sampler (input,n)=>Promise<string[]>
      errorReflect: null,         // CLEAR self-reflection grader
      routeErrors: true,          // enqueue flagged pairs to the human review queue
      // diversitySelect: route the SELECT stage through the embedding-native
      // diversity algorithms instead of the default data-select path.
      diversitySelect: false,
      select_method: 'k-center',  // 'k-center' | 'facility-location' | 'badge'
    }, opts || {});

    const inFile = in_path || _ingestRawPairsPath(ns);
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
      // ── opt-in W921 fields (stay null/absent unless the new stages run) ──
      // backend_used: which dedup path actually executed
      //   ('none' | 'minhash-js' | 'python:<backend>' | 'minhash-js+python:<backend>').
      backend_used: 'none',
      // n_clusters: count of MinHash near-dup clusters collapsed (null if not run).
      n_clusters: null,
      // minhash: the MinHash pre-pass report block (null if not run).
      minhash: null,
      // selection: the SELECT-stage report block (null if no target_size).
      selection: null,
      // ── W921 opt-in report blocks (null/absent unless the new stages run) ──
      // quality: learned-classifier report {backend, mode, threshold_used, kept,
      //   dropped, score_p50, score_p10} (null when qualityClassifier off).
      quality: null,
      // topics: named c-TF-IDF topics from the semantic cluster stage (null off).
      topics: null,
      // label_errors: the Confident-Learning label-error report (null when off).
      label_errors: null,
    };

    // a. quality — drop low-scoring teacher outputs.
    //    DEFAULT: the output-only scoreCandidateLocal heuristic (back-compat).
    //    OPT-IN (o.qualityClassifier): the learned per-pair quality CLASSIFIER
    //    (FineWeb-Edu/DCLM/AlpaGasus lineage) with a percentile-or-absolute
    //    threshold. Stamps p.quality_score; surfaces report.quality. Never throws
    //    — any failure degrades to the heuristic path.
    if (o.quality && o.qualityClassifier) {
      try {
        const scored = _scoreQualityLearned({ rows: work, backend: 'auto', model: o.quality_model || null });
        const scores = (scored && Array.isArray(scored.scores)) ? scored.scores : work.map(() => 0.5);
        const thr = _applyQualityThreshold(scores, {
          mode: o.quality_mode === 'absolute' ? 'absolute' : 'percentile',
          keep_fraction: Number.isFinite(Number(o.keep_fraction)) ? Number(o.keep_fraction) : 0.9,
          minQuality: Number.isFinite(Number(o.minQuality)) ? Number(o.minQuality) : 0.35,
        });
        const keptSet = new Set(thr.kept_indices);
        const survivors = [];
        for (let i = 0; i < work.length; i++) {
          work[i].quality_score = scores[i];
          if (keptSet.has(i)) survivors.push(work[i]);
          else report.quality_filtered += 1;
        }
        const sorted = scores.slice().sort((a, b) => a - b);
        const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
        report.quality = {
          backend: scored.backend || 'learned-default',
          mode: thr.mode,
          threshold_used: thr.threshold_used,
          kept: survivors.length,
          dropped: work.length - survivors.length,
          score_p50: Number(pct(0.5).toFixed(6)),
          score_p10: Number(pct(0.1).toFixed(6)),
        };
        work = survivors;
      } catch (e) {
        // degrade to the heuristic path; record why the learned path didn't run.
        report.quality = { skipped: 'error:' + String((e && e.message) || e) };
        work = _runHeuristicQuality(work, o, report);
      }
    } else if (o.quality) {
      work = _runHeuristicQuality(work, o, report);
    }

    // b0. minhash-predup — OPT-IN Node-native MinHash/LSH near-dup pre-pass
    //     (runs BEFORE the python pass; catches exact + near-exact dups off-GPU
    //     so the O(n^2)-class python embedding pass only sees survivors). Pure
    //     JS, never throws — degrades to a no-op on its own if it ever errors.
    if (o.minhash) {
      try {
        const pre = minhashPredup(work, {
          jaccardThreshold: Number(o.minhashThreshold) || 0.85,
          verify: true,
        });
        if (pre && Array.isArray(pre.kept)) {
          report.deduped += Math.max(0, work.length - pre.kept.length);
          report.minhash = pre.report;
          report.n_clusters = (pre.report && typeof pre.report.n_clusters === 'number')
            ? pre.report.n_clusters
            : (Array.isArray(pre.clusters) ? pre.clusters.length : null);
          report.backend_used = 'minhash-js';
          work = pre.kept;
        }
      } catch (e) {
        // minhash pre-pass is best-effort — never fails curate.
        report.minhash = { skipped: 'error:' + String((e && e.message) || e) };
      }
    }

    // b. dedup — semantic near-dup removal via python (degrades to no-op).
    if (o.dedup) {
      const ded = _dedupViaPython(work, ns, o.dedupThreshold);
      if (ded.note === 'ok') {
        report.deduped += Math.max(0, work.length - ded.kept.length);
        report.dedup = 'ok';
        const pyBackend = 'python:' + (ded.backend || 'unknown');
        report.backend_used = report.backend_used === 'minhash-js'
          ? 'minhash-js+' + pyBackend
          : pyBackend;
        work = ded.kept;
      } else {
        report.dedup = ded.note; // 'skipped:<reason>'
        // work unchanged — dedup degraded, pipeline continues.
      }
    }

    // c. cluster — tag each survivor + build coverage histogram.
    //    DEFAULT: the 3-gram-prefix hash bucket (back-compat).
    //    OPT-IN (o.semanticCluster): embedding k-means + c-TF-IDF topic auto-
    //    labeling (named, human-readable cluster_id slugs + report.topics).
    //    Degrades to the bucket path on any failure — never fails curate.
    if (o.cluster && o.semanticCluster) {
      let labeled = null;
      try {
        labeled = await _clusterAndLabel({
          pairs: work,
          n_clusters: o.n_clusters || null,
          labeler: typeof o.cluster_labeler === 'function' ? o.cluster_labeler : null,
        });
      } catch (e) {
        labeled = { ok: false, error: String((e && e.message) || e) };
      }
      if (labeled && labeled.ok && Array.isArray(labeled.assigned) && labeled.assigned.length === work.length) {
        for (let i = 0; i < work.length; i++) {
          work[i].cluster_id = labeled.assigned[i].cluster_id;
          work[i].cluster_idx = labeled.assigned[i].cluster_idx;
        }
        report.coverage = labeled.coverage || {};
        report.clusters = Object.keys(report.coverage).length;
        report.topics = labeled.topics || [];
        report.cluster_method = labeled.method;
        report.k_selected = labeled.k;
        report.k_method = labeled.k_method;
      } else {
        // degrade to the 3-gram bucket path.
        const coverage = {};
        for (const p of work) { const cid = _bucketKeyFor(p); p.cluster_id = cid; coverage[cid] = (coverage[cid] || 0) + 1; }
        report.coverage = coverage;
        report.clusters = Object.keys(coverage).length;
        report.cluster_method = 'fallback:3gram';
      }
    } else if (o.cluster) {
      const coverage = {};
      for (const p of work) {
        const cid = _bucketKeyFor(p);
        p.cluster_id = cid;
        coverage[cid] = (coverage[cid] || 0) + 1;
      }
      report.coverage = coverage;
      report.clusters = Object.keys(coverage).length;
    }

    // c2. error — OPT-IN Confident-Learning label-error detection (runs AFTER
    //     cluster so it has cluster_ids to compute the input->output topic-
    //     agreement confident-joint). FLAGS by default (stamps
    //     provenance.error_flag + routes to the human review queue);
    //     errorAction:'filter' drops the flagged set. Never throws.
    if (o.detectErrors && work.length > 0) {
      try {
        const led = await _detectLabelErrors({
          pairs: work,
          clusterField: 'cluster_id',
          method: o.errorMethod === 'clear' ? 'clear' : 'cl',
          action: o.errorAction || 'review',
          threshold: o.errorThreshold,
          sample: typeof o.errorSample === 'function' ? o.errorSample : null,
          reflect: typeof o.errorReflect === 'function' ? o.errorReflect : null,
          tenant: tenantId,
          namespace: ns,
        });
        if (led && led.ok) {
          report.label_errors = {
            flagged: led.flagged,
            by_reason: led.by_reason,
            backend: led.backend,
            off_diagonal_rate: led.off_diagonal_rate,
            median_confidence: led.median_confidence,
            sample: led.sample,
            action: o.errorAction || 'review',
            routed_to_review: 0,
          };
          const flaggedEntries = Array.isArray(led.flagged_entries) ? led.flagged_entries : [];
          // errorAction:'filter' — drop the flagged set (recorded).
          if ((o.errorAction || 'review') === 'filter' && flaggedEntries.length) {
            const drop = new Set(flaggedEntries.map((e) => e.index));
            const survivors = [];
            for (let i = 0; i < work.length; i++) if (!drop.has(i)) survivors.push(work[i]);
            report.label_errors.filtered = work.length - survivors.length;
            work = survivors;
          } else if (o.routeErrors && flaggedEntries.length) {
            // 'review' (default) — enqueue flagged pairs to the human review queue.
            try {
              const routed = await _routeErrorsToReview({
                flaggedPairs: flaggedEntries.map((e) => ({
                  pair: e.pair,
                  method: e.method,
                  score: e.score,
                  reason: e.reason,
                })),
                tenant: tenantId,
                namespace: ns,
                method: o.errorMethod === 'clear' ? 'clear' : 'cl',
              });
              report.label_errors.routed_to_review = routed.enqueued || 0;
            } catch (_) { /* routing is best-effort */ }
          }
        } else {
          report.label_errors = { skipped: 'detect_failed', backend: led && led.backend };
        }
      } catch (e) {
        report.label_errors = { skipped: 'error:' + String((e && e.message) || e) };
      }
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

    // f. select — OPT-IN informative-subset SELECTION (off unless target_size>0).
    //    CURATE only FILTERS by default; this caps the survivors to a budget-
    //    bounded, diversity-aware (or target-distribution-matched) subset so
    //    teacher tokens are spent on the most informative pairs, not near-dups.
    //    Pure JS via src/data-select.js → never throws / hangs / spawns python.
    const targetSize = Number(o.target_size);
    if (Number.isFinite(targetSize) && targetSize > 0 && work.length > 0) {
      try {
        if (o.diversitySelect) {
          // OPT-IN: embedding-native diversity algorithm (k-center / facility-
          // location / badge) from src/data-diversity-select.js.
          const method = ['k-center', 'facility-location', 'badge'].includes(o.select_method)
            ? o.select_method : 'k-center';
          const sel = _selectDiverse({ items: work, target_size: targetSize, method });
          if (sel && sel.ok && Array.isArray(sel.kept)) {
            const beforeSel = work.length;
            work = sel.kept;
            report.selection = {
              strategy: 'diversity-' + method,
              target_size: targetSize,
              n_in: beforeSel,
              n_selected: work.length,
              dropped: Math.max(0, beforeSel - work.length),
              coverage_radius: sel.coverage_radius,
              objective: sel.objective,
              basis: method,
              version: sel.version,
            };
          }
        } else {
          const strategy = o.select_strategy === 'dsir' ? 'dsir' : 'diversity';
          const selOpts = {
            diversity_tau: Number.isFinite(Number(o.diversity_tau)) ? Number(o.diversity_tau) : 0.9,
          };
          if (strategy === 'dsir' && Array.isArray(o.target_items) && o.target_items.length) {
            selOpts.target_items = o.target_items;
          }
          const sel = selectInformativeSubset(work, targetSize, selOpts);
          if (sel && Array.isArray(sel.kept)) {
            const beforeSel = work.length;
            work = sel.kept;
            report.selection = {
              strategy,
              target_size: targetSize,
              diversity_tau: selOpts.diversity_tau,
              n_in: beforeSel,
              n_selected: work.length,
              dropped: Math.max(0, beforeSel - work.length),
              coverage_radius: sel.coverage_radius,
              basis: sel.basis,
              version: sel.version,
            };
          }
        }
      } catch (e) {
        // selection is best-effort — never fails curate; record why it didn't run.
        report.selection = { skipped: 'error:' + String((e && e.message) || e) };
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
  scoreCandidateLocal,
  flagCot,
  flagPii,
  redactPii,
};
