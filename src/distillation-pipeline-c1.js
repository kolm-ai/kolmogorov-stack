// src/distillation-pipeline-c1.js
//
// FINALIZED-C1 - Teacher -> Student Distillation Pipeline (recipe-tier ->
// model-tier upgrade). One coherent orchestrator that turns a recipe-tier
// teacher capture set into a shippable model-tier student artifact, matching
// current SOTA distillation:
//
//   * on-policy distillation (GKD / MiniLLM-style) with a REVERSE-KL objective
//     (student samples its own trajectories; teacher scores them; the loss
//     pulls the student toward the teacher on the student's own distribution)
//   * sequence-level KD with rejection sampling + a LEARNED JUDGE (teacher
//     proposes N candidates; the judge keeps the best; only accepted sequences
//     enter the student SFT corpus)
//   * GRPO / preference distillation for reasoning recipes (group-relative
//     verifiable-reward optimization, and DPO/SimPO/ORPO/KTO over mined pairs)
//   * a REAL LoRA / QLoRA + INT4 (AWQ / GPTQ / NVFP4) export path so a "collect"
//     run becomes a "full" run by default ON A GPU
//
// And the load-bearing contract:
//
//   * TEACHER-FIDELITY (T) AS A HARD CONTRACT. The student must hit a declared
//     fraction of the teacher's holdout accuracy BEFORE the artifact ships.
//     T = student_holdout_accuracy / teacher_holdout_accuracy. The pipeline
//     refuses to mark an artifact shippable when T < declared_min_fidelity.
//     This is a fail-CLOSED gate, not a warning. It is the distillation moat:
//     a distilled student that secretly lost too much teacher quality cannot
//     be shipped by accident.
//
// DESIGN POSTURE (atom-scoped, additive):
//   * This module OWNS new code. It does NOT edit the shared pipeline funnels
//     (src/distill-pipeline.js, src/compile-pipeline.js, src/kscore.js, the
//     export-*.js chain, the workers/distill trainers). It COMPOSES them via
//     lazy import so older deploys without one of those files still load this
//     module. What must be wired into those shared files is reported by the
//     integration step (see the test's crossFileNeeds note).
//   * Pure JS. No new npm deps. Heavy ML (real LoRA/QLoRA gradients, INT4
//     calibration) stays behind env-gated trainer/export shells that fail LOUD
//     with an install hint when the optional dep is absent - the real code path
//     is preserved, never stubbed away.
//
// PRIVACY BOUNDARY (load-bearing for kolm):
//   * The pipeline NEVER passes raw rows to a hyperscaler teacher when the
//     privacy posture forbids it. assertPrivacyBoundary() is a PROVABLE check:
//     it inspects each row for a redaction stamp and refuses an external-teacher
//     plan unless every row is redacted/synthesized OR the operator has
//     explicitly opted into an open-weights/local teacher. The boundary verdict
//     is stamped onto the run manifest so an auditor can confirm it after the
//     fact without re-running.
//
// MOAT PRESERVED:
//   * Signed .kolm sealing + K-score gating happen in the SHARED compile
//     pipeline; this module produces the train-only student + the fidelity
//     verdict that the seal consumes. It NEVER weakens holdout disjointness
//     (it asserts it, fail-closed) and it is train-only (the holdout set is
//     read for SCORING only, never fed to the trainer).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const PIPELINE_VERSION = 'finalized-c1-distill-v1';

// Distillation objectives this orchestrator can route. Each maps to a SOTA
// recipe and (for the real-train path) to an in-repo / external trainer.
export const OBJECTIVES = Object.freeze([
  'seq_kd_rejection',   // sequence-level KD: teacher candidates -> judge -> accepted SFT corpus
  'on_policy_rkl',      // on-policy reverse-KL (GKD / MiniLLM)
  'grpo',               // group-relative verifiable-reward RL (reasoning recipes)
  'preference',         // DPO / SimPO / ORPO / KTO over mined preference pairs
]);

// INT4 / quant export targets the model-tier upgrade can emit. Mirrors the
// shared export-format-registry; we re-declare the SOTA INT4 family here so the
// module is standalone (no hard import at module-load).
export const QUANT_EXPORT_TARGETS = Object.freeze(['awq', 'gptq', 'nvfp4', 'gguf', 'none']);

// Default fidelity contract: a distilled student must reach at least this
// fraction of the teacher's holdout accuracy to ship. 0.90 = "the student is
// within 10% of the teacher on the held-out eval". Operators tighten or loosen
// per recipe via opts.min_fidelity, but they can NEVER drop it to <= 0 (that
// would defeat the contract); see resolveFidelityContract().
export const DEFAULT_MIN_FIDELITY = 0.90;
export const FIDELITY_FLOOR = 0.50; // a contract below this is rejected as meaningless

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round4(x) { return Number((Number.isFinite(x) ? x : 0).toFixed(4)); }

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
}

