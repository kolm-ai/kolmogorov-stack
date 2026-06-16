// Active Synthesis Loop — verifier-gated, student-loss-driven iterative data synthesis.
// finalized-c1 atom: "Verifier-gated, student-loss-driven active synthesis loop".
//
// WHAT THIS IS
//   A closed iterative loop. Each round:
//     (1) GENERATE a candidate synthetic batch from the current seeds (via a
//         caller-supplied generator) — the generate step.
//     (2) VERIFY every candidate row through a TASK-APPROPRIATE verifier
//         (exact-match / unit-test / json-schema / llm-judge) and DROP rows that
//         fail their own check — the generate-then-verify-then-filter paradigm.
//     (3) SCORE the survivors by the STUDENT's prediction loss on a lightweight
//         probe checkpoint, then SELECT the high-loss / high-info-gain examples by
//         ARGMAX (deterministic top-k, NOT softmax sampling) — per the
//         active-synthesis finding that difficulty beats reward and student-pred
//         beats ground-truth.
//     (4) FEED the selected set back as the next generation's seeds, iterating
//         until the eval / K-score metric PLATEAUS.
//
//   Survivor-pool curation REUSES the shipped pipeline primitives:
//     - applyThreshold() from data-quality-classifier.js (keep-fraction cut), and
//     - selectDiverseBatch() / reprFilterSelect() from data-select.js (the
//       diversity gate) — so a high-loss cluster cannot dominate the seed set.
//
//   Every round surfaces:  verify_pass_rate (verified / generated) and the
//   k_score_delta (this round's K-score minus the previous round's), so callers
//   can watch the loop converge and stop on a real plateau, not a fixed budget.
//
// PRIVACY / MOAT
//   This module is PURE control flow. It makes ZERO external calls itself. The
//   generator, the verifier, and the student probe are all CALLER-SUPPLIED
//   functions (sync or async). A local/deterministic path is fully supported and
//   is what the tests exercise; any egress (e.g. an llm-judge that calls a
//   teacher) lives entirely inside the caller's verifier, where the existing
//   redaction boundary already applies. No data is forwarded anywhere by us.
//
//   The K-score plateau gate never weakens holdout disjointness: the eval set is
//   the caller's, kept separate from the synthesized train rows, and we never
//   move a row from train into eval (train-only synthesis is preserved).
//
// DEPS: zero new npm deps. Reuses in-repo pure-JS modules only.

import { applyThreshold } from './data-quality-classifier.js';
import { selectDiverseBatch } from './data-select.js';

export const ACTIVE_SYNTH_LOOP_VERSION = 'asl-v1';

