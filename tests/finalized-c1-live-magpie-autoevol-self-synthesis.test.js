// tests/finalized-c1-live-magpie-autoevol-self-synthesis.test.js
//
// Proves the LIVE self-synthesis engine (src/self-synthesis-engine.js):
//   (a) Magpie prompt-free generation - prompts the generator with ONLY its
//       chat-template pre-query prefix; per-model template registry
//       (Qwen/Llama/Mistral); produces real instruction+response pairs with
//       NO seed; canonical augment-pairs shape + generation_id +
//       parent_seed_cids; PHI-redaction is moot (seed-free) so no customer
//       data leaves.
//   (b) Auto-Evol-Instruct - evolution RULES are LLM-generated and iteratively
//       optimized against a MEASURED failure-rate signal (no hand-written
//       depth/breadth templates); winning rules evolve the full seed batch;
//       provenance points back at parent seeds; the privacy redactor runs on
//       every seed BEFORE any teacher prompt.
//   (c) Cost-preview gate: PREVIEW writes nothing; APPLY (approve) writes the
//       canonical augment-pairs.jsonl; teacher_calls reflect the real bill.
//
// Pure node:test. teacher_caller is a programmable fake - NO network, NO key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate every on-disk write to a throwaway data dir BEFORE importing the
// engine (the engine reads process.env.KOLM_DATA_DIR at call time, but the
// event-store reads HOME/USERPROFILE/KOLM_DATA_DIR lazily - set both).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-selfsynth-'));
process.env.KOLM_DATA_DIR = TMP;
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
process.env.KOLM_EVENT_STORE_PATH = path.join(TMP, 'events.jsonl');

const eng = await import('../src/self-synthesis-engine.js');
const {
  SELF_SYNTHESIS_VERSION,
  MAGPIE_TEMPLATES,
  MAGPIE_FAMILY_NAMES,
  resolveMagpieTemplate,
  magpiePrequeryPrefix,
  magpieGenerate,
  autoEvolInstruct,
  previewCost,
  selfSynthesize,
} = eng;

// ---------------------------------------------------------------------------
// Programmable teacher_caller fakes. Each records every prompt it saw so the
// test can PROVE what bytes were fed to the generator (the Magpie pre-query
// trick + the privacy boundary).
// ---------------------------------------------------------------------------

function magpieFake() {
  const seen = [];
  let i = 0;
  const caller = async (prompt, opts) => {
    seen.push({ prompt, opts });
    // Phase is signaled by opts.phase. Instruction phase returns a fabricated
    // user turn; response phase returns a fabricated answer.
    if (opts && opts.phase === 'magpie_instruction') {
      i += 1;
      // Return WITH a trailing stop token to prove _cleanInstruction strips it.
      return `How do I reset my password (case ${i})?<|im_end|>`;
    }
    if (opts && opts.phase === 'magpie_response') {
      return `Go to Settings > Security and click Reset.<|im_end|>`;
    }
    return '';
  };
  return { caller, seen };
}

