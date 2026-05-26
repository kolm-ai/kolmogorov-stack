// W828 — REASONING TRACE DISTILLATION v2 lock-ins.
//
// W713 already shipped reasoning-trace CAPTURE. W828 adds the v2 upgrades:
//   1) AUTO-DETECT — `autoDetectReasoningCapability(response)` sniffs the
//      response shape so callers don't need to pass `provider:`.
//   2) TRACE-AWARE LOSS — `trace_aware_loss(logits, target_ids, trace_mask,
//      attention_mask, w)` in `apps/trainer/distill.py`.
//   3) CLI flag `--reasoning-trace-loss-weight 0.0..1.0` + env
//      `KOLM_REASONING_TRACE_LOSS_WEIGHT` plumbing.
//   4) Bench scaffold `apps/trainer/bench_trace_aware.py`.
//
// These are OBSERVABLE lock-ins, not implementation details. We grep the
// Python files for the formula tokens (answer_loss, trace_loss, `w *`) so
// a refactor that drops the trace-aware loss is caught at CI time.
//
// Concurrency 1; KOLM_DATA_DIR isolated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-w828-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const {
  autoDetectReasoningCapability,
  autoExtractReasoningTrace,
  extractReasoningTrace,
} = await import('../src/capture.js');

// ============================================================================
// 1) Anthropic shape → has_traces:true, format:'anthropic_thinking'
// ============================================================================
test('W828 #1 — autoDetectReasoningCapability detects Anthropic thinking blocks', () => {
  const resp = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me work through this step by step.' },
      { type: 'text', text: 'The answer is 42.' },
    ],
  };
  const cap = autoDetectReasoningCapability(resp);
  assert.equal(cap.has_traces, true, 'Anthropic thinking block must be detected');
  assert.equal(cap.format, 'anthropic_thinking');
  assert.equal(cap.provider, 'anthropic');

  // And the auto-extractor should produce the same trace the manual W713
  // path produces — backward compatibility lock-in.
  const traceAuto = autoExtractReasoningTrace(resp);
  const traceManual = extractReasoningTrace(resp, 'anthropic');
  assert.deepEqual(traceAuto, traceManual,
    'autoExtractReasoningTrace must match manual W713 extractor output');
});

// ============================================================================
// 2) OpenAI o1 shape → has_traces:true, format:'openai_reasoning_tokens'
// ============================================================================
test('W828 #2 — autoDetectReasoningCapability detects OpenAI o1 reasoning_tokens', () => {
  // Current canonical shape: usage.completion_tokens_details.reasoning_tokens.
  const resp = {
    id: 'chatcmpl_01',
    choices: [{ message: { role: 'assistant', content: 'final answer' } }],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 150 },
    },
  };
  const cap = autoDetectReasoningCapability(resp);
  assert.equal(cap.has_traces, true);
  assert.equal(cap.format, 'openai_reasoning_tokens');
  assert.equal(cap.provider, 'openai');

  // Legacy / preview shape: flat usage.reasoning_tokens.
  const respLegacy = {
    choices: [{ message: { content: 'answer' } }],
    usage: { reasoning_tokens: 80 },
  };
  const capLegacy = autoDetectReasoningCapability(respLegacy);
  assert.equal(capLegacy.has_traces, true);
  assert.equal(capLegacy.format, 'openai_reasoning_tokens');
  assert.equal(capLegacy.provider, 'openai');

  // reasoning_tokens === 0 → not detected.
  const respZero = {
    choices: [{ message: { content: 'plain' } }],
    usage: { completion_tokens_details: { reasoning_tokens: 0 } },
  };
  assert.equal(autoDetectReasoningCapability(respZero).has_traces, false);
});

