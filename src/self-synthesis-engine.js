// src/self-synthesis-engine.js
//
// KOLM DATA ENGINE - AUGMENT sub-strategy: LIVE SELF-SYNTHESIS ENGINE.
//
// Two real, LLM-driven synthetic-data paths that replace the templated
// depth/breadth string scaffolds in data-augment.js when the corpus is too
// thin (cold-start) or the templated evolutions stop improving:
//
//   (a) MAGPIE prompt-free generation  (arXiv:2406.08464)
//       Prompt an aligned/instruct GENERATOR with ONLY its chat-template
//       pre-query prefix (BOS + the user-turn OPEN tag, no user content) and
//       let it autoregress an INSTRUCTION from scratch. A second call - the
//       full chat turn with that instruction - autoregresses the RESPONSE.
//       This is how Magpie extracts instruction+response pairs directly from
//       an aligned model without ANY seed prompt, which is exactly what we
//       want when captures are cold-start-scarce.
//
//   (b) AUTO-EVOL-INSTRUCT  (arXiv:2406.00770)
//       The evolution RULES are themselves LLM-generated and iteratively
//       optimized against a MEASURED failure-rate signal, replacing the
//       hand-written depth/breadth templates. Each optimization round:
//         1. evolve a sample of seeds with the current rule set,
//         2. an LLM analyzer measures the per-instruction failure rate
//            (stagnation / copied-seed / unsolvable / format-broken),
//         3. an LLM optimizer rewrites the rule set to drive that rate down,
//         4. keep the rule set with the lowest measured failure rate.
//       The winning rule set then evolves the full seed batch.
//
// Both paths:
//   - run through the SAME dependency-injected teacher_caller seam used by
//     synthetic-augment.js: async (prompt, opts?) -> string. Tests never hit
//     a real API; the live wiring injects workers/distill/teacher-bridge
//     callTeacher (PHI-redacted) on the operator side.
//   - persist into the CANONICAL augment-pairs.jsonl shape
//     (id/input/output/source_type:'augment'/provenance{...}) so a later
//     COLLECT/TRAIN step consumes them with zero special-casing.
//   - carry generation_id + parent_seed_cids on every row for audit.
//   - are PREVIEW-ONLY unless opts.apply === true (the data-engine cost gate
//     owns the approve decision; this module simply honors apply).
//
// PRIVACY BOUNDARY (load-bearing for kolm):
//   The Magpie path is SEED-FREE - no customer data leaves at all. The
//   Auto-Evol path sends seed INSTRUCTIONS (prompts) to the generator; when
//   opts.redactor is supplied it is applied to every seed string before it is
//   ever placed in a teacher prompt, so the boundary is provable. We never
//   pass raw seed OUTPUTS (answers) to the evolution analyzer/optimizer.
//
// MOAT: this module only MANUFACTURES candidate pairs. It never signs a
// .kolm, never touches K-score gating, never reads the holdout. The train-only
// distill + signed-artifact moat is untouched downstream.
//
// No new npm deps. Pure JS. ASCII only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { estimateBatchCost } from './cost-estimator.js';
import * as eventStore from './event-store.js';

export const SELF_SYNTHESIS_VERSION = 'self-synthesis-v1';

const PROVIDER = 'kolm_self_synthesis';

// Pricing-only teacher slug (mirrors data-augment.js). The engine never calls
// this; it only feeds estimateBatchCost so the preview reflects a realistic
// per-row bill for the LIVE generation a caller approves.
const DEFAULT_PRICING_TEACHER = 'openai:gpt-4o-mini';

// ===========================================================================
// MAGPIE PRE-QUERY PREFIX REGISTRY
//
// The Magpie trick: feed the generator ONLY the template tokens that come
// BEFORE the user's content on a user turn (BOS + user-turn open), then let
// it autoregress the instruction. Below, `prequery` is that exact string and
// `userClose`/`assistantOpen` let us assemble the SECOND (response) call.
//
// These markers agree with src/chat-templates.js where the two overlap
// (chatml<->Qwen, llama-3<->Llama). Mistral is added here because the shared
// registry does not ship it and Magpie explicitly targets Mistral bases.
// Each family is keyed by the canonical Magpie family name AND matched against
// a base-model string so callers can pass either.
// ===========================================================================