// ── pair text extraction (mirrors the convention across the data engine) ──────
function pairInput(p) {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['input', 'prompt']) {
    if (typeof p[k] === 'string') return p[k];
  }
  return '';
}
function pairOutput(p) {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['output', 'teacher_output', 'response']) {
    if (typeof p[k] === 'string') return p[k];
  }
  return '';
}
function pairText(p) {
  if (typeof p === 'string') return p;
  return (pairInput(p) + '\n\n' + pairOutput(p)).trim();
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ── (1) TASK-APPROPRIATE VERIFIERS ───────────────────────────────────────────
// Each verifier maps a row -> {pass:boolean, reason?:string}. They are the
// generate-then-verify-then-filter check. A row that throws is treated as a
// HARD FAIL (fail-closed): a verifier that crashes never silently passes a row.

// exact-match: the produced output must equal the expected reference (the
// declared gold). Whitespace-normalized by default; set normalize:false for byte
// equality (e.g. code where indentation is load-bearing).
function verifyExactMatch(row, opts = {}) {
  const out = pairOutput(row);
  const expected = row && (typeof row.expected === 'string' ? row.expected
    : (typeof row.reference === 'string' ? row.reference : null));
  if (expected == null) return { pass: false, reason: 'no_expected_reference' };
  if (opts.normalize === false) {
    return out === expected ? { pass: true } : { pass: false, reason: 'mismatch' };
  }
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  return norm(out) === norm(expected)
    ? { pass: true }
    : { pass: false, reason: 'mismatch' };
}

// unit-test: run the row's declared assertions against its output. A row carries
// `tests: [{expect, got?}]` OR a single `assert(output) -> boolean` predicate
// supplied via opts.assertFn. All assertions must hold. Any throw = fail-closed.
function verifyUnitTest(row, opts = {}) {
  const out = pairOutput(row);
  const assertFn = typeof opts.assertFn === 'function' ? opts.assertFn : null;
  if (assertFn) {
    try {
      return assertFn(out, row) ? { pass: true } : { pass: false, reason: 'assert_false' };
    } catch (e) {
      return { pass: false, reason: 'assert_threw:' + String((e && e.message) || e) };
    }
  }
  const tests = Array.isArray(row && row.tests) ? row.tests : null;
  if (!tests || tests.length === 0) return { pass: false, reason: 'no_tests_declared' };
  for (const t of tests) {
    try {
      // A test is {expect, got?}: compare the declared produced value at t.got
      // (or a caller transform via opts.applyFn over `output`) against t.expect.
      const got = typeof opts.applyFn === 'function'
        ? opts.applyFn(out, t, row)
        : (t && Object.prototype.hasOwnProperty.call(t, 'got') ? t.got : out);
      if (!_deepEq(got, t && t.expect)) {
        return { pass: false, reason: 'unit_test_failed' };
      }
    } catch (e) {
      return { pass: false, reason: 'unit_test_threw:' + String((e && e.message) || e) };
    }
  }
  return { pass: true };
}

// json-schema: the output must parse as JSON and satisfy a small, dependency-free
// schema (types, required keys, enum). This is the structured-output gate.
function verifyJsonSchema(row, opts = {}) {
  const schema = (row && row.schema) || opts.schema;
  if (!schema || typeof schema !== 'object') return { pass: false, reason: 'no_schema' };
  const raw = pairOutput(row);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { pass: false, reason: 'not_json' };
  }
  const err = _validateSchema(obj, schema);
  return err ? { pass: false, reason: err } : { pass: true };
}

// llm-judge: delegate the pass/fail to a caller-supplied judge function. The
// judge MAY egress (e.g. a teacher council) — that boundary is the caller's, and
// the existing redaction layer applies there, not here. We only consume its
// boolean/score verdict. A judge that throws = fail-closed.
async function verifyLlmJudge(row, opts = {}) {
  const judge = typeof opts.judgeFn === 'function' ? opts.judgeFn : null;
  if (!judge) {
    // ENV-GATE / install hint: an llm-judge task with no judge wired is a LOUD
    // configuration error, not a silent pass.
    return {
      pass: false,
      reason: 'no_judge_fn',
      hint: 'pass opts.verify.judgeFn (a (row)=>{pass|score} judge). For a teacher-backed judge set ANTHROPIC_API_KEY or FAL_KEY and wire src/synthesis.js teacher; this loop never egresses on its own.',
    };
  }
  try {
    const v = await judge(row);
    if (typeof v === 'boolean') return v ? { pass: true } : { pass: false, reason: 'judge_reject' };
    if (v && typeof v === 'object') {
      if (typeof v.pass === 'boolean') return v.pass ? { pass: true } : { pass: false, reason: v.reason || 'judge_reject' };
      const thresh = Number.isFinite(Number(opts.judgeThreshold)) ? Number(opts.judgeThreshold) : 0.5;
      const score = clamp01(v.score);
      return score >= thresh ? { pass: true } : { pass: false, reason: 'judge_below_threshold' };
    }
    return { pass: false, reason: 'judge_bad_return' };
  } catch (e) {
    return { pass: false, reason: 'judge_threw:' + String((e && e.message) || e) };
  }
}

const VERIFIERS = {
  'exact-match': verifyExactMatch,
  'unit-test': verifyUnitTest,
  'json-schema': verifyJsonSchema,
  'llm-judge': verifyLlmJudge,
};

export const TASK_TYPES = Object.freeze(Object.keys(VERIFIERS));

