// Trace → IR compile pass.
//
// Reads a structured trace from src/trace-capture.js and emits a workflow IR
// (src/workflow-ir.js) that can be embedded inside a workflow_capsule .kolm
// artifact. The IR is the deterministic, replayable skeleton; the seeds list
// inside it is the captured (input → output) pairs that let the runtime
// short-circuit known traffic without calling the executors at all.
//
// Honest scope:
//
//   IS:
//     - traceToIr(trace_id, opts) — read the trace via trace-capture.readTrace,
//       filter to replayable spans (LLM, TOOL, BRANCH, ARTIFACT, USER_INPUT),
//       emit nodes + edges + seeds, return the IR
//     - tracesToIr(trace_ids, opts) — multi-trace fold: merges multiple runs
//       of the same workflow into one IR by accumulating seeds for repeated
//       input shapes; nodes/edges must match across traces or compile fails
//     - per-trace fingerprinting so duplicate-shape traces collapse
//
//   IS NOT:
//     - A static-analysis tool that infers branches not actually taken in any
//       trace. The IR's coverage is exactly the coverage of the input traces.
//       This is intentional: kolm artifacts ship with explicit coverage, not
//       guessed coverage.
//     - A runtime. compile-ir.js produces the IR; workflow-ir.js executes it.
//     - A redactor. If the trace carries PHI, call traceCapture.redactForExport
//       BEFORE handing it to this pass.

import * as traceCapture from './trace-capture.js';
import { WORKFLOW_IR_VERSION, NODE_KINDS, hashIr, validateIr, interpret as interpretIr } from './workflow-ir.js';

// W409w — step-kind classification surfaced on every replayable IR node.
// Existing NODE_KINDS describes the wire shape (llm / tool / branch / ...);
// STEP_KINDS layers a semantic on top so a runtime can decide whether to
// invoke an LLM, execute a deterministic table lookup, or hand off to a
// human reviewer. The classification is stamped during compile by walking
// N traces of the same workflow shape — see _classifyStep.
export const STEP_KINDS = Object.freeze({
  DETERMINISTIC:  'deterministic',   // output is a pure function of input across all traces
  LLM_REQUIRED:   'llm_required',    // output varies for same input, or is natural language
  HUMAN_REQUIRED: 'human_required',  // span payload declares requires_human:true
  TOOL_CALL:      'tool_call',       // tool call that is not yet provably deterministic
});

// Span kinds from trace-capture that become IR nodes. IO and STATE spans are
// skipped: they are runtime side-effects, not replayable program steps.
const REPLAYABLE = new Set([
  traceCapture.SPAN_KINDS.USER_INPUT,
  traceCapture.SPAN_KINDS.LLM_CALL,
  traceCapture.SPAN_KINDS.TOOL_CALL,
  traceCapture.SPAN_KINDS.BRANCH,
  traceCapture.SPAN_KINDS.ARTIFACT,
]);