// Auto-Evol fake: drives the rule-optimization loop with a MEASURABLE failure
// signal. Round 0 uses the INITIAL rules -> we make analyzer return STAGNANT
// (failures). The optimizer is asked to rewrite; once the rules contain the
// token 'HARDER' (which the optimizer injects), the evolve output differs and
// the analyzer returns PASS. This proves the loop measures, optimizes, and
// improves.
function autoEvolFake() {
  const seen = [];
  const caller = async (prompt, opts) => {
    seen.push({ prompt, opts, phase: opts && opts.phase });
    const phase = opts && opts.phase;
    const rulesAreImproved = /HARDER/.test(prompt);
    if (phase === 'auto_evol_evolve') {
      // Pull the given instruction out of the evolve prompt.
      const m = prompt.match(/#Given Instruction#\n([\s\S]*?)\n\n#Evolved Instruction#/);
      const given = m ? m[1].trim() : 'X';
      // With improved rules, append a real constraint -> a different, harder
      // instruction. With initial rules, a weak cosmetic tweak (stagnant but
      // NOT a verbatim copy - a real model never returns byte-identical text).
      return rulesAreImproved
        ? `${given} Additionally, justify each step and handle the empty-input edge case.`
        : `${given} Please.`;
    }
    if (phase === 'auto_evol_analyze') {
      // Evolved differs from original only under improved rules.
      const m = prompt.match(/#Evolved#\n([\s\S]*?)\n\n#Verdict#/);
      const evolved = m ? m[1].trim() : '';
      const harder = /justify each step/.test(evolved);
      return harder ? 'PASS' : 'STAGNANT - not meaningfully harder';
    }
    if (phase === 'auto_evol_optimize') {
      // The optimizer returns an improved method that injects the HARDER token
      // the evolve step keys off of.
      return [
        '1. Read the given instruction.',
        '2. Make it strictly HARDER: add a justification requirement AND a concrete edge case.',
        '3. Never copy; never make it unsolvable.',
        '4. Output only the rewritten instruction.',
      ].join('\n');
    }
    return '';
  };
  return { caller, seen };
}

// ===========================================================================
// MAGPIE
// ===========================================================================

test('magpie: per-model pre-query prefix registry covers Qwen/Llama/Mistral with real markers', () => {
  assert.deepEqual([...MAGPIE_FAMILY_NAMES].sort(), ['llama', 'mistral', 'qwen']);

  // Qwen / ChatML.
  assert.equal(magpiePrequeryPrefix('qwen'), '<|im_start|>user\n');
  assert.equal(magpiePrequeryPrefix('Qwen/Qwen2.5-7B-Instruct'), '<|im_start|>user\n');

  // Llama 3 - BOS + user header, no content.
  const llama = magpiePrequeryPrefix('meta-llama/Llama-3.1-8B-Instruct');
  assert.ok(llama.startsWith('<|begin_of_text|>'), 'llama prefix must carry BOS');
  assert.ok(llama.includes('<|start_header_id|>user<|end_header_id|>'), 'llama user turn open');

  // Mistral - BOS + [INST] open, no content.
  const mistral = magpiePrequeryPrefix('mistralai/Mistral-7B-Instruct-v0.3');
  assert.ok(mistral.startsWith('<s>[INST]'), 'mistral prefix must be BOS + [INST]');

  // Each prefix STOPS before any user content (Magpie's defining property).
  for (const fam of MAGPIE_FAMILY_NAMES) {
    const p = MAGPIE_TEMPLATES[fam].prequery;
    assert.ok(!/please|how do i|write a/i.test(p), `prefix for ${fam} must contain NO instruction content`);
  }
});

test('magpie: unknown generator fails LOUD (no silent wrong-marker guess)', async () => {
  assert.equal(resolveMagpieTemplate('gpt-2'), null);
  assert.throws(() => magpiePrequeryPrefix('some-unknown-base'), /no chat-template/);

  const res = await magpieGenerate({ teacher_caller: async () => 'x', generator_family: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'generator_template_required');
  assert.match(res.hint, /qwen|llama|mistral/);
});

test('magpie: missing teacher_caller fails with an install/wiring hint', async () => {
  const res = await magpieGenerate({ generator_family: 'qwen' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'teacher_caller_required');
  assert.match(res.hint, /teacher_caller/);
});

test('magpie: prompt-free generation feeds ONLY the pre-query prefix, then autoregresses an instruction+response pair', async () => {
  const { caller, seen } = magpieFake();
  const res = await magpieGenerate({ teacher_caller: caller, generator_family: 'qwen', n: 3, salt: 'fixed' });

  assert.equal(res.ok, true);
  assert.equal(res.method, 'magpie');
  assert.equal(res.n_candidates, 3);

  // PROVE the instruction phase saw ONLY the bare pre-query prefix - no seed,
  // no instruction content. This is the load-bearing Magpie property.
  const instrCalls = seen.filter((s) => s.opts && s.opts.phase === 'magpie_instruction');
  assert.equal(instrCalls.length, 3);
  for (const c of instrCalls) {
    assert.equal(c.prompt, '<|im_start|>user\n', 'instruction call must be the bare pre-query prefix');
    assert.equal(c.opts.mode, 'raw_completion', 'must signal raw completion, not a chat message');
  }

  // The response phase must include the autoregressed instruction inside a full
  // user turn closed off and the assistant turn opened.
  const respCalls = seen.filter((s) => s.opts && s.opts.phase === 'magpie_response');
  assert.equal(respCalls.length, 3);
  for (const c of respCalls) {
    assert.ok(c.prompt.startsWith('<|im_start|>user\n'), 'response prompt opens the user turn');
    assert.ok(c.prompt.includes('<|im_start|>assistant\n'), 'response prompt opens the assistant turn');
  }

  // Each candidate is a REAL instruction+response pair (output is non-empty),
  // canonical shape, seed-free, with audit fields.
  for (const cand of res.candidates) {
    assert.ok(cand.input && /reset my password/.test(cand.input), 'instruction present + stop-token stripped');
    assert.ok(!cand.input.includes('<|im_end|>'), 'stop token must be stripped from instruction');
    assert.ok(cand.output && cand.output.length > 0, 'magpie row carries a real response');
    assert.equal(cand.source_type, 'augment');
    assert.equal(cand.kolm_synthetic, true);
    assert.ok(cand.generation_id && cand.generation_id.length === 16, 'generation_id present');
    assert.deepEqual(cand.parent_seed_cids, [], 'magpie is seed-free: no parents');
    assert.equal(cand.provenance.method, 'magpie');
    assert.equal(cand.provenance.seed_free, true);
    assert.equal(cand.provenance.prequery_prefix, '<|im_start|>user\n');
  }

  // Deterministic generation_id given the same salt.
  const res2 = await magpieGenerate({ teacher_caller: magpieFake().caller, generator_family: 'qwen', n: 3, salt: 'fixed' });
  assert.equal(res2.candidates[0].generation_id, res.candidates[0].generation_id);
});

// ===========================================================================
// AUTO-EVOL-INSTRUCT
// ===========================================================================

test('auto-evol: rules are LLM-generated and OPTIMIZED against a MEASURED failure rate (no hand-written templates)', async () => {
  const { caller, seen } = autoEvolFake();
  const seedPairs = [
    { input: 'Summarize the refund policy.', id: 'seed-A' },
    { input: 'Explain how to escalate a ticket.', id: 'seed-B' },
    { input: 'List the steps to close an account.', id: 'seed-C' },
  ];
  const res = await autoEvolInstruct({ teacher_caller: caller, seedPairs, rounds: 2, sample_size: 2, salt: 'fixed' });

  assert.equal(res.ok, true);
  assert.equal(res.method, 'auto-evol-instruct');

  // The optimizer was actually invoked (rule generation is LLM-driven).
  assert.ok(seen.some((s) => s.phase === 'auto_evol_optimize'), 'optimizer LLM call must have run');

  // The MEASURED failure rate improved: round 0 (initial rules) should fail
  // (STAGNANT) and a later round should reach 0 after the optimizer injects
  // the HARDER directive.
  assert.equal(res.rule_trace.length, 2);
  assert.ok(res.rule_trace[0].failure_rate > 0, 'round 0 must measure real failures under the initial rules');
  assert.equal(res.best_failure_rate, 0, 'optimization must drive measured failure rate to 0');

  // The winning rules are the LLM-optimized ones (carry the injected token),
  // NOT the initial hand-written method.
  assert.match(res.optimized_rules, /HARDER/, 'winning rules are the LLM-optimized method');

  // Final batch evolved ALL seeds; provenance points back at each parent seed.
  assert.equal(res.n_candidates, 3);
  const parents = new Set();
  for (const cand of res.candidates) {
    assert.equal(cand.source_type, 'augment');
    assert.equal(cand.provenance.method, 'auto-evol-instruct');
    assert.equal(cand.parent_seed_cids.length, 1, 'each evolved row references its parent seed');
    parents.add(cand.parent_seed_cids[0]);
    assert.ok(/justify each step/.test(cand.input), 'final evolution used the WINNING harder rules');
    assert.ok(cand.generation_id && cand.generation_id.length === 16);
  }
  assert.deepEqual([...parents].sort(), ['seed-A', 'seed-B', 'seed-C']);
});

test('auto-evol: privacy redactor runs on EVERY seed BEFORE any teacher prompt (provable boundary)', async () => {
  const { caller, seen } = autoEvolFake();
  // A redactor that replaces a secret token. If ANY teacher prompt contains the
  // raw secret, the boundary is broken.
  const redactor = (s) => String(s).replace(/SECRET-SSN-123-45-6789/g, '[REDACTED_SSN]');
  const seedPairs = [
    { input: 'Look up account for SECRET-SSN-123-45-6789 and summarize.', id: 'p1' },
    { input: 'Escalate the SECRET-SSN-123-45-6789 case.', id: 'p2' },
  ];
  const res = await autoEvolInstruct({ teacher_caller: caller, seedPairs, redactor, rounds: 1, sample_size: 2, salt: 'fixed' });
  assert.equal(res.ok, true);

  // No prompt sent to the teacher may contain the raw secret.
  for (const s of seen) {
    assert.ok(!s.prompt.includes('SECRET-SSN-123-45-6789'), 'raw customer secret must NEVER reach the teacher');
  }
  // The redacted token DID make it through (so we know redaction, not dropping).
  assert.ok(seen.some((s) => s.prompt.includes('[REDACTED_SSN]')), 'redacted form is what the teacher sees');
});

test('auto-evol: missing teacher_caller / no seeds fail LOUD', async () => {
  const a = await autoEvolInstruct({ seedPairs: [{ input: 'x' }] });
  assert.equal(a.ok, false);
  assert.equal(a.error, 'teacher_caller_required');

  const b = await autoEvolInstruct({ teacher_caller: async () => 'x', seedPairs: [] });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'no_seed_instructions');
});

// ===========================================================================
// COST PREVIEW + APPLY GATE (data-engine seam compatibility)
// ===========================================================================

test('cost preview: counts the REAL teacher-call bill for each method', () => {
  const m = previewCost('magpie', { n: 10 });
  assert.equal(m.teacher_calls, 20, 'magpie = 2 calls/row');
  assert.equal(m.n, 10);
  assert.ok(m.est_cost_usd >= 0);

  // auto-evol: rounds*sample*2 + (rounds-1) + n_seeds
  const a = previewCost('auto-evol-instruct', { n_seeds: 5, rounds: 2, sample_size: 3 });
  assert.equal(a.teacher_calls, 2 * 3 * 2 + 1 + 5);
  assert.equal(a.n, 5);
});

test('selfSynthesize: PREVIEW writes nothing; APPLY writes canonical augment-pairs.jsonl', async () => {
  const ns = 'ss-apply-test';
  const target = path.join(TMP, '.kolm', 'data', ns, 'augment-pairs.jsonl');
  try { fs.rmSync(target, { force: true }); } catch {}

  const { caller } = magpieFake();

  // 1) PREVIEW (apply omitted) - nothing on disk.
  const preview = await selfSynthesize({
    namespace: ns,
    mode: 'magpie',
    opts: { teacher_caller: caller, generator_family: 'qwen', n: 4, salt: 'fixed' },
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.strategy, 'self-synthesis:magpie');
  assert.equal(preview.wrote, false);
  assert.ok(preview.cost_preview && preview.cost_preview.teacher_calls === 8);
  assert.ok(!fs.existsSync(target), 'PREVIEW must not write the augment file');

  // 2) APPLY - canonical rows land on disk.
  const applied = await selfSynthesize({
    namespace: ns,
    mode: 'magpie',
    opts: { teacher_caller: magpieFake().caller, generator_family: 'qwen', n: 4, salt: 'fixed', apply: true },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.wrote, true);
  assert.ok(fs.existsSync(target), 'APPLY must write the augment file');

  const lines = fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
  for (const ln of lines) {
    const row = JSON.parse(ln);
    assert.ok(row.id && typeof row.input === 'string' && typeof row.output === 'string');
    assert.equal(row.source_type, 'augment');
    assert.equal(row.kolm_synthetic, true);
    assert.ok(row.generation_id, 'persisted row carries generation_id');
    assert.ok(Array.isArray(row.parent_seed_cids), 'persisted row carries parent_seed_cids');
    assert.equal(row.provenance.strategy, 'self-synthesis:magpie');
  }
});

test("selfSynthesize 'auto' mode: cold-start (no seeds) picks Magpie; with seeds picks Auto-Evol", async () => {
  // Cold-start: no usable seeds -> magpie.
  const cold = await selfSynthesize({
    namespace: 'ss-auto-cold',
    mode: 'auto',
    seedPairs: [],
    opts: { teacher_caller: magpieFake().caller, generator_family: 'qwen', n: 2, salt: 'fixed' },
  });
  assert.equal(cold.ok, true);
  assert.equal(cold.method, 'magpie', 'cold-start must self-synthesize from scratch via Magpie');

  // Warm: seeds present -> auto-evol.
  const warm = await selfSynthesize({
    namespace: 'ss-auto-warm',
    mode: 'auto',
    seedPairs: [{ input: 'Explain escalation.', id: 's1' }, { input: 'Summarize refunds.', id: 's2' }],
    opts: { teacher_caller: autoEvolFake().caller, rounds: 1, sample_size: 2, salt: 'fixed' },
  });
  assert.equal(warm.ok, true);
  assert.equal(warm.method, 'auto-evol-instruct', 'with seeds, evolve them via Auto-Evol-Instruct');
});

test('version constant is exported', () => {
  assert.equal(SELF_SYNTHESIS_VERSION, 'self-synthesis-v1');
});