// Resolve the verifier for a row: an explicit row.task_type wins, else the
// loop's declared default. A custom verify.verifierFn overrides everything.
function resolveVerifier(row, taskType, verifyOpts) {
  if (typeof verifyOpts.verifierFn === 'function') return verifyOpts.verifierFn;
  const t = (row && typeof row.task_type === 'string' && VERIFIERS[row.task_type])
    ? row.task_type
    : taskType;
  return VERIFIERS[t] || null;
}

// Run the verifier over a batch. Returns {survivors, survivorIdx, pass_rate,
// reasons}. Verifiers may be async (llm-judge) — we await each. Fail-closed: any
// non-pass (including throws / missing verifier) DROPS the row.
async function verifyBatch(batch, taskType, verifyOpts) {
  const survivors = [];
  const survivorIdx = [];
  const reasons = {};
  let passed = 0;
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    const vfn = resolveVerifier(row, taskType, verifyOpts);
    let verdict;
    if (!vfn) {
      verdict = { pass: false, reason: 'no_verifier_for_task:' + String((row && row.task_type) || taskType) };
    } else {
      try {
        verdict = await vfn(row, verifyOpts);
      } catch (e) {
        verdict = { pass: false, reason: 'verifier_threw:' + String((e && e.message) || e) };
      }
    }
    if (verdict && verdict.pass) {
      passed++;
      survivors.push(row);
      survivorIdx.push(i);
    } else {
      const r = (verdict && verdict.reason) || 'rejected';
      reasons[r] = (reasons[r] || 0) + 1;
    }
  }
  const pass_rate = batch.length ? passed / batch.length : 0;
  return { survivors, survivorIdx, pass_rate: Number(pass_rate.toFixed(6)), reasons };
}

// ── (2) STUDENT-LOSS PROBE SCORING + ARGMAX SELECTION ────────────────────────
// The active-synthesis finding: select by the STUDENT's prediction loss on a
// lightweight probe checkpoint (difficulty/info-gain), NOT by a reward model and
// NOT by ground-truth agreement. High student loss = the example the student is
// currently worst at = highest expected info gain when trained on.
//
// studentLossFn(row) -> number in [0, +inf) (a loss; higher = harder for the
// student). If the caller has no probe, we fall back to a deterministic
// difficulty proxy so the loop still selects by difficulty (never by reward).
function defaultDifficultyProxy(row) {
  // Longer, denser, more-structured outputs are harder targets; this is a
  // monotone difficulty proxy, NOT a quality/reward score. Bounded for stability.
  const out = pairOutput(row);
  const n = out.trim().length;
  if (n === 0) return 0; // an empty target carries no learnable signal
  const lenTerm = Math.min(1, Math.log2(1 + n) / Math.log2(1 + 2000));
  const words = out.toLowerCase().match(/[a-z0-9]+/g) || [];
  const uniq = new Set(words).size;
  const ttr = words.length ? uniq / words.length : 0; // lexical diversity
  const digits = (out.match(/\d/g) || []).length;
  const digitTerm = n ? Math.min(1, digits / n) : 0;
  // weight length + diversity + symbol density as a difficulty surrogate
  return 0.6 * lenTerm + 0.3 * ttr + 0.1 * digitTerm;
}

async function scoreByStudentLoss(survivors, studentLossFn) {
  const fn = typeof studentLossFn === 'function' ? studentLossFn : defaultDifficultyProxy;
  const losses = [];
  for (const row of survivors) {
    let v;
    try {
      v = await fn(row);
    } catch {
      v = 0;
    }
    const num = Number(v);
    losses.push(Number.isFinite(num) ? Math.max(0, num) : 0);
  }
  return losses;
}

// ARGMAX selection: take the top-k survivors by student loss (descending),
// deterministic tie-break on original index. This is the deliberate choice over
// softmax sampling — difficulty beats reward, and we want the HARDEST examples,
// not a temperature-smoothed sample of them.
function argmaxTopK(losses, k) {
  const n = losses.length;
  const keepN = Math.max(0, Math.min(n, Math.trunc(k)));
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (losses[b] - losses[a]) || (a - b));
  return order.slice(0, keepN).sort((a, b) => a - b);
}

