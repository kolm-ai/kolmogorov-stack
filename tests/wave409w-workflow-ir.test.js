// Wave 409w — agent/workflow trace compilation: IR + generalization.
//
// The trust bug from the auditor's W409 audit was that src/compile-ir.js
// kept the literal prompt from the captured trace and called parameter
// extraction "future work". A workflow_capsule built that way can only
// replay the EXACT input that produced the trace — feed it a new value
// and the captured cache misses and the literal prompt fires verbatim.
// That is replay, not workflow compression.
//
// W409w wires:
//   - compileWorkflowFromTraces(traces, opts) — walks N traces of the
//     same workflow, hoists positions that differ as {{var_N}} template
//     variables, classifies each step as deterministic | llm_required
//     | human_required | tool_call, and returns an IR.
//   - runCompiledWorkflow(ir, input, opts) — executes the IR against
//     NEW inputs. Cached inputs short-circuit to the captured output
//     (replay). New inputs walk the IR: deterministic steps run without
//     an LLM; llm_required steps fire opts.exec.llm with the templated
//     prompt; tool_call steps fire opts.exec.tool; human_required steps
//     fire opts.exec.human or throw.
//
// Tests assert BEHAVIOR (no copy assertions about page text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWorkflowFromTraces,
  runCompiledWorkflow,
  STEP_KINDS,
} from '../src/compile-ir.js';

// ---------- helpers ----------

// Build a synthetic trace span array directly (skips trace-capture file I/O
// so the test does not touch ~/.kolm/traces). Each span looks exactly like
// what trace-capture.readTrace would return.
let __seq = 0;
function mkSpan(kind, payload, parent_span_id = null) {
  __seq += 1;
  const span_id = String(__seq).padStart(16, '0');
  return {
    spec: 'trace-v1',
    seq: __seq,
    kind,
    trace_id: 'a'.repeat(32),
    span_id,
    parent_span_id,
    started_at: new Date().toISOString(),
    payload,
  };
}

function summarizeLogTrace(filePath, summary, parentChain = null) {
  __seq = 0;
  const inputSpan = mkSpan('user_input', { role: 'user', text: filePath, channel: 'cli' }, null);
  const toolSpan = mkSpan('tool_call', {
    tool_name: 'read_file',
    args: { path: filePath },
    result: `<contents of ${filePath}>`,
  }, inputSpan.span_id);
  const llmSpan = mkSpan('llm_call', {
    vendor: 'anthropic',
    model: 'claude-haiku-4-5',
    prompt: `Summarize the following log file: ${filePath}\n\nContents:\n<contents of ${filePath}>`,
    response: summary,
    tokens_in: 100, tokens_out: 30, cost_usd: 0.001,
  }, toolSpan.span_id);
  return [inputSpan, toolSpan, llmSpan];
}

function fetchUserTrace(userId, userRecord) {
  __seq = 0;
  const inputSpan = mkSpan('user_input', { role: 'user', text: userId, channel: 'cli' }, null);
  const toolSpan = mkSpan('tool_call', {
    tool_name: 'db_lookup',
    args: { table: 'users', id: userId },
    result: userRecord,
  }, inputSpan.span_id);
  return [inputSpan, toolSpan];
}

// ---------- TASK 1 — 10 traces of "summarize log file <X>" ----------

test('W409w #1 — 10 summarize-log traces compile to ONE llm_required step with {{var_N}} param', async () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    const path = `/var/log/app-${i}.log`;
    traces.push(summarizeLogTrace(path, `Summary of ${path}: 3 errors`));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  assert.equal(ir.spec, 'wir-v1');
  assert.ok(Array.isArray(ir.nodes));
  // Exactly one LLM node (the summarize step).
  const llmNodes = ir.nodes.filter((n) => n.kind === 'llm');
  assert.equal(llmNodes.length, 1, `expected 1 llm node, got ${llmNodes.length}`);
  const llm = llmNodes[0];
  assert.equal(llm.step_kind, STEP_KINDS.LLM_REQUIRED,
    `summarize step must be llm_required (got ${llm.step_kind})`);
  // The prompt template must contain a {{var_N}} placeholder where the file
  // path used to be. The literal /var/log/app-0.log must NOT survive.
  assert.ok(/\{\{var_\d+\}\}/.test(llm.prompt_template),
    `prompt_template must carry {{var_N}} placeholder; got: ${llm.prompt_template}`);
  assert.ok(!llm.prompt_template.includes('/var/log/app-0.log'),
    `prompt_template must not contain the literal first-trace path; got: ${llm.prompt_template}`);
  // parameters block enumerates the hoisted variables.
  assert.ok(Array.isArray(ir.parameters), 'ir.parameters must be an array');
  assert.ok(ir.parameters.length >= 1, `expected >= 1 parameter, got ${ir.parameters.length}`);
});