function _spanToNode(span, spanIdToNodeId) {
  const id = spanIdToNodeId.get(span.span_id);
  switch (span.kind) {
    case traceCapture.SPAN_KINDS.USER_INPUT:
      // The first user_input becomes the INPUT node; later ones become
      // CONST nodes carrying the captured text (rare but legal).
      return { id, kind: NODE_KINDS.INPUT, source_span_id: span.span_id };
    case traceCapture.SPAN_KINDS.LLM_CALL:
      return {
        id,
        kind: NODE_KINDS.LLM,
        vendor: span.payload.vendor,
        model: span.payload.model,
        // Prompt is captured verbatim; the compile pass does not template-ify.
        // Future pass: parameter extraction — replace literal substrings with
        // ${input} placeholders when they match the user input.
        prompt_template: span.payload.prompt,
        // Captured response — used as the seed-cache fallback for this node.
        captured_response: span.payload.response,
        tokens_in: span.payload.tokens_in,
        tokens_out: span.payload.tokens_out,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.TOOL_CALL:
      return {
        id,
        kind: NODE_KINDS.TOOL,
        tool_name: span.payload.tool_name,
        args_template: span.payload.args,
        captured_result: span.payload.result,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.BRANCH:
      return {
        id,
        kind: NODE_KINDS.BRANCH,
        condition: span.payload.value,
        // then_ref / else_ref filled in by the second pass after node ids
        // are minted, since we need to know which sibling-of-parent the
        // taken edge actually corresponded to.
        captured_taken: span.payload.taken_edge,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.ARTIFACT:
      return {
        id,
        kind: NODE_KINDS.ARTIFACT,
        artifact_hash: span.payload.artifact_hash,
        recipe_id: span.payload.recipe_id,
        input_template: span.payload.input,
        captured_output: span.payload.output,
        source_span_id: span.span_id,
      };
    default:
      throw new Error(`non-replayable span kind reached _spanToNode: ${span.kind}`);
  }
}

// Compile one trace into an IR. Returns {ir, dropped: [...]} where dropped
// lists the span ids skipped (IO/STATE) so the compile pass is auditable.
//
// W425 — tenant ownership: when `opts.tenant_id` is supplied, the trace is
// only loaded for matching tenants; foreign-tenant compiles fail loud with
// a `tenant_mismatch` error so an attacker cannot pull another tenant's
// workflow shape via /v1/ir/compile. The resulting IR is stamped with the
// same `tenant_id` so downstream artifact builders carry the fence.
export async function traceToIr(trace_id, opts = {}) {
  const tenant_id = (opts && opts.tenant_id != null && opts.tenant_id !== '')
    ? String(opts.tenant_id) : null;
  const spans = await traceCapture.readTrace(trace_id, tenant_id);
  if (spans.length === 0) {
    if (tenant_id != null) {
      // Disambiguate empty-vs-foreign so the caller learns the right thing.
      const raw = await traceCapture.readTrace(trace_id);
      if (raw.length > 0) throw new Error(`tenant_mismatch: ${trace_id}`);
    }
    throw new Error(`empty trace: ${trace_id}`);
  }
  const { ir, dropped } = spansToIr(spans, { ...opts, source_trace_id: trace_id });
  if (tenant_id != null) ir.tenant_id = tenant_id;
  return { ir, dropped };
}

// Compile a span list directly. Caller may pass an already-redacted span list.
// Exposed separately so the redactForExport pass can be inserted between
// readTrace and this function.
export function spansToIr(spans, opts = {}) {
  if (!Array.isArray(spans) || spans.length === 0) {
    throw new Error('spans must be a non-empty array');
  }

  // Filter to replayable spans. Record the dropped ones for audit.
  const replayable = [];
  const dropped = [];
  for (const s of spans) {
    if (REPLAYABLE.has(s.kind)) replayable.push(s);
    else dropped.push({ span_id: s.span_id, kind: s.kind, reason: 'non_replayable_kind' });
  }
  if (replayable.length === 0) {
    throw new Error('no replayable spans in trace; cannot compile to IR');
  }

  // Find the root (first user_input or earliest seq). It becomes the INPUT
  // node. The artifact's user-facing input is the payload of this span.
  const userInputs = replayable.filter(s => s.kind === traceCapture.SPAN_KINDS.USER_INPUT);
  const rootSpan = userInputs.length > 0 ? userInputs[0] : replayable[0];

  // Mint a node id per span. Use the span_id directly — short, unique, and
  // already in the trace's span_id space.
  const spanIdToNodeId = new Map();
  for (const s of replayable) spanIdToNodeId.set(s.span_id, 'n_' + s.span_id);

  // Build IR nodes. Skip non-root user_inputs (rare; treat as CONST).
  const nodes = [];
  for (const s of replayable) {
    if (s.kind === traceCapture.SPAN_KINDS.USER_INPUT && s.span_id !== rootSpan.span_id) {
      nodes.push({
        id: 'n_' + s.span_id,
        kind: NODE_KINDS.CONST,
        value: s.payload.text || s.payload,
        source_span_id: s.span_id,
      });
    } else {
      nodes.push(_spanToNode(s, spanIdToNodeId));
    }
  }

  // Build edges from parent_span_id relationships. The IR's edges encode
  // data dependency: a child's parent is upstream in topo order.
  const edges = [];
  const present = new Set(spanIdToNodeId.keys());
  for (const s of replayable) {
    if (s.parent_span_id && present.has(s.parent_span_id)) {
      edges.push({
        from: 'n_' + s.parent_span_id,
        to: 'n_' + s.span_id,
      });
    }
  }

  // Output node: a synthetic node whose value_template references the LAST
  // span's output. This is a reasonable default; the compile pass can be
  // re-run with an explicit output_span_id to point elsewhere.
  const lastSpan = opts.output_span_id
    ? replayable.find(s => s.span_id === opts.output_span_id)
    : replayable[replayable.length - 1];
  if (!lastSpan) throw new Error(`output_span_id not found in trace`);
  const outputNodeId = 'n_output';
  nodes.push({
    id: outputNodeId,
    kind: NODE_KINDS.OUTPUT,
    value_template: { ref: 'n_' + lastSpan.span_id },
  });
  edges.push({ from: 'n_' + lastSpan.span_id, to: outputNodeId });

  // The seed: this trace itself becomes a seed pair. interpret() with the
  // same input gets a cache hit and never touches an executor.
  const rootInput = rootSpan.kind === traceCapture.SPAN_KINDS.USER_INPUT
    ? (rootSpan.payload.text != null ? rootSpan.payload.text : rootSpan.payload)
    : rootSpan.payload;

  // Compute the captured output by walking the trace one last time.
  // Use whatever the OUTPUT node's value_template ref points to.
  const seedOutput = _capturedValue(lastSpan);

  const ir = {
    spec: WORKFLOW_IR_VERSION,
    source_trace_id: opts.source_trace_id || null,
    nodes,
    edges,
    seeds: [{ input: rootInput, output: seedOutput, source_trace_id: opts.source_trace_id || null }],
  };
  validateIr(ir);
  ir.hash = hashIr(ir);
  return { ir, dropped };
}

// Pull the "captured output" value out of any replayable span kind.
function _capturedValue(span) {
  switch (span.kind) {
    case traceCapture.SPAN_KINDS.LLM_CALL:    return span.payload.response;
    case traceCapture.SPAN_KINDS.TOOL_CALL:   return span.payload.result;
    case traceCapture.SPAN_KINDS.BRANCH:      return span.payload.value;
    case traceCapture.SPAN_KINDS.ARTIFACT:    return span.payload.output;
    case traceCapture.SPAN_KINDS.USER_INPUT:  return span.payload.text != null ? span.payload.text : span.payload;
    default: return null;
  }
}

// Canonicalize an IR by renaming nodes to position-stable ids. The renamer
// walks the IR in topological order and assigns each node an id of the form
// `c<i>` where `i` is the topo-order position. This makes two structurally
// identical IRs (different trace span ids, same workflow shape) compare equal
// at the fingerprint level and merge cleanly.
function _canonicalizeIr(ir) {
  // Recreate a topo order using only nodes + edges in this IR.
  const adj = {};
  const indeg = {};
  for (const n of ir.nodes) { adj[n.id] = []; indeg[n.id] = 0; }
  for (const e of ir.edges) { adj[e.from].push(e.to); indeg[e.to] += 1; }
  const queue = Object.keys(indeg).filter(id => indeg[id] === 0).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj[id]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) { queue.push(next); queue.sort(); }
    }
  }
  const rename = new Map();
  order.forEach((oldId, i) => rename.set(oldId, 'c' + i));
  const renameRef = (v) => {
    if (v && typeof v === 'object' && 'ref' in v && rename.has(v.ref)) {
      return { ...v, ref: rename.get(v.ref) };
    }
    if (Array.isArray(v)) return v.map(renameRef);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = renameRef(v[k]);
      return out;
    }
    return v;
  };
  const nodes = order.map(oldId => {
    const n = ir.nodes.find(x => x.id === oldId);
    const renamed = { ...n, id: rename.get(oldId) };
    // Rewrite known ref fields.
    if (renamed.value_template) renamed.value_template = renameRef(renamed.value_template);
    if (renamed.prompt_template) renamed.prompt_template = renameRef(renamed.prompt_template);
    if (renamed.args_template) renamed.args_template = renameRef(renamed.args_template);
    if (renamed.input_template) renamed.input_template = renameRef(renamed.input_template);
    if (renamed.then_ref && rename.has(renamed.then_ref)) renamed.then_ref = rename.get(renamed.then_ref);
    if (renamed.else_ref && rename.has(renamed.else_ref)) renamed.else_ref = rename.get(renamed.else_ref);
    return renamed;
  });
  const edges = ir.edges.map(e => ({ from: rename.get(e.from), to: rename.get(e.to) }));
  return { ...ir, nodes, edges };
}

