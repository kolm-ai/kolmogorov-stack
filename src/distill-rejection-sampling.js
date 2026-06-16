// src/distill-rejection-sampling.js
//
// FINALIZED-C4 - Rejection-sampling / best-of-N distillation trainer.
//
// This is the STaR / RAFT / best-of-N distillation regime, the bridge between
// pure SFT-KD (workers/distill/train_lora.py) and full GRPO/RLVR
// (src/distill-grpo.js). For each prompt we:
//
//   1. sample N candidates from the teacher (or the student, for self-
//      distillation) at a temperature,
//   2. score EVERY candidate with the SAME reward path the GRPO/RLVR trainer
//      uses (the reward families in apps/trainer/grpo.py REWARD_FUNCTIONS + the
//      kolm_verifier reward), so the accept-scorer and the GRPO reward stay ONE
//      path. (NOTE: this is the GRPO *training* reward, NOT the K-score *ship
//      gate*'s accuracy axis - the gate scores accuracy via eval_adapter.py
//      _judge_local recall-overlap; do not conflate the two.)
//   3. keep the best (or first above-threshold) candidate per prompt,
//   4. fine-tune the student on the ACCEPTED set only.
//
// The selection + scoring half is pure JS and GPU-free so it runs in CI and on
// the Node-only box; it is a faithful port of the Python REWARD_FUNCTIONS so a
// candidate scored here gets the SAME number it would get inside the Python
// trainer's reward call. The Python SFT half (workers/distill/scripts/
// train_rejection.py -> apps.trainer.reject_sample) reuses the ACTUAL
// apps.trainer.grpo.REWARD_FUNCTIONS, so the two scorers cannot drift: the
// JS port has a parity self-test against the Python families' contract.
//
// run-meta surfaces: accept_rate, mean_candidate_score, mean_accepted_score,
// num_candidates (N), threshold, selection ('best' | 'threshold'), and the
// per-prompt accept/reject ledger hash so the receipt chain is auditable.
//
// Citations:
//   STaR:  Zelikman et al, 2022, arXiv:2203.14465 (bootstrap on correct traces)
//   RAFT:  Dong et al, 2023, arXiv:2304.06767 (reward-ranked fine-tuning)
//   RFT:   Yuan et al, 2023, arXiv:2308.01825 (rejection-sampling fine-tuning)
//   Best-of-N / BOND: Sessa et al, 2024, arXiv:2407.14622

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

// The verifiable reward families. MUST match apps/trainer/grpo.py
// REWARD_FUNCTIONS keys + the two synthetic families train_grpo.py adds
// ('format', 'kolm_verifier') so a method=rejection_sampling run can reuse any
// reward the GRPO path can. distill-grpo.js already exports this exact set; we
// keep an independent copy so this module has no import cycle with the GRPO
// shell, and assert equality in the test.
export const REWARD_FAMILIES = Object.freeze([
  'code_exec', 'math_checker', 'schema_validator', 'format', 'kolm_verifier',
]);

// Selection strategies. 'best' keeps the argmax-score candidate per prompt;
// 'threshold' keeps the FIRST candidate scoring >= threshold (RAFT/STaR style:
// any correct trace is a positive example). Both fall back to "reject the
// prompt entirely" when no candidate clears the floor, which is the whole
// point of rejection sampling: a prompt with no good candidate contributes
// ZERO training rows rather than a bad one.
export const SELECTION_MODES = Object.freeze(['best', 'threshold']);

const INSTALL_HINT = [
  'Rejection-sampling / best-of-N distillation SFT requires torch + transformers + peft + accelerate.',
  '',
  'install: pip install torch transformers peft accelerate datasets',
  '',
  'the trainer lives at workers/distill/scripts/train_rejection.py and is invoked as:',
  '  python train_rejection.py --candidates <jsonl> --student <path> --out <dir>',
  '    --reward kolm_verifier --num-candidates 8 --threshold 0.5 --selection best',
  '',
  'override with $KOLM_REJECTION_TRAINER (absolute path to a compatible script).',
].join('\n');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