// ============================================================================
// 3) DeepSeek shape → has_traces:true, format:'deepseek_reasoning'
// ============================================================================
test('W828 #3 — autoDetectReasoningCapability detects DeepSeek reasoning_content', () => {
  const resp = {
    id: 'chatcmpl_ds',
    choices: [{
      message: {
        role: 'assistant',
        content: 'final answer',
        reasoning_content: 'Step 1: parse. Step 2: solve.',
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 30 },
  };
  const cap = autoDetectReasoningCapability(resp);
  assert.equal(cap.has_traces, true);
  assert.equal(cap.format, 'deepseek_reasoning');
  assert.equal(cap.provider, 'deepseek');

  // Empty reasoning_content string → not detected (honest signal).
  const respEmpty = {
    choices: [{ message: { content: 'a', reasoning_content: '' } }],
  };
  assert.equal(autoDetectReasoningCapability(respEmpty).has_traces, false);
});

// ============================================================================
// 4) Gemini shape → has_traces:true, format:'gemini_thinking'
// ============================================================================
test('W828 #4 — autoDetectReasoningCapability detects Gemini thinking parts', () => {
  const resp = {
    candidates: [{
      content: {
        parts: [
          { thinking: 'internal deliberation' },
          { text: 'final answer' },
        ],
      },
    }],
  };
  const cap = autoDetectReasoningCapability(resp);
  assert.equal(cap.has_traces, true);
  assert.equal(cap.format, 'gemini_thinking');
  assert.equal(cap.provider, 'gemini');

  // Part with no thinking field → not detected.
  const respNoThink = {
    candidates: [{ content: { parts: [{ text: 'plain' }] } }],
  };
  assert.equal(autoDetectReasoningCapability(respNoThink).has_traces, false);
});

// ============================================================================
// 5) Fallback (none) → has_traces:false
// ============================================================================
test('W828 #5 — autoDetectReasoningCapability returns has_traces:false for non-reasoning shapes', () => {
  // Plain Anthropic response with text only — no thinking block.
  const plainAnthropic = {
    content: [{ type: 'text', text: 'hello' }],
  };
  assert.equal(autoDetectReasoningCapability(plainAnthropic).has_traces, false);

  // Plain OpenAI response.
  const plainOpenAI = {
    choices: [{ message: { content: 'hello' } }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
  assert.equal(autoDetectReasoningCapability(plainOpenAI).has_traces, false);

  // Malformed inputs never throw.
  assert.equal(autoDetectReasoningCapability(null).has_traces, false);
  assert.equal(autoDetectReasoningCapability(undefined).has_traces, false);
  assert.equal(autoDetectReasoningCapability('not an object').has_traces, false);
  assert.equal(autoDetectReasoningCapability({}).has_traces, false);
  assert.equal(autoDetectReasoningCapability(123).has_traces, false);
  assert.equal(autoDetectReasoningCapability([]).has_traces, false);

  // The has_traces:false shape must NOT include format/provider (caller
  // branches on has_traces first).
  const noTrace = autoDetectReasoningCapability(plainOpenAI);
  assert.equal(noTrace.format, undefined);
  assert.equal(noTrace.provider, undefined);
});

// ============================================================================
// 6) trace_aware_loss function defined in apps/trainer/distill.py
// ============================================================================
test('W828 #6 — trace_aware_loss is defined in apps/trainer/distill.py', () => {
  const distillPath = path.join(process.cwd(), 'apps', 'trainer', 'distill.py');
  const text = fs.readFileSync(distillPath, 'utf8');
  // Function signature is what callers depend on; assert the exact name + arg order.
  assert.ok(
    /def\s+trace_aware_loss\s*\(\s*logits\s*,\s*target_ids\s*,\s*trace_mask\s*,\s*attention_mask\s*,\s*w\s*=\s*0\.5\s*\)/.test(text),
    'def trace_aware_loss(logits, target_ids, trace_mask, attention_mask, w=0.5) must exist'
  );
  // Exported in __all__ so a worker harness can import it directly.
  assert.ok(text.includes('"trace_aware_loss"'),
    'trace_aware_loss must be in __all__ for direct import');
  // The W828 version stamp must exist.
  assert.ok(text.includes('REASONING_TRACE_LOSS_VERSION = "w828-v1"'),
    'REASONING_TRACE_LOSS_VERSION = "w828-v1" must be present');
});

// ============================================================================
// 7) Weighted-sum formula present (answer_loss + trace_loss + w *)
// ============================================================================
test('W828 #7 — weighted-sum formula (1-w)*answer_loss + w*trace_loss in distill.py', () => {
  const distillPath = path.join(process.cwd(), 'apps', 'trainer', 'distill.py');
  const text = fs.readFileSync(distillPath, 'utf8');
  // Verify the three core tokens of the trace-aware loss formula appear.
  assert.ok(text.includes('answer_loss'),
    'answer_loss identifier must appear in trace_aware_loss');
  assert.ok(text.includes('trace_loss'),
    'trace_loss identifier must appear in trace_aware_loss');
  // The literal weighted-sum expression. We accept either "w *" or "* w"
  // (Python allows both, formatter may move it) but assert at least one
  // form is present so the math itself isn't silently lost.
  assert.ok(
    /\(1\.0?\s*-\s*w\)\s*\*\s*answer_loss/.test(text)
      || /\(1\s*-\s*w\)\s*\*\s*answer_loss/.test(text),
    'must contain (1-w) * answer_loss term'
  );
  assert.ok(
    /w\s*\*\s*trace_loss/.test(text),
    'must contain w * trace_loss term'
  );
  // Defense-in-depth: the clamp-to-1 denominators that prevent divide-by-zero.
  assert.ok(text.includes('answer_mask.sum().clamp(min=1)')
    || text.includes('clamp(min=1)'),
    'denominator clamp(min=1) must be present to dodge divide-by-zero');
});

// ============================================================================
// 8) CLI flag --reasoning-trace-loss-weight parses in cli/kolm.js
// ============================================================================
test('W828 #8 — cli/kolm.js parses --reasoning-trace-loss-weight flag', () => {
  const cliPath = path.join(process.cwd(), 'cli', 'kolm.js');
  const cliText = fs.readFileSync(cliPath, 'utf8');
  assert.ok(cliText.includes("'--reasoning-trace-loss-weight'"),
    '--reasoning-trace-loss-weight flag literal must be parsed in cli/kolm.js');
  // The flag clamps to [0,1] so out-of-range values can't slip through.
  assert.ok(
    /Math\.max\s*\(\s*0\s*,\s*Math\.min\s*\(\s*1\s*,/.test(cliText),
    'flag value must be clamped to [0,1] via Math.max(0, Math.min(1, ...))'
  );
  // The body field that the server stamps into run-meta.
  assert.ok(cliText.includes('reasoning_trace_loss_weight'),
    'reasoning_trace_loss_weight field must be echoed into the POST body');
});

// ============================================================================
// 9) Env KOLM_REASONING_TRACE_LOSS_WEIGHT plumbed
// ============================================================================
test('W828 #9 — KOLM_REASONING_TRACE_LOSS_WEIGHT env plumbed in CLI + trainer', () => {
  // CLI side: process.env.KOLM_REASONING_TRACE_LOSS_WEIGHT is set when the
  // flag is passed >0.
  const cliPath = path.join(process.cwd(), 'cli', 'kolm.js');
  const cliText = fs.readFileSync(cliPath, 'utf8');
  assert.ok(cliText.includes('KOLM_REASONING_TRACE_LOSS_WEIGHT'),
    'CLI must plumb KOLM_REASONING_TRACE_LOSS_WEIGHT env to the worker');

  // Trainer side: distill.py argparser reads the env when the flag is omitted.
  const distillPath = path.join(process.cwd(), 'apps', 'trainer', 'distill.py');
  const distillText = fs.readFileSync(distillPath, 'utf8');
  assert.ok(distillText.includes('KOLM_REASONING_TRACE_LOSS_WEIGHT'),
    'distill.py must read KOLM_REASONING_TRACE_LOSS_WEIGHT env fallback');
  // The argparser line itself must reference the dest field.
  assert.ok(distillText.includes('--reasoning-trace-loss-weight'),
    'distill.py must register the --reasoning-trace-loss-weight argparse flag');
  assert.ok(distillText.includes('reasoning_trace_loss_weight'),
    'distill.py must thread reasoning_trace_loss_weight into distill_trainer()');
});

// ============================================================================
// 10) Bench scaffold exits cleanly with BENCH_STUB message when no --data
// ============================================================================
test('W828 #10 — bench_trace_aware.py prints BENCH_STUB_REQUIRES_REAL_DATA without --data', () => {
  const benchPath = path.join(process.cwd(), 'apps', 'trainer', 'bench_trace_aware.py');
  assert.ok(fs.existsSync(benchPath), 'apps/trainer/bench_trace_aware.py must exist');
  const benchText = fs.readFileSync(benchPath, 'utf8');
  // Source-level lock-ins (no Python interpreter required).
  assert.ok(benchText.includes('BENCH_STUB_REQUIRES_REAL_DATA'),
    'bench script must emit BENCH_STUB_REQUIRES_REAL_DATA when --data omitted');
  assert.ok(benchText.includes('answer_only_kscore'),
    'bench script must surface answer_only_kscore metric');
  assert.ok(benchText.includes('trace_aware_kscore'),
    'bench script must surface trace_aware_kscore metric');
  // Ship threshold per W828-5 must be > 2%.
  assert.ok(
    /DEFAULT_SHIP_THRESHOLD\s*=\s*0\.02/.test(benchText),
    'ship threshold must be 0.02 per W828-5 (2% K-Score delta)'
  );
  assert.ok(benchText.includes('ship_decision'),
    'bench script must emit ship_decision (SHIP|NO_SHIP)');

  // Best-effort runtime check: if python is on PATH, run the script with no
  // --data and verify it exits 0 + emits the banner. Skipped silently if
  // python is unavailable (CI sandboxes without python should not fail).
  const pyCandidates = ['python3', 'python', 'py'];
  let pyExe = null;
  for (const candidate of pyCandidates) {
    try {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (probe.status === 0 || (probe.stdout || probe.stderr || '').includes('Python')) {
        pyExe = candidate;
        break;
      }
    } catch (_) { // deliberate: cleanup
      // try next candidate
    }
  }
  if (pyExe) {
    const result = spawnSync(pyExe, [benchPath], { encoding: 'utf8', shell: true });
    // Exit code 0 by contract (stub or real, never errors on missing data).
    assert.equal(result.status, 0,
      `bench_trace_aware.py must exit 0 in stub mode (got ${result.status}, stderr=${result.stderr})`);
    const out = (result.stdout || '') + (result.stderr || '');
    assert.ok(out.includes('BENCH_STUB_REQUIRES_REAL_DATA'),
      `bench output must include BENCH_STUB_REQUIRES_REAL_DATA banner, got: ${out.slice(0, 400)}`);
  }
});

// ============================================================================
// 11) W828 marked SHIPPED in the plan
// ============================================================================
test('W828 #11 — KOLM_W707_SYSTEM_UPGRADE_PLAN.md marks W828 SHIPPED', () => {
  const planPath = path.join(process.cwd(), 'KOLM_W707_SYSTEM_UPGRADE_PLAN.md');
  const planText = fs.readFileSync(planPath, 'utf8');
  // Must mark the wave SHIPPED at the heading level so the plan reader
  // sees status without scrolling sub-bullets.
  assert.ok(
    /^### W828.*SHIPPED/m.test(planText),
    'W828 heading in plan must include SHIPPED status'
  );
  // Each sub-bullet (W828-1, -3, -4, -5) must individually carry **SHIPPED**.
  // W828-2 is shipped via W713-2/-3 and stays struck through.
  assert.ok(planText.includes('[W828-1]') && /\[W828-1\][\s\S]*?\*\*SHIPPED\*\*/.test(planText),
    'W828-1 must be marked SHIPPED');
  assert.ok(/\[W828-3\][\s\S]*?\*\*SHIPPED\*\*/.test(planText),
    'W828-3 must be marked SHIPPED');
  assert.ok(/\[W828-4\][\s\S]*?\*\*SHIPPED\*\*/.test(planText),
    'W828-4 must be marked SHIPPED');
  assert.ok(/\[W828-5\][\s\S]*?\*\*SHIPPED\*\*/.test(planText),
    'W828-5 must be marked SHIPPED');
});

// ============================================================================
// 12) sw.js bumped with wave828-reasoning-v2 suffix
// ============================================================================
test('W828 #12 — public/sw.js bumped with wave828-reasoning-v2 suffix', () => {
  const swPath = path.join(process.cwd(), 'public', 'sw.js');
  const swText = fs.readFileSync(swPath, 'utf8');
  assert.ok(swText.includes('wave828-reasoning-v2'),
    'public/sw.js CACHE name must include the wave828-reasoning-v2 suffix');
  // Wave-token threshold lock-in (regex-based, future-compat): any
  // wave(NNN) token >= 828 satisfies the family-token contract.
  const tokens = swText.match(/wave(\d{3,4})/g) || [];
  const maxWave = tokens
    .map(t => parseInt(t.slice(4), 10))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0);
  assert.ok(maxWave >= 828,
    `public/sw.js must carry a wave token >= 828 (got max=${maxWave})`);
});