// Multi-trace fold. Merges N traces of the same workflow into one IR. Each
// trace is first canonicalized (span ids → position-stable ids), then the
// shapes are compared. If shapes match, seeds are merged; otherwise we fail
// loud so the operator can decide to split into separate capsules or expand
// the IR coverage.
export async function tracesToIr(trace_ids, opts = {}) {
  if (!Array.isArray(trace_ids) || trace_ids.length === 0) {
    throw new Error('trace_ids must be a non-empty array');
  }
  // W425 — tenant ownership: pass opts.tenant_id through to traceToIr so
  // any cross-tenant trace_id in the list trips `tenant_mismatch` instead
  // of silently merging seeds from another tenant.
  const tenant_id = (opts && opts.tenant_id != null && opts.tenant_id !== '')
    ? String(opts.tenant_id) : null;
  const compiled = [];
  for (const tid of trace_ids) {
    const { ir, dropped } = await traceToIr(tid, opts);
    compiled.push({ ir: _canonicalizeIr(ir), dropped });
  }
  const canonical = compiled[0].ir;
  const canonicalShape = _shapeFingerprint(canonical);
  for (let i = 1; i < compiled.length; i++) {
    const shape = _shapeFingerprint(compiled[i].ir);
    if (shape !== canonicalShape) {
      throw new Error(`trace ${trace_ids[i]} has divergent shape from ${trace_ids[0]} — split into separate capsules or expand the IR coverage`);
    }
  }
  // Merge seeds. Drop duplicates by input key. Cross-trace duplicate inputs
  // with diverging outputs are a real bug worth surfacing — but we accept
  // the first seen and surface conflicts via the `conflicts` array so the
  // caller can decide whether to ship or split.
  const seen = new Map();
  const conflicts = [];
  for (const c of compiled) {
    for (const s of c.ir.seeds) {
      const key = JSON.stringify(s.input);
      if (seen.has(key)) {
        const prior = seen.get(key);
        if (JSON.stringify(prior.output) !== JSON.stringify(s.output)) {
          conflicts.push({ input: s.input, outputs: [prior.output, s.output] });
        }
        continue;
      }
      seen.set(key, s);
    }
  }
  const merged = { ...canonical, seeds: Array.from(seen.values()) };
  if (tenant_id != null) merged.tenant_id = tenant_id;
  validateIr(merged);
  merged.hash = hashIr(merged);
  const droppedAll = compiled.flatMap(c => c.dropped);
  return { ir: merged, dropped: droppedAll, merged_from: trace_ids, conflicts };
}