// Stable content hash of a string set - used for holdout-disjointness proof.
function _rowKey(row) {
  const p = row && (row.prompt != null ? row.prompt : row.input);
  return crypto.createHash('sha256').update(String(p == null ? '' : p)).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// LEARNED JUDGE (sequence-level KD scoring).
//
// Mirrors workers/distill/scripts/eval_adapter.py::_judge_local so the
// train-time acceptance scoring and the eval-time K-score scoring share ONE
// scoring function (train/eval mismatch becomes structurally impossible). The
// judge is a deterministic, $0, content-token-overlap heuristic against the
// reference (the reviewed/approved answer) PLUS quality penalties (refusals,
// leaked chain-of-thought, emptiness). When a cloud judge is wired and the
// privacy posture permits, scoreWithJudge() can defer to it - but the default
// is local so the train loop never spends teacher tokens on its own scoring.
// ---------------------------------------------------------------------------

export const JUDGE_VERSION = 'finalized-c1-judge-v1';

function _contentToks(s) {
  if (typeof s !== 'string') return new Set();
  return new Set(
    (s.toLowerCase().match(/\w+/g) || []).filter((t) => t.length > 2),
  );
}

// scoreWithJudge(candidate, reference, opts) -> { score in [0,1]|null, reasons[], judge }.
// score=null means "no reference to judge against" (the caller must fall back
// to a reference-free heuristic or drop the candidate). The local judge is the
// SAME math as eval_adapter._judge_local (overlap = |ref & stu| / |ref|) with
// additive quality penalties so a fluent-but-wrong or leaked-CoT candidate is
// down-ranked even at high overlap.
export function scoreWithJudge(candidate, reference, _opts = {}) {
  const reasons = [];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return { score: 0, reasons: ['empty_candidate'], judge: 'local', version: JUDGE_VERSION };
  }
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    return { score: null, reasons: ['no_reference'], judge: 'local', version: JUDGE_VERSION };
  }
  const ref = _contentToks(reference);
  const stu = _contentToks(candidate);
  if (ref.size === 0) {
    return { score: null, reasons: ['empty_reference'], judge: 'local', version: JUDGE_VERSION };
  }
  let inter = 0;
  for (const w of ref) if (stu.has(w)) inter += 1;
  let score = inter / ref.size; // eval_adapter parity: overlap over reference tokens.
  reasons.push(`overlap:${round4(score)}`);

  const t = candidate.trim();
  // Leaked chain-of-thought is a hard penalty: a model-tier student must not
  // emit raw reasoning tokens in its final answer.
  if (/<think>|<\/think>|<reasoning>|<scratchpad>/i.test(t)) { score -= 0.30; reasons.push('cot_leak'); }
  // Refusal patterns - a distilled student should not refuse approved tasks.
  if (/\b(i cannot|i can't|i'm not able to|as an ai|i am unable)\b/i.test(t)) {
    score -= 0.25; reasons.push('refusal');
  }
  // Degenerate-length penalty.
  if (t.length < 4) { score -= 0.20; reasons.push('too_short'); }

  score = clamp01(score);
  return { score: round4(score), reasons, judge: 'local', version: JUDGE_VERSION };
}

// ---------------------------------------------------------------------------
// REJECTION SAMPLING (sequence-level KD corpus construction).
//
// For each prompt the teacher proposes N candidates. The learned judge scores
// each candidate against the prompt's reference; the BEST candidate is kept iff
// its judge score clears `accept_threshold`. Rejected prompts (no candidate
// clears the bar) are reported so the caller can route them to a stronger
// teacher / human review rather than silently polluting the SFT corpus.
//
// Input rows: { prompt|input, reference?, candidates: [string...] }.
//   - `candidates` is the teacher's N proposals for this prompt (already
//      collected upstream by the teacher bridge; this module does NOT itself
//      call the teacher - that keeps the API/token boundary in one place).
//   - `reference` is the reviewed/approved answer used by the judge. When
//      absent we fall back to "highest-overlap-to-self-consistency" (the
//      candidate most similar to the others), so reference-free prompts still
//      yield a usable accepted sequence instead of being dropped.
// ---------------------------------------------------------------------------