export const MAGPIE_TEMPLATES = Object.freeze({
  qwen: Object.freeze({
    family: 'qwen',
    description: 'Qwen / ChatML (Qwen2.5, Qwen3). <|im_start|> turn markers.',
    matches: [/qwen/i, /chatml/i],
    // BOS for ChatML is the turn marker itself; the pre-query prefix opens a
    // user turn and stops right before the user content the model must invent.
    prequery: '<|im_start|>user\n',
    userClose: '<|im_end|>\n',
    assistantOpen: '<|im_start|>assistant\n',
    stop_tokens: ['<|im_end|>', '<|endoftext|>'],
  }),
  llama: Object.freeze({
    family: 'llama',
    description: 'Llama 3 header_id template.',
    matches: [/llama-?3/i, /^meta-llama/i],
    prequery: '<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n',
    userClose: '<|eot_id|>',
    assistantOpen: '<|start_header_id|>assistant<|end_header_id|>\n\n',
    stop_tokens: ['<|eot_id|>', '<|end_of_text|>'],
  }),
  mistral: Object.freeze({
    family: 'mistral',
    description: 'Mistral / Mixtral [INST] template (BOS + instruction open).',
    matches: [/mistral/i, /mixtral/i],
    // Mistral wraps the user instruction in [INST] ... [/INST]; the pre-query
    // prefix is BOS + [INST] open. The response call closes [/INST].
    prequery: '<s>[INST] ',
    userClose: ' [/INST]',
    assistantOpen: '',
    stop_tokens: ['</s>', '[INST]'],
  }),
});

export const MAGPIE_FAMILY_NAMES = Object.freeze(Object.keys(MAGPIE_TEMPLATES));

// Resolve a Magpie template by explicit family name OR by matching a
// base-model string. Returns null when nothing matches so the caller can fail
// LOUD rather than silently guess the wrong markers (wrong markers => the
// generator emits garbage, which would poison training data).
export function resolveMagpieTemplate(modelOrFamily) {
  const key = String(modelOrFamily || '').trim();
  if (!key) return null;
  if (MAGPIE_TEMPLATES[key.toLowerCase()]) return MAGPIE_TEMPLATES[key.toLowerCase()];
  for (const tpl of Object.values(MAGPIE_TEMPLATES)) {
    for (const re of tpl.matches) if (re.test(key)) return tpl;
  }
  return null;
}

// Build the exact Magpie pre-query string for a family/model. Exported so the
// live wiring (and tests) can assert the bytes that get fed to the generator.
export function magpiePrequeryPrefix(modelOrFamily) {
  const tpl = resolveMagpieTemplate(modelOrFamily);
  if (!tpl) {
    throw new Error(
      `magpie: no chat-template for '${modelOrFamily}'. known families: ` +
      `${MAGPIE_FAMILY_NAMES.join(', ')}. Pass {generator_family:'qwen'|'llama'|'mistral'} ` +
      'or a base-model name that matches one of them.'
    );
  }
  return tpl.prequery;
}

// ===========================================================================
// helpers (mirrors data-augment.js canonical shape so rows are interchangeable)
// ===========================================================================

function _root() {
  return process.env.KOLM_DATA_DIR || os.homedir();
}

function _dataPath(namespace) {
  const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
  return path.join(_root(), '.kolm', 'data', ns, 'augment-pairs.jsonl');
}

function _genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// A stable per-row generation_id so a later commit/audit can reference the
// exact synthesized row. Derived from content + salt so two rows never collide
// and a re-run with different content yields a different id.
function _generationId(method, content, salt) {
  return crypto.createHash('sha256')
    .update(`${method}|${content}|${salt}`)
    .digest('hex')
    .slice(0, 16);
}

function _asArray(v) {
  return Array.isArray(v) ? v : (v == null ? [] : [v]);
}

function _promptOf(pair) {
  if (pair == null) return '';
  if (typeof pair === 'string') return pair;
  const v = pair.input != null ? pair.input
    : pair.prompt != null ? pair.prompt
    : pair.question != null ? pair.question
    : pair.text != null ? pair.text
    : '';
  return typeof v === 'string' ? v : String(v);
}

function _seedCidOf(pair) {
  if (pair == null || typeof pair === 'string') return null;
  const v = pair.cid != null ? pair.cid
    : pair.capture_cid != null ? pair.capture_cid
    : pair.event_id != null ? pair.event_id
    : pair.id != null ? pair.id
    : null;
  return v == null ? null : String(v);
}