// ---------- TASK 1 — 10 fetch-user traces, deterministic over an in-memory DB ----------

test('W409w #2 — 10 fetch-user traces compile a deterministic step (no LLM)', async () => {
  const db = new Map([
    ['u1', { name: 'Ada' }],
    ['u2', { name: 'Bob' }],
    ['u3', { name: 'Cleo' }],
    ['u4', { name: 'Dan' }],
    ['u5', { name: 'Eve' }],
    ['u6', { name: 'Frank' }],
    ['u7', { name: 'Gina' }],
    ['u8', { name: 'Hugo' }],
    ['u9', { name: 'Ivy' }],
    ['u10', { name: 'Jay' }],
  ]);
  const traces = [];
  for (const [id, rec] of db.entries()) {
    traces.push(fetchUserTrace(id, rec));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  const toolNodes = ir.nodes.filter((n) => n.kind === 'tool');
  assert.equal(toolNodes.length, 1);
  const tool = toolNodes[0];
  // Pure function across all traces (id -> record): deterministic.
  assert.equal(tool.step_kind, STEP_KINDS.DETERMINISTIC,
    `fetch-user tool must be deterministic across traces (got ${tool.step_kind})`);
  // The tool node must carry a lookup_table built from the captured pairs so a
  // new input the IR has not seen can still resolve without an LLM.
  assert.ok(tool.lookup_table && typeof tool.lookup_table === 'object',
    'deterministic tool must carry a lookup_table mapping input -> output');
  assert.equal(tool.lookup_table.u3.name, 'Cleo');
});

// ---------- TASK 1 — replay regression: cached input still works ----------

test('W409w #3 — replay: cached input returns the cached output byte-for-byte', async () => {
  const traces = [];
  for (let i = 0; i < 5; i++) {
    const p = `/var/log/app-${i}.log`;
    traces.push(summarizeLogTrace(p, `Summary of ${p}`));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  // Replay the very first cached input.
  const { output, cache_hit } = await runCompiledWorkflow(ir, '/var/log/app-0.log', {
    exec: {
      llm: async () => { throw new Error('replay must not call llm'); },
      tool: async () => { throw new Error('replay must not call tool'); },
    },
  });
  assert.equal(cache_hit, true, 'cached input must short-circuit to seed');
  assert.equal(output, 'Summary of /var/log/app-0.log');
});

// ---------- TASK 1 — generalization: NEW input the IR has not seen ----------

test('W409w #4 — generalization: new input fires the llm_required step with the templated prompt', async () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    const p = `/var/log/app-${i}.log`;
    traces.push(summarizeLogTrace(p, `Summary of ${p}`));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  const newInput = '/var/log/NEW-FILE-NOT-SEEN.log';
  let promptSeen = null;
  let toolCalled = 0;
  const { output, cache_hit } = await runCompiledWorkflow(ir, newInput, {
    exec: {
      llm: async (_node, prompt) => {
        promptSeen = prompt;
        return `Summary of ${newInput}`;
      },
      tool: async (_node, args) => {
        toolCalled += 1;
        return `<contents of ${args.path}>`;
      },
    },
  });
  assert.equal(cache_hit, false, 'new input must not hit cache');
  assert.equal(output, `Summary of ${newInput}`);
  // The templated prompt must have been substituted with the new input.
  assert.ok(promptSeen, 'llm executor must have been called');
  assert.ok(promptSeen.includes(newInput),
    `prompt must contain the NEW input, got: ${promptSeen}`);
  assert.ok(!promptSeen.includes('{{var_'),
    `prompt must not contain unresolved {{var_N}} placeholders, got: ${promptSeen}`);
  assert.equal(toolCalled, 1, 'tool node should fire exactly once for a new input');
});

// ---------- TASK 1 — deterministic step does NOT call the LLM on new inputs in the table ----------

test('W409w #5 — deterministic step with cached lookup avoids the LLM', async () => {
  const traces = [];
  const db = [
    ['k1', { v: 1 }], ['k2', { v: 2 }], ['k3', { v: 3 }],
    ['k4', { v: 4 }], ['k5', { v: 5 }], ['k6', { v: 6 }],
    ['k7', { v: 7 }], ['k8', { v: 8 }], ['k9', { v: 9 }],
    ['k10', { v: 10 }],
  ];
  for (const [id, rec] of db) traces.push(fetchUserTrace(id, rec));
  const { ir } = compileWorkflowFromTraces(traces);
  let llmCalls = 0;
  // Replay k5 — should hit cache.
  const r1 = await runCompiledWorkflow(ir, 'k5', {
    exec: { llm: async () => { llmCalls += 1; return 'unused'; } },
  });
  assert.deepEqual(r1.output, { v: 5 });
  assert.equal(llmCalls, 0, 'cached deterministic step must not call llm');
});

// ---------- TASK 1 — deterministic step on UNKNOWN input falls back to tool executor ----------

test('W409w #6 — deterministic step on unknown input fires tool executor (not LLM)', async () => {
  const traces = [];
  for (let i = 0; i < 5; i++) {
    traces.push(fetchUserTrace(`u${i}`, { name: `name-${i}` }));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  let llmCalls = 0;
  let toolCalls = 0;
  const r = await runCompiledWorkflow(ir, 'u99', {
    exec: {
      llm:  async () => { llmCalls += 1; return 'should not fire'; },
      tool: async (_n, args) => {
        toolCalls += 1;
        assert.equal(args.id, 'u99', 'tool should receive the new input id');
        return { name: 'live-name-u99' };
      },
    },
  });
  assert.equal(llmCalls, 0, 'deterministic step must never call llm on unknown input');
  assert.equal(toolCalls, 1, 'tool executor must fire exactly once when lookup_table misses');
  assert.deepEqual(r.output, { name: 'live-name-u99' });
});

// ---------- TASK 1 — human_required marker survives compile ----------

test('W409w #7 — human_required step is detected when payload carries approval flag', async () => {
  __seq = 0;
  const traces = [];
  for (let i = 0; i < 3; i++) {
    __seq = 0;
    const inSp = mkSpan('user_input', { role: 'user', text: `request-${i}`, channel: 'cli' }, null);
    const apprSp = mkSpan('tool_call', {
      tool_name: 'human_approval',
      args: { request: `request-${i}` },
      result: 'approved',
      requires_human: true,
    }, inSp.span_id);
    void apprSp;
    traces.push([inSp, apprSp]);
  }
  const { ir } = compileWorkflowFromTraces(traces);
  const human = ir.nodes.find((n) => n.step_kind === STEP_KINDS.HUMAN_REQUIRED);
  assert.ok(human, `expected a human_required step in the IR, got: ${JSON.stringify(ir.nodes.map(n=>({id:n.id,k:n.kind,s:n.step_kind})))}`);
  assert.equal(human.tool_name, 'human_approval');
});

// ---------- TASK 1 — STEP_KINDS contract ----------

test('W409w #8 — STEP_KINDS exports the four documented kinds', () => {
  assert.equal(STEP_KINDS.DETERMINISTIC, 'deterministic');
  assert.equal(STEP_KINDS.LLM_REQUIRED, 'llm_required');
  assert.equal(STEP_KINDS.HUMAN_REQUIRED, 'human_required');
  assert.equal(STEP_KINDS.TOOL_CALL, 'tool_call');
});

// ---------- TASK 1 — IR carries seeds (replay cache) AND parameters (generalization) ----------

test('W409w #9 — IR exposes both seeds[] and parameters[] for the runtime', () => {
  const traces = [];
  for (let i = 0; i < 4; i++) {
    const p = `/p/${i}.log`;
    traces.push(summarizeLogTrace(p, `s${i}`));
  }
  const { ir } = compileWorkflowFromTraces(traces);
  assert.ok(Array.isArray(ir.seeds));
  assert.equal(ir.seeds.length, 4, 'all 4 captured input/output pairs must become seeds');
  assert.ok(Array.isArray(ir.parameters));
  for (const p of ir.parameters) {
    assert.ok(p.name, 'each parameter must have a name');
    assert.ok(p.bound_to_input === true || p.source === 'input',
      `each parameter must bind to the workflow input (got: ${JSON.stringify(p)})`);
  }
});

// ---------- TASK 1 — fail loud on divergent shape (existing W144 contract) ----------

test('W409w #10 — compileWorkflowFromTraces throws on divergent trace shapes', () => {
  const a = summarizeLogTrace('/a.log', 's');
  const b = fetchUserTrace('u1', { name: 'Ada' });
  assert.throws(() => compileWorkflowFromTraces([a, b]),
    /divergent|shape|mismatch/i,
    'mixed-shape traces must throw a divergence error');
});