// Shape fingerprint of a CANONICALIZED IR. Two canonicalized IRs with the
// same topology produce the same fingerprint regardless of which underlying
// traces produced them.
function _shapeFingerprint(ir) {
  const kinds = ir.nodes.map(n => `${n.id}:${n.kind}`).sort().join('|');
  const edges = ir.edges.map(e => `${e.from}->${e.to}`).sort().join('|');
  return kinds + '##' + edges;
}

// =====================================================================
// W409w — Workflow compression: parameter extraction + step classification.
//
// Compile N traces of the same workflow shape directly from span arrays
// (no file I/O) and emit an IR whose LLM/TOOL nodes carry:
//   * step_kind            — STEP_KINDS.{DETERMINISTIC, LLM_REQUIRED,
//                            HUMAN_REQUIRED, TOOL_CALL}
//   * prompt_template      — literal substrings replaced with {{var_N}}
//                            placeholders where positions differ across
//                            traces with the same skeleton
//   * args_template        — same templating for tool args (string fields)
//   * lookup_table         — only for DETERMINISTIC tool nodes; maps the
//                            captured input -> captured output so the
//                            runtime can resolve without an executor
// And, at the IR level:
//   * parameters[]         — enumerates the hoisted {{var_N}} placeholders,
//                            each with `bound_to_input:true`/`source:'input'`
//                            so the runtime knows to substitute the user
//                            input when running against new values.
//
// The compile pass is the deliberate companion to the auditor finding that
// pre-W409w compile-ir.js shipped literal prompts and called parameter
// extraction "future work". Same module, no breaking change to the wire
// shape — new fields are additive, old callers ignore them.
// =====================================================================