// Canonical augment-pairs row + the self-synthesis audit fields. `output`
// MAY be '' for a prompt-only candidate, but the Magpie path fills it with the
// generator's own response (a real instruction+response pair).
function _candidate({ input, output = '', method, parent_seed_cids, generation_id, extra }) {
  return {
    id: _genId('syn'),
    input: String(input == null ? '' : input),
    output: String(output == null ? '' : output),
    source_type: 'augment',
    // Top-level audit fields (the honesty contract): these mirror
    // synthetic-augment.mergeSyntheticIntoCaptureRows so both engines'
    // outputs filter/up-weight identically downstream.
    kolm_synthetic: true,
    generation_id: String(generation_id),
    parent_seed_cids: Array.isArray(parent_seed_cids) ? parent_seed_cids.slice() : [],
    provenance: {
      strategy: `self-synthesis:${method}`,
      method,
      generation_id: String(generation_id),
      parent_seed_cids: Array.isArray(parent_seed_cids) ? parent_seed_cids.slice() : [],
      generated_at: new Date().toISOString(),
      ...(extra && typeof extra === 'object' ? extra : {}),
    },
  };
}

function _appendJsonl(targetPath, records) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  fs.appendFileSync(targetPath, lines + (records.length ? '\n' : ''), 'utf8');
  return targetPath;
}

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'self-synthesis/v1',
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

// Apply a caller-supplied redactor to a string. The redactor may return a
// string OR an envelope { redacted } / { text } / { output }. When no redactor
// is supplied the string passes through unchanged (Magpie is seed-free so this
// only matters for the Auto-Evol seed path). Never throws on the data path.
function _redact(redactor, s) {
  const str = s == null ? '' : String(s);
  if (typeof redactor !== 'function') return str;
  try {
    const r = redactor(str);
    if (r == null) return str;
    if (typeof r === 'string') return r;
    if (typeof r === 'object') {
      if (typeof r.redacted === 'string') return r.redacted;
      if (typeof r.text === 'string') return r.text;
      if (typeof r.output === 'string') return r.output;
    }
    return String(r);
  } catch {
    // A redactor that throws must NOT leak the raw string downstream: fail
    // closed to empty so the boundary holds.
    return '';
  }
}

// Pull a clean instruction string out of a raw generator completion. Magpie
// completions can carry leading whitespace, a stray role tag the model echoed,
// or trailing stop-token fragments. We strip known stop tokens and role
// echoes, then trim. Returns '' for empty/degenerate output so the caller
// drops the row instead of writing junk.
function _cleanInstruction(raw, tpl) {
  let s = String(raw == null ? '' : raw);
  // Cut at the first stop token if the generator ran past the user turn.
  for (const stop of (tpl && tpl.stop_tokens) || []) {
    const idx = s.indexOf(stop);
    if (idx !== -1) s = s.slice(0, idx);
  }
  // Strip any echoed turn-open the model may have repeated.
  s = s.replace(/^<\|im_start\|>\s*user\s*/i, '')
       .replace(/^<\|start_header_id\|>\s*user\s*<\|end_header_id\|>/i, '')
       .replace(/^\[INST\]\s*/i, '');
  return s.trim();
}

function _cleanResponse(raw, tpl) {
  let s = String(raw == null ? '' : raw);
  for (const stop of (tpl && tpl.stop_tokens) || []) {
    const idx = s.indexOf(stop);
    if (idx !== -1) s = s.slice(0, idx);
  }
  s = s.replace(/^<\|im_start\|>\s*assistant\s*/i, '')
       .replace(/^<\|start_header_id\|>\s*assistant\s*<\|end_header_id\|>/i, '');
  return s.trim();
}

// ===========================================================================
// (a) MAGPIE prompt-free generation
//
// magpieGenerate({ teacher_caller, generator, n, ... }) -> {ok, candidates,...}
//
// teacher_caller signature: async (prompt, opts) -> string.
//   We pass opts.mode='raw_completion' to SIGNAL the harness that this is a
//   base-completion-style call (the generator must continue the pre-query
//   prefix, NOT treat it as a chat message). A harness that ignores opts still
//   works as long as it returns the continuation text.
//
// Two teacher calls per row:
//   1. INSTRUCTION  = teacher_caller(prequeryPrefix)        -> the user turn
//   2. RESPONSE     = teacher_caller(prequery+instr+close+assistantOpen)
//                                                            -> the answer
// The result is a real instruction+response pair with NO seed, ideal for the
// cold-start case. Rows whose instruction cleans to empty are dropped (and
// counted in `dropped`) rather than written.
// ===========================================================================