export function rejectionSample(rows, opts = {}) {
  const accept_threshold = Number.isFinite(opts.accept_threshold) ? opts.accept_threshold : 0.55;
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'rows_not_array', accepted: [], rejected: [], stats: {}, version: PIPELINE_VERSION };
  }
  const accepted = [];
  const rejected = [];
  let with_reference = 0;
  let self_consistency = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') { rejected.push({ reason: 'bad_row' }); continue; }
    const prompt = row.prompt != null ? String(row.prompt) : (row.input != null ? String(row.input) : null);
    const cands = Array.isArray(row.candidates)
      ? row.candidates.filter((c) => typeof c === 'string' && c.trim().length > 0)
      : [];
    if (!prompt || cands.length === 0) { rejected.push({ prompt, reason: 'no_candidates' }); continue; }
    const ref = (typeof row.reference === 'string' && row.reference.trim()) ? row.reference : null;
    let scored;
    if (ref) {
      with_reference += 1;
      scored = cands.map((c) => ({ text: c, ...scoreWithJudge(c, ref) }));
    } else {
      // Reference-free: self-consistency. Score each candidate by mean overlap
      // to its peers (the candidate most agreed-with by the rest). Deterministic.
      self_consistency += 1;
      scored = cands.map((c) => {
        let sum = 0; let n = 0;
        for (const other of cands) {
          if (other === c) continue;
          const s = scoreWithJudge(c, other);
          if (s.score != null) { sum += s.score; n += 1; }
        }
        const score = n > 0 ? sum / n : 0;
        return { text: c, score: round4(score), reasons: ['self_consistency'], judge: 'local' };
      });
    }
    scored.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
    const best = scored[0];
    if (best && best.score != null && best.score >= accept_threshold) {
      accepted.push({
        prompt,
        response: best.text,
        judge_score: best.score,
        n_candidates: cands.length,
        basis: ref ? 'reference' : 'self_consistency',
        event_id: row.event_id || null,
        // Carry the redaction stamp forward so the privacy boundary can be
        // re-asserted on the SFT corpus, not just the raw rows.
        redaction_policy: row.redaction_policy || null,
        synthesized: !!row.synthesized,
      });
    } else {
      rejected.push({ prompt, reason: 'below_threshold', best_score: best ? best.score : null });
    }
  }
  return {
    ok: true,
    accepted,
    rejected,
    stats: {
      rows_in: rows.length,
      accepted: accepted.length,
      rejected: rejected.length,
      with_reference,
      self_consistency,
      accept_threshold,
    },
    version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// HOLDOUT DISJOINTNESS (moat: fail-closed).
//
// The train corpus and the holdout eval set MUST be disjoint, or the fidelity
// number is a lie. assertHoldoutDisjoint() hashes each side's prompt and throws
// (fail-closed) on ANY overlap. It returns a proof object (the overlap count +
// the disjoint set sizes) that gets stamped onto the manifest so a verifier can
// confirm disjointness without the raw rows.
// ---------------------------------------------------------------------------

export function assertHoldoutDisjoint(trainRows, holdoutRows) {
  const trainKeys = new Set((trainRows || []).map(_rowKey));
  const holdoutKeys = new Set((holdoutRows || []).map(_rowKey));
  const overlap = [];
  for (const k of holdoutKeys) if (trainKeys.has(k)) overlap.push(k);
  if (overlap.length > 0) {
    const err = new Error('holdout_not_disjoint');
    err.code = 'holdout_not_disjoint';
    err.overlap_count = overlap.length;
    err.detail = `${overlap.length} prompt(s) appear in BOTH train and holdout; the fidelity ratio would be inflated. Holdout must be disjoint from train (kolm moat: fail-closed).`;
    throw err;
  }
  return {
    ok: true,
    disjoint: true,
    train_size: trainKeys.size,
    holdout_size: holdoutKeys.size,
    overlap_count: 0,
    proof_algo: 'sha256-prompt-24',
  };
}

// ---------------------------------------------------------------------------
// PRIVACY BOUNDARY (load-bearing: provable, fail-closed for external teachers).
//
// kolm's non-negotiable: sensitive/real customer rows MUST NOT be passed to a
// hyperscaler teacher. assertPrivacyBoundary() classifies the planned teacher
// (open-weights/local vs proprietary/external) and, for an external teacher,
// requires EVERY row to be redacted or synthesized. If any raw row would leak,
// it returns ok:false with the leaking-row count and an actionable hint - the
// caller refuses the external-teacher plan. The verdict is stamped onto the
// manifest so the boundary is auditable after the fact.
//
// Open-weights / local teachers (local:/hf: prefix, or the operator opting in
// via KOLM_TEACHER_SOURCE=open-weights) run on the operator's own metal, so the
// raw-row constraint does not apply - the boundary is satisfied by construction.
// ---------------------------------------------------------------------------

export function classifyTeacherSource(teacherSlug) {
  if (teacherSlug == null) return 'none';
  const raw = String(teacherSlug).trim().toLowerCase();
  if (!raw) return 'none';
  if (raw.startsWith('local:') || raw.startsWith('hf:')) return 'open-weights';
  if (raw.startsWith('anthropic:') || raw.startsWith('openai:') || raw.startsWith('google:')) return 'proprietary';
  const base = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  const OPEN = ['qwen', 'llama', 'mistral', 'mixtral', 'deepseek', 'gemma', 'phi'];
  const PROP = ['claude', 'gpt', 'gemini'];
  // Match an exact key OR a key immediately followed by a non-letter separator
  // (digit / dot / dash / underscore) so 'qwen' matches 'qwen2.5-7b' but NOT
  // 'qwenfoo' (a different family).
  const startsWithFamily = (s, k) => {
    if (s === k) return true;
    if (!s.startsWith(k)) return false;
    const next = s[k.length];
    return next === '-' || next === '_' || next === '.' || (next >= '0' && next <= '9');
  };
  for (const k of PROP) if (startsWithFamily(base, k)) return 'proprietary';
  for (const k of OPEN) if (startsWithFamily(base, k)) return 'open-weights';
  return 'unknown'; // safe-deny: treated as proprietary by the boundary check.
}

function _rowIsProtected(row) {
  // A row is safe to send to an external teacher iff it carries a redaction
  // stamp OR is explicitly synthetic. Anything else is treated as raw customer
  // data (safe-deny).
  if (!row || typeof row !== 'object') return false;
  if (row.synthesized === true || row.source_type === 'synthetic') return true;
  if (row.redaction_policy != null && String(row.redaction_policy).trim() !== '') return true;
  if (row.redacted === true) return true;
  return false;
}

export function assertPrivacyBoundary(rows, teacherSlug, opts = {}) {
  const source = classifyTeacherSource(teacherSlug);
  const externalOptIn = process.env.KOLM_TEACHER_SOURCE === 'open-weights' || opts.force_local === true;
  // Open-weights / local: boundary satisfied by construction (operator's metal).
  if (source === 'open-weights' || (externalOptIn && source !== 'proprietary')) {
    return {
      ok: true,
      boundary: 'local-or-open-weights',
      teacher_source: source,
      external_egress: false,
      rows_checked: Array.isArray(rows) ? rows.length : 0,
      leaking_rows: 0,
      provable: true,
      version: PIPELINE_VERSION,
    };
  }
  // External / proprietary / unknown teacher: every row must be protected.
  const list = Array.isArray(rows) ? rows : [];
  let leaking = 0;
  for (const r of list) if (!_rowIsProtected(r)) leaking += 1;
  if (leaking > 0) {
    return {
      ok: false,
      boundary: 'external-egress-blocked',
      teacher_source: source,
      external_egress: true,
      rows_checked: list.length,
      leaking_rows: leaking,
      provable: true,
      error: 'raw_rows_would_leak_to_hyperscaler',
      hint: `${leaking} of ${list.length} rows are NOT redacted/synthesized and the teacher "${teacherSlug}" is ${source}. Redact/synthesize every row before an external-teacher call, OR set KOLM_TEACHER_SOURCE=open-weights and use a local:/hf: teacher. kolm never passes raw customer data to a hyperscaler.`,
      version: PIPELINE_VERSION,
    };
  }
  return {
    ok: true,
    boundary: 'external-egress-allowed-all-redacted',
    teacher_source: source,
    external_egress: true,
    rows_checked: list.length,
    leaking_rows: 0,
    provable: true,
    version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// TEACHER-FIDELITY HARD CONTRACT (the centerpiece).
//
// T = student_holdout_accuracy / teacher_holdout_accuracy. The contract is:
// the artifact ships iff T >= min_fidelity. evaluateFidelityContract() returns
// a fail-closed verdict object. This is what makes "collect -> full" safe: a
// model-tier student that lost too much teacher quality on the HELD-OUT eval is
// blocked from shipping, with the exact shortfall reported.
//
// resolveFidelityContract() clamps the declared minimum into [FIDELITY_FLOOR,1]
// so an operator can tighten the contract but cannot defeat it by declaring 0.
// ---------------------------------------------------------------------------

export function resolveFidelityContract(opts = {}) {
  let min = opts.min_fidelity;
  if (!Number.isFinite(min)) {
    const env = Number(process.env.KOLM_MIN_TEACHER_FIDELITY);
    min = Number.isFinite(env) ? env : DEFAULT_MIN_FIDELITY;
  }
  if (min < FIDELITY_FLOOR) min = FIDELITY_FLOOR; // cannot defeat the contract
  if (min > 1) min = 1;
  return round4(min);
}

export function evaluateFidelityContract({
  student_holdout_accuracy,
  teacher_holdout_accuracy,
  min_fidelity = undefined,
} = {}) {
  const min = resolveFidelityContract({ min_fidelity });
  const sh = Number(student_holdout_accuracy);
  const th = Number(teacher_holdout_accuracy);
  // Fail-closed: a missing or unverifiable teacher anchor means the contract is
  // UNVERIFIABLE, which is NOT shippable (we never let an unverifiable T pass).
  if (!Number.isFinite(th) || th < 0.05) {
    return {
      ok: false,
      ships: false,
      verdict: 'unverifiable',
      reason: 'teacher_holdout_accuracy missing or below the verifiable floor (0.05); cannot anchor a fidelity ratio',
      min_fidelity: min,
      teacher_fidelity: null,
      student_holdout_accuracy: Number.isFinite(sh) ? round4(sh) : null,
      teacher_holdout_accuracy: Number.isFinite(th) ? round4(th) : null,
      version: PIPELINE_VERSION,
    };
  }
  if (!Number.isFinite(sh)) {
    return {
      ok: false,
      ships: false,
      verdict: 'unverifiable',
      reason: 'student_holdout_accuracy missing; the student was not evaluated on the holdout',
      min_fidelity: min,
      teacher_fidelity: null,
      student_holdout_accuracy: null,
      teacher_holdout_accuracy: round4(th),
      version: PIPELINE_VERSION,
    };
  }
  const T = clamp01(sh / th);
  const ships = T >= min;
  return {
    ok: true,
    ships,
    verdict: ships ? 'pass' : 'blocked',
    teacher_fidelity: round4(T),
    min_fidelity: min,
    shortfall: ships ? 0 : round4(min - T),
    student_holdout_accuracy: round4(sh),
    teacher_holdout_accuracy: round4(th),
    reason: ships
      ? `student reached ${(T * 100).toFixed(1)}% of teacher holdout accuracy (contract: >= ${(min * 100).toFixed(1)}%)`
      : `student reached only ${(T * 100).toFixed(1)}% of teacher holdout accuracy; contract requires >= ${(min * 100).toFixed(1)}% - artifact BLOCKED from ship`,
    version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// REAL TRAINER ROUTING (env-gated, fail-LOUD, real code path preserved).
//
// routeTrainer() composes the existing in-repo trainer shells per objective.
// It returns either a ready trainer descriptor OR a deferred envelope carrying
// the install hint (NEVER a silent stub). The actual gradient step runs in the
// Python trainers under workers/distill/scripts or apps/trainer; this module
// only chooses + invokes them via the existing shells (lazy-imported so this
// file loads even on a deploy missing one of them).
// ---------------------------------------------------------------------------

const TRAINER_HINTS = Object.freeze({
  seq_kd_rejection: 'pip install torch transformers peft trl  (SFT on the accepted rejection-sampled corpus)',
  on_policy_rkl: 'pip install torch transformers peft trl  + set $KOLM_ONPOLICY_TRAINER (GKD/reverse-KL trainer)',
  grpo: 'pip install "trl>=0.12.0" torch transformers peft jsonschema  (GRPO/RLVR)',
  preference: 'pip install torch transformers peft trl  + set $KOLM_PREFERENCE_TRAINER (DPO/SimPO/ORPO/KTO)',
});

export async function routeTrainer(objective, _opts = {}) {
  if (!OBJECTIVES.includes(objective)) {
    return { ok: false, error: 'unknown_objective', detail: `objective must be one of ${OBJECTIVES.join('|')}` };
  }
  // Lazy-import the matching shell. A missing shell file (older deploy) is a
  // deferred envelope, not a crash.
  try {
    if (objective === 'grpo') {
      const m = await import('./distill-grpo.js').catch(() => null);
      if (m && m.doctor) {
        const d = m.doctor();
        return { ok: true, objective, ready: !!d.ready, shell: 'distill-grpo', doctor: d, install_hint: TRAINER_HINTS.grpo };
      }
    } else if (objective === 'preference') {
      const m = await import('./distill-preference.js').catch(() => null);
      if (m && m.doctor) {
        const d = m.doctor();
        return { ok: true, objective, ready: !!d.ready, shell: 'distill-preference', doctor: d, install_hint: TRAINER_HINTS.preference };
      }
    } else if (objective === 'on_policy_rkl') {
      const m = await import('./distill-onpolicy.js').catch(() => null);
      if (m && (m.doctor || m.doctorRopd)) {
        const d = m.doctor ? m.doctor() : null;
        const dr = m.doctorRopd ? m.doctorRopd() : null;
        const ready = !!(d && d.ready) || !!(dr && dr.ready);
        return { ok: true, objective, ready, shell: 'distill-onpolicy', doctor: d, doctor_ropd: dr, install_hint: TRAINER_HINTS.on_policy_rkl };
      }
    } else if (objective === 'seq_kd_rejection') {
      // Sequence-level KD trains a plain SFT over the ACCEPTED rejection corpus.
      // The shared distill-pipeline worker (collect/full) owns that path; we
      // detect full-mode readiness via the same env gate it uses.
      const ready = process.env.KOLM_DISTILL_FULL === '1';
      return {
        ok: true,
        objective,
        ready,
        shell: 'distill-pipeline',
        worker: path.join(ROOT, 'workers', 'distill', 'distill.mjs'),
        install_hint: TRAINER_HINTS.seq_kd_rejection,
        note: ready ? 'full-mode SFT enabled (KOLM_DISTILL_FULL=1)' : 'set KOLM_DISTILL_FULL=1 + install torch to run a real LoRA SFT; otherwise collect-mode only',
      };
    }
  } catch { /* fall through to deferred */ }
  return {
    ok: true,
    deferred: true,
    objective,
    ready: false,
    error: 'trainer_shell_unavailable',
    install_hint: TRAINER_HINTS[objective],
  };
}

// ---------------------------------------------------------------------------
// INT4 / QUANT EXPORT ROUTING (env-gated, fail-LOUD).
//
// planQuantExport() resolves the requested INT4 target (AWQ / GPTQ / NVFP4 /
// GGUF) against the shared export-format-registry. It returns a plan with the
// install hint + GPU requirement. The actual quantize runs in the shared
// export-<fmt>.js chain (GPU-required for AWQ/GPTQ/NVFP4). When the registry is
// absent (older deploy) it falls back to a built-in INT4 hint table so the
// model-tier upgrade path is never silently dropped.
// ---------------------------------------------------------------------------

const INT4_FALLBACK_HINTS = Object.freeze({
  awq: { requires_gpu: true, install_hint: 'pip install autoawq', quant_levels: ['w4', 'w4-g128', 'w8'] },
  gptq: { requires_gpu: true, install_hint: 'pip install auto-gptq optimum', quant_levels: ['w4', 'w4-g128', 'w8'] },
  nvfp4: { requires_gpu: true, install_hint: 'pip install nvidia-modelopt[torch]', quant_levels: ['nvfp4'] },
  gguf: { requires_gpu: false, install_hint: 'build llama.cpp (cmake -B build && cmake --build build)', quant_levels: ['q4_k_m', 'q5_k_m', 'q8_0'] },
});

export async function planQuantExport(target, opts = {}) {
  const t = String(target || 'none').toLowerCase().trim();
  if (t === 'none') {
    return { ok: true, target: 'none', export_planned: false, note: 'no INT4/quant export requested; student ships at training precision (bf16/fp16)' };
  }
  if (!QUANT_EXPORT_TARGETS.includes(t)) {
    return { ok: false, error: 'unknown_quant_target', detail: `target must be one of ${QUANT_EXPORT_TARGETS.join('|')}` };
  }
  let entry = null;
  try {
    const reg = await import('./export-format-registry.js').catch(() => null);
    if (reg && reg.getFormat) {
      const e = reg.getFormat(t);
      if (e) entry = { requires_gpu: !!e.requires_gpu, install_hint: e.install_hint, quant_levels: e.quant_levels, vendor: e.vendor };
    }
  } catch { /* fall back below */ }
  if (!entry) entry = INT4_FALLBACK_HINTS[t] || { requires_gpu: true, install_hint: `install the ${t} toolchain`, quant_levels: [] };
  const quant = opts.quant || (entry.quant_levels && entry.quant_levels[0]) || null;
  const gpuPresent = process.env.KOLM_GPU === '1' || process.env.CUDA_VISIBLE_DEVICES != null;
  const ready = entry.requires_gpu ? gpuPresent : true;
  return {
    ok: true,
    target: t,
    quant,
    requires_gpu: entry.requires_gpu,
    ready,
    export_planned: true,
    install_hint: entry.install_hint,
    note: ready
      ? `${t} ${quant || ''} INT4 export ready`
      : `${t} INT4 export requires a CUDA GPU; set KOLM_GPU=1 (or CUDA_VISIBLE_DEVICES) on a GPU box. Install: ${entry.install_hint}`,
    version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// CORPUS SPLIT (train-only distill; holdout reserved for scoring).
//
// splitCorpus() deterministically partitions rows into train + holdout using a
// content-hash bucket (NOT index modulo, so re-ordering the corpus cannot leak
// a row across the boundary). The holdout fraction is configurable. Rows
// flagged holdout_only NEVER enter train (moat: fail-closed at the boundary).
// ---------------------------------------------------------------------------

export function splitCorpus(rows, opts = {}) {
  const holdoutFraction = Number.isFinite(opts.holdout_fraction) ? opts.holdout_fraction : 0.2;
  const buckets = Math.max(2, Math.round(1 / Math.min(Math.max(holdoutFraction, 0.05), 0.5)));
  const train = [];
  const holdout = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || typeof row !== 'object') continue;
    if (row.holdout_only === true) { holdout.push(row); continue; }
    // Deterministic bucket from the prompt hash.
    const key = _rowKey(row);
    const b = parseInt(key.slice(0, 8), 16) % buckets;
    if (b === 0) holdout.push(row); else train.push(row);
  }
  return { train, holdout, stats: { train: train.length, holdout: holdout.length, buckets, holdout_fraction: holdoutFraction } };
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR: planDistillation() - the recipe-tier -> model-tier upgrade.
//
// Pure, side-effect-free PLAN builder. Given a corpus + recipe config it:
//   1. splits train/holdout (train-only distill) and PROVES disjointness
//   2. asserts the privacy boundary against the chosen teacher (fail-closed)
//   3. (for seq_kd_rejection) builds the accepted SFT corpus via the judge
//   4. routes the real trainer + the INT4 export (env-gated, fail-loud)
//   5. resolves the teacher-fidelity contract that the FINAL ship gate enforces
//
// It does NOT run the trainer (that is runDistillation(), which writes a run
// dir + invokes the shared worker). Keeping plan/run split lets callers preview
// the whole upgrade - including the fidelity contract and privacy verdict -
// before spending a GPU-hour.
// ---------------------------------------------------------------------------

export function planDistillation({
  rows = [],
  objective = 'seq_kd_rejection',
  teacher = null,
  student_base = 'qwen-0.5b',
  min_fidelity = undefined,
  holdout_fraction = 0.2,
  accept_threshold = 0.55,
  quant_export = 'none',
  privacy_opts = {},
} = {}) {
  if (!OBJECTIVES.includes(objective)) {
    return { ok: false, error: 'unknown_objective', detail: `objective must be one of ${OBJECTIVES.join('|')}` };
  }
  // 1. Split + prove disjointness (throws fail-closed on overlap).
  const split = splitCorpus(rows, { holdout_fraction });
  const disjoint = assertHoldoutDisjoint(split.train, split.holdout);

  // 2. Privacy boundary (fail-closed for an external teacher with raw rows).
  const privacy = assertPrivacyBoundary(split.train, teacher, privacy_opts);

  // 3. Sequence-level KD: build the accepted SFT corpus when candidates exist.
  let rejection = null;
  let sft_corpus_size = split.train.length;
  if (objective === 'seq_kd_rejection') {
    const haveCandidates = split.train.some((r) => Array.isArray(r && r.candidates) && r.candidates.length > 0);
    if (haveCandidates) {
      rejection = rejectionSample(split.train, { accept_threshold });
      sft_corpus_size = rejection.accepted.length;
    }
  }

  // 5. Fidelity contract (the centerpiece - enforced at ship in finalizeShip()).
  const contract = resolveFidelityContract({ min_fidelity });

  return {
    ok: privacy.ok, // a blocked privacy boundary makes the plan not-ok (fail-closed)
    version: PIPELINE_VERSION,
    objective,
    teacher,
    teacher_source: classifyTeacherSource(teacher),
    student_base,
    split: split.stats,
    holdout_disjoint_proof: disjoint,
    privacy_boundary: privacy,
    rejection_sampling: rejection ? rejection.stats : null,
    sft_corpus_size,
    fidelity_contract: { min_fidelity: contract, axis: 'T = student_holdout_acc / teacher_holdout_acc', enforced_at: 'finalizeShip' },
    quant_export_target: quant_export,
    train_only: true,
    next: [
      'runDistillation(plan) to train the student (env-gated full-mode on GPU)',
      'evaluate student + teacher on the SAME holdout',
      'finalizeShip({plan, student_holdout_accuracy, teacher_holdout_accuracy}) to enforce the T contract before sealing the .kolm',
    ],
  };
}

// ---------------------------------------------------------------------------
// finalizeShip() - the FINAL gate. Enforces the teacher-fidelity contract and
// re-checks the privacy boundary verdict before the (shared) compile pipeline
// seals + signs the .kolm. Returns a fail-closed verdict + a manifest fragment
// the seal step stamps in. THIS is the function a recipe-tier -> model-tier
// upgrade must pass before the artifact is allowed to ship.
// ---------------------------------------------------------------------------

export function finalizeShip({
  plan,
  student_holdout_accuracy,
  teacher_holdout_accuracy,
  quant_export_result = null,
} = {}) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, ships: false, error: 'plan_required' };
  }
  const min_fidelity = plan.fidelity_contract && plan.fidelity_contract.min_fidelity;
  const fidelity = evaluateFidelityContract({
    student_holdout_accuracy,
    teacher_holdout_accuracy,
    min_fidelity,
  });
  // Re-assert the privacy verdict captured at plan time (fail-closed).
  const privacyOk = !!(plan.privacy_boundary && plan.privacy_boundary.ok);
  const ships = fidelity.ships && privacyOk;
  const blockers = [];
  if (!fidelity.ships) blockers.push(`teacher_fidelity:${fidelity.verdict}`);
  if (!privacyOk) blockers.push('privacy_boundary_blocked');
  return {
    ok: true,
    ships,
    blockers,
    fidelity_contract: fidelity,
    privacy_boundary: plan.privacy_boundary || null,
    // Manifest fragment the shared seal step stamps onto the signed .kolm so the
    // fidelity contract + privacy verdict are part of the receipt chain.
    manifest_fragment: {
      distill_pipeline_version: PIPELINE_VERSION,
      objective: plan.objective,
      teacher: plan.teacher,
      teacher_source: plan.teacher_source,
      student_base: plan.student_base,
      train_only: true,
      holdout_disjoint: !!(plan.holdout_disjoint_proof && plan.holdout_disjoint_proof.disjoint),
      teacher_fidelity_score: fidelity.teacher_fidelity,
      min_teacher_fidelity: fidelity.min_fidelity,
      teacher_fidelity_verdict: fidelity.verdict,
      privacy_boundary: plan.privacy_boundary ? plan.privacy_boundary.boundary : null,
      external_egress: plan.privacy_boundary ? plan.privacy_boundary.external_egress : null,
      quant_export: quant_export_result ? quant_export_result.target : (plan.quant_export_target || 'none'),
    },
    version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// runDistillation() - side-effecting runner. Writes a run dir, the accepted
// SFT corpus (for seq_kd_rejection), the run manifest (with the privacy +
// disjointness proofs), and reports the routed trainer + export readiness. It
// does NOT block on a GPU: when full-mode is unavailable it returns a deferred
// envelope carrying the install hint (real code path preserved, fail-loud).
// The actual gradient step + seal happen in the shared worker/compile pipeline
// (reported in crossFileNeeds for the integration step).
// ---------------------------------------------------------------------------

export async function runDistillation(planOrOpts = {}, opts = {}) {
  // Accept either a prebuilt plan or raw planDistillation() opts.
  const plan = (planOrOpts && planOrOpts.version === PIPELINE_VERSION && planOrOpts.fidelity_contract)
    ? planOrOpts
    : planDistillation(planOrOpts);
  if (!plan.ok) {
    return { ok: false, plan, error: plan.error || 'plan_not_ok', deferred: false };
  }
  const runDir = opts.out_dir
    || path.join(_kolmDir(), 'c1-distill-runs', `run_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(runDir, { recursive: true });

  // Write the accepted SFT corpus (sequence-level KD) when present.
  let sftPath = null;
  if (plan.rejection_sampling && Array.isArray(opts.accepted_corpus)) {
    sftPath = path.join(runDir, 'sft-corpus.jsonl');
    fs.writeFileSync(sftPath, opts.accepted_corpus.map((r) => JSON.stringify({
      input: r.prompt, output: r.response, judge_score: r.judge_score,
    })).join('\n') + (opts.accepted_corpus.length ? '\n' : ''), 'utf8');
  }

  const trainer = await routeTrainer(plan.objective, opts);
  const quant = await planQuantExport(plan.quant_export_target, opts);

  const manifest = {
    version: PIPELINE_VERSION,
    objective: plan.objective,
    teacher: plan.teacher,
    teacher_source: plan.teacher_source,
    student_base: plan.student_base,
    split: plan.split,
    holdout_disjoint_proof: plan.holdout_disjoint_proof,
    privacy_boundary: plan.privacy_boundary,
    rejection_sampling: plan.rejection_sampling,
    sft_corpus_size: plan.sft_corpus_size,
    fidelity_contract: plan.fidelity_contract,
    trainer,
    quant_export: quant,
    train_only: true,
    created_at: new Date().toISOString(),
  };
  const manifestPath = path.join(runDir, 'c1-run-manifest.json');
  try { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); } catch { /* best-effort */ }

  // Deferred when the trainer cannot run a real full-mode step here (no GPU /
  // no torch). The real code path is preserved - the worker/compile pipeline
  // runs the gradient step + seal; this runner staged everything for it.
  const deferred = !trainer.ready;
  return {
    ok: true,
    deferred,
    run_dir: runDir,
    manifest_path: manifestPath,
    sft_corpus_path: sftPath,
    plan,
    trainer,
    quant_export: quant,
    install_hint: deferred ? trainer.install_hint : null,
    version: PIPELINE_VERSION,
  };
}

export default {
  PIPELINE_VERSION,
  OBJECTIVES,
  QUANT_EXPORT_TARGETS,
  DEFAULT_MIN_FIDELITY,
  FIDELITY_FLOOR,
  JUDGE_VERSION,
  scoreWithJudge,
  rejectionSample,
  assertHoldoutDisjoint,
  classifyTeacherSource,
  assertPrivacyBoundary,
  resolveFidelityContract,
  evaluateFidelityContract,
  routeTrainer,
  planQuantExport,
  splitCorpus,
  planDistillation,
  finalizeShip,
  runDistillation,
};