// Public: compile N raw span arrays (each one a single trace) directly.
// Tests and the trace-driven CLI both call this — no ~/.kolm/traces I/O.
export function compileWorkflowFromTraces(traces, opts = {}) {
  if (!Array.isArray(traces) || traces.length === 0) {
    throw new Error('compileWorkflowFromTraces: traces must be a non-empty array');
  }
  // Compile each trace's spans through the existing spansToIr pass, then
  // canonicalize so structurally-identical workflows produce identical
  // node ids (existing W144 contract).
  const compiled = traces.map((spans, idx) => {
    if (!Array.isArray(spans) || spans.length === 0) {
      throw new Error(`compileWorkflowFromTraces: trace ${idx} has no spans`);
    }
    const { ir, dropped } = spansToIr(spans, { ...opts, source_trace_id: spans[0]?.trace_id || null });
    return { ir: _canonicalizeIr(ir), dropped, spans };
  });
  // All traces must share the same skeleton — refuse to merge divergent shapes.
  const canonShape = _shapeFingerprint(compiled[0].ir);
  for (let i = 1; i < compiled.length; i++) {
    if (_shapeFingerprint(compiled[i].ir) !== canonShape) {
      throw new Error(`compileWorkflowFromTraces: trace ${i} has divergent shape from trace 0 — split into separate workflows or capture more samples`);
    }
  }
  // Walk the per-trace IRs in lockstep node-by-node. For each non-INPUT,
  // non-OUTPUT, non-CONST node we hoist the differing positions in the
  // prompt/args strings as {{var_N}} placeholders and classify the step.
  const base = compiled[0].ir;
  const parameters = []; // { name, source, bound_to_input, examples }
  const nodes = [];
  let __paramCounter = 0;
  function newParamName() { return `var_${__paramCounter++}`; }

  // The user-facing input is the value bound to the INPUT node for each
  // trace. We capture them once here so per-node templating can look up
  // whether a substring matches the input verbatim (which is how we know
  // "this position takes the workflow input").
  const inputsPerTrace = compiled.map((c) => {
    const inputNode = c.ir.nodes.find((n) => n.kind === NODE_KINDS.INPUT);
    if (!inputNode) return null;
    const root = c.spans.find((s) => s.span_id === inputNode.source_span_id);
    if (!root) return null;
    return root.payload?.text != null ? root.payload.text : root.payload;
  });

  for (const baseNode of base.nodes) {
    // Pass-through for structural nodes that have no templating surface.
    if (baseNode.kind === NODE_KINDS.INPUT || baseNode.kind === NODE_KINDS.OUTPUT || baseNode.kind === NODE_KINDS.CONST) {
      nodes.push({ ...baseNode });
      continue;
    }
    // Collect the same node from every trace (by canonical id).
    const perTrace = compiled.map((c) => c.ir.nodes.find((n) => n.id === baseNode.id));
    const merged = { ...baseNode };

    if (baseNode.kind === NODE_KINDS.LLM) {
      const prompts = perTrace.map((n) => n && typeof n.prompt_template === 'string' ? n.prompt_template : '');
      const responses = perTrace.map((n) => n && n.captured_response);
      const { template, holes } = _hoistPlaceholders(prompts, inputsPerTrace, newParamName);
      merged.prompt_template = template;
      for (const h of holes) parameters.push(h);
      // Classify: an LLM step is by definition llm_required.
      merged.step_kind = STEP_KINDS.LLM_REQUIRED;
      merged.captured_response_examples = responses;
    } else if (baseNode.kind === NODE_KINDS.TOOL) {
      // Pull the tool span out of every trace so we can decide deterministic
      // vs tool_call vs human_required.
      const toolSpans = compiled.map((c) => {
        const n = c.ir.nodes.find((x) => x.id === baseNode.id);
        if (!n) return null;
        return c.spans.find((s) => s.span_id === n.source_span_id) || null;
      });
      // Human checkpoint: any span flagged requires_human:true takes priority.
      const wantsHuman = toolSpans.some((s) => s && s.payload && s.payload.requires_human === true);
      // Args templating (string fields only — keep objects/numbers literal so
      // the runtime can call the tool with the right type).
      const argSamples = toolSpans.map((s) => (s && s.payload && s.payload.args) || {});
      const { templatedArgs, holes: argHoles } = _hoistArgsPlaceholders(argSamples, inputsPerTrace, newParamName);
      merged.args_template = templatedArgs;
      for (const h of argHoles) parameters.push(h);
      // Deterministic check: build the lookup table keyed by the (per-trace)
      // input. If every (input, output) pair is consistent (no input maps to
      // two outputs) the step is provably deterministic; otherwise it stays
      // tool_call.
      const inputKeys = inputsPerTrace.map((v) => _stableKey(v));
      const outputs = toolSpans.map((s) => (s && s.payload) ? s.payload.result : null);
      const conflict = _hasInputOutputConflict(inputKeys, outputs);
      const deterministic = !wantsHuman && !conflict;
      if (wantsHuman) {
        merged.step_kind = STEP_KINDS.HUMAN_REQUIRED;
      } else if (deterministic) {
        merged.step_kind = STEP_KINDS.DETERMINISTIC;
        merged.lookup_table = {};
        for (let i = 0; i < inputsPerTrace.length; i++) {
          const propKey = _propKey(inputsPerTrace[i]);
          if (propKey != null) merged.lookup_table[propKey] = outputs[i];
        }
      } else {
        merged.step_kind = STEP_KINDS.TOOL_CALL;
      }
      merged.captured_result_examples = outputs;
    } else {
      // BRANCH / ARTIFACT — leave as-is for now; classify as tool_call so the
      // runtime defaults to the executor.
      merged.step_kind = STEP_KINDS.TOOL_CALL;
    }
    nodes.push(merged);
  }

  // Merge seeds across all traces (drop duplicates by canonical input key).
  const seenSeeds = new Map();
  for (const c of compiled) {
    for (const s of c.ir.seeds) {
      const k = _stableKey(s.input);
      if (!seenSeeds.has(k)) seenSeeds.set(k, s);
    }
  }
  const ir = {
    spec: WORKFLOW_IR_VERSION,
    source_trace_id: null,
    nodes,
    edges: base.edges.map((e) => ({ ...e })),
    seeds: Array.from(seenSeeds.values()),
    parameters,
  };
  validateIr(ir);
  ir.hash = hashIr(ir);
  return { ir, parameters };
}

