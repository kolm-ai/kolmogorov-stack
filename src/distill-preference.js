// W480 - preference distillation orchestration shell.
//
// Distills RLHF-style preferences without an explicit reward model.
// Supports DPO (Rafailov et al., 2023), SimPO (Meng et al., 2024),
// ORPO (Hong et al., 2024), and KTO (Ethayarajh et al., 2024) as
// different objectives over the same {chosen, rejected} pair format.
//
// This module is a thin Node orchestration shell. The actual gradient
// computation runs in an external trainer (huggingface trl, unsloth,
// or a custom recipe) exposed via $KOLM_PREFERENCE_TRAINER. When the
// trainer is absent we return an honest no_trainer_installed envelope.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export const OBJECTIVES = ['dpo', 'simpo', 'orpo', 'kto'];

const INSTALL_HINT = [
  'preference distillation requires an external trainer.',
  '',
  'set $KOLM_PREFERENCE_TRAINER to the absolute path of a script that accepts:',
  '  --pairs <jsonl>    {prompt, chosen, rejected} rows (or {prompt, response, label} for KTO)',
  '  --student <path>   path to the student adapter root',
  '  --objective <name> dpo | simpo | orpo | kto',
  '  --out <dir>        where to write updated adapter + manifest',
  '',
  'reference implementations:',
  '  - huggingface/trl (DPOTrainer, KTOTrainer)',
  '  - unsloth DPO recipe (docs.unsloth.ai)',
  '  - princeton-nlp/simpo',
].join('\n');

function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try { if (fs.existsSync(name) && fs.statSync(name).isFile()) return name; } catch (_) {} // deliberate: cleanup
    return null;
  }
  const P = process.env.PATH || '';
  const SEP = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  for (const dir of P.split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {} // deliberate: cleanup
    }
  }
  return null;
}

// W713 - resolve the preference trainer. Order of precedence:
//   1. KOLM_PREFERENCE_NO_TRAINER=1 forces the durable no-tool path (test seam,
//      mirrors src/distill-grpo.js's KOLM_GRPO_NO_TRAINER).
//   2. $KOLM_PREFERENCE_TRAINER override (JSON array or PATH name) - an
//      explicit override that points nowhere is "no trainer", NOT a silent
//      fallback to the in-repo script.
//   3. A `kolm-preference-distill` / `preference-distill` on PATH.
//   4. The in-repo workers/distill/scripts/train_preference.py (the first-class
//      K-score-aligned trainer). This is the default that makes the preference
//      path reachable through the product shell (the prior dark-by-default gap).
function resolveTrainer() {
  if (process.env.KOLM_PREFERENCE_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_PREFERENCE_TRAINER;
  if (envCmd) {
    try {
      const parsed = JSON.parse(envCmd);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = whichSync(parsed[0]);
        if (head) return { argv: [head, ...parsed.slice(1)], source: 'env-array' };
      }
    } catch (_) {} // deliberate: cleanup
    const resolved = whichSync(envCmd);
    if (resolved) return { argv: [resolved], source: 'env' };
    return null;
  }
  for (const name of ['kolm-preference-distill', 'preference-distill']) {
    const r = whichSync(name);
    if (r) return { argv: [r], source: 'path' };
  }
  // In-repo first-class trainer (mirrors distill-grpo.js in_repo fallback).
  const inRepo = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_preference.py');
  if (fs.existsSync(inRepo)) return { argv: [_pythonBin(), inRepo], source: 'in_repo' };
  return null;
}

export function doctor() {
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      ready: false,
      kind: 'distill_preference',
      objectives: OBJECTIVES,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  return {
    ok: true,
    ready: true,
    kind: 'distill_preference',
    objectives: OBJECTIVES,
    // For the in_repo path argv is [python, script]; surface the script so
    // doctor names the actual trainer, not the interpreter.
    trainer: t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0],
    trainer_source: t.source,
  };
}