export async function magpieGenerate(opts = {}) {
  const o = opts || {};
  if (typeof o.teacher_caller !== 'function') {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'magpie',
      error: 'teacher_caller_required',
      hint: 'magpieGenerate is DI - pass {teacher_caller: async (prompt, opts) => string}. ' +
            'Live wiring injects workers/distill/teacher-bridge callTeacher (PHI-redacted).',
    };
  }
  const family = o.generator_family || o.generator || o.base_model;
  let tpl;
  try {
    tpl = resolveMagpieTemplate(family);
    if (!tpl) throw new Error('no template');
  } catch {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'magpie',
      error: 'generator_template_required',
      hint: `pass {generator_family:'qwen'|'llama'|'mistral'} or a base-model name. ` +
            `known: ${MAGPIE_FAMILY_NAMES.join(', ')}`,
    };
  }

  const n = Math.max(1, Math.min(10000, Number.isFinite(Number(o.n)) ? Math.trunc(Number(o.n)) : 50));
  const salt = o.salt != null ? String(o.salt) : crypto.randomBytes(4).toString('hex');
  const prequery = tpl.prequery;

  const candidates = [];
  const errors = [];
  let dropped = 0;

  for (let i = 0; i < n; i++) {
    let instruction = '';
    let response = '';
    try {
      // PHASE 1 - autoregress the instruction from the bare pre-query prefix.
      const rawInstr = await o.teacher_caller(prequery, {
        mode: 'raw_completion',
        stop: tpl.stop_tokens,
        phase: 'magpie_instruction',
      });
      instruction = _cleanInstruction(rawInstr, tpl);
      if (!instruction) { dropped += 1; continue; }

      // PHASE 2 - feed the full user turn and autoregress the response.
      const responsePrompt = prequery + instruction + tpl.userClose + tpl.assistantOpen;
      const rawResp = await o.teacher_caller(responsePrompt, {
        mode: 'raw_completion',
        stop: tpl.stop_tokens,
        phase: 'magpie_response',
      });
      response = _cleanResponse(rawResp, tpl);
    } catch (e) {
      errors.push({ index: i, error: String((e && e.message) || e) });
      continue;
    }

    const generation_id = _generationId('magpie', instruction, `${salt}|${i}`);
    candidates.push(_candidate({
      input: instruction,
      output: response,
      method: 'magpie',
      // Magpie is SEED-FREE: there are no parent seed cids by construction.
      parent_seed_cids: [],
      generation_id,
      extra: {
        generator_family: tpl.family,
        prequery_prefix: prequery,
        seed_free: true,
      },
    }));
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'magpie',
      error: 'magpie_produced_no_rows',
      detail: errors.length ? errors[0].error : `all ${n} generations cleaned to empty`,
      errors,
      dropped,
      generator_family: tpl.family,
    };
  }

  return {
    ok: true,
    version: SELF_SYNTHESIS_VERSION,
    method: 'magpie',
    generator_family: tpl.family,
    prequery_prefix: prequery,
    n_requested: n,
    n_candidates: candidates.length,
    dropped,
    errors,
    candidates,
  };
}

// ===========================================================================
// (b) AUTO-EVOL-INSTRUCT  (arXiv:2406.00770)
//
// The evolution method is itself a PROMPT we ask an LLM to write and then
// iteratively improve. The loop is fully driven by teacher_caller; there are
// NO hand-written depth/breadth string templates here.
//
// autoEvolInstruct({ teacher_caller, seedPairs, rounds, sample_size, ... })
//   -> { ok, candidates, optimized_rules, rule_trace, failure_rate, ... }
//
// Round r (r = 1..rounds):
//   1. EVOLVE a SAMPLE of seeds with the current evolving-rule-set
//      (rule set is a natural-language method an LLM can execute).
//   2. ANALYZE: an LLM judges each evolved instruction for the canonical
//      Auto-Evol failure modes and we MEASURE the failure rate.
//   3. OPTIMIZE: an LLM rewrites the rule set to drive the measured failure
//      rate down, given the analysis feedback.
//   Keep whichever rule set scored the lowest measured failure rate so far.
//
// After the loop, evolve the FULL seed batch with the winning rule set and
// emit canonical candidates. parent_seed_cids points back at the seed each
// evolved instruction came from.
//
// Failure-rate measurement is REAL and deterministic given the analyzer's
// verdicts: failure_rate = failures / evaluated. We never fabricate a score.
// ===========================================================================

// The initial evolving rule set (the Auto-Evol paper seeds the loop with a
// generic method; the LLM then specializes it). This is a METHOD the model
// executes, not a fixed depth/breadth template.
const INITIAL_EVOL_RULES = [
  'Read the #Given Instruction#.',
  'Increase its difficulty by adding ONE of: a constraint, a reasoning step, a concrete edge case, or a required justification - chosen to fit the instruction.',
  'Keep it solvable by a knowledgeable human and keep all original requirements.',
  'Do not copy the given instruction verbatim and do not merely restate it.',
  'Output ONLY the rewritten instruction with no preamble.',
].join('\n');