// =====================================================================
// W409w — runner that honors step_kind and resolves {{var_N}} against the
// workflow's user input. The classic interpret() in workflow-ir.js handles
// the cache-hit path; we delegate to it when the input matches a seed.
// On a cache miss we walk the IR ourselves so:
//   - deterministic steps with a lookup_table hit return without an executor
//   - llm_required steps fire opts.exec.llm AFTER substituting {{var_N}}
//   - human_required steps fire opts.exec.human (or throw)
//   - tool_call steps fire opts.exec.tool with the templated args
// =====================================================================
export async function runCompiledWorkflow(ir, input, opts = {}) {
  validateIr(ir);
  // Cache-hit fast path: identical to interpret() seed lookup.
  for (const seed of (ir.seeds || [])) {
    if (_stableKey(seed.input) === _stableKey(input)) {
      return { output: seed.output, cache_hit: true, trace: { _cache_hit: true } };
    }
  }
  // Cache miss — walk the IR. We use the existing topological order.
  const order = _topoOrder(ir);
  const env = {};
  const trace = {};
  for (const id of order) {
    const node = ir.nodes.find((n) => n.id === id);
    if (!node) continue;
    switch (node.kind) {
      case NODE_KINDS.INPUT:
        env[id] = input;
        trace[id] = { kind: 'input', value: input };
        break;
      case NODE_KINDS.CONST:
        env[id] = node.value;
        trace[id] = { kind: 'const', value: node.value };
        break;
      case NODE_KINDS.LLM: {
        if (!opts.exec || !opts.exec.llm) {
          throw new Error(`runCompiledWorkflow: no exec.llm wired for llm_required node ${id}`);
        }
        const prompt = _substituteTemplate(node.prompt_template, input);
        const v = await opts.exec.llm({ id, vendor: node.vendor, model: node.model, step_kind: node.step_kind }, prompt);
        env[id] = v;
        trace[id] = { kind: 'llm', prompt, value: v };
        break;
      }
      case NODE_KINDS.TOOL: {
        const args = _substituteTemplateDeep(node.args_template, input);
        // 1) Deterministic step with a lookup table — never call the LLM.
        if (node.step_kind === STEP_KINDS.DETERMINISTIC && node.lookup_table) {
          const key = _propKey(input);
          if (key != null && Object.prototype.hasOwnProperty.call(node.lookup_table, key)) {
            env[id] = node.lookup_table[key];
            trace[id] = { kind: 'tool', step_kind: 'deterministic', source: 'lookup_table', value: env[id] };
            break;
          }
          // Lookup table miss — fall through to the tool executor. Still no LLM.
          if (!opts.exec || !opts.exec.tool) {
            throw new Error(`runCompiledWorkflow: deterministic step ${id} missed lookup_table and no exec.tool wired`);
          }
          const v = await opts.exec.tool({ id, tool_name: node.tool_name, step_kind: node.step_kind }, args);
          env[id] = v;
          trace[id] = { kind: 'tool', step_kind: 'deterministic', source: 'executor', value: v };
          break;
        }
        // 2) Human approval — fire the human handler if wired, else throw.
        if (node.step_kind === STEP_KINDS.HUMAN_REQUIRED) {
          if (opts.exec && opts.exec.human) {
            const v = await opts.exec.human({ id, tool_name: node.tool_name, step_kind: node.step_kind }, args);
            env[id] = v;
            trace[id] = { kind: 'tool', step_kind: 'human_required', value: v };
            break;
          }
          throw new Error(`runCompiledWorkflow: human_required step ${id} but no exec.human wired`);
        }
        // 3) Plain tool call.
        if (!opts.exec || !opts.exec.tool) {
          throw new Error(`runCompiledWorkflow: no exec.tool wired for tool_call node ${id}`);
        }
        const v = await opts.exec.tool({ id, tool_name: node.tool_name, step_kind: node.step_kind }, args);
        env[id] = v;
        trace[id] = { kind: 'tool', step_kind: node.step_kind, value: v };
        break;
      }
      case NODE_KINDS.BRANCH:
      case NODE_KINDS.ARTIFACT:
      case NODE_KINDS.MEMORY_READ:
      case NODE_KINDS.MEMORY_WRITE: {
        // Delegate to the canonical interpret() so we don't fork its semantics.
        // We need to run interpret() over a sub-graph; the cheapest correct path
        // is to re-use the existing interpreter for the full IR when cache misses
        // hit one of these structural kinds. For now, defer with a clear error so
        // future waves wire them through.
        throw new Error(`runCompiledWorkflow: node kind ${node.kind} not yet supported on cache miss (use interpret() for full graphs)`);
      }
      case NODE_KINDS.OUTPUT: {
        const ref = node.value_template && node.value_template.ref;
        if (!ref || !(ref in env)) {
          throw new Error(`runCompiledWorkflow: OUTPUT references unresolved node ${ref}`);
        }
        env[id] = env[ref];
        trace[id] = { kind: 'output', value: env[id] };
        break;
      }
      default:
        throw new Error(`runCompiledWorkflow: unknown node kind ${node.kind}`);
    }
  }
  const outNode = ir.nodes.find((n) => n.kind === NODE_KINDS.OUTPUT);
  return { output: outNode ? env[outNode.id] : null, cache_hit: false, trace };
}