export function trainPreference({
  pairsPath,
  studentPath,
  objective = 'dpo',
  outDir = null,
  tenant_id = 'local',
  namespace = 'default',
  beta = 0.1,
  // W713 - K-score reward shaping. When true (default), the in-repo trainer
  // weights the DPO/SimPO/ORPO loss by the K-score margin derived from each
  // pair's chosen/rejected scores (if the pairs JSONL carries chosen_score /
  // rejected_score or a `margin` field), and records reward_source='kscore' in
  // run-meta.json so the receipt chain proves train-eval scoring parity. Set
  // false to fall back to the vanilla trl loss (no margin weighting).
  kscoreReward = true,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!OBJECTIVES.includes(objective)) {
    return { ok: false, error: 'unknown_objective', detail: `objective must be one of ${OBJECTIVES.join('|')}` };
  }
  if (!pairsPath || !fs.existsSync(pairsPath)) {
    return { ok: false, error: 'pairs_missing', detail: `pairs file not found: ${pairsPath}` };
  }
  if (!studentPath) {
    return { ok: false, error: 'student_missing', detail: 'studentPath required' };
  }
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      deferred: true,
      kind: 'distill_preference',
      objective,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  const runDir = outDir || path.join(os.homedir(), '.kolm', 'preference-runs', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [...t.argv.slice(1),
    '--pairs', pairsPath,
    '--student', studentPath,
    '--objective', objective,
    '--beta', String(beta),
    '--out', runDir,
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
  // W713 - engage the K-score-aligned reward shaping on the in-repo trainer.
  // The external override / PATH trainers may not accept this flag, so only
  // pass it for the in_repo source.
  if (kscoreReward && t.source === 'in_repo') args.push('--reward-source', 'kscore');
  const result = spawnSync(t.argv[0], args, {
    stdio: 'pipe',
    timeout: timeoutMs,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(t.argv[0]),
  });
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      objective,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      run_dir: runDir,
    };
  }
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {} // deliberate: cleanup
  }
  return {
    ok: true,
    kind: 'distill_preference',
    objective,
    run_dir: runDir,
    trainer_source: t.source,
    // W713 - the reward authority the trainer actually used (echoed from the
    // manifest so callers can prove train-eval parity without re-reading disk).
    reward_source: (manifest && manifest.reward_source) || (kscoreReward && t.source === 'in_repo' ? 'kscore' : 'trl_default'),
    manifest,
    stdout: stdout.slice(-2000),
  };
}

// =============================================================================
// W921 - preference PAIR MINING from T2.3 council-disagreement rows + a local
// candidate scorer. ADDITIVE: existing doctor/trainPreference/OBJECTIVES are
// untouched. These let a recipe's preference stage consume council-disagreement
// pairs (chosen=higher-scoring council response, rejected=lower) WITHOUT a
// trainer present (the mining is pure JS).
//
// Mirrors the local-judge heuristic used by workers/distill/scripts/
// eval_adapter.py::_judge_local so the chosen/rejected ranking agrees with the
// K-score T-axis.
// =============================================================================

export const PREFERENCE_MINER_VERSION = 'w921-preference-miner-1';

// tokenOverlap(candidate, reference) -> Jaccard-ish overlap in [0,1] or null.
// Returns null when either side is empty (no signal). Lowercased word-set
// intersection over union - cheap, deterministic, mirrors eval_adapter.
export function tokenOverlap(candidate, reference) {
  if (typeof candidate !== 'string' || typeof reference !== 'string') return null;
  const tok = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  );
  const a = tok(candidate);
  const b = tok(reference);
  if (a.size === 0 || b.size === 0) return null;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : null;
}

// scoreCandidateLocal(text, opts) -> { score in [0,1], reasons[] }.
// Penalizes leaked <think> chain-of-thought, refusals, and emptiness; lifts
// candidates that overlap a provided seed_output. Bounded, deterministic.
export function scoreCandidateLocal(text, opts = {}) {
  const reasons = [];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { score: 0, reasons: ['empty'] };
  }
  let score = 0.5;
  const t = text.trim();

  // <think> CoT leak is a hard penalty (the student must not emit raw CoT).
  if (/<think>|<\/think>|<reasoning>/i.test(t)) { score -= 0.3; reasons.push('cot_leak'); }

  // Refusal patterns.
  if (/\b(i cannot|i can't|i'm not able to|as an ai|i am unable)\b/i.test(t)) {
    score -= 0.25; reasons.push('refusal');
  }

  // Length sanity - very short answers are usually low quality; extremely long
  // ones often ramble. A gentle band.
  const len = t.length;
  if (len < 8) { score -= 0.15; reasons.push('too_short'); }
  else if (len > 40) { score += 0.1; reasons.push('substantive_length'); }

  // Seed-output overlap lifts the score (closer to the reviewed answer).
  if (typeof opts.seed_output === 'string') {
    const ov = tokenOverlap(t, opts.seed_output);
    if (ov != null) {
      score += 0.3 * ov;
      reasons.push(`seed_overlap:${ov.toFixed(2)}`);
    }
  }

  // Clamp.
  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(4)), reasons };
}