// ---------------------------------------------------------------------------
// JS port of apps/trainer/grpo.py scoring helpers. These are deliberate, line-
// faithful mirrors so a candidate scored on the Node box gets the SAME reward
// it would get inside the Python trainer. The Python trainer reuses the real
// REWARD_FUNCTIONS; this port exists for the GPU-free selection pass + CI.
// ---------------------------------------------------------------------------

// Mirror of grpo.py::_extract_answer.
export function extractAnswer(text) {
  if (typeof text !== 'string') return null;
  let m = /<answer>([\s\S]*?)<\/answer>/i.exec(text);
  if (m) return m[1].trim();
  m = /\\boxed\{([^{}]+)\}/.exec(text);
  if (m) return m[1].trim();
  m = /(?:final\s+)?answer\s*[:=]\s*(.+?)(?:\n|$)/i.exec(text);
  if (m) return m[1].trim().replace(/\.+$/, '');
  return null;
}

// Mirror of grpo.py::_normalize_number.
function normalizeNumber(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '').replace(/\$/g, '').replace(/%/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// Mirror of grpo.py::reward_math_checker (single completion).
export function rewardMathChecker(completion, reference, tolerance = 1e-4) {
  const ans = extractAnswer(completion);
  if (ans == null) return 0.0;
  const aNum = normalizeNumber(ans);
  const rNum = (typeof reference === 'number')
    ? reference
    : normalizeNumber(String(reference));
  if (aNum != null && rNum != null) {
    return Math.abs(aNum - rNum) <= tolerance ? 1.0 : 0.0;
  }
  return String(ans).trim().toLowerCase() === String(reference).trim().toLowerCase() ? 1.0 : 0.0;
}

// Mirror of grpo.py::reward_schema_validator (regex branch only; JSON-schema
// validation needs the Python jsonschema dep and is resolved Python-side).
export function rewardSchemaValidator(completion, { regex } = {}) {
  if (regex == null) {
    // schema= branch deferred to Python (jsonschema). Treat as un-scoreable
    // in JS -> null so selection defers; the Python pass will re-score these
    // exactly.
    return null;
  }
  try {
    return new RegExp(regex).test(completion) ? 1.0 : 0.0;
  } catch {
    return 0.0;
  }
}

// Mirror of train_grpo.py::kolm_verifier_reward (single completion). This is
// the K-score-style local verifier: token-overlap with the reference + a
// structural-sanity penalty. SAME formula as the Python kolm_verifier so the
// release gate and the selection pass score a candidate identically.
export function rewardKolmVerifier(completion, reference) {
  const text = typeof completion === 'string' ? completion : String(completion);
  let score = 0.5;
  const low = text.toLowerCase();
  if (low.includes('<think>') || low.includes('</think>')) score -= 0.3;
  for (const p of ['i cannot', "i can't", 'as an ai']) {
    if (low.includes(p)) { score -= 0.25; break; }
  }
  if (reference) {
    const a = new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
    const b = new Set(String(reference).toLowerCase().split(/\s+/).filter(Boolean));
    if (a.size && b.size) {
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const union = a.size + b.size - inter;
      score += 0.3 * (union ? inter / union : 0.0);
    }
  }
  return Math.max(0.0, Math.min(1.0, score));
}

// Single-path scorer. Routes a (candidate, row, family) to the matching mirror
// above and returns a reward in [0,1], or null when the family is only
// resolvable Python-side (schema= JSON-schema / code_exec sandbox). `row`
// carries the verifiable column (reference / regex / schema / tests).
export function scoreCandidate(candidate, row, family) {
  switch (family) {
    case 'kolm_verifier':
      return rewardKolmVerifier(candidate, row && (row.reference ?? row.output ?? row.reference_text));
    case 'math_checker':
      return rewardMathChecker(candidate, row && (row.reference ?? row.output));
    case 'schema_validator':
      return rewardSchemaValidator(candidate, { regex: row && row.regex });
    case 'format': {
      const m = /<think>([\s\S]+?)<\/think>/.exec(candidate || '');
      return (m && m[1].trim()) ? 1.0 : 0.0;
    }
    case 'code_exec':
      return null; // sandboxed exec is Python-side only
    default:
      throw new Error(`unknown reward family: ${family}`);
  }
}

// ---------------------------------------------------------------------------
// Best-of-N selection over an in-memory candidate set. This is the heart of
// rejection-sampling: for each prompt, score every candidate, then keep the
// best (or first-above-threshold) candidate IFF it clears the threshold.
// ---------------------------------------------------------------------------

// selectAcceptedSet(groups, opts)
//   groups: [ { id, prompt, row, candidates: [string, ...] } ]
//     row carries the verifiable column for the reward family.
//   opts.family:     reward family name (default 'kolm_verifier')
//   opts.threshold:  accept floor in [0,1] (default 0.5)
//   opts.selection:  'best' | 'threshold' (default 'best')
// Returns { ok, accepted: [{id, prompt, completion, score}], ledger, stats }.
// stats: { prompts, candidates_total, num_candidates_max, accepted, rejected,
//          accept_rate, mean_candidate_score, mean_accepted_score, threshold,
//          selection, family, scored_in_js, deferred_to_python, ledger_hash }.
export function selectAcceptedSet(groups, opts = {}) {
  if (!Array.isArray(groups)) return { ok: false, error: 'groups_not_array' };
  const family = opts.family || 'kolm_verifier';
  if (!REWARD_FAMILIES.includes(family)) {
    return { ok: false, error: 'unknown_reward', detail: `family must be one of ${REWARD_FAMILIES.join('|')}; got ${family}` };
  }
  const threshold = opts.threshold == null ? 0.5 : Number(opts.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { ok: false, error: 'bad_threshold', detail: 'threshold must be a number in [0,1]' };
  }
  const selection = opts.selection || 'best';
  if (!SELECTION_MODES.includes(selection)) {
    return { ok: false, error: 'unknown_selection', detail: `selection must be one of ${SELECTION_MODES.join('|')}` };
  }

  const accepted = [];
  const ledger = [];
  let candidatesTotal = 0;
  let numCandidatesMax = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  let acceptedScoreSum = 0;
  let scoredInJs = 0;
  let deferredToPython = 0;

  for (const g of groups) {
    if (!g || !Array.isArray(g.candidates)) continue;
    const cands = g.candidates;
    candidatesTotal += cands.length;
    if (cands.length > numCandidatesMax) numCandidatesMax = cands.length;

    const scored = [];
    for (const c of cands) {
      const s = scoreCandidate(c, g.row || {}, family);
      if (s == null) {
        deferredToPython++;
        scored.push({ completion: c, score: null });
      } else {
        scoredInJs++;
        scoreSum += s;
        scoreCount++;
        scored.push({ completion: c, score: s });
      }
    }

    const jsScored = scored.filter(x => x.score != null);
    if (jsScored.length === 0) {
      // A TRULY-EMPTY candidate group has nothing to accept AND nothing to
      // defer, so it is a REJECT (zero training rows) - identical to the Python
      // trainer (apps/trainer/reject_sample.py select_accepted, empty branch),
      // keeping the cross-language ledger_hash byte-identical. A NON-empty group
      // whose candidates are all Python-deferred (e.g. the code_exec family,
      // which JS cannot score) stays 'deferred': the Python trainer makes that
      // call with the real reward. (The hash-parity guarantee covers families
      // JS scores in-process; code_exec is authoritatively scored by Python.)
      if (cands.length === 0) {
        ledger.push({ id: g.id, decision: 'reject', best_score: null, n: 0 });
      } else {
        ledger.push({ id: g.id, decision: 'deferred', best_score: null, n: cands.length });
      }
      continue;
    }

    let pick = null;
    if (selection === 'threshold') {
      pick = jsScored.find(x => x.score >= threshold) || null;
    } else {
      // 'best' — argmax score; ties keep the earliest candidate (stable).
      pick = jsScored.reduce((a, b) => (b.score > a.score ? b : a), jsScored[0]);
      if (pick.score < threshold) pick = null;
    }

    const bestScore = jsScored.reduce((m, x) => Math.max(m, x.score), -Infinity);
    if (pick) {
      accepted.push({ id: g.id, prompt: g.prompt, completion: pick.completion, score: pick.score });
      acceptedScoreSum += pick.score;
      ledger.push({ id: g.id, decision: 'accept', score: pick.score, best_score: bestScore, n: cands.length });
    } else {
      ledger.push({ id: g.id, decision: 'reject', best_score: bestScore, n: cands.length });
    }
  }

  const prompts = groups.length;
  const acceptedCount = accepted.length;
  const ledgerStr = ledger.map(l => JSON.stringify(l)).join('\n');
  const stats = {
    prompts,
    candidates_total: candidatesTotal,
    num_candidates_max: numCandidatesMax,
    accepted: acceptedCount,
    rejected: prompts - acceptedCount,
    accept_rate: prompts > 0 ? acceptedCount / prompts : 0,
    mean_candidate_score: scoreCount > 0 ? scoreSum / scoreCount : 0,
    mean_accepted_score: acceptedCount > 0 ? acceptedScoreSum / acceptedCount : 0,
    threshold,
    selection,
    family,
    scored_in_js: scoredInJs,
    deferred_to_python: deferredToPython,
    ledger_hash: 'sha256:' + crypto.createHash('sha256').update(ledgerStr).digest('hex'),
  };
  return { ok: true, accepted, ledger, stats };
}

// ---------------------------------------------------------------------------
// Candidate-file writer. Each group becomes one JSONL row carrying the prompt,
// the verifiable column, and the N sampled candidates so the Python trainer
// can re-score + select with the REAL reward and SFT on the accepted set.
// ---------------------------------------------------------------------------
export function buildCandidatesJsonl(groups, opts, outPath) {
  if (!Array.isArray(groups)) return { ok: false, error: 'groups_not_array' };
  if (!outPath) return { ok: false, error: 'path_required' };
  const family = (opts && opts.family) || 'kolm_verifier';
  const rows = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const prompt = g.prompt != null ? String(g.prompt) : (g.input != null ? String(g.input) : null);
    if (!prompt || !Array.isArray(g.candidates)) continue;
    const row = { id: g.id || null, prompt, candidates: g.candidates.map(String) };
    const r = g.row || {};
    if (family === 'kolm_verifier' || family === 'math_checker') {
      if (r.reference != null) row.references = r.reference;
      else if (r.output != null) row.references = r.output;
    } else if (family === 'schema_validator') {
      if (r.schema != null) row.schemas = r.schema;
      else if (r.regex != null) row.regexes = r.regex;
    } else if (family === 'code_exec') {
      if (r.tests != null) row.tests = r.tests;
    }
    rows.push(row);
  }
  try {
    const dir = path.dirname(outPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: e.message };
  }
  return { ok: true, path: outPath, count: rows.length, family };
}