// Build the evolve prompt that applies a rule set to one seed instruction.
function _evolvePrompt(ruleSet, seedInstruction) {
  return [
    'You are an instruction-evolution engine. Apply the METHOD below to the #Given Instruction#.',
    '',
    '#Evolution Method#',
    ruleSet,
    '',
    '#Given Instruction#',
    seedInstruction,
    '',
    '#Evolved Instruction#',
  ].join('\n');
}

// The analyzer prompt: an LLM labels an evolved instruction with the canonical
// Auto-Evol failure modes. We ask for a strict one-token verdict so the
// measured failure rate is unambiguous; a non-PASS first token counts as a
// failure. (Robust to chatty models - we scan for the verdict keyword.)
function _analyzePrompt(seedInstruction, evolvedInstruction) {
  return [
    'You are an evolution QUALITY CHECKER. Compare the EVOLVED instruction to the ORIGINAL.',
    'Reply with EXACTLY one verdict word on the first line:',
    '  PASS         - strictly harder, still solvable, keeps original intent, not a copy.',
    '  STAGNANT     - not meaningfully harder than the original.',
    '  COPIED       - essentially a restatement / verbatim copy.',
    '  UNSOLVABLE   - made impossible, self-contradictory, or lost required info.',
    '  BROKEN       - malformed / empty / not an instruction.',
    '',
    '#Original#',
    seedInstruction,
    '',
    '#Evolved#',
    evolvedInstruction,
    '',
    '#Verdict#',
  ].join('\n');
}

// The optimizer prompt: an LLM rewrites the rule set to reduce the measured
// failure rate, given the analysis feedback from this round.
function _optimizePrompt(currentRules, failureSummary) {
  return [
    'You optimize an instruction-evolution METHOD. The current method below produced the',
    'failures summarized after it. Rewrite the METHOD so future evolutions avoid those',
    'failures: less stagnation, no copying, never unsolvable, never malformed, while still',
    'increasing difficulty. Output ONLY the improved method as numbered or newline steps.',
    '',
    '#Current Method#',
    currentRules,
    '',
    '#Observed Failures#',
    failureSummary,
    '',
    '#Improved Method#',
  ].join('\n');
}

const _VERDICTS = ['PASS', 'STAGNANT', 'COPIED', 'UNSOLVABLE', 'BROKEN'];

function _parseVerdict(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase();
  for (const v of _VERDICTS) {
    if (s.includes(v)) return v;
  }
  // No recognizable verdict => treat as BROKEN (a checker that cannot judge it
  // is itself a signal the evolved row is unusable).
  return 'BROKEN';
}