// ── K-score / eval metric over the accumulated train set ─────────────────────
// The plateau gate runs the caller's evalFn over the CURRENT accumulated train
// set against a HELD-OUT eval set the caller owns. evalFn(trainRows) -> number
// (the K-score, higher = better). If no evalFn is supplied we use a
// deterministic intrinsic proxy: mean student-difficulty coverage of the train
// set — so the loop still has a real, monotone-ish signal to plateau on.
async function computeKScore(trainRows, evalFn, studentLossFn) {
  if (typeof evalFn === 'function') {
    try {
      const v = await evalFn(trainRows);
      const num = Number(v);
      if (Number.isFinite(num)) return num;
    } catch {
      // fall through to intrinsic proxy
    }
  }
  // Intrinsic proxy: mean difficulty the student would FACE on the current set.
  // As the loop accumulates hard, verified, diverse rows this rises then plateaus.
  if (!trainRows.length) return 0;
  const losses = await scoreByStudentLoss(trainRows, studentLossFn);
  const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
  return Number(mean.toFixed(6));
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
/**
 * runActiveSynthesisLoop(opts) — the closed verifier-gated, student-loss-driven loop.
 *
 * @param {object} opts
 *   seeds            {Array}  initial seed rows ({input/prompt, ...}). REQUIRED.
 *   generate         {Function} async (seeds, ctx) => candidateRows[]. REQUIRED —
 *                     the generate step. Pure control flow on our side; any egress
 *                     is the caller's (redaction boundary applies there).
 *   taskType         {string} default verifier: one of TASK_TYPES. Per-row
 *                     row.task_type overrides. Default 'exact-match'.
 *   verify           {object} verifier options (schema/judgeFn/assertFn/...). Also
 *                     accepts verify.verifierFn to override the whole verifier.
 *   studentLossFn    {Function} async (row) => loss (>=0). The probe-checkpoint
 *                     student loss. Omit -> deterministic difficulty proxy.
 *   evalFn           {Function} async (trainRows) => kScore. The eval/K-score over
 *                     the accumulated train set vs the caller's HELD-OUT eval set.
 *                     Omit -> intrinsic difficulty-coverage proxy.
 *   selectFraction   {number} keep-fraction for the high-loss survivor cut
 *                     (reuses applyThreshold). Default 0.5.
 *   diversityTau     {number} cosine-sim ceiling for the diversity gate
 *                     (reuses selectDiverseBatch). Default 0.9.
 *   maxIterations    {number} hard ceiling on rounds. Default 8.
 *   plateauEps       {number} stop when |k_score_delta| <= eps for plateauPatience
 *                     consecutive rounds. Default 1e-3.
 *   plateauPatience  {number} consecutive small-delta rounds to declare plateau.
 *                     Default 2.
 *   seedBudget       {number} max rows fed back as next seeds. Default = seeds.length.
 *
 * @returns {Promise<object>} {ok, version, stopped_reason, iterations:[...],
 *   train, n_train, final_k_score, plateaued}
 *   Each iteration entry: {iter, generated, verified, verify_pass_rate,
 *   verify_reasons, after_quality_cut, selected, k_score, k_score_delta,
 *   plateau_streak, next_seeds}.
 */
export async function runActiveSynthesisLoop(opts = {}) {
  const seeds0 = Array.isArray(opts.seeds) ? opts.seeds : [];
  const generate = typeof opts.generate === 'function' ? opts.generate : null;
  if (!generate) {
    return {
      ok: false, version: ACTIVE_SYNTH_LOOP_VERSION, error: 'no_generate_fn',
      hint: 'pass opts.generate = async (seeds, ctx) => candidateRows[]',
    };
  }
  const taskType = (typeof opts.taskType === 'string' && VERIFIERS[opts.taskType]) ? opts.taskType : 'exact-match';
  const verifyOpts = (opts.verify && typeof opts.verify === 'object') ? opts.verify : {};
  const studentLossFn = opts.studentLossFn;
  const evalFn = opts.evalFn;
  const selectFraction = Number.isFinite(Number(opts.selectFraction)) ? clamp01(opts.selectFraction) : 0.5;
  const diversityTau = Number.isFinite(Number(opts.diversityTau)) ? Number(opts.diversityTau) : 0.9;
  const maxIterations = Math.max(1, Math.trunc(Number(opts.maxIterations) || 8));
  const plateauEps = Number.isFinite(Number(opts.plateauEps)) ? Math.abs(Number(opts.plateauEps)) : 1e-3;
  const plateauPatience = Math.max(1, Math.trunc(Number(opts.plateauPatience) || 2));
  const seedBudget = Math.max(1, Math.trunc(Number(opts.seedBudget) || seeds0.length || 1));

  const iterations = [];
  const train = [];                 // accumulated, verified, selected train rows
  let seeds = seeds0.slice();
  let prevK = null;
  let plateauStreak = 0;
  let stopped_reason = 'max_iterations';
  let plateaued = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    // (1) GENERATE candidate batch from current seeds.
    let batch;
    try {
      batch = await generate(seeds, { iter, train: train.slice(), version: ACTIVE_SYNTH_LOOP_VERSION });
    } catch (e) {
      stopped_reason = 'generate_threw:' + String((e && e.message) || e);
      break;
    }
    batch = Array.isArray(batch) ? batch : [];
    const generated = batch.length;
    if (generated === 0) {
      iterations.push({ iter, generated: 0, verified: 0, verify_pass_rate: 0, verify_reasons: {}, after_quality_cut: 0, selected: 0, k_score: prevK == null ? 0 : prevK, k_score_delta: 0, plateau_streak: plateauStreak, next_seeds: seeds.length });
      stopped_reason = 'generator_exhausted';
      break;
    }

    // (2) VERIFY-then-FILTER: drop every row that fails its own check.
    const { survivors, pass_rate, reasons } = await verifyBatch(batch, taskType, verifyOpts);

    if (survivors.length === 0) {
      iterations.push({ iter, generated, verified: 0, verify_pass_rate: pass_rate, verify_reasons: reasons, after_quality_cut: 0, selected: 0, k_score: prevK == null ? 0 : prevK, k_score_delta: 0, plateau_streak: plateauStreak, next_seeds: seeds.length });
      stopped_reason = 'all_candidates_failed_verification';
      break;
    }

    // (3a) STUDENT-LOSS scoring of survivors (difficulty / info-gain).
    const losses = await scoreByStudentLoss(survivors, studentLossFn);

    // (3b) keep-fraction CUT on the survivor pool — REUSE applyThreshold(). We
    // keep the TOP fraction by student LOSS (the hardest), the active-synthesis
    // inversion of a quality cut: here a HIGH score == HIGH loss == KEEP.
    const cut = applyThreshold(losses, { mode: 'percentile', keep_fraction: selectFraction });
    const poolIdx = cut.kept_indices;            // indices into `survivors`
    const pool = poolIdx.map((i) => survivors[i]);
    const poolLosses = poolIdx.map((i) => losses[i]);

    // (3c) DIVERSITY GATE on the high-loss pool — REUSE selectDiverseBatch(). A
    // single hard cluster must not monopolize the seeds; this enforces spread.
    // We pre-order the pool by loss desc so the repr-filter walk is loss-greedy.
    const order = Array.from({ length: pool.length }, (_, i) => i)
      .sort((a, b) => (poolLosses[b] - poolLosses[a]) || (a - b));
    const orderedPool = order.map((i) => pool[i]);
    const div = selectDiverseBatch(orderedPool, pool.length, { method: 'repr-filter', tau: diversityTau });
    const diversePool = div.batch;               // diversity-gated, still loss-ranked

    // (3d) ARGMAX final selection: top-k by student loss (NOT softmax). seedBudget
    // bounds how many feed forward. diversePool is already loss-ordered, so the
    // argmax over it is its loss-descending prefix.
    const diverseLosses = await scoreByStudentLoss(diversePool, studentLossFn);
    const pickIdx = argmaxTopK(diverseLosses, seedBudget);
    const selected = pickIdx.map((i) => diversePool[i]);

    // accumulate selected, verified, hard, diverse rows into the train set.
    for (const r of selected) train.push(r);

    // (4) K-score over the accumulated train set vs the caller's held-out eval.
    const kScore = await computeKScore(train, evalFn, studentLossFn);
    const kDelta = prevK == null ? kScore : Number((kScore - prevK).toFixed(6));

    // plateau bookkeeping (only after we have a baseline to compare against).
    if (prevK != null && Math.abs(kDelta) <= plateauEps) plateauStreak += 1;
    else plateauStreak = 0;

    iterations.push({
      iter,
      generated,
      verified: survivors.length,
      verify_pass_rate: pass_rate,
      verify_reasons: reasons,
      after_quality_cut: pool.length,
      selected: selected.length,
      k_score: Number(typeof kScore.toFixed === 'function' ? kScore.toFixed(6) : kScore),
      k_score_delta: kDelta,
      plateau_streak: plateauStreak,
      next_seeds: selected.length,
    });

    prevK = kScore;

    // (4-feedback) feed the selected set back as next seeds.
    seeds = selected.length ? selected.slice() : seeds;

    if (plateauStreak >= plateauPatience) {
      stopped_reason = 'k_score_plateau';
      plateaued = true;
      break;
    }
  }

  return {
    ok: true,
    version: ACTIVE_SYNTH_LOOP_VERSION,
    task_type: taskType,
    stopped_reason,
    plateaued,
    iterations,
    train,
    n_train: train.length,
    final_k_score: prevK == null ? 0 : Number(typeof prevK.toFixed === 'function' ? prevK.toFixed(6) : prevK),
  };
}