// ---------------------------------------------------------------------------
// Trainer resolution + durable envelope (mirrors src/distill-grpo.js).
// ---------------------------------------------------------------------------
export function resolveTrainer() {
  if (process.env.KOLM_REJECTION_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_REJECTION_TRAINER;
  if (envCmd) {
    return fs.existsSync(envCmd) ? { script: envCmd, source: 'env' } : null;
  }
  const inRepo = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_rejection.py');
  if (fs.existsSync(inRepo)) return { script: inRepo, source: 'in_repo' };
  return null;
}

export function doctor() {
  const t = resolveTrainer();
  let torch_ok = false;
  try {
    const r = spawnSync(_pythonBin(), ['-c', 'import torch,transformers'], { stdio: 'pipe', timeout: 30000 });
    torch_ok = r.status === 0;
  } catch { /* absent */ }
  return {
    ok: !!t,
    ready: !!t && torch_ok,
    kind: 'distill_rejection_sampling',
    reward_families: REWARD_FAMILIES,
    selection_modes: SELECTION_MODES,
    torch_ok,
    trainer: t ? t.script : null,
    trainer_source: t ? t.source : null,
    install_hint: INSTALL_HINT,
  };
}

// trainRejectionSampling(opts) - durable envelope. Spawns the Python trainer
// when present; returns an honest no_trainer_installed envelope otherwise
// (still writes the run dir). This is the GENUINE branch selected by
// distillation_method=rejection_sampling (see crossFileNeeds in the worker).
export function trainRejectionSampling({
  candidatesPath,
  studentPath,
  rewardFunction = 'kolm_verifier',
  numCandidates = 8,
  threshold = 0.5,
  selection = 'best',
  temperature = 0.8,
  outDir = null,
  namespace = 'default',
  tenant_id = 'local',
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!candidatesPath || !fs.existsSync(candidatesPath)) {
    return { ok: false, error: 'candidates_missing', detail: `candidates file not found: ${candidatesPath}` };
  }
  if (!studentPath) {
    return { ok: false, error: 'student_missing', detail: 'studentPath required' };
  }
  if (!REWARD_FAMILIES.includes(rewardFunction)) {
    return { ok: false, error: 'unknown_reward', detail: `reward must be one of ${REWARD_FAMILIES.join('|')}; got ${rewardFunction}` };
  }
  if (!SELECTION_MODES.includes(selection)) {
    return { ok: false, error: 'unknown_selection', detail: `selection must be one of ${SELECTION_MODES.join('|')}` };
  }
  const th = Number(threshold);
  if (!Number.isFinite(th) || th < 0 || th > 1) {
    return { ok: false, error: 'bad_threshold', detail: 'threshold must be a number in [0,1]' };
  }

  const runDir = outDir || path.join(os.homedir(), '.kolm', 'rejection-runs', `rs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });

  const t = resolveTrainer();
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'distill_rejection_sampling',
      reward_function: rewardFunction,
      num_candidates: numCandidates,
      threshold: th,
      selection,
      temperature,
      run_dir: runDir,
      trainer_kicked: false,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }

  const args = [
    t.script,
    '--candidates', candidatesPath,
    '--student', studentPath,
    '--out', runDir,
    '--reward', rewardFunction,
    '--num-candidates', String(numCandidates),
    '--threshold', String(th),
    '--selection', selection,
    '--temperature', String(temperature),
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];

  let result;
  try {
    result = spawnSync(_pythonBin(), args, { stdio: 'pipe', timeout: timeoutMs });
  } catch (e) {
    return { ok: false, error: 'trainer_spawn_failed', detail: e.message, run_dir: runDir };
  }
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      reward_function: rewardFunction,
      run_dir: runDir,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
    };
  }
  let manifest = null;
  const manifestPath = path.join(runDir, 'run-meta.json');
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* tolerate */ }
  }
  return {
    ok: true,
    kind: 'distill_rejection_sampling',
    reward_function: rewardFunction,
    threshold: th,
    selection,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export default {
  REWARD_FAMILIES,
  SELECTION_MODES,
  extractAnswer,
  rewardMathChecker,
  rewardSchemaValidator,
  rewardKolmVerifier,
  scoreCandidate,
  selectAcceptedSet,
  buildCandidatesJsonl,
  resolveTrainer,
  doctor,
  trainRejectionSampling,
};