// Evolve one seed with a rule set; returns the cleaned evolved instruction.
async function _evolveOne(teacher_caller, ruleSet, seedInstruction) {
  const raw = await teacher_caller(_evolvePrompt(ruleSet, seedInstruction), { phase: 'auto_evol_evolve' });
  let s = String(raw == null ? '' : raw).trim();
  // Drop a leading "#Evolved Instruction#" echo if present.
  s = s.replace(/^#?\s*evolved instruction\s*#?:?\s*/i, '').trim();
  return s;
}

export async function autoEvolInstruct(opts = {}) {
  const o = opts || {};
  if (typeof o.teacher_caller !== 'function') {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'auto-evol-instruct',
      error: 'teacher_caller_required',
      hint: 'autoEvolInstruct is DI - pass {teacher_caller: async (prompt, opts) => string}.',
    };
  }
  const seeds = _asArray(o.seedPairs).length ? _asArray(o.seedPairs) : _asArray(o.seeds);
  // Build a normalized seed list of { instruction, cid }, redacting every
  // instruction string BEFORE it can enter a teacher prompt (privacy boundary).
  const redactor = o.redactor;
  const normSeeds = [];
  for (const s of seeds) {
    const raw = _promptOf(s);
    if (!String(raw).trim()) continue;
    const instruction = _redact(redactor, raw);
    if (!String(instruction).trim()) continue; // redactor nuked it -> skip
    normSeeds.push({ instruction, cid: _seedCidOf(s) });
  }
  if (normSeeds.length === 0) {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'auto-evol-instruct',
      error: 'no_seed_instructions',
      hint: 'pass {seedPairs:[{input|prompt|...}]}. After redaction at least one non-empty seed is required.',
    };
  }

  const rounds = Math.max(1, Math.min(8, Number.isFinite(Number(o.rounds)) ? Math.trunc(Number(o.rounds)) : 2));
  const sampleSize = Math.max(1, Math.min(normSeeds.length,
    Number.isFinite(Number(o.sample_size)) ? Math.trunc(Number(o.sample_size)) : Math.min(4, normSeeds.length)));
  const salt = o.salt != null ? String(o.salt) : crypto.randomBytes(4).toString('hex');

  // --- RULE-SET OPTIMIZATION LOOP -----------------------------------------
  let currentRules = (typeof o.initial_rules === 'string' && o.initial_rules.trim())
    ? o.initial_rules.trim()
    : INITIAL_EVOL_RULES;
  let bestRules = currentRules;
  let bestFailureRate = Infinity;
  const ruleTrace = [];

  // A deterministic, salted sample of seeds for the optimization loop so the
  // measured signal is stable across a re-run with the same salt.
  const sample = _sampleSeeds(normSeeds, sampleSize, salt);

  for (let r = 0; r < rounds; r++) {
    let failures = 0;
    let evaluated = 0;
    const verdictCounts = { PASS: 0, STAGNANT: 0, COPIED: 0, UNSOLVABLE: 0, BROKEN: 0 };
    const failureExamples = [];

    for (const seed of sample) {
      let evolved = '';
      try {
        evolved = await _evolveOne(o.teacher_caller, currentRules, seed.instruction);
      } catch (e) {
        // An evolve call that throws is itself a failure of this rule set.
        evaluated += 1;
        failures += 1;
        verdictCounts.BROKEN += 1;
        failureExamples.push(`BROKEN(evolve-threw): ${String((e && e.message) || e).slice(0, 80)}`);
        continue;
      }
      evaluated += 1;
      let verdict;
      if (!evolved) {
        verdict = 'BROKEN';
      } else {
        try {
          const rawVerdict = await o.teacher_caller(
            _analyzePrompt(seed.instruction, evolved), { phase: 'auto_evol_analyze' });
          verdict = _parseVerdict(rawVerdict);
        } catch {
          verdict = 'BROKEN';
        }
      }
      verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
      if (verdict !== 'PASS') {
        failures += 1;
        if (failureExamples.length < 5) {
          failureExamples.push(`${verdict}: ${evolved.slice(0, 80) || '(empty)'}`);
        }
      }
    }

    const failureRate = evaluated > 0 ? failures / evaluated : 1;
    ruleTrace.push({
      round: r,
      rules: currentRules,
      evaluated,
      failures,
      failure_rate: Number(failureRate.toFixed(4)),
      verdicts: verdictCounts,
    });

    if (failureRate < bestFailureRate) {
      bestFailureRate = failureRate;
      bestRules = currentRules;
    }

    // OPTIMIZE for the next round (skip after the last round - nothing uses it).
    if (r < rounds - 1) {
      const summary = [
        `failure_rate=${failureRate.toFixed(3)} (${failures}/${evaluated})`,
        `verdicts=${JSON.stringify(verdictCounts)}`,
        failureExamples.length ? `examples:\n- ${failureExamples.join('\n- ')}` : 'examples: none',
      ].join('\n');
      try {
        const rawRules = await o.teacher_caller(
          _optimizePrompt(currentRules, summary), { phase: 'auto_evol_optimize' });
        const next = String(rawRules == null ? '' : rawRules)
          .replace(/^#?\s*improved method\s*#?:?\s*/i, '').trim();
        if (next) currentRules = next;
      } catch {
        // Optimizer failed: keep the current rules for the next round rather
        // than aborting. The loop still measures and can converge on what works.
      }
    }
  }

  // --- FINAL EVOLUTION with the WINNING rule set --------------------------
  const candidates = [];
  const errors = [];
  let dropped = 0;
  for (let i = 0; i < normSeeds.length; i++) {
    const seed = normSeeds[i];
    let evolved = '';
    try {
      evolved = await _evolveOne(o.teacher_caller, bestRules, seed.instruction);
    } catch (e) {
      errors.push({ index: i, error: String((e && e.message) || e) });
      continue;
    }
    if (!evolved || evolved === seed.instruction) { dropped += 1; continue; }
    const generation_id = _generationId('auto-evol', evolved, `${salt}|${i}`);
    candidates.push(_candidate({
      input: evolved,
      // Evolved rows are PROMPT candidates awaiting a COLLECT step - output ''
      // by design (matches data-augment.js evol contract).
      output: '',
      method: 'auto-evol-instruct',
      parent_seed_cids: seed.cid ? [seed.cid] : [],
      generation_id,
      extra: {
        evolved_from: seed.instruction.slice(0, 200),
        winning_failure_rate: Number(bestFailureRate === Infinity ? 1 : bestFailureRate.toFixed(4)),
      },
    }));
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      version: SELF_SYNTHESIS_VERSION,
      method: 'auto-evol-instruct',
      error: 'auto_evol_produced_no_rows',
      detail: errors.length ? errors[0].error : `all ${normSeeds.length} evolutions were dropped`,
      errors,
      dropped,
      rule_trace: ruleTrace,
      optimized_rules: bestRules,
      best_failure_rate: bestFailureRate === Infinity ? null : Number(bestFailureRate.toFixed(4)),
    };
  }

  return {
    ok: true,
    version: SELF_SYNTHESIS_VERSION,
    method: 'auto-evol-instruct',
    n_seeds: normSeeds.length,
    n_candidates: candidates.length,
    dropped,
    rounds,
    sample_size: sampleSize,
    optimized_rules: bestRules,
    best_failure_rate: bestFailureRate === Infinity ? null : Number(bestFailureRate.toFixed(4)),
    rule_trace: ruleTrace,
    errors,
    candidates,
  };
}