// ── tiny dependency-free helpers (deep-eq + minimal JSON-schema validator) ────
function _deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!_deepEq(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      if (!_deepEq(a[ka[i]], b[kb[i]])) return false;
    }
    return true;
  }
  return false;
}

// Minimal JSON-schema subset: {type, required, properties:{k:{type, enum}}}.
// Supported types: object, array, string, number, integer, boolean, null.
// Returns an error string, or '' when valid. Dependency-free on purpose.
function _validateSchema(obj, schema) {
  const typeOf = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (Number.isInteger(v)) return 'integer';
    return typeof v; // 'object' | 'string' | 'number' | 'boolean'
  };
  const typeMatch = (v, t) => {
    if (!t) return true;
    const actual = typeOf(v);
    if (t === 'number') return actual === 'number' || actual === 'integer';
    if (t === 'integer') return actual === 'integer';
    return actual === t;
  };
  if (schema.type && !typeMatch(obj, schema.type)) {
    return 'type_mismatch:expected_' + schema.type;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => _deepEq(e, obj))) {
    return 'enum_mismatch';
  }
  if (schema.type === 'object' || (schema.properties && obj && typeof obj === 'object' && !Array.isArray(obj))) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'expected_object';
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) return 'missing_required:' + key;
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Object.keys(props)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const err = _validateSchema(obj[key], props[key]);
        if (err) return key + '.' + err;
      }
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(obj)) return 'expected_array';
    if (schema.items) {
      for (let i = 0; i < obj.length; i++) {
        const err = _validateSchema(obj[i], schema.items);
        if (err) return '[' + i + '].' + err;
      }
    }
  }
  return '';
}

export const __internals = Object.freeze({
  verifyExactMatch,
  verifyUnitTest,
  verifyJsonSchema,
  verifyLlmJudge,
  verifyBatch,
  defaultDifficultyProxy,
  scoreByStudentLoss,
  argmaxTopK,
  computeKScore,
  _deepEq,
  _validateSchema,
  pairOutput,
  pairText,
});

export default {
  ACTIVE_SYNTH_LOOP_VERSION,
  TASK_TYPES,
  runActiveSynthesisLoop,
  __internals,
};
