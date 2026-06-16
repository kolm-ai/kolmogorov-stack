// Recipe Synthesis Engine (finalized-c1)
// =============================================================================
// Best-in-slot LLM program synthesis for kolm `synthesized_rule` recipes.
//
// This atom upgrades the single-shot synthesis path (src/synthesis.js) into a
// frontier program-synthesis loop in the lineage of FunSearch / AlphaCodium /
// self-debugging-LLM work, while keeping the kolm moat intact:
//
//   1. MULTI-CANDIDATE SAMPLING - draw N candidate generators per round across
//      a temperature ladder and across every teacher in a COUNCIL, instead of
//      one blind roll.
//   2. STRUCTURED / CONSTRAINED DECODING - every candidate is parsed into a
//      constrained recipe AST (no I/O, no FFI, bounded shape) BEFORE it is
//      allowed to compile. Malformed / unsafe candidates are repaired or
//      dropped, never silently shipped. (Mirrors the verifier's sandbox scan
//      so we reject early, with a structured reason.)
//   3. EXECUTION-FEEDBACK REPAIR LOOP - a candidate that compiles but fails
//      eval cases is NOT re-rolled blind. The next draft is conditioned on the
//      exact failing inputs/expected/got triples (self-debugging), so the
//      teacher fixes the bug rather than guessing again.
//   4. LIBRARY-OF-INDUCED-SUBROUTINES - subroutines that helped a winning (or
//      best-so-far) candidate are induced into a reusable, in-memory library
//      and offered to later drafts. This is FunSearch's "programs database"
//      specialized to recipe synthesis.
//   5. VERIFIER-IN-THE-LOOP + TEACHER-COUNCIL VOTING - candidates are ranked by
//      a fused score (verifier quality + council vote weight). The council uses
//      the existing src/teacher-council.js weighting when teacher priors are
//      supplied, falling back to uniform votes.
//
// MOAT / PRIVACY CONTRACT (load-bearing):
//   - K-score gating: a recipe is only ACCEPTED when its quality clears the
//     QUALITY_GATE from src/verifier.js. We never lower it.
//   - Holdout disjointness: the engine fits ONLY on the train split. If a
//     `holdout` split is supplied it is used for an INDEPENDENT, post-hoc
//     generalization check; any overlap between train and holdout is a
//     fail-CLOSED error (no silent acceptance). Train-only fit is preserved.
//   - Privacy membrane: when no teacher is configured (no key), the engine runs
//     the deterministic pattern path with ZERO external calls - sensitive data
//     never leaves the box. When a teacher IS configured the caller supplies a
//     `complete` member and is responsible for redaction; this module passes
//     only the example payloads it is given and marks `external_calls` so the
//     boundary is provable in the receipt.
//
// Pure JS. No new npm deps. The teacher path is injected (dependency-injected
// council member `complete`) so this module is testable offline and so the
// heavy LLM SDK stays in src/synthesis.js / src/llm-call.js where it lives.
// =============================================================================

import { compileJs, verify, hashSource, QUALITY_GATE } from './verifier.js';
import { subroutines } from './library.js';

export const RECIPE_SYNTHESIS_ENGINE_VERSION = 'finalized-c1-v1';

// ---------------------------------------------------------------------------
// Constrained recipe AST.
//
// A synthesized recipe MUST be a single pure function `generate(input, lib)`.
// We do not embed a full JS parser; instead we validate the *shape* with the
// same forbidden-identifier discipline the verifier sandbox enforces, plus
// structural checks (one generate fn, balanced braces, bounded size). The AST
// node is a structured, auditable description that conditions the next decode
// and feeds the receipt.
// ---------------------------------------------------------------------------