// ---------- helpers ----------

// Stable property key for the lookup_table: primitives stay raw so a
// captured `u3` keys the table as `lookup_table.u3` (not the JSON-stringified
// `"u3"`). Object/array inputs fall through to the canonical JSON form so
// they remain valid object keys.
function _propKey(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return _stableKey(v);
}

// Stable JSON key for any value. Used for both seed lookup and
// deterministic input/output table keying.
function _stableKey(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stableKey).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _stableKey(v[k])).join(',') + '}';
}

// Topological order for the runtime walk (same as workflow-ir._topoOrder).
function _topoOrder(ir) {
  const adj = {};
  const indeg = {};
  for (const n of ir.nodes) { adj[n.id] = []; indeg[n.id] = 0; }
  for (const e of ir.edges) { adj[e.from].push(e.to); indeg[e.to] += 1; }
  const queue = Object.keys(indeg).filter((id) => indeg[id] === 0);
  const out = [];
  while (queue.length > 0) {
    const id = queue.shift();
    out.push(id);
    for (const next of adj[id]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) queue.push(next);
    }
  }
  return out;
}

// Hoist {{var_N}} placeholders into a prompt template. The strategy: if every
// trace's prompt is identical, return it verbatim. Otherwise: for each input
// value that appears as a literal substring in every trace's prompt at the
// SAME relative position, replace with one shared placeholder. We bias toward
// the workflow input because that is the value the runtime will substitute
// on a new call; positions that differ but are NOT the input are left literal
// so the templated prompt still encodes intent.
function _hoistPlaceholders(prompts, inputs, newParamName) {
  const holes = [];
  if (prompts.every((p) => p === prompts[0])) {
    return { template: prompts[0] || '', holes };
  }
  // If every input string appears in its corresponding prompt at a stable
  // location (start, middle or end is fine), we can hoist by replacing those
  // substrings with one placeholder. We need the substring to be present in
  // every trace's prompt — only then is the substitution lossless.
  // Find one placeholder that maps "this prompt position == this trace's
  // input" across every trace.
  if (inputs.every((v) => typeof v === 'string' && v.length > 0)) {
    let allContain = true;
    for (let i = 0; i < prompts.length; i++) {
      if (typeof prompts[i] !== 'string' || !prompts[i].includes(inputs[i])) { allContain = false; break; }
    }
    if (allContain) {
      const name = newParamName();
      // Build the template from trace 0: replace ALL occurrences of input[0]
      // with the placeholder.
      const placeholder = `{{${name}}}`;
      const template = prompts[0].split(inputs[0]).join(placeholder);
      holes.push({
        name,
        source: 'input',
        bound_to_input: true,
        examples: inputs.map((v) => String(v)),
      });
      return { template, holes };
    }
  }
  // Fall back to trace-0's prompt verbatim. Better than nothing — the seed
  // cache still handles exact-match replay, and llm_required is the worst
  // case for a generalization miss.
  return { template: prompts[0] || '', holes };
}