// mineDisagreementPairs(rows, opts) -> { ok, pairs, stats, version, basis }.
// rows are council/eval rows shaped like:
//   { prompt|input, candidates:[{model,text,score?}], seed_output? }
//   OR { prompt, responses:[{model, text, score?}], reference? }
// We rank candidates (using provided per-candidate score, else scoreCandidateLocal)
// and emit {prompt, chosen, rejected} for the top/bottom pair when the gap
// exceeds opts.min_gap. Council DISAGREEMENT = the spread between best and worst.
export function mineDisagreementPairs(rows, opts = {}) {
  const min_gap = Number.isFinite(opts.min_gap) ? opts.min_gap : 0.1;
  const max_pairs = Number.isFinite(opts.max_pairs) ? opts.max_pairs : Infinity;
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'rows_not_array', pairs: [], stats: {}, version: PREFERENCE_MINER_VERSION };
  }
  const pairs = [];
  let considered = 0, skipped_no_gap = 0, skipped_shape = 0;
  for (const row of rows) {
    if (pairs.length >= max_pairs) break;
    if (!row || typeof row !== 'object') { skipped_shape++; continue; }
    const prompt = row.prompt != null ? String(row.prompt) : (row.input != null ? String(row.input) : null);
    const cands = Array.isArray(row.candidates) ? row.candidates
      : (Array.isArray(row.responses) ? row.responses : null);
    if (!prompt || !cands || cands.length < 2) { skipped_shape++; continue; }
    considered++;
    const seed = row.seed_output != null ? String(row.seed_output)
      : (row.reference != null ? String(row.reference) : undefined);
    const scored = cands.map((c) => {
      const text = (c && typeof c.text === 'string') ? c.text : String(c && c.response || '');
      const s = (c && Number.isFinite(c.score)) ? c.score : scoreCandidateLocal(text, { seed_output: seed }).score;
      return { model: c && c.model || null, text, score: s };
    }).filter((c) => c.text.length > 0);
    if (scored.length < 2) { skipped_shape++; continue; }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const worst = scored[scored.length - 1];
    const gap = best.score - worst.score;
    if (gap < min_gap) { skipped_no_gap++; continue; }
    pairs.push({
      prompt,
      chosen: best.text,
      rejected: worst.text,
      chosen_model: best.model,
      rejected_model: worst.model,
      disagreement: Number(gap.toFixed(4)),
    });
  }
  return {
    ok: true,
    pairs,
    stats: {
      rows_in: rows.length,
      considered,
      pairs_out: pairs.length,
      skipped_no_gap,
      skipped_shape,
      min_gap,
    },
    version: PREFERENCE_MINER_VERSION,
    basis: 'council_disagreement_local_score',
  };
}

// toKtoRows(pairs) -> [{prompt, completion, label}]. Splits each preference
// pair into a positive (chosen, label=true) then negative (rejected,
// label=false) KTO row. Deterministic order: all chosen-positives are emitted
// for each pair followed by the rejected-negative.
export function toKtoRows(pairs) {
  const out = [];
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs) {
    if (!p || typeof p !== 'object' || p.prompt == null) continue;
    if (p.chosen != null) out.push({ prompt: String(p.prompt), completion: String(p.chosen), label: true });
    if (p.rejected != null) out.push({ prompt: String(p.prompt), completion: String(p.rejected), label: false });
  }
  return out;
}

// writePreferencePairs(pairs, path, {format}) -> { ok, count }.
// format='pref' (default): {prompt,chosen,rejected} JSONL.
// format='kto': {prompt,completion,label} JSONL via toKtoRows.
export function writePreferencePairs(pairs, outPath, { format = 'pref' } = {}) {
  if (!Array.isArray(pairs)) return { ok: false, error: 'pairs_not_array', count: 0 };
  if (!outPath || typeof outPath !== 'string') return { ok: false, error: 'path_required', count: 0 };
  let rows;
  if (format === 'kto') {
    rows = toKtoRows(pairs);
  } else if (format === 'pref') {
    rows = pairs
      .filter((p) => p && p.prompt != null && p.chosen != null && p.rejected != null)
      .map((p) => ({ prompt: String(p.prompt), chosen: String(p.chosen), rejected: String(p.rejected) }));
  } else {
    return { ok: false, error: 'unknown_format', count: 0, detail: "format must be 'pref' or 'kto'" };
  }
  try {
    const dir = path.dirname(outPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: e.message, count: 0 };
  }
  return { ok: true, count: rows.length, format, path: outPath };
}

// W921 - extended doctor: in addition to the W480 trainer probe, report which
// preference TRAINER KIND is available (in_repo apps.trainer.train_preference,
// external $KOLM_PREFERENCE_TRAINER, or none) + whether trl is importable.
// Additive: returns a superset envelope; callers reading the W480 fields are
// unaffected.
export function doctorExtended() {
  const base = doctor();
  let trainer_kind = 'none';
  if (process.env.KOLM_PREFERENCE_TRAINER) trainer_kind = 'external';
  else {
    try {
      const inRepo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'workers', 'distill', 'scripts', 'train_preference.py');
      if (fs.existsSync(inRepo)) trainer_kind = 'in_repo';
    } catch (_) { /* best-effort */ }
  }
  let trl_importable = false;
  try {
    const py = process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const r = spawnSync(py, ['-c', 'import trl'], { stdio: 'pipe', timeout: 20000 });
    trl_importable = r.status === 0;
  } catch (_) { trl_importable = false; }
  return { ...base, trainer_kind, trl_importable, miner_version: PREFERENCE_MINER_VERSION };
}

export default {
  doctor,
  doctorExtended,
  trainPreference,
  OBJECTIVES,
  INSTALL_HINT,
  // W921 additive
  PREFERENCE_MINER_VERSION,
  tokenOverlap,
  scoreCandidateLocal,
  mineDisagreementPairs,
  toKtoRows,
  writePreferencePairs,
};
