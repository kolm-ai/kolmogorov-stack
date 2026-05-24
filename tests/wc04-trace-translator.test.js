// WC04 — test coverage close-out for src/trace-translator.js.
//
// Previously: 268 LOC, 0 tests anywhere in tests/.
// Pins the public surface of translateIr() + KNOWN_PROVIDERS + the helpers'
// invariants that the route + CLI wrappers depend on.
//
// translateTrace + detectTraceProvider are I/O wrappers around translateIr +
// trace-capture; they're covered indirectly through W463 (trace-compile) and
// the wave467 route tests. Here we focus on the pure-function core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_PROVIDERS,
  translateIr,
  translateTrace,
  detectTraceProvider,
} from '../src/trace-translator.js';

// Minimal valid IR: INPUT → LLM(anthropic, model) → OUTPUT.
function mkIr({ vendor = 'anthropic', model = 'claude-opus-4-7' } = {}) {
  return {
    spec: 'wir-v1',
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'llm1', kind: 'llm', vendor, model, prompt_template: 'say hi' },
      { id: 'out', kind: 'output' },
    ],
    edges: [
      { from: 'in', to: 'llm1' },
      { from: 'llm1', to: 'out' },
    ],
    seeds: [],
  };
}

test('WC04-tt #1 KNOWN_PROVIDERS exposes anthropic/openai/generic and is frozen', () => {
  assert.deepEqual([...KNOWN_PROVIDERS].sort(), ['anthropic', 'generic', 'openai']);
  assert.ok(Object.isFrozen(KNOWN_PROVIDERS), 'KNOWN_PROVIDERS must be frozen');
});

test('WC04-tt #2 translateIr throws invalid_from_provider for unknown from', () => {
  assert.throws(
    () => translateIr(mkIr(), { from: 'mystery', to: 'openai' }),
    (err) => err.code === 'invalid_from_provider',
  );
});

test('WC04-tt #3 translateIr throws invalid_to_provider for unknown to', () => {
  assert.throws(
    () => translateIr(mkIr(), { from: 'anthropic', to: 'mystery' }),
    (err) => err.code === 'invalid_to_provider',
  );
});

test('WC04-tt #4 translateIr throws ir_required for null/missing ir', () => {
  assert.throws(
    () => translateIr(null, { from: 'anthropic', to: 'openai' }),
    (err) => err.code === 'ir_required',
  );
});

test('WC04-tt #5 translateIr noop when from===to', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-opus-4-7' });
  const res = translateIr(ir, { from: 'anthropic', to: 'anthropic' });
  assert.equal(res.from, 'anthropic');
  assert.equal(res.to, 'anthropic');
  assert.equal(res.mappings.length, 1);
  assert.equal(res.mappings[0].reason, 'noop');
  assert.equal(res.mappings[0].to_model, 'claude-opus-4-7');
  assert.equal(res.mappings[0].mapped, true);
  // ir is a deep copy
  assert.notEqual(res.ir, ir);
  assert.notEqual(res.ir.nodes, ir.nodes);
});

test('WC04-tt #6 translateIr maps anthropic flagship → openai gpt-4o (tier_default)', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-opus-4-7' });
  const res = translateIr(ir, { from: 'anthropic', to: 'openai' });
  assert.equal(res.mappings.length, 1);
  const m = res.mappings[0];
  assert.equal(m.from_model, 'claude-opus-4-7');
  assert.equal(m.from_vendor, 'anthropic');
  assert.equal(m.to_model, 'gpt-4o');
  assert.equal(m.to_vendor, 'openai');
  assert.equal(m.tier, 'flagship');
  assert.equal(m.mapped, true);
  assert.equal(m.reason, 'tier_default');
  // IR is rewritten in place
  const llmNode = res.ir.nodes.find(n => n.id === 'llm1');
  assert.equal(llmNode.vendor, 'openai');
  assert.equal(llmNode.model, 'gpt-4o');
});

test('WC04-tt #7 translateIr maps anthropic haiku → openai gpt-4o-mini', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-haiku-4-5-20251001' });
  const res = translateIr(ir, { from: 'anthropic', to: 'openai' });
  assert.equal(res.mappings[0].tier, 'haiku');
  assert.equal(res.mappings[0].to_model, 'gpt-4o-mini');
});