// Deterministic salted sample of seeds (no clock, no Math.random - so a re-run
// with the same salt measures the same signal). Picks distinct indices.
function _sampleSeeds(seeds, k, salt) {
  if (seeds.length <= k) return seeds.slice();
  const scored = seeds.map((s, i) => {
    const h = crypto.createHash('sha256').update(`${salt}|${i}|${s.instruction}`).digest('hex');
    return { s, score: h };
  });
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
  return scored.slice(0, k).map((x) => x.s);
}

// ===========================================================================
// COST PREVIEW
//
// Magpie spends 2 teacher calls per row; Auto-Evol spends
//   (rounds*sample*2)  [evolve+analyze]
// + (rounds-1)         [optimize]
// + n_seeds            [final evolve]
// calls. We surface BOTH a row-count cost (what data-augment.js shows) AND the
// true call count so the operator sees the real bill before approving live
// generation. This is the number the data-engine cost gate compares against
// opts.approve_cost_usd.
// ===========================================================================

export function previewCost(method, params = {}, opts = {}) {
  const teacher = (typeof opts.teacher === 'string' && opts.teacher) ? opts.teacher : DEFAULT_PRICING_TEACHER;
  const avg_input_tokens = Number.isFinite(opts.avg_input_tokens) ? Number(opts.avg_input_tokens) : 256;
  const avg_output_tokens = Number.isFinite(opts.avg_output_tokens) ? Number(opts.avg_output_tokens) : 384;

  let calls = 0;
  let rows = 0;
  if (method === 'magpie') {
    rows = Math.max(0, Number(params.n) || 0);
    calls = rows * 2; // instruction + response
  } else if (method === 'auto-evol-instruct') {
    const nSeeds = Math.max(0, Number(params.n_seeds) || 0);
    const rounds = Math.max(1, Number(params.rounds) || 1);
    const sample = Math.max(0, Math.min(nSeeds, Number(params.sample_size) || 0));
    rows = nSeeds;
    calls = (rounds * sample * 2) + Math.max(0, rounds - 1) + nSeeds;
  } else {
    rows = Math.max(0, Number(params.n) || 0);
    calls = rows;
  }

  const batch = estimateBatchCost({
    teachers: [{ slug: teacher, rows: calls }],
    avg_input_tokens,
    avg_output_tokens,
  });
  const est = Number.isFinite(batch.total_usd) ? batch.total_usd : 0;
  return {
    method,
    est_cost_usd: est,
    n: rows,
    teacher_calls: calls,
    per_row_usd: rows > 0 ? Number((est / rows).toFixed(6)) : 0,
    teacher,
    unknown_models: batch.unknown_models || [],
    assumptions: batch.assumptions,
  };
}

// ===========================================================================
// PUBLIC AUGMENT-COMPATIBLE ENTRY POINT
//
// selfSynthesize({ tenant, namespace, mode, opts }) returns the SAME envelope
// shape as src/data-augment.js augment() so the data-engine AUGMENT stage can
// route a `self-synthesis` sub-strategy through this module with zero changes
// to its cost-gate logic (it reads cost_preview.est_cost_usd + honors apply).
//
//   mode: 'magpie' | 'auto-evol-instruct' | 'auto'
//     'auto' picks MAGPIE when there are no usable seeds (cold-start) and
//     AUTO-EVOL when seeds exist - exactly the cold-start-scarce trigger in
//     the spec.
//
//   opts.apply !== true  -> PREVIEW ONLY (compute candidates + cost, write 0).
//   opts.apply === true  -> append candidates to augment-pairs.jsonl.
// ===========================================================================