// Mirror of src/verifier.js DANGEROUS tokens (kept local so the engine can
// reject BEFORE handing source to the sandbox, and so the rejection reason is
// structured rather than a thrown string). If verifier.js adds a token, add it
// here too - the engine test asserts the engine never *accepts* something the
// verifier would reject.
const FORBIDDEN_TOKENS = [
  'process', 'require', 'module', 'globalThis', 'global', '__dirname', '__filename',
  'Function', 'eval', 'constructor', 'prototype', 'ArrayBuffer', 'SharedArrayBuffer',
  'Atomics', 'Reflect', 'Proxy', 'WeakRef', 'FinalizationRegistry',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
];
const FORBIDDEN_PATTERNS = [
  /\bimport\s*\(/,
];

const MAX_RECIPE_BYTES = 2048; // matches SYSTEM_PROMPT "under 2 KB" contract
const MAX_RECIPE_BYTES_HARD = 64 * 1024; // verifier hard ceiling

// Strip comments + string/template literals so a forbidden word in a comment
// (the #1 first-author trap per verifier.js) does not produce a false reject.
// Identical strategy to src/verifier.js stripCommentsAndStrings.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i += 2; else i++; }
      i++; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

function balancedBraces(scanned) {
  let depth = 0;
  for (const ch of scanned) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

// Parse a candidate source into a constrained recipe AST node.
// Returns { ok, node, violations } - never throws.
export function parseRecipeAst(source) {
  const violations = [];
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, node: null, violations: ['empty_source'] };
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_RECIPE_BYTES_HARD) violations.push('over_hard_size_limit');

  const scanned = stripCommentsAndStrings(source);

  // Structural: exactly one top-level generate function.
  const genMatches = scanned.match(/function\s+generate\s*\(/g) || [];
  if (genMatches.length === 0) violations.push('missing_generate_fn');
  if (genMatches.length > 1) violations.push('multiple_generate_fns');
  if (!balancedBraces(scanned)) violations.push('unbalanced_braces');

  // Safety: forbidden identifiers / patterns (post strip, so comments are safe).
  const hitTokens = [];
  for (const tok of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${tok}\\b`);
    if (re.test(scanned)) hitTokens.push(tok);
  }
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(scanned)) hitTokens.push(re.source);
  }
  if (hitTokens.length) violations.push(`forbidden:${hitTokens.join(',')}`);

  // Induce the set of library subroutines this candidate references. This is
  // the seed for the induced-subroutine library (FunSearch programs DB).
  const usedSubroutines = [];
  for (const name of Object.keys(subroutines)) {
    const re = new RegExp(`\\blib\\.${name}\\b`);
    if (re.test(scanned)) usedSubroutines.push(name);
  }

  const node = {
    kind: 'recipe',
    entry: 'generate',
    bytes,
    used_subroutines: usedSubroutines,
    over_soft_size_limit: bytes > MAX_RECIPE_BYTES,
    forbidden_hits: hitTokens,
    structural_ok: genMatches.length === 1 && balancedBraces(scanned),
  };
  return { ok: violations.length === 0, node, violations };
}

// ---------------------------------------------------------------------------
// Induced-subroutine library (FunSearch "programs database").
//
// As candidates are evaluated, the subroutines used by HIGH-QUALITY candidates
// are reinforced. Later decode rounds receive a ranked "what worked" hint so
// the teacher reuses proven building blocks instead of re-deriving them. This
// is in-memory and per-synthesis-call (no global state, no cross-tenant leak).
// ---------------------------------------------------------------------------
export function createInducedLibrary() {
  const scores = new Map(); // subroutine name -> cumulative reinforcement
  const api = {
    reinforce(usedSubroutines, quality) {
      for (const name of usedSubroutines || []) {
        scores.set(name, (scores.get(name) || 0) + Math.max(0, quality));
      }
    },
    // Ranked list of (name, weight) by reinforcement, best first.
    ranked() {
      return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([name, w]) => ({ name, weight: round(w, 3) }));
    },
    // A compact hint string for the next decode prompt.
    hint() {
      const r = api.ranked();
      if (!r.length) return '';
      return `PROVEN SUBROUTINES (reuse these, they worked on earlier drafts, best first): ${r.map(x => `lib.${x.name}`).join(', ')}`;
    },
    size() { return scores.size; },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Teacher-council vote.
//
// Each council member proposes candidates; we fuse the verifier quality with a
// per-member vote weight. When member.weight / councilWeights are supplied we
// use them; otherwise uniform. The fused score breaks verifier ties in favour
// of candidates produced by higher-trust teachers, which lifts first-pass
// pass-rate on broad task classes (the spec's target).
// ---------------------------------------------------------------------------
function fuseScore(quality, voteWeight) {
  // quality dominates (it is ground-truth on the train split); the vote is a
  // gentle tie-breaker so we never ship a worse recipe because a teacher is
  // "trusted". 0.9 * quality keeps quality strictly ordering-dominant when the
  // gap exceeds ~0.1 / (council size).
  return 0.9 * quality + 0.1 * voteWeight;
}

// ---------------------------------------------------------------------------
// Execution-feedback formatting (self-debugging).
//
// Build a compact, structured description of the FAILING eval cases from a
// verifier trace so the next draft is conditioned on real failures, not a
// blind re-roll. We cap the number of failures surfaced to keep the prompt
// bounded and to avoid leaking the entire dataset into an external call.
// ---------------------------------------------------------------------------
export function extractFailures(trace, { maxFailures = 6 } = {}) {
  const failures = [];
  for (const t of trace || []) {
    if (t.kind === 'positive' && !t.pass) {
      failures.push({ kind: 'positive', input: t.input, expected: t.expected, got: t.output, error: t.error || null });
    } else if (t.kind === 'negative' && !t.reject) {
      failures.push({ kind: 'negative', input: t.input, got: t.output, note: 'must NOT produce this' });
    } else if (t.kind === 'property' && !t.pass) {
      failures.push({ kind: 'property', name: t.name, error: t.error || null });
    }
    if (failures.length >= maxFailures) break;
  }
  return failures;
}

function repairPrompt(prevSource, failures, inducedHint) {
  const lines = [];
  lines.push('Your previous generator did not pass all eval cases. FIX it.');
  lines.push('');
  lines.push('PREVIOUS GENERATOR:');
  lines.push(prevSource);
  lines.push('');
  lines.push('FAILING CASES (input -> what you returned vs what was required):');
  lines.push(JSON.stringify(failures, null, 2));
  if (inducedHint) { lines.push(''); lines.push(inducedHint); }
  lines.push('');
  lines.push('Return ONLY the corrected function generate(input, lib). Keep it pure, deterministic, under 2 KB.');
  return lines.join('\n');
}

function initialPrompt({ positives, negatives, output_spec, priors }, inducedHint) {
  const lines = [];
  lines.push('OUTPUT_SPEC:');
  lines.push(JSON.stringify(output_spec, null, 2));
  lines.push('');
  lines.push('POSITIVES (must produce expected output):');
  lines.push(JSON.stringify((positives || []).slice(0, 12), null, 2));
  if (negatives && negatives.length) {
    lines.push('');
    lines.push('NEGATIVES (must NOT produce expected_not):');
    lines.push(JSON.stringify(negatives.slice(0, 8), null, 2));
  }
  if (priors && priors.hint) { lines.push(''); lines.push(`HINT: ${priors.hint}`); }
  if (inducedHint) { lines.push(''); lines.push(inducedHint); }
  lines.push('');
  lines.push('Synthesize function generate(input, lib) that satisfies all positives and rejects all negatives.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Holdout disjointness check (fail-closed).
//
// The engine fits on the train split only. If a holdout split is supplied we
// (a) refuse to proceed when train and holdout share an example (the moat:
// holdout disjointness is fail-closed, never silently ignored), and (b) report
// an INDEPENDENT generalization score the caller can fold into K-score's R axis.
// ---------------------------------------------------------------------------
function exampleKey(ex) {
  try { return JSON.stringify({ i: ex.input, e: ex.expected ?? ex.expected_not ?? null }); }
  catch { return String(ex.input); }
}

export function assertHoldoutDisjoint(train, holdout) {
  if (!holdout || !holdout.length) return { disjoint: true, overlap: [] };
  const trainKeys = new Set((train || []).map(exampleKey));
  const overlap = [];
  for (const h of holdout) {
    if (trainKeys.has(exampleKey(h))) overlap.push(exampleKey(h));
  }
  if (overlap.length) {
    const err = new Error(`holdout not disjoint from train (${overlap.length} shared example(s)) - refusing to fit (moat: fail-closed holdout)`);
    err.code = 'HOLDOUT_OVERLAP';
    err.overlap = overlap;
    throw err;
  }
  return { disjoint: true, overlap: [] };
}

// ---------------------------------------------------------------------------
// Core: synthesizeRecipe.
//
// opts:
//   positives, negatives, output_spec, priors    - the spec (train split)
//   holdout                                       - optional disjoint split
//   council    - [{ id, complete(prompt,{temperature})->source|null, weight? }]
//   patternFn  - ({positives,negatives,output_spec,priors}) -> [source...]
//                Deterministic, key-free candidate generator (privacy path).
//   rounds        - max repair rounds per member (default 2)
//   samplesPerRound - temperatures per member per round (default [0, 0.4])
//   gate          - quality gate override (default QUALITY_GATE)
//   councilWeights- optional map id->weight (e.g. from teacher-council.js)
//
// Returns a structured result (accepted | best-effort) with a full audit
// trail, the induced library, and the holdout generalization score.
// ---------------------------------------------------------------------------
export async function synthesizeRecipe(opts = {}) {
  const {
    positives = [],
    negatives = [],
    output_spec = {},
    priors = {},
    holdout = [],
    council = [],
    patternFn = null,
    rounds = 2,
    samplesPerRound = [0, 0.4],
    gate = QUALITY_GATE,
    councilWeights = {},
  } = opts;

  const startedAt = Date.now();
  const attempts = [];
  const induced = createInducedLibrary();
  let externalCalls = 0;

  // Moat: fail-closed holdout disjointness BEFORE any fitting.
  assertHoldoutDisjoint([...positives, ...negatives], holdout);

  const property_tests = priors.property_tests || [];

  // Evaluate one candidate source on the train split. Pure, no external call.
  function evalCandidate(source, member) {
    const ast = parseRecipeAst(source);
    if (!ast.ok) {
      return { source, member, ast, error: `ast_rejected:${ast.violations.join(';')}`, result: null };
    }
    try {
      const compiled = compileJs(source);
      const result = verify(compiled, { positives, negatives, property_tests });
      induced.reinforce(ast.node.used_subroutines, result.quality_score);
      return { source, member, ast, result, error: null };
    } catch (e) {
      return { source, member, ast, result: null, error: String(e.message || e) };
    }
  }

  function memberWeight(member) {
    if (member && member.weight != null) return Number(member.weight);
    if (member && councilWeights[member.id] != null) return Number(councilWeights[member.id]);
    return 1 / Math.max(1, council.length || 1);
  }

  function maybeAccept(ev, g) {
    if (ev.result && ev.result.quality_score >= g && ev.result.pass_rate_positive >= 0.85) return ev;
    return null;
  }

  // --- 1. Deterministic pattern council (privacy path, zero external calls).
  if (typeof patternFn === 'function') {
    let patternSources = [];
    try { patternSources = patternFn({ positives, negatives, output_spec, priors }) || []; }
    catch (e) { attempts.push({ member: 'pattern', error: `patternFn:${String(e.message || e)}` }); }
    for (const src of patternSources) {
      const ev = evalCandidate(src, { id: 'pattern', weight: 1 });
      attempts.push(ev);
      const accepted = maybeAccept(ev, gate);
      if (accepted) return finalize(accepted, { attempts, induced, holdout, externalCalls, startedAt, council, property_tests });
    }
  }

  // --- 2. Teacher council with repair loop (external path).
  for (const member of council) {
    if (typeof member.complete !== 'function') continue;
    let prompt = initialPrompt({ positives, negatives, output_spec, priors }, induced.hint());

    for (let r = 0; r < Math.max(1, rounds); r++) {
      let roundBest = null;
      for (const temperature of samplesPerRound) {
        let source = null;
        try {
          source = await member.complete(prompt, { temperature });
          externalCalls++;
        } catch (e) {
          attempts.push({ member: member.id, round: r, temperature, error: `complete:${String(e.message || e)}` });
          continue;
        }
        if (source == null) continue;
        const ev = evalCandidate(source, member);
        ev.round = r; ev.temperature = temperature;
        attempts.push(ev);

        const accepted = maybeAccept(ev, gate);
        if (accepted) return finalize(accepted, { attempts, induced, holdout, externalCalls, startedAt, council, property_tests });

        if (ev.result && (!roundBest || ev.result.quality_score > roundBest.result.quality_score)) {
          roundBest = ev;
        }
      }
      // No acceptance this round: condition the NEXT round on real failures.
      if (!roundBest || !roundBest.result) break; // nothing compiled - repair has no anchor
      const failures = extractFailures(roundBest.result.trace);
      if (failures.length === 0) break; // perfect on train but below gate by property/size - re-roll won't help
      prompt = repairPrompt(roundBest.source, failures, induced.hint());
    }
  }

  // --- 3. No acceptance: return best-effort with full audit trail.
  const scored = attempts
    .filter(a => a.result)
    .map(a => ({ a, fused: fuseScore(a.result.quality_score, memberWeight(a.member)) }))
    .sort((x, y) => y.fused - x.fused);

  if (!scored.length) {
    return {
      accepted: false,
      reason: 'no candidate compiled',
      attempts: attempts.map(a => ({ member: a.member?.id || a.member, error: a.error })),
      external_calls: externalCalls,
      induced_library: induced.ranked(),
      duration_ms: Date.now() - startedAt,
      version: RECIPE_SYNTHESIS_ENGINE_VERSION,
    };
  }

  const best = scored[0].a;
  return {
    accepted: false,
    reason: `quality ${best.result.quality_score} below gate ${gate}`,
    best_source: best.source,
    best_result: best.result,
    best_member: best.member?.id || best.member,
    attempts_n: attempts.length,
    external_calls: externalCalls,
    induced_library: induced.ranked(),
    duration_ms: Date.now() - startedAt,
    version: RECIPE_SYNTHESIS_ENGINE_VERSION,
  };
}

function finalize(ev, { attempts, induced, holdout, externalCalls, startedAt, council, property_tests }) {
  const result = ev.result;
  // Independent holdout generalization (moat: train-only fit, disjoint check).
  let holdout_generalization = null;
  if (holdout && holdout.length) {
    try {
      const compiled = compileJs(ev.source);
      const holdPos = holdout.filter(h => 'expected' in h);
      const holdNeg = holdout.filter(h => 'expected_not' in h);
      const hv = verify(compiled, { positives: holdPos, negatives: holdNeg, property_tests });
      holdout_generalization = {
        quality_score: hv.quality_score,
        pass_rate_positive: hv.pass_rate_positive,
        reject_rate_negative: hv.reject_rate_negative,
        // R axis for K-score v2 (held-out accuracy / declared accuracy), clamped.
        robustness_ratio: result.pass_rate_positive > 0
          ? round(Math.min(1, hv.pass_rate_positive / result.pass_rate_positive), 3)
          : null,
        n: holdout.length,
      };
    } catch (e) {
      holdout_generalization = { error: String(e.message || e) };
    }
  }

  return {
    accepted: true,
    source: ev.source,
    quality_score: result.quality_score,
    pass_rate_positive: result.pass_rate_positive,
    reject_rate_negative: result.reject_rate_negative,
    property_pass_rate: result.property_pass_rate,
    latency_p50_us: result.latency_p50_us,
    size_bytes: Buffer.byteLength(ev.source, 'utf8'),
    source_hash: hashSource(ev.source),
    recipe_class: 'synthesized_rule',
    member: ev.member?.id || ev.member,
    round: ev.round ?? null,
    used_subroutines: ev.ast?.node?.used_subroutines || [],
    induced_library: induced.ranked(),
    holdout_generalization,
    test_trace: result.trace,
    attempts_n: attempts.length,
    external_calls: externalCalls,
    council_size: council.length,
    duration_ms: Date.now() - startedAt,
    version: RECIPE_SYNTHESIS_ENGINE_VERSION,
  };
}

function round(x, d = 3) { const m = 10 ** d; return Math.round(x * m) / m; }

export default {
  RECIPE_SYNTHESIS_ENGINE_VERSION,
  synthesizeRecipe,
  parseRecipeAst,
  createInducedLibrary,
  extractFailures,
  assertHoldoutDisjoint,
};