test('WC04-tt #8 translateIr maps openai gpt-4o-mini → anthropic claude-haiku (reverse)', () => {
  const ir = mkIr({ vendor: 'openai', model: 'gpt-4o-mini' });
  const res = translateIr(ir, { from: 'openai', to: 'anthropic' });
  assert.equal(res.mappings[0].tier, 'haiku');
  assert.equal(res.mappings[0].to_model, 'claude-haiku-4-5-20251001');
});

test('WC04-tt #9 translateIr to=generic preserves model + vendor (passthrough)', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-opus-4-7' });
  const res = translateIr(ir, { from: 'anthropic', to: 'generic' });
  assert.equal(res.mappings[0].to_model, 'claude-opus-4-7');
  assert.equal(res.mappings[0].reason, 'passthrough_to_generic');
  // generic preserves source vendor — does NOT overwrite to 'generic'
  const llmNode = res.ir.nodes.find(n => n.id === 'llm1');
  assert.equal(llmNode.vendor, 'anthropic');
});

test('WC04-tt #10 translateIr override map wins over tier_default (case-insensitive)', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-opus-4-7' });
  const res = translateIr(ir, {
    from: 'anthropic',
    to: 'openai',
    model_map: { 'CLAUDE-OPUS-4-7': 'gpt-4-turbo' },
  });
  assert.equal(res.mappings[0].reason, 'override');
  assert.equal(res.mappings[0].to_model, 'gpt-4-turbo');
});

test('WC04-tt #11 translateIr unmapped model: mapped=false + dropped[] populated', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'never-shipped-model-9000' });
  const res = translateIr(ir, { from: 'anthropic', to: 'openai' });
  assert.equal(res.mappings[0].mapped, false);
  assert.equal(res.mappings[0].reason, 'unmapped');
  assert.equal(res.dropped.length, 1);
  assert.equal(res.dropped[0].model, 'never-shipped-model-9000');
});

test('WC04-tt #12 translateIr strict=true throws unmapped_models when any unmapped', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'never-shipped-model-9000' });
  assert.throws(
    () => translateIr(ir, { from: 'anthropic', to: 'openai', strict: true }),
    (err) => err.code === 'unmapped_models' && err.unmapped_count === 1 && Array.isArray(err.mappings),
  );
});

test('WC04-tt #13 translateIr returns stable ir_hash for identical inputs', () => {
  const a = translateIr(mkIr(), { from: 'anthropic', to: 'openai' });
  const b = translateIr(mkIr(), { from: 'anthropic', to: 'openai' });
  assert.equal(typeof a.ir_hash, 'string');
  assert.equal(a.ir_hash.length > 0, true);
  assert.equal(a.ir_hash, b.ir_hash);
});

test('WC04-tt #14 translateIr leaves non-LLM nodes (INPUT/OUTPUT) untouched', () => {
  const ir = mkIr({ vendor: 'anthropic', model: 'claude-opus-4-7' });
  const res = translateIr(ir, { from: 'anthropic', to: 'openai' });
  const inputNode = res.ir.nodes.find(n => n.id === 'in');
  const outputNode = res.ir.nodes.find(n => n.id === 'out');
  assert.equal(inputNode.kind, 'input');
  assert.equal(outputNode.kind, 'output');
  // No mappings emitted for non-LLM nodes
  assert.equal(res.mappings.length, 1);
  assert.equal(res.mappings[0].node_id, 'llm1');
});

test('WC04-tt #15 translateTrace + detectTraceProvider exported as async functions', () => {
  assert.equal(typeof translateTrace, 'function');
  assert.equal(typeof detectTraceProvider, 'function');
});

test('WC04-tt #16 translateTrace requires trace_id + tenant_id', async () => {
  await assert.rejects(
    () => translateTrace({ tenant_id: 't1', from: 'anthropic', to: 'openai' }),
    (err) => err.code === 'trace_id_required',
  );
  await assert.rejects(
    () => translateTrace({ trace_id: 'x', from: 'anthropic', to: 'openai' }),
    (err) => err.code === 'tenant_id_required',
  );
});
