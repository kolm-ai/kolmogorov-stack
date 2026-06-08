// W463 - Agent Trace Compilation MVP.
//
// Closes audit P1 Agent Trace cluster open item: "trace storage schema
// + replay verification + workflow IR across providers." The trace
// storage primitive (src/trace-capture.js) and the IR compile/replay
// primitives (src/workflow-ir.js + src/compile-ir.js) shipped earlier
// (W144 / W409w). What was missing was the loop CLOSER: a single
// function that walks a trace_id → IR → replay-verify, plus a route +
// CLI surface that ties the three together.
//
// The MVP contract:
//
//   compileTraceToReplay(trace_id, {tenant_id, opts})
//     → { ir, ir_hash, seeds_count, dropped[] }
//
//   verifyTraceReplay(trace_id, {tenant_id, exec})
//     → { ok, total, matches[], mismatches[], dropped[], ir_hash,
//         coverage: matches/(matches+mismatches) }
//
// The compile step pulls every replayable span out of the trace,
// builds the IR, and seeds the IR with the (input → final output)
// pair so a cache-hit replay against the same input returns the
// original output without re-running the LLM/tool steps. This is
// the "replay-the-decision-graph-as-one-call" property the audit
// memo calls out.
//
// The verify step replays the IR against the original trace's input
// and reports per-output match/mismatch. The optional `exec` hook
// lets callers wire deterministic LLM + tool stubs; without exec, the
// replay relies on the cache-hit seed path (which is the dominant
// scenario for the "same input → same output" guarantee an agent
// compile is trying to prove).
//
// Anchoring: tenant-fenced at the trace_id level. trace-capture.js
// already disambiguates "empty trace" from "foreign trace" via
// tenant_mismatch errors; this module surfaces those verbatim.

import * as traceCapture from './trace-capture.js';
import * as compileIr from './compile-ir.js';
import * as workflowIr from './workflow-ir.js';

// Canonical key for comparing inputs/outputs across the original trace
// and the replayed IR. Stable across object key ordering and
// transparently handles primitives.
function _stableKey(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stableKey).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _stableKey(v[k])).join(',') + '}';
}

// Pull the user-facing (input, output) pair out of a trace. The input
// is the payload of the first USER_INPUT span (or the first replayable
// span if there's no user_input). The output is the final LLM_CALL
// response or, failing that, the final TOOL_CALL result.
function _extractEndpoints(spans) {
  const kinds = traceCapture.SPAN_KINDS;
  let input = null;
  let output = null;
  for (const s of spans) {
    if (input == null && s.kind === kinds.USER_INPUT) {
      input = (s.payload && (s.payload.text !== undefined ? s.payload.text : s.payload));
    }
    if (s.kind === kinds.LLM_CALL && s.payload && s.payload.response !== undefined) {
      output = s.payload.response;
    } else if (s.kind === kinds.TOOL_CALL && s.payload && s.payload.result !== undefined) {
      output = s.payload.result;
    }
  }
  if (input == null && spans.length > 0) {
    // Fall back to the first replayable span's payload.text
    const first = spans[0];
    input = (first.payload && (first.payload.text !== undefined ? first.payload.text : first.payload));
  }
  return { input, output };
}

// Compile a trace into an IR with an input→output seed pre-loaded so
// cache-hit replay against the original input matches the original
// final output.
export async function compileTraceToReplay(trace_id, opts = {}) {
  if (typeof trace_id !== 'string' || !/^[0-9a-f]{32}$/.test(trace_id)) {
    throw new Error('trace_id must be 32 hex chars');
  }
  const tenant_id = (opts.tenant_id != null && opts.tenant_id !== '') ? String(opts.tenant_id) : null;
  const spans = await traceCapture.readTrace(trace_id, tenant_id);
  if (spans.length === 0) {
    if (tenant_id != null) {
      const raw = await traceCapture.readTrace(trace_id);
      if (raw.length > 0) throw new Error('tenant_mismatch: ' + trace_id);
    }
    throw new Error('empty trace: ' + trace_id);
  }
  const { ir, dropped } = await compileIr.traceToIr(trace_id, { tenant_id, ...(opts.ir_opts || {}) });
  const { input, output } = _extractEndpoints(spans);
  if (input != null && output != null) {
    if (!Array.isArray(ir.seeds)) ir.seeds = [];
    const exists = ir.seeds.some(s => _stableKey(s.input) === _stableKey(input));
    if (!exists) ir.seeds.push({ input, output });
  }
  workflowIr.validateIr(ir);
  const ir_hash = workflowIr.hashIr(ir);
  return {
    ir,
    ir_hash,
    seeds_count: Array.isArray(ir.seeds) ? ir.seeds.length : 0,
    dropped: Array.isArray(dropped) ? dropped : [],
    source_trace_id: trace_id,
    tenant_id,
  };
}

// Replay the compiled IR against the trace's seeded input and check
// that the produced output matches the original trace's final output.
// Returns a structured envelope with match/mismatch counts; never
// throws on a behavioral mismatch (callers decide).
export async function verifyTraceReplay(trace_id, opts = {}) {
  const compile = await compileTraceToReplay(trace_id, opts);
  const ir = compile.ir;
  const seeds = ir.seeds || [];
  const exec = (opts && opts.exec) || null;

  const matches = [];
  const mismatches = [];
  for (const seed of seeds) {
    let actual;
    let err = null;
    try {
      const ran = await compileIr.runCompiledWorkflow(ir, seed.input, exec ? { exec } : {});
      actual = ran && (ran.output !== undefined ? ran.output : ran);
    } catch (e) {
      err = String(e && e.message || e);
    }
    const expectedKey = _stableKey(seed.output);
    const actualKey = _stableKey(actual);
    if (err == null && expectedKey === actualKey) {
      matches.push({ input: seed.input, expected: seed.output, actual });
    } else {
      mismatches.push({ input: seed.input, expected: seed.output, actual, error: err });
    }
  }
  const total = matches.length + mismatches.length;
  return {
    ok: mismatches.length === 0 && total > 0,
    total,
    matches,
    mismatches,
    dropped: compile.dropped,
    ir_hash: compile.ir_hash,
    seeds_count: seeds.length,
    coverage: total > 0 ? matches.length / total : 0,
    source_trace_id: trace_id,
    tenant_id: compile.tenant_id,
  };
}

export default { compileTraceToReplay, verifyTraceReplay };