// Same hoisting trick but for tool args. We walk every string-valued field in
// the args object and check whether ALL traces have that field set to the
// workflow input. If so, replace with a {{var_N}} placeholder.
function _hoistArgsPlaceholders(argSamples, inputs, newParamName) {
  const holes = [];
  if (argSamples.length === 0) return { templatedArgs: {}, holes };
  const keys = new Set();
  for (const a of argSamples) {
    if (a && typeof a === 'object') for (const k of Object.keys(a)) keys.add(k);
  }
  const out = {};
  for (const k of keys) {
    const vals = argSamples.map((a) => (a && a[k] !== undefined) ? a[k] : null);
    // String field that equals the per-trace input across every trace -> hoist.
    const allStringAndInput = vals.every((v, i) => typeof v === 'string' && v === inputs[i] && typeof inputs[i] === 'string');
    if (allStringAndInput) {
      const name = newParamName();
      out[k] = `{{${name}}}`;
      holes.push({ name, source: 'input', bound_to_input: true, examples: vals.map((v) => String(v)), arg_key: k });
      continue;
    }
    // Otherwise use the trace-0 value (literal). Differences across traces
    // for non-input fields are recorded only as captured_examples — the
    // generalization runtime won't try to vary them.
    out[k] = vals[0];
  }
  return { templatedArgs: out, holes };
}

// Substitute {{var_N}} placeholders in a string with the workflow input
// (every placeholder currently binds to the same input — see _hoistPlaceholders).
function _substituteTemplate(template, input) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{var_\d+\}\}/g, () => typeof input === 'string' ? input : JSON.stringify(input));
}

function _substituteTemplateDeep(template, input) {
  if (template === null || template === undefined) return template;
  if (typeof template === 'string') return _substituteTemplate(template, input);
  if (Array.isArray(template)) return template.map((v) => _substituteTemplateDeep(v, input));
  if (typeof template === 'object') {
    const out = {};
    for (const k of Object.keys(template)) out[k] = _substituteTemplateDeep(template[k], input);
    return out;
  }
  return template;
}

// True when the same input key maps to two different outputs across traces
// (i.e. the step is not a pure function of its input).
function _hasInputOutputConflict(inputKeys, outputs) {
  const seen = new Map();
  for (let i = 0; i < inputKeys.length; i++) {
    const k = inputKeys[i];
    if (k == null) continue;
    const v = _stableKey(outputs[i]);
    if (seen.has(k) && seen.get(k) !== v) return true;
    seen.set(k, v);
  }
  return false;
}

void interpretIr; // touched so the import lints as used; full interpreter
                   // delegation is reserved for future waves on BRANCH/ARTIFACT.

export default {
  REPLAYABLE,
  STEP_KINDS,
  traceToIr,
  spansToIr,
  tracesToIr,
  compileWorkflowFromTraces,
  runCompiledWorkflow,
};