export async function selfSynthesize({ tenant, namespace, mode, seedPairs, opts } = {}) {
  try {
    const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
    const tn = (typeof tenant === 'string' && tenant.trim()) ? tenant.trim() : 'tenant_local';
    const o = (opts && typeof opts === 'object') ? opts : {};
    const seeds = _asArray(seedPairs).length ? _asArray(seedPairs) : _asArray(o.seedPairs);

    // Resolve mode. 'auto' => cold-start picks magpie, else auto-evol.
    let chosen = (typeof mode === 'string' && mode) ? mode : (o.mode || 'auto');
    const usableSeeds = seeds.filter((s) => String(_promptOf(s)).trim()).length;
    if (chosen === 'auto') {
      chosen = usableSeeds > 0 ? 'auto-evol-instruct' : 'magpie';
    }

    let gen;
    if (chosen === 'magpie') {
      gen = await magpieGenerate({ ...o, teacher_caller: o.teacher_caller });
    } else if (chosen === 'auto-evol-instruct') {
      gen = await autoEvolInstruct({ ...o, teacher_caller: o.teacher_caller, seedPairs: seeds });
    } else {
      return {
        ok: false,
        version: SELF_SYNTHESIS_VERSION,
        error: `unknown self-synthesis mode '${chosen}'. valid: magpie, auto-evol-instruct, auto`,
      };
    }

    if (!gen || gen.ok !== true) {
      // Surface the underlying failure but keep the augment envelope shape so
      // the cost gate / data-engine slot reads uniformly.
      return {
        ok: false,
        version: SELF_SYNTHESIS_VERSION,
        strategy: `self-synthesis:${chosen}`,
        error: (gen && gen.error) || 'self-synthesis produced no envelope',
        ...(gen && gen.hint ? { hint: gen.hint } : {}),
        ...(gen && gen.detail ? { detail: gen.detail } : {}),
      };
    }

    const candidates = gen.candidates;
    const costParams = chosen === 'magpie'
      ? { n: gen.n_requested != null ? gen.n_requested : candidates.length }
      : { n_seeds: gen.n_seeds, rounds: gen.rounds, sample_size: gen.sample_size };
    const cost_preview = previewCost(chosen, costParams, o);

    const apply = o.apply === true;
    const targetPath = _dataPath(ns);
    let wrote = false;
    if (apply && candidates.length) {
      _appendJsonl(targetPath, candidates);
      wrote = true;
    }

    const persistence = await _persist({
      tenant: tn,
      namespace: ns,
      workflow: `self_synthesis_${chosen}`,
      payload: {
        method: chosen,
        n_candidates: candidates.length,
        applied: wrote,
        est_cost_usd: cost_preview.est_cost_usd,
        teacher_calls: cost_preview.teacher_calls,
        ...(gen.best_failure_rate != null ? { best_failure_rate: gen.best_failure_rate } : {}),
      },
    });

    return {
      ok: true,
      version: SELF_SYNTHESIS_VERSION,
      strategy: `self-synthesis:${chosen}`,
      method: chosen,
      n_candidates: candidates.length,
      cost_preview,
      wrote,
      path: targetPath,
      candidates,
      // Pass through the method-specific audit fields the data-engine slot may
      // want to show in the Data Health panel.
      ...(gen.optimized_rules ? { optimized_rules: gen.optimized_rules } : {}),
      ...(gen.rule_trace ? { rule_trace: gen.rule_trace } : {}),
      ...(gen.best_failure_rate != null ? { best_failure_rate: gen.best_failure_rate } : {}),
      ...(gen.prequery_prefix ? { prequery_prefix: gen.prequery_prefix } : {}),
      ...(gen.dropped != null ? { dropped: gen.dropped } : {}),
      persistence,
    };
  } catch (e) {
    return { ok: false, version: SELF_SYNTHESIS_VERSION, error: String((e && e.message) || e) };
  }
}

export default {
  SELF_SYNTHESIS_VERSION,
  MAGPIE_TEMPLATES,
  MAGPIE_FAMILY_NAMES,
  resolveMagpieTemplate,
  magpiePrequeryPrefix,
  magpieGenerate,
  autoEvolInstruct,
  previewCost,
  selfSynthesize,
};
